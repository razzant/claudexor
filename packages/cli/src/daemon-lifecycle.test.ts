import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { armDaemonLifecycle } from "./daemon-lifecycle.js";

describe("armDaemonLifecycle", () => {
  it("coalesces SIGTERM and SIGINT into ONE state-machine entry and finalizes idempotently", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-lifecycle-"));
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
    lifecycle.finalize();
    lifecycle.finalize();
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(snapshots).toBe(1);
  });

  it("does not let diagnostic log or snapshot failures suppress shutdown", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-lifecycle-"));
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
    expect(() => lifecycle.finalize()).not.toThrow();
  });
});
