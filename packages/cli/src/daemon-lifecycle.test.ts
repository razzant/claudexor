import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
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

  it("escalates a HUNG stop() to a forced exit after the disclosed deadline (Ф2.5 W-C8)", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-lifecycle-"));
    const signals = new EventEmitter() as EventEmitter & Pick<NodeJS.Process, "on" | "off">;
    const exits: number[] = [];
    const lifecycle = armDaemonLifecycle({
      daemonDir: root,
      logPath: join(root, "daemon.log"),
      signals,
      snapshot: () => {},
      forceExit: (code) => exits.push(code),
      stopDeadlineMs: 20,
      stop: () => new Promise<void>(() => {}), // never resolves — the immortal-daemon class
    });

    signals.emit("SIGTERM");
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(exits).toEqual([1]);
    const log = readFileSync(join(root, "daemon.log"), "utf8");
    expect(log).toContain("graceful stop exceeded 20ms; forcing exit");
    lifecycle.finalize();
  });

  it("sweeps a leaked handle after a CLEAN stop with a disclosed drain-grace exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-lifecycle-"));
    const signals = new EventEmitter() as EventEmitter & Pick<NodeJS.Process, "on" | "off">;
    const exits: number[] = [];
    const lifecycle = armDaemonLifecycle({
      daemonDir: root,
      logPath: join(root, "daemon.log"),
      signals,
      snapshot: () => {},
      forceExit: (code) => exits.push(code),
      stopDeadlineMs: 5_000,
      drainGraceMs: 20,
      stop: async () => {},
    });

    signals.emit("SIGTERM");
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    // In-process the loop is naturally alive (the test runner holds it), so
    // the sweep fires: a real clean daemon exits first and never reaches it.
    expect(exits).toEqual([0]);
    const log = readFileSync(join(root, "daemon.log"), "utf8");
    expect(log).toContain("leaked handle");
    lifecycle.finalize();
  });

  it("the drain sweep reads the exit code at FIRE time, not arm time (sol #17)", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-lifecycle-"));
    const signals = new EventEmitter() as EventEmitter & Pick<NodeJS.Process, "on" | "off">;
    const exits: number[] = [];
    const prevExitCode = process.exitCode;
    const lifecycle = armDaemonLifecycle({
      daemonDir: root,
      logPath: join(root, "daemon.log"),
      signals,
      snapshot: () => {},
      forceExit: (code) => exits.push(code),
      stopDeadlineMs: 5_000,
      drainGraceMs: 40,
      // A clean stop() that sets a FAILURE exit code during the grace window.
      stop: async () => {
        process.exitCode = 1;
      },
    });
    try {
      signals.emit("SIGTERM");
      await new Promise<void>((resolve) => setTimeout(resolve, 90));
      expect(exits).toEqual([1]); // NOT the arm-time 0
      lifecycle.finalize();
    } finally {
      process.exitCode = prevExitCode;
    }
  });

  it("finalize() before any timer fires cancels the escalation (sol #17)", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-lifecycle-"));
    const signals = new EventEmitter() as EventEmitter & Pick<NodeJS.Process, "on" | "off">;
    const exits: number[] = [];
    const lifecycle = armDaemonLifecycle({
      daemonDir: root,
      logPath: join(root, "daemon.log"),
      signals,
      snapshot: () => {},
      forceExit: (code) => exits.push(code),
      stopDeadlineMs: 40,
      drainGraceMs: 40,
      stop: async () => {},
    });
    signals.emit("SIGTERM");
    await new Promise<void>((resolve) => setTimeout(resolve, 10)); // let stop() settle + drain arm
    lifecycle.finalize(); // clean shutdown reached main()'s tail
    await new Promise<void>((resolve) => setTimeout(resolve, 90));
    expect(exits).toEqual([]); // no forced exit — both timers cancelled
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
