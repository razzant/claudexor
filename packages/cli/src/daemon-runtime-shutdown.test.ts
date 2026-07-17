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
  });

  it("sweeps a leaked handle after a CLEAN stop with a disclosed drain-grace exit", async () => {
    const { runtime, exits, log } = machine({ stopDeadlineMs: 5_000, drainGraceMs: 20 });

    await runtime.beginShutdown("test");
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    // In-process the loop is naturally alive (the test runner holds it), so
    // the sweep fires: a real clean daemon exits first and never reaches it.
    expect(exits).toEqual([0]);
    expect(log.join("\n")).toContain("leaked handle");
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
    } finally {
      process.exitCode = prevExitCode;
    }
  });

  it("a CLEAN stop clears the hung-stop deadline — never force-exited nonzero", async () => {
    // The deadline (exit 1) is the timer a clean shutdown must escape, and
    // the clean-stop continuation itself owns the clearing — there is no
    // external finalize() hook anymore (the Ф2.5 one also cancelled the
    // drain sweep, silently disabling the leaked-handle protection in every
    // production shutdown; Ф3 final review + its confirmation pass, which
    // caught the first replacement test for this as vacuous).
    const { runtime, exits, log } = machine({ stopDeadlineMs: 40, drainGraceMs: 5_000 });
    await runtime.beginShutdown("test");
    await new Promise<void>((resolve) => setTimeout(resolve, 90));
    expect(exits).toEqual([]); // no exit-1 escalation after the clean stop
    expect(log.join("\n")).not.toContain("forcing exit");
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
  });

  it("coalesced triggers are disclosed and share one completion", async () => {
    const { runtime, log } = machine();
    const first = runtime.beginShutdown("SIGTERM");
    const second = runtime.beginShutdown("socket-rpc stop");
    expect(second).toBe(first);
    await first;
    expect(log.join("\n")).toContain("shutdown already in progress (socket-rpc stop coalesced)");
  });
});
