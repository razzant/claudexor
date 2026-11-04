import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient, DaemonLocalClient, DaemonServer, type RunContext } from "@claudexor/daemon";
import type { ControlGcReceipt } from "@claudexor/schema";
import { describe, expect, it, vi } from "vitest";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import {
  DaemonRuntimeShutdown,
  productionDaemonStop,
  type DaemonRuntimeShutdownOptions,
} from "./daemon-runtime-shutdown.js";
import { serializeRetention } from "./retention-lifetime.js";
import { scheduleStartupRetention } from "./retention-schedule.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

function machine(overrides: Partial<DaemonRuntimeShutdownOptions> = {}): {
  runtime: DaemonRuntimeShutdown;
  exits: number[];
  log: string[];
} {
  const exits: number[] = [];
  const log: string[] = [];
  const runtime = new DaemonRuntimeShutdown({
    daemon: { stop: async () => undefined },
    setup: {
      hasActiveWork: () => false,
      beginDrain: () => undefined,
      shutdown: async () => undefined,
    },
    control: () => null,
    journal: { close: () => undefined },
    log: (message) => log.push(message),
    forceExit: (code) => exits.push(code),
    ...overrides,
  });
  return { runtime, exits, log };
}

describe("DaemonRuntimeShutdown", () => {
  it("waits for asynchronous storage close before reporting a clean stop", async () => {
    let release!: () => void;
    let closing = false;
    let stopped = false;
    const closed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runtime } = machine({
      journal: {
        close: () => {
          closing = true;
          return closed;
        },
      },
    });
    const completion = runtime.beginShutdown("SQL close").then(() => {
      stopped = true;
    });
    await vi.waitFor(() => expect(closing).toBe(true));
    expect(stopped).toBe(false);
    release();
    await completion;
    expect(stopped).toBe(true);
  });

  it("reports an asynchronous storage close failure without claiming a clean stop", async () => {
    const failure = new Error("final SQLite barrier failed");
    const observed = vi.fn();
    const { runtime } = machine({
      journal: {
        close: async () => {
          throw failure;
        },
      },
      onStopFailure: observed,
    });
    await expect(runtime.beginShutdown("SQL close failure")).rejects.toBe(failure);
    expect(observed).toHaveBeenCalledWith(failure);
  });

  it("refuses active setup without fencing any writer", () => {
    const events: string[] = [];
    const runtime = new DaemonRuntimeShutdown({
      daemon: { stop: async () => void events.push("daemon-stop") },
      setup: {
        hasActiveWork: () => true,
        beginDrain: () => void events.push("setup-fence"),
        shutdown: async () => void events.push("setup-stop"),
      },
      control: () => ({ stop: async () => void events.push("control-stop") }),
      journal: { close: () => void events.push("journal-close") },
      forceExit: () => undefined,
    });

    expect(() => runtime.beginRuntimeReplacement()).toThrowError(
      expect.objectContaining({ code: "runtime_replacement_busy", status: 409, retryable: true }),
    );
    expect(events).toEqual([]);
  });

  it("maps setup authority failure to activity-unknown without fencing any writer", () => {
    const events: string[] = [];
    const runtime = new DaemonRuntimeShutdown({
      daemon: { stop: async () => void events.push("daemon-stop") },
      setup: {
        hasActiveWork: () => {
          throw new Error("setup journal unavailable");
        },
        beginDrain: () => void events.push("setup-fence"),
        shutdown: async () => void events.push("setup-stop"),
      },
      control: () => ({ stop: async () => void events.push("control-stop") }),
      journal: { close: () => void events.push("journal-close") },
      forceExit: () => undefined,
    });

    expect(() => runtime.beginRuntimeReplacement()).toThrowError(
      expect.objectContaining({ code: "runtime_activity_unknown", status: 503, retryable: true }),
    );
    expect(events).toEqual([]);
  });

  it("fences setup, control, and daemon synchronously after replacement admission", async () => {
    const events: string[] = [];
    const runtime = new DaemonRuntimeShutdown({
      daemon: { stop: async () => void events.push("daemon-stop") },
      setup: {
        hasActiveWork: () => false,
        beginDrain: () => void events.push("setup-fence"),
        shutdown: async () => void events.push("setup-stop"),
      },
      control: () => ({ stop: async () => void events.push("control-stop") }),
      journal: { close: () => void events.push("journal-close") },
      forceExit: () => undefined,
    });

    const stopping = runtime.beginRuntimeReplacement();
    expect(events).toEqual(["setup-fence", "control-stop", "daemon-stop", "setup-stop"]);
    await stopping;
    expect(events.at(-1)).toBe("journal-close");
  });

  it("fences setup, stops every writer, then closes the journal once", async () => {
    const events: string[] = [];
    const runtime = new DaemonRuntimeShutdown({
      daemon: { stop: async () => void events.push("daemon-stop") },
      setup: {
        hasActiveWork: () => false,
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
    // external finalize() hook anymore (the F2.5 one also cancelled the
    // drain sweep, silently disabling the leaked-handle protection in every
    // production shutdown; F3 final review + its confirmation pass, which
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

describe("productionDaemonStop", () => {
  it("starts every cleanup in one turn with the fence first, on the owners current at stop", async () => {
    const events: string[] = [];
    let server = { stop: async () => void events.push("stale server") };
    let retention = async () => void events.push("stale retention");
    let finishOpening!: (error: Error) => void;
    let opening: Promise<void> | null = null;
    const participant = productionDaemonStop({
      abort: () => void events.push("abort"),
      server: () => server,
      closeModels: () => void events.push("models"),
      stopRetention: () => retention(),
      opening: () => opening,
    });
    server = { stop: async () => void events.push("server") };
    retention = async () => void events.push("retention");
    opening = new Promise((_resolve, reject) => {
      finishOpening = reject;
    });
    let stopped = false;
    const stopping = participant.stop().then(() => {
      stopped = true;
    });
    expect(events).toEqual(["abort", "server", "models", "retention"]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    finishOpening(new Error("a cancelled opening is not a stop failure"));
    await stopping;
  });

  it("runs every cleanup past a failure and reports each one", async () => {
    const serverFailure = new Error("server");
    const modelFailure = new Error("models");
    const retentionFailure = new Error("retention");
    const steps = (
      server: () => Promise<void>,
      models: () => void,
      retention: () => Promise<void>,
    ) =>
      productionDaemonStop({
        abort: () => undefined,
        server: () => ({ stop: server }),
        closeModels: models,
        stopRetention: retention,
        opening: () => null,
      }).stop();
    const none = async () => undefined;
    await expect(
      steps(
        none,
        () => {
          throw modelFailure;
        },
        none,
      ),
    ).rejects.toBe(modelFailure);
    let retentionRan = false;
    await expect(
      steps(
        () => Promise.reject(serverFailure),
        () => {
          throw modelFailure;
        },
        () => {
          retentionRan = true;
          return Promise.reject(retentionFailure);
        },
      ),
    ).rejects.toMatchObject({ errors: [serverFailure, modelFailure, retentionFailure] });
    expect(retentionRan).toBe(true);
  });
});

const IDENTITY = { version: "1.2.3", buildSha: "a".repeat(40) };
const LEASE = { pid: 4242, token: "runtime-lease" };
const TARGET = { ...IDENTITY, leaseOwner: LEASE };
const PASS_RECEIPT = {
  freed_bytes: 0,
  deleted_runs: [],
  deleted_reviews: [],
  errors: [],
} as unknown as ControlGcReceipt;
const ask = (prompt: string) => ({ mode: "ask", prompt });

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const compositionCleanups: Array<() => Promise<void>> = [];
afterEachClosed(async () => {
  for (const close of compositionCleanups.splice(0).reverse()) await close();
});

/** The production order over real owners: SQL commands, DaemonServer with its
 * socket, the in-process client, the retention scheduler and shutdown machine. */
async function composition(
  options: {
    setupActivity?: () => boolean;
    failDrain?: { armed: boolean };
    stopDeadlineMs?: number;
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx603-")));
  const sql = await sqlFixture(root);
  const pass = barrier();
  const passStarted = barrier();
  const events: string[] = [];
  const exits: number[] = [];
  const log: string[] = [];
  const failures: unknown[] = [];
  const running = new Map<string, RunContext>();
  let runtime!: DaemonRuntimeShutdown;
  let stopRetention: () => Promise<void> = async () => undefined;
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\${root.replace(/[^a-zA-Z0-9]/g, "-")}`
      : join(root, "daemon.sock");
  const fault = options.failDrain;
  const commands = fault
    ? Object.create(sql.graph.commands, {
        pruneHistory: {
          value: (...args: Parameters<typeof sql.graph.commands.pruneHistory>) => {
            if (fault.armed) throw new Error("fixture: the terminal bookkeeping failed");
            return sql.graph.commands.pruneHistory(...args);
          },
        },
      })
    : sql.graph.commands;
  const server = new DaemonServer({
    socketPath,
    token: "token",
    commands,
    runtimeIdentity: IDENTITY,
    runtimeLeaseOwner: LEASE,
    onShutdownRequested: () => runtime.beginShutdown("socket-rpc stop"),
    onRuntimeReplacementRequested: () => runtime.beginRuntimeReplacement(),
    runner: async (params, ctx) => {
      if ((params as { prompt?: string }).prompt !== "hold") return { lifecycle: "succeeded" };
      running.set(ctx.jobId, ctx);
      await new Promise<void>((resolve) =>
        ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { lifecycle: "cancelled" };
    },
  });
  runtime = new DaemonRuntimeShutdown({
    daemon: productionDaemonStop({
      abort: () => void events.push("abort"),
      server: () => server,
      closeModels: () => void events.push("models-close"),
      stopRetention: () => stopRetention(),
      opening: () => null,
    }),
    setup: {
      hasActiveWork: options.setupActivity ?? (() => false),
      beginDrain: () => void events.push("setup-fence"),
      shutdown: async () => void events.push("setup-stop"),
    },
    control: () => null,
    journal: { close: () => void events.push("journal-close") },
    log: (message) => log.push(message),
    forceExit: (code) => exits.push(code),
    onStopFailure: (error) => failures.push(error),
    stopDeadlineMs: options.stopDeadlineMs ?? 60_000,
    drainGraceMs: 60_000,
  });
  await server.start();
  // As in production: the scheduler is assigned after the participant was built.
  stopRetention = scheduleStartupRetention(
    serializeRetention(async () => {
      passStarted.release();
      await pass.promise;
      return PASS_RECEIPT;
    }),
    { logPath: join(root, "retention.log"), shuttingDown: () => runtime.requested(), delayMs: 0 },
  );
  compositionCleanups.push(async () => {
    pass.release();
    if (fault) fault.armed = false;
    await runtime.beginShutdown("test cleanup").catch(() => undefined);
    await sql.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await passStarted.promise;
  const local = new DaemonLocalClient(() => server);
  const prompts = () =>
    sql.records().map((record) => (record.params as { prompt?: string }).prompt);
  const settled = (id: string) =>
    vi.waitFor(async () =>
      expect(["queued", "running"]).not.toContain((await local.status(id)).state),
    );
  return {
    sql,
    server,
    runtime,
    local,
    socket: new DaemonClient(socketPath, "token"),
    pass,
    events,
    exits,
    log,
    failures,
    running,
    prompts,
    settled,
  };
}

describe("the production stop while a real retention pass is held (#603)", () => {
  it("has closed new keys by the time the exact replacement is answered", async () => {
    const f = await composition();
    const before = await f.local.enqueue(ask("before"), { idempotencyKey: "before" });
    expect(before.reused).toBe(false);
    await f.settled(before.id);
    const viaSocket = await f.socket.enqueue(ask("socket"), { idempotencyKey: "socket" });
    expect(viaSocket.reused).toBe(false);
    await f.settled(viaSocket.id);

    await expect(f.socket.shutdownForRuntimeReplacement(TARGET)).resolves.toEqual({
      ok: true,
      fenced: true,
      targetBound: true,
    });
    expect(f.runtime.requested()).toBe(true);
    await expect(f.local.enqueue(ask("late"), { idempotencyKey: "late" })).rejects.toMatchObject({
      code: "daemon_stopping",
      status: 503,
    });
    await expect(
      f.socket.enqueue(ask("late"), { idempotencyKey: "late-socket" }),
    ).rejects.toMatchObject({ code: "daemon_unavailable" });
    await expect(
      f.local.enqueue(ask("before"), { idempotencyKey: "before" }),
    ).resolves.toMatchObject({ id: before.id, reused: true });
    expect(f.prompts()).toEqual(["before", "socket"]);
    expect(f.events).not.toContain("journal-close");

    f.pass.release();
    await f.runtime.wait();
    expect(f.events.at(-1)).toBe("journal-close");
    expect(f.prompts()).toEqual(["before", "socket"]);
    expect(f.exits).toEqual([]);
  });

  it.each([
    ["busy daemon work", {}, TARGET, "runtime_replacement_busy", true],
    [
      "active setup work",
      { setupActivity: (): boolean => true },
      TARGET,
      "runtime_replacement_busy",
      false,
    ],
    [
      "unknown setup activity",
      {
        setupActivity: (): boolean => {
          throw new Error("setup journal unavailable");
        },
      },
      TARGET,
      "runtime_activity_unknown",
      false,
    ],
    [
      "another build",
      {},
      { ...TARGET, buildSha: "b".repeat(40) },
      "runtime_activity_unknown",
      false,
    ],
    [
      "another lease owner",
      {},
      { ...TARGET, leaseOwner: { pid: LEASE.pid, token: "prior-process" } },
      "runtime_activity_unknown",
      false,
    ],
  ] as const)(
    "%s refuses and leaves every ingress open",
    async (_label, setup, target, code, busy) => {
      const f = await composition(setup);
      if (busy) {
        await f.local.enqueue(ask("hold"), { idempotencyKey: "busy" });
        await vi.waitFor(() => expect(f.running.size).toBe(1));
      }
      await expect(f.socket.shutdownForRuntimeReplacement(target)).rejects.toMatchObject({ code });
      expect(f.runtime.requested()).toBe(false);
      expect(f.events).toEqual([]);
      await expect(
        f.socket.enqueue(ask("open socket"), { idempotencyKey: "open-socket" }),
      ).resolves.toMatchObject({ reused: false });
      await expect(
        f.local.enqueue(ask("open local"), { idempotencyKey: "open-local" }),
      ).resolves.toMatchObject({ reused: false });
      for (const ctx of f.running.values()) expect(ctx.signal.aborted).toBe(false);
    },
  );

  it("an ordinary stop aborts running work at once, coalesces triggers, then waits for the pass", async () => {
    const f = await composition();
    const job = await f.local.enqueue(ask("hold"), { idempotencyKey: "work" });
    await vi.waitFor(() => expect(f.running.size).toBe(1));
    const ctx = f.running.get(job.id)!;

    const stopping = f.runtime.beginShutdown("SIGTERM");
    expect(ctx.signal.aborted).toBe(true);
    expect(ctx.signal.reason).toBe("host_cancelled");
    expect(f.runtime.beginShutdown("socket-rpc stop")).toBe(stopping);
    expect(f.log.join("\n")).toContain("shutdown already in progress (socket-rpc stop coalesced)");
    await f.settled(job.id);
    await expect(f.local.enqueue(ask("late"), { idempotencyKey: "late" })).rejects.toMatchObject({
      code: "daemon_stopping",
    });
    await f.server.stop();
    expect(f.events).not.toContain("journal-close");

    f.pass.release();
    await stopping;
    expect(f.events.at(-1)).toBe("journal-close");
    expect(f.prompts()).toEqual(["hold"]);
  });

  it("a pass that never drains still meets the stop deadline with admission closed", async () => {
    const f = await composition({ stopDeadlineMs: 30 });
    void f.runtime.beginShutdown("SIGTERM");
    await expect(f.local.enqueue(ask("late"), { idempotencyKey: "late" })).rejects.toMatchObject({
      code: "daemon_stopping",
    });
    await vi.waitFor(() => expect(f.exits).toEqual([1]));
    expect(f.events).not.toContain("journal-close");
    expect(f.prompts()).toEqual([]);
  });

  it("holds a real unconfirmed daemon stop with no unhandled rejection and fails with the journal open", async () => {
    const fault = { armed: false };
    const f = await composition({ failDrain: fault, stopDeadlineMs: 60_000 });
    await f.local.enqueue(ask("hold"), { idempotencyKey: "work" });
    await vi.waitFor(() => expect(f.running.size).toBe(1));
    fault.armed = true;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let finished = false;
      const stopping = f.runtime.beginShutdown("SIGTERM");
      void stopping.catch(() => undefined).finally(() => (finished = true));
      // The drain began before the pass ended, so its failure arrives during the hold.
      expect([...f.running.values()][0]!.signal.aborted).toBe(true);
      await expect(f.server.stop()).rejects.toMatchObject({ code: "daemon_shutdown_unconfirmed" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      expect(finished).toBe(false);

      f.pass.release();
      await expect(stopping).rejects.toMatchObject({
        message: "daemon runtime shutdown failed",
        errors: [expect.objectContaining({ code: "daemon_shutdown_unconfirmed" })],
      });
      expect(f.failures).toHaveLength(1);
      expect(f.events).not.toContain("journal-close");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
