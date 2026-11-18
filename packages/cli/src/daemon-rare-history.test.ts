import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processTiming } from "@claudexor/util";
import {
  openStartupDiagnostics,
  type StartupDiagnosticsHandle,
} from "./daemon-admission-runtime.js";
import {
  loopStallMessage,
  rareHistoryPath,
  readDaemonRareHistory,
  withRareHistory,
} from "./daemon-rare-history.js";
import { DaemonRuntimeShutdown } from "./daemon-runtime-shutdown.js";
import type { QuotaRefreshDiagnostic } from "./quota-refresh-diagnostics.js";
import * as startupDiagnostics from "./startup-diagnostics.js";

const GENERATION_CAP = 256 * 1024;
const identity = { version: "3.3.15", sha: "a".repeat(40), entry: "/opt/claudexord.js" };
const roots: string[] = [];
const handles: StartupDiagnosticsHandle[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  const owned = roots.splice(0);
  for (const handle of handles.splice(0)) handle.close();
  for (const root of owned) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

function logFile(): string {
  const root = mkdtempSync(join(tmpdir(), "claudexor-rare-history-"));
  roots.push(root);
  return join(root, "claudexord.log");
}

function open(path: string): StartupDiagnosticsHandle {
  const handle = openStartupDiagnostics(identity, { path });
  handles.push(handle);
  return handle;
}

const text = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

/** A receipt past the old 2 000-character plain-line bound. */
const observation = (
  operationId: string,
  reason = "observed ".repeat(400),
): QuotaRefreshDiagnostic => ({
  source: "claude_oauth_usage",
  stage: "usage_http",
  outcome: "succeeded",
  operationId,
  profileId: null,
  at: "2026-10-04T10:00:00.000Z",
  foreground: false,
  credentialEpoch: 1,
  current: true,
  reason,
});

function rotateQuotaLog(handle: StartupDiagnosticsHandle) {
  const reason = "observed ".repeat(1_900);
  for (let i = 0; i < 40; i++) handle.logQuotaObservation(observation(`quota-${i}`, reason));
}

describe("daemon log writer and rare history (#688, #707)", () => {
  it("writes each quota observation once, as one full plain line the old reader parses", () => {
    const path = logFile();
    const handle = open(path);
    const record = observation("op-full");
    handle.logQuotaObservation(record);

    const lines = startupDiagnostics
      .readDaemonDiagnosticTail({ path })
      .text.split("\n")
      .filter((line) => line.includes("quota.observation"));
    expect(lines).toHaveLength(1); // no duplicate JSON record of the same message
    const match = /^\[[^\]]+\] quota\.observation (\{.*\})$/.exec(lines[0]!);
    expect(JSON.parse(match![1]!)).toEqual(record);
  });

  it("keeps stalls and Stop stages readable after quota rollover and a restart", () => {
    const path = logFile();
    const first = open(path);
    first.port.record({ stage: "loop_stall", message: "loop window delayed {}" });
    first.log("shutdown", "shutdown requested (SIGTERM)");
    const size = (generation: string) => (existsSync(generation) ? statSync(generation).size : 0);
    for (let i = 0; i < 200; i += 1) {
      first.logQuotaObservation(observation(`op-${i}`));
      expect(Math.max(size(path), size(`${path}.1`))).toBeLessThanOrEqual(GENERATION_CAP);
    }
    // Ordinary quota rollover has pushed both rare events out of the daemon log.
    expect(text(path) + text(`${path}.1`)).not.toContain("SIGTERM");
    first.close();
    open(path).close(); // the next daemon life reopens both writers

    const rare = readDaemonRareHistory({ path: rareHistoryPath(path) })?.text;
    expect(rare).toContain('"stage":"loop_stall"');
    expect(rare).toContain("shutdown requested (SIGTERM)");
    expect(rare).not.toContain("quota.observation");
    expect(withRareHistory("tail\n", rare!, "rare.log")).toBe(
      `tail\n--- rare daemon events (rare.log) ---\n${rare}`,
    );
  });

  it("keeps the fired deadline after quota traffic replaces both main generations", async () => {
    vi.useFakeTimers();
    const path = logFile();
    const handle = open(path);
    const rare = () => readDaemonRareHistory({ path: rareHistoryPath(path) })?.text;
    const reason = "graceful stop exceeded 20ms; forcing exit";
    const exit = vi.fn();
    const runtime = new DaemonRuntimeShutdown({
      daemon: {
        stop: async () => {
          throw new Error("fixture stop failure");
        },
      },
      setup: { hasActiveWork: () => false, beginDrain: () => {}, shutdown: async () => {} },
      control: () => null,
      journal: { close: () => {} },
      log: (message) => handle.log("shutdown", message),
      logForcedExit: handle.logForcedExit,
      onStopFailure: () => {},
      forceExit: (code) => exit(code, rare()),
      stopDeadlineMs: 20,
    });
    try {
      await expect(runtime.beginShutdown("test stop")).rejects.toThrow();
      expect(rare()).not.toContain(reason);
      await vi.advanceTimersByTimeAsync(20);
      expect(exit).toHaveBeenCalledExactlyOnceWith(1, expect.stringContaining(`] ${reason}\n`));
      expect(text(path).split(`] ${reason}\n`)).toHaveLength(2);
      handle.close();
      rotateQuotaLog(open(path));
      const main = text(path) + text(`${path}.1`);
      expect(main).not.toContain("test stop");
      expect(main).not.toContain(reason);
      expect(rare()?.split(reason)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["main", "rare"])("writes the deadline when the open %s writer declines it", (fault) => {
    const path = logFile();
    const handle = open(path);
    const history = startupDiagnostics.daemonLogOwner(rareHistoryPath(path)).writer!;
    const rareAppend = vi.spyOn(history, "appendLine");
    const mainAppend = vi.spyOn(handle.diagnostics!, "appendLine");
    (fault === "main" ? mainAppend : rareAppend).mockReturnValueOnce(false);
    const reason = "graceful stop exceeded 20ms; forcing exit";

    handle.logForcedExit(reason);

    expect(rareAppend).toHaveBeenCalledExactlyOnceWith(reason);
    expect(mainAppend).toHaveBeenCalledExactlyOnceWith(reason);
    expect(text(path).includes(`] ${reason}\n`)).toBe(fault !== "main");
    expect(text(history.path).includes(`] ${reason}\n`)).toBe(fault !== "rare");
  });

  it("shows clean completion once and keeps the late-timer reservation out of both tails", () => {
    const path = logFile();
    const handle = open(path);
    handle.log("shutdown", "shutdown requested (socket-rpc stop)");
    handle.recordStage("shutdown_complete", "claudexord shut down");
    handle.close(true);
    const main = startupDiagnostics.readDaemonDiagnosticTail({ path }).text;
    const rare = readDaemonRareHistory({ path: rareHistoryPath(path), lines: 1 })!.text;
    const message = "claudexord shut down";
    expect(main.split(message)).toHaveLength(2);
    expect(rare.split(message)).toHaveLength(2);
    expect(JSON.parse(rare)).toMatchObject({ stage: "shutdown_complete", message });
    const view = withRareHistory(main, rare);
    expect(view.split(message)).toHaveLength(2);
    expect(rare + view).not.toMatch(/exit-slot| {20}/);
  });

  it("keeps a failed start distinct from its completed cleanup", () => {
    const path = logFile();
    const handle = open(path);
    handle.recordFailure("daemon lifecycle FAILED", new Error("fixture startup failure"));
    handle.log("shutdown", "shutdown requested (startup failure)");
    handle.recordStage("shutdown", "daemon cleanup completed after lifecycle failure");
    handle.close(true);
    const main = startupDiagnostics.readDaemonDiagnosticTail({ path }).text;
    const rare = readDaemonRareHistory({ path: rareHistoryPath(path) })!.text;
    expect(main).toContain('"stage":"startup_failure"');
    expect(rare).toContain("shutdown requested (startup failure)");
    expect(rare).toContain("daemon cleanup completed after lifecycle failure");
    expect(main + rare).not.toMatch(/shutdown_complete|claudexord shut down/);
    handle.logForcedExit("fixture timer fired after cleanup");
    expect(text(rareHistoryPath(path))).toContain("] fixture timer fired after cleanup\n");
  });

  it.each([0, 1, 2])("handles a late timer after %i rare log rotations", async (rotations) => {
    vi.useFakeTimers();
    const path = logFile();
    const rarePath = rareHistoryPath(path);
    const generations = [rarePath, `${rarePath}.1`];
    const history = () => readDaemonRareHistory({ path: rarePath })?.text;
    const retiring = open(path);
    const exit = vi.fn();
    const runtime = new DaemonRuntimeShutdown({
      daemon: { stop: async () => {} },
      setup: { hasActiveWork: () => false, beginDrain: () => {}, shutdown: async () => {} },
      control: () => null,
      journal: { close: () => {} },
      log: (message) => retiring.log("shutdown", message),
      logForcedExit: retiring.logForcedExit,
      forceExit: (code) => exit(code, history()),
      drainGraceMs: 20,
    });
    try {
      await runtime.beginShutdown("socket-rpc stop", { name: "example-client" });
      retiring.close(true);
      const successor = open(path);
      rotateQuotaLog(successor);
      expect(text(path) + text(`${path}.1`)).not.toContain("socket-rpc stop");
      // Sixteen full records fill a generation. The first already holds the Stop.
      for (let i = 0; i < 16 * rotations; i++) {
        successor.port.record({ stage: "loop_stall", message: "s".repeat(16 * 1024) });
      }
      successor.log("shutdown", "successor event");
      const successorTail = text(path);
      const before = generations.map(text);
      const historyBefore = history();
      expect(historyBefore).not.toContain("forcing exit");
      const stop = "shutdown requested (socket-rpc stop) (client-reported: example-client)";
      expect(before.findIndex((body) => body.includes(stop))).toBe(rotations < 2 ? rotations : -1);
      await vi.advanceTimersByTimeAsync(20);
      const reason = "event loop still alive 20ms after a clean stop (leaked handle); forcing exit";
      expect(exit).toHaveBeenCalledExactlyOnceWith(
        Number(process.exitCode ?? 0),
        rotations < 2
          ? expect.stringContaining(`[${new Date().toISOString()}] ${reason}\n`)
          : historyBefore,
      );
      expect(text(path)).toBe(successorTail);
      expect(history()).toContain("successor event");
      expect(history()).not.toMatch(/exit-slot| {20}/);
      for (const [i, generation] of generations.entries()) {
        const after = text(generation);
        if (i === rotations) {
          expect(after).toContain(stop);
          expect(after.split(reason)).toHaveLength(2);
          expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before[i]!));
        } else {
          expect(after).toBe(before[i]);
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])("uses the main log if rare history refused to open (late=%s)", (late) => {
    const path = logFile();
    const realOpen = startupDiagnostics.openDaemonStartupDiagnosticsAfterAuthority;
    vi.spyOn(startupDiagnostics, "openDaemonStartupDiagnosticsAfterAuthority").mockImplementation(
      (context, options) => {
        if (options?.path === rareHistoryPath(path)) throw new Error("fixture open refused");
        return realOpen(context, options);
      },
    );
    const handle = open(path);
    if (late) handle.close(true);
    handle.logForcedExit("fixture timer fired");
    const tail = startupDiagnostics.readDaemonDiagnosticTail({ path }).text;
    expect(tail).toContain("rare daemon history writer refused its target");
    expect(tail).toContain("] fixture timer fired\n");
  });

  it("never reopens a refused target and never throws into the lifecycle", () => {
    if (process.platform === "win32" || !process.getuid) return;
    const path = logFile();
    const shared = join(path, "..", "shared");
    mkdirSync(shared, { mode: 0o755 });
    chmodSync(shared, 0o755); // not private: both writers refuse it
    const target = join(shared, "claudexord.log");
    const handle = open(target);

    expect(handle.diagnostics).toBeNull();
    expect(() => {
      handle.log("shutdown", "shutdown requested (SIGTERM)");
      handle.recordStage("shutdown_complete", "claudexord shut down");
      handle.recordFailure("daemon lifecycle FAILED", new Error("boom"));
      expect(handle.port.record({ stage: "loop_stall", message: "x" })).toBe(false);
    }).not.toThrow();
    expect(existsSync(target)).toBe(false);
    expect(existsSync(rareHistoryPath(target))).toBe(false);
    expect(readDaemonRareHistory({ path: rareHistoryPath(target) })).toBeNull();
  });

  it("describes a delayed window with measured facts only, keeping missing ones unknown", () => {
    const allFacts = vi.spyOn(processTiming, "facts");
    const memory = vi.spyOn(process, "memoryUsage").mockReturnValue({
      rss: 456_789,
      heapUsed: 123_456,
      heapTotal: 200_000,
      external: 0,
      arrayBuffers: 0,
    });
    const sample = { operation: "daemon.log_line", durationMs: 4_321 } as const;
    const inside = { ...sample, at: "2026-08-13T12:34:55.000Z" };
    const earlier = { ...sample, durationMs: 6_000, at: "2026-08-13T12:34:40.000Z" };
    vi.spyOn(processTiming, "worstSync").mockReturnValue([earlier, inside]);
    const message = loopStallMessage(
      {
        windowMs: 12_000,
        windowEndedAt: "2026-08-13T12:34:56.000Z",
        delay: null,
        utilization: null,
        gc: { count: 1, totalMs: 3, maxMs: 3 },
      },
      10_000,
    );
    expect(allFacts).not.toHaveBeenCalled();
    expect(message.startsWith("loop window delayed {")).toBe(true);
    const facts = JSON.parse(message.slice("loop window delayed ".length)) as Record<
      string,
      unknown
    >;
    expect(memory).toHaveBeenCalledOnce();
    expect(facts).toMatchObject({
      expectedMs: 10_000,
      lateMs: 2_000,
      delay: null,
      memory: { rssBytes: 456_789, heapUsedBytes: 123_456 },
    });
    expect(facts.utilization).toBeNull();
    expect(facts.worstSyncInWindow).toEqual([inside]);
  });
});
