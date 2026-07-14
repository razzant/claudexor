import { describe, expect, it } from "vitest";
import { SetupSupervisor } from "./setup-supervisor.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not reached before timeout");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("SetupSupervisor", () => {
  it("starts exactly once, serializes the monitor, and drains an active tick", async () => {
    const tickGate = deferred();
    let reconciles = 0;
    let ticks = 0;
    let activeTicks = 0;
    let maximumActiveTicks = 0;
    let aborts = 0;
    const supervisor = new SetupSupervisor({
      pollMs: 0,
      recoveryRequired: () => false,
      reconcile: async () => {
        reconciles += 1;
      },
      tick: async () => {
        ticks += 1;
        activeTicks += 1;
        maximumActiveTicks = Math.max(maximumActiveTicks, activeTicks);
        await tickGate.promise;
        activeTicks -= 1;
      },
      abortInFlight: () => {
        aborts += 1;
      },
    });

    await Promise.all([supervisor.start(), supervisor.start()]);
    await waitUntil(() => ticks === 1);
    expect(supervisor.health()).toMatchObject({ state: "healthy", activeTasks: 1 });
    expect(reconciles).toBe(1);

    let shutdownCompleted = false;
    const shutdown = supervisor.shutdown().then(() => {
      shutdownCompleted = true;
    });
    expect(shutdownCompleted).toBe(false);
    expect(supervisor.health()).toMatchObject({ state: "draining", activeTasks: 1 });
    expect(aborts).toBe(1);

    tickGate.resolve();
    await shutdown;
    await supervisor.shutdown();
    expect(supervisor.health()).toMatchObject({ state: "stopped", activeTasks: 0 });
    expect({ reconciles, ticks, maximumActiveTicks, aborts }).toEqual({
      reconciles: 1,
      ticks: 1,
      maximumActiveTicks: 1,
      aborts: 1,
    });
  });

  it("fences ordinary admission synchronously and drains safety work to a fixed point", async () => {
    const ordinaryGate = deferred();
    const safetyGate = deferred();
    let safetyStarted = false;
    let ordinaryAfterDrainStarted = false;
    let supervisor!: SetupSupervisor;
    supervisor = new SetupSupervisor({
      pollMs: 60_000,
      recoveryRequired: () => false,
      reconcile: async () => {},
      tick: async () => {},
      abortInFlight: () => {},
    });

    const ordinary = supervisor.track("ordinary", async () => {
      await ordinaryGate.promise;
      void supervisor.track(
        "safety",
        async () => {
          safetyStarted = true;
          await safetyGate.promise;
        },
        { safety: true },
      );
    });
    const shutdown = supervisor.shutdown();
    expect(() => supervisor.assertCreateAllowed()).toThrow(/unavailable/);
    await expect(
      supervisor.track("too-late", async () => {
        ordinaryAfterDrainStarted = true;
      }),
    ).rejects.toThrow(/will not start ordinary work/);
    expect(ordinaryAfterDrainStarted).toBe(false);

    ordinaryGate.resolve();
    await ordinary;
    await waitUntil(() => safetyStarted);
    expect(supervisor.health()).toMatchObject({ state: "draining", activeTasks: 1 });
    safetyGate.resolve();
    await shutdown;
    expect(supervisor.health()).toMatchObject({ state: "stopped", activeTasks: 0 });
  });

  it("fails closed after a monitor fault", async () => {
    const supervisor = new SetupSupervisor({
      pollMs: 0,
      recoveryRequired: () => false,
      reconcile: async () => {},
      tick: async () => {
        throw new Error("monitor exploded");
      },
      abortInFlight: () => {},
    });

    await supervisor.start();
    await waitUntil(() => supervisor.health().state === "failed");
    expect(supervisor.health().failure?.message).toContain("monitor: monitor exploded");
    expect(() => supervisor.assertCreateAllowed()).toThrow(/monitor exploded/);
    await supervisor.shutdown();
  });

  it("does not reconcile or admit mutations when journal recovery is required", async () => {
    let reconciled = false;
    const supervisor = new SetupSupervisor({
      pollMs: 0,
      recoveryRequired: () => true,
      reconcile: async () => {
        reconciled = true;
      },
      tick: async () => {},
      abortInFlight: () => {},
    });

    await expect(supervisor.start()).rejects.toThrow(/requires recovery/);
    expect(reconciled).toBe(false);
    expect(supervisor.health().state).toBe("recovery_required");
    expect(() => supervisor.assertCreateAllowed()).toThrow(/requires recovery/);
    await supervisor.shutdown();
  });

  it("waits for in-progress reconciliation before shutdown resolves", async () => {
    const reconcileGate = deferred();
    let reconcileStarted = false;
    const supervisor = new SetupSupervisor({
      pollMs: 0,
      recoveryRequired: () => false,
      reconcile: async () => {
        reconcileStarted = true;
        await reconcileGate.promise;
      },
      tick: async () => {},
      abortInFlight: () => {},
    });

    const start = supervisor.start();
    expect(supervisor.health().state).toBe("starting");
    expect(() => supervisor.assertCreateAllowed()).toThrow(/unavailable/);
    await waitUntil(() => reconcileStarted);
    let shutdownCompleted = false;
    const shutdown = supervisor.shutdown().then(() => {
      shutdownCompleted = true;
    });
    await Promise.resolve();
    expect(shutdownCompleted).toBe(false);
    reconcileGate.resolve();
    await expect(start).rejects.toThrow(/unavailable/);
    await shutdown;
    expect(supervisor.health().state).toBe("stopped");
  });
});
