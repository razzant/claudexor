import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loopFacts } from "@claudexor/daemon";
import { armDaemonLifecycle, runStartupCrashGc } from "./daemon-lifecycle.js";
import { rmSync as __rmSyncReap } from "node:fs";
import { afterAll as __afterAllReap } from "vitest";

// W-h: reap every temp dir this suite creates so the gate stops leaking tmpdirs.
const __reapDirs: string[] = [];
function reapMk(...args: Parameters<typeof mkdtempSync>): string {
  const dir = mkdtempSync(...args);
  __reapDirs.push(dir);
  return dir;
}
__afterAllReap(() => {
  for (const dir of __reapDirs.splice(0)) __rmSyncReap(dir, { recursive: true, force: true });
});

describe("armDaemonLifecycle", () => {
  it("leaves a previous life's pids.json byte-untouched until snapshots are armed; crash-GC consumes it on the normal start (C2)", async () => {
    vi.useFakeTimers();
    try {
      const root = reapMk(join(tmpdir(), "claudexor-lifecycle-"));
      const pidsPath = join(root, "pids.json");
      // A crashed previous life's reap list: one dead process group recorded
      // with full birth identity (the only record of surviving children).
      const previousLife = `${JSON.stringify({
        pids: [
          {
            pid: 999_999_990,
            cmd: "crashed-previous-life-harness",
            processGroup: {
              schemaVersion: 1,
              pgid: 999_999_990,
              leader: {
                status: "known",
                pid: 999_999_990,
                platform: "darwin",
                source: "proc_pidinfo",
                startToken: "darwin:1:000001",
                processGroupId: 999_999_990,
              },
            },
          },
        ],
      })}\n`;
      writeFileSync(pidsPath, previousLife, { mode: 0o600 });
      const signals = new EventEmitter() as EventEmitter & Pick<NodeJS.Process, "on" | "off">;
      const lifecycle = armDaemonLifecycle({
        daemonDir: root,
        logPath: join(root, "daemon.log"),
        signals,
        beginShutdown: async () => {},
      });
      // Recovery-only serving: crash-GC never ran, so the previous file must
      // survive every snapshot interval AND the shutdown finalizer.
      vi.advanceTimersByTime(10_000);
      expect(readFileSync(pidsPath, "utf8")).toBe(previousLife);
      // The armed lifecycle measures loop windows from the start, and its
      // finalizer stops them.
      expect(loopFacts()).not.toBeNull();
      await lifecycle.finalize();
      expect(loopFacts()).toBeNull();
      expect(readFileSync(pidsPath, "utf8")).toBe(previousLife);
      // The later NORMAL start's crash-GC consumes the reap list.
      await runStartupCrashGc({
        daemonDir: root,
        logPath: join(root, "daemon.log"),
        knownProjectRoots: () => [],
      });
      expect(existsSync(pidsPath)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes lifecycle messages through the post-authority diagnostic sink with exact stages", async () => {
    const root = reapMk(join(tmpdir(), "claudexor-lifecycle-"));
    const signals = new EventEmitter() as EventEmitter & Pick<NodeJS.Process, "on" | "off">;
    const records: Array<{ stage: string; message: string }> = [];
    const lifecycle = armDaemonLifecycle({
      daemonDir: root,
      diagnostics: {
        record: (record) => {
          records.push({ stage: record.stage, message: record.message });
          return true;
        },
      },
      signals,
      snapshot: () => {
        throw new Error("snapshot failed");
      },
      beginShutdown: async () => {},
    });

    signals.emit("SIGTERM");
    await new Promise<void>((resolve) => setImmediate(resolve));
    lifecycle.beginPidSnapshots();
    await lifecycle.finalize();

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "shutdown_signal",
          message: expect.stringContaining("SIGTERM"),
        }),
        expect.objectContaining({
          stage: "pid_snapshot",
          message: expect.stringContaining("snapshot failed"),
        }),
      ]),
    );
    expect(() => readFileSync(join(root, "daemon.log"), "utf8")).toThrow();
  });

  it("coalesces SIGTERM and SIGINT into ONE state-machine entry and finalizes idempotently", async () => {
    const root = reapMk(join(tmpdir(), "claudexor-lifecycle-"));
    const signals = new EventEmitter() as EventEmitter & Pick<NodeJS.Process, "on" | "off">;
    const reasons: string[] = [];
    let snapshots = 0;
    const lifecycle = armDaemonLifecycle({
      daemonDir: root,
      logPath: join(root, "daemon.log"),
      signals,
      snapshot: () => {
        snapshots += 1;
      },
      beginShutdown: async (reason) => {
        reasons.push(reason);
        throw new Error("drain failed"); // the machine owns failure handling
      },
    });

    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reasons).toEqual(["SIGTERM"]);
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    const log = readFileSync(join(root, "daemon.log"), "utf8");
    expect(log).toContain("SIGTERM received; stopping daemon");
    lifecycle.beginPidSnapshots();
    await lifecycle.finalize();
    await lifecycle.finalize();
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(snapshots).toBe(1);
  });

  it("snapshots children off the loop, and finalizes only after an in-flight write settles", async () => {
    vi.useFakeTimers();
    try {
      const root = reapMk(join(tmpdir(), "claudexor-lifecycle-"));
      const signals = new EventEmitter() as EventEmitter & Pick<NodeJS.Process, "on" | "off">;
      const order: string[] = [];
      let settle!: () => void;
      const inflight = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const lifecycle = armDaemonLifecycle({
        daemonDir: root,
        logPath: join(root, "daemon.log"),
        signals,
        snapshot: () => order.push("final"),
        pidsWriter: {
          refresh: () => {
            order.push("refresh");
            return inflight;
          },
          settled: () => inflight.then(() => void order.push("settled")),
        },
        beginShutdown: async () => {},
      });
      lifecycle.beginPidSnapshots();
      vi.advanceTimersByTime(4_000);
      expect(order).toEqual(["refresh", "refresh"]);
      const finalized = lifecycle.finalize();
      await Promise.resolve();
      // The final synchronous snapshot waits for the periodic write in flight.
      expect(order).toEqual(["refresh", "refresh"]);
      settle();
      await finalized;
      expect(order).toEqual(["refresh", "refresh", "settled", "final"]);
      vi.advanceTimersByTime(4_000);
      expect(order).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let diagnostic log or snapshot failures suppress shutdown", async () => {
    const root = reapMk(join(tmpdir(), "claudexor-lifecycle-"));
    const signals = new EventEmitter() as EventEmitter & Pick<NodeJS.Process, "on" | "off">;
    let entered = false;
    const lifecycle = armDaemonLifecycle({
      daemonDir: root,
      // A directory cannot be append-opened as a log file.
      logPath: root,
      signals,
      snapshot: () => {
        throw new Error("snapshot failed");
      },
      beginShutdown: async () => {
        entered = true;
      },
    });

    signals.emit("SIGTERM");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(entered).toBe(true);
    await expect(lifecycle.finalize()).resolves.toBeUndefined();
  });
});
