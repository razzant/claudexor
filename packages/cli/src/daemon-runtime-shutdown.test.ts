import { describe, expect, it } from "vitest";
import {
  DaemonRuntimeShutdown,
  type DaemonRuntimeShutdownOptions,
} from "./daemon-runtime-shutdown.js";

function machine(overrides: Partial<DaemonRuntimeShutdownOptions> = {}): {
  runtime: DaemonRuntimeShutdown;
  exits: number[];
  log: string[];
} {
  const exits: number[] = [];
  const log: string[] = [];
  const runtime = new DaemonRuntimeShutdown({
    daemon: { stop: async () => undefined },
    setup: { beginDrain: () => undefined, shutdown: async () => undefined },
    control: () => null,
    journal: { close: () => undefined },
    log: (message) => log.push(message),
    forceExit: (code) => exits.push(code),
    ...overrides,
  });
  return { runtime, exits, log };
}

describe("DaemonRuntimeShutdown", () => {
  it("fences setup, stops every writer, then closes the journal once", async () => {
    const events: string[] = [];
    const runtime = new DaemonRuntimeShutdown({
      daemon: { stop: async () => void events.push("daemon-stop") },
      setup: {
        beginDrain: () => void events.push("setup-fence"),
        shutdown: async () => void events.push("setup-stop"),
      },
      control: () => ({ stop: async () => void events.push("control-stop") }),
      journal: { close: () => void events.push("journal-close") },
      forceExit: () => undefined,
    });

    const first = runtime.beginShutdown("test");
    expect(runtime.beginShutdown("again")).toBe(first);
    expect(events).toEqual(["setup-fence", "control-stop", "daemon-stop", "setup-stop"]);
    await first;
    expect(events).toEqual([
      "setup-fence",
      "control-stop",
      "daemon-stop",
      "setup-stop",
      "journal-close",
    ]);
    runtime.finalize();
  });

  it("keeps the journal open when any writer fails to stop", async () => {
    let journalClosed = false;
    const { runtime } = machine({
      daemon: {
        stop: async () => {
          throw new Error("final persist failed");
        },
      },
      journal: { close: () => void (journalClosed = true) },
      onStopFailure: () => undefined,
    });

    await expect(runtime.beginShutdown("test")).rejects.toThrow(/shutdown failed/);
    await expect(runtime.wait()).rejects.toThrow(/shutdown failed/);
    expect(journalClosed).toBe(false);
    runtime.finalize();
  });

  it("every trigger gets the escalation ladder: a HUNG stop is force-exited after the deadline (W3.5/W-C8)", async () => {
    const { runtime, exits, log } = machine({
      daemon: { stop: () => new Promise<void>(() => {}) }, // never resolves — the immortal-daemon class
      stopDeadlineMs: 20,
    });

    // The socket-RPC trigger, not an OS signal — the ladder is trigger-agnostic.
    void runtime.beginShutdown("socket-rpc stop");
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(exits).toEqual([1]);
    expect(log.join("\n")).toContain("shutdown requested (socket-rpc stop)");
    expect(log.join("\n")).toContain("graceful stop exceeded 20ms; forcing exit");
    runtime.finalize();
  });

  it("sweeps a leaked handle after a CLEAN stop with a disclosed drain-grace exit", async () => {
    const { runtime, exits, log } = machine({ stopDeadlineMs: 5_000, drainGraceMs: 20 });

    await runtime.beginShutdown("test");
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    // In-process the loop is naturally alive (the test runner holds it), so
    // the sweep fires: a real clean daemon exits first and never reaches it.
    expect(exits).toEqual([0]);
    expect(log.join("\n")).toContain("leaked handle");
    runtime.finalize();
  });

  it("the drain sweep reads the exit code at FIRE time, not arm time (sol #17)", async () => {
    const prevExitCode = process.exitCode;
    const { runtime, exits } = machine({
      stopDeadlineMs: 5_000,
      drainGraceMs: 40,
      // A clean stop that sets a FAILURE exit code during the grace window.
      daemon: {
        stop: async () => {
          process.exitCode = 1;
        },
      },
    });
    try {
      await runtime.beginShutdown("test");
      await new Promise<void>((resolve) => setTimeout(resolve, 90));
      expect(exits).toEqual([1]); // NOT the arm-time 0
      runtime.finalize();
    } finally {
      process.exitCode = prevExitCode;
    }
  });

  it("finalize() called SYNCHRONOUSLY after the trigger wins the microtask race (confirm #5)", async () => {
    const { runtime, exits } = machine({ stopDeadlineMs: 40, drainGraceMs: 40 });
    // finalize() runs BEFORE the clean-stop continuation arms the drain timer.
    void runtime.beginShutdown("test");
    runtime.finalize();
    await new Promise<void>((resolve) => setTimeout(resolve, 90));
    expect(exits).toEqual([]); // the post-finalize continuation must not re-arm
  });

  it("finalize() before any timer fires cancels the escalation (sol #17)", async () => {
    const { runtime, exits } = machine({ stopDeadlineMs: 40, drainGraceMs: 40 });
    await runtime.beginShutdown("test");
    await new Promise<void>((resolve) => setTimeout(resolve, 10)); // let the drain timer arm
    runtime.finalize(); // clean shutdown reached the composition root's tail
    await new Promise<void>((resolve) => setTimeout(resolve, 90));
    expect(exits).toEqual([]); // no forced exit — both timers cancelled
  });

  it("a failed stop keeps the deadline armed and reports through onStopFailure", async () => {
    let observed: unknown = null;
    const { runtime, exits, log } = machine({
      daemon: {
        stop: async () => {
          throw new Error("drain failed");
        },
      },
      onStopFailure: (error) => {
        observed = error;
      },
      stopDeadlineMs: 20,
    });

    await expect(runtime.beginShutdown("SIGTERM")).rejects.toThrow(/shutdown failed/);
    expect(observed).toBeInstanceOf(AggregateError);
    expect(log.join("\n")).toContain("shutdown FAILED");
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(exits).toEqual([1]); // the deadline still guarantees termination
    runtime.finalize();
  });

  it("coalesced triggers are disclosed and share one completion", async () => {
    const { runtime, log } = machine();
    const first = runtime.beginShutdown("SIGTERM");
    const second = runtime.beginShutdown("socket-rpc stop");
    expect(second).toBe(first);
    await first;
    expect(log.join("\n")).toContain("shutdown already in progress (socket-rpc stop coalesced)");
    runtime.finalize();
  });
});
