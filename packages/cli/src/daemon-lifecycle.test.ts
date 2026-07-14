import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { armDaemonLifecycle } from "./daemon-lifecycle.js";

describe("armDaemonLifecycle", () => {
  it("coalesces SIGTERM and SIGINT, observes failure, and finalizes idempotently", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-lifecycle-"));
    const signals = new EventEmitter() as EventEmitter & Pick<NodeJS.Process, "on" | "off">;
    let stopCalls = 0;
    let failures = 0;
    let snapshots = 0;
    const lifecycle = armDaemonLifecycle({
      daemonDir: root,
      logPath: join(root, "daemon.log"),
      signals,
      snapshot: () => {
        snapshots += 1;
      },
      onStopFailure: () => {
        failures += 1;
      },
      stop: async () => {
        stopCalls += 1;
        throw new Error("drain failed");
      },
    });

    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopCalls).toBe(1);
    expect(failures).toBe(1);
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    lifecycle.finalize();
    lifecycle.finalize();
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(snapshots).toBe(1);
  });

  it("does not let diagnostic log or snapshot failures suppress shutdown", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-lifecycle-"));
    const signals = new EventEmitter() as EventEmitter & Pick<NodeJS.Process, "on" | "off">;
    let stopped = false;
    const lifecycle = armDaemonLifecycle({
      daemonDir: root,
      // A directory cannot be append-opened as a log file.
      logPath: root,
      signals,
      snapshot: () => {
        throw new Error("snapshot failed");
      },
      stop: async () => {
        stopped = true;
      },
    });

    signals.emit("SIGTERM");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(true);
    expect(() => lifecycle.finalize()).not.toThrow();
  });
});
