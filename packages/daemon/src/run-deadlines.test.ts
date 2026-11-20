/**
 * run-deadline/1 at the scheduler: contract trials 1, 2, 5, 6, 7 and 9 and the
 * review round's acceptance, durability and ownership cases. These run an
 * in-process DaemonServer through its local client (no socket, no warden
 * process unless a test injects one); real wardens are proven in
 * `run-deadline-process.test.ts`.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DaemonLocalClient } from "./daemon-local-client.js";
import { RunDeadlines, systemDeadlineClock, type RunDeadlineClock } from "./run-deadlines.js";
import { RUN_DEADLINE_STOP_GRACE_SEC } from "./run-deadline-warden.js";
import { DaemonServer, type JobRecord, type RunnerFn } from "./server.js";
import { DurableJournal } from "./store/test-support/fixtures/legacy/journal/index.js";
import { CommandStore } from "./store/test-support/fixtures/legacy/daemon/command-store.js";
import { legacyCommandFixture } from "./store/test-support/legacy-command-fixture.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
const temp = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "d-rdl-")));
  dirs.push(dir);
  return dir;
};

const CAPS = {
  max_concurrent: 1,
  max_concurrent_non_model_jobs: 1,
  max_concurrent_model_operations: 1,
  max_parallel_candidates: 1,
  max_deep_scan_width: 1,
  max_council_members: 2,
};

function daemon(
  runner: RunnerFn,
  opts: {
    dir?: string;
    clock?: RunDeadlineClock;
    deadlineDir?: string;
    onTurnEnqueueFailed?: (turnId: string, problem: unknown) => void;
  } = {},
) {
  const dir = opts.dir ?? temp();
  const journal = new DurableJournal({ rootDir: join(dir, "journal"), partition: "global" });
  const store = new CommandStore(journal);
  store.recoverAfterStartup();
  const server = new DaemonServer({
    socketPath: join(dir, "unused.sock"),
    token: "token",
    commands: legacyCommandFixture({ current: () => store }),
    runtimeConcurrencyCaps: CAPS,
    runDeadlines: {
      ...(opts.clock ? { clock: opts.clock } : {}),
      ...(opts.deadlineDir ? { dir: opts.deadlineDir, spawnWarden: async () => ({ pid: 1 }) } : {}),
    },
    ...(opts.onTurnEnqueueFailed ? { onTurnEnqueueFailed: opts.onTurnEnqueueFailed } : {}),
    runner,
  });
  const client = new DaemonLocalClient(() => server);
  return {
    dir,
    server,
    client,
    store,
    async close() {
      await server.stop();
      journal.close();
    },
  };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`condition not met: ${JSON.stringify(value)}`);
    await sleep(20);
  }
}

const live = (record: { state: string }) => record.state === "queued" || record.state === "running";
const errorCode = async (work: Promise<unknown>) =>
  work.then(
    () => "resolved",
    (error: { code?: string }) => error.code,
  );

/** A runner that holds its slot until released; it records which jobs it ran. */
function slotRunner() {
  const ran: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const runner: RunnerFn = async (params, ctx) => {
    ran.push((params as { label: string }).label);
    if ((params as { label: string }).label === "blocker")
      await Promise.race([
        gate,
        new Promise<void>((resolve) =>
          ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
    else
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) resolve();
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        setTimeout(resolve, 300);
      });
    return { lifecycle: ctx.signal.aborted ? "cancelled" : "succeeded" };
  };
  return { ran, runner, release: () => release() };
}

/** A clock whose host reading can be pushed forward (a late timer, a suspend). */
function steppedClock() {
  const system = systemDeadlineClock();
  let hostOffset = 0n;
  let wallOffset = 0;
  let jumpAfterRead = 0n;
  const clock: RunDeadlineClock = {
    ...system,
    hostNow: () => {
      const value = system.hostNow() + hostOffset;
      hostOffset += jumpAfterRead;
      jumpAfterRead = 0n;
      return value;
    },
    wallNow: () => Date.now() + wallOffset,
  };
  return {
    clock,
    advanceHost: (ms: number) => (hostOffset += BigInt(ms) * 1_000_000n),
    /** The next host reading is the present one; every later one is `ms` ahead. */
    advanceHostAfterNextRead: (ms: number) => (jumpAfterRead = BigInt(ms) * 1_000_000n),
    stepWall: (ms: number) => (wallOffset += ms),
  };
}

describe("run-deadline/1 at the scheduler", () => {
  it("trial 1: a queued start whose answer was lost never starts after its deadline", async () => {
    const slot = slotRunner();
    const d = daemon(slot.runner);
    try {
      await d.client.enqueue({ label: "blocker" }, { idempotencyKey: "b", clientId: "t" });
      const request = { label: "late", deadline: { at: inMs(400) } };
      // The caller never reads this answer ("lost"); it finds the run by its key.
      void d.client.enqueue(request, { idempotencyKey: "lost", clientId: "t" });
      const found = (await until(
        () => d.client.findAccepted(request, { idempotencyKey: "lost", clientId: "t" }),
        (value) => value !== null,
      )) as JobRecord;
      expect(found.state).toBe("queued");
      const read = await d.client.runDeadline(found.id, { action: "read" });
      expect(read).toMatchObject({ at: request.deadline.at, revision: 0, state: "armed" });
      expect(Date.parse(read.serverNow)).toBeGreaterThan(0);
      expect(read.stopGraceSec).toBe(RUN_DEADLINE_STOP_GRACE_SEC);
      const ended = await until(
        () => d.client.status(found.id),
        (record) => !live(record),
      );
      expect(ended).toMatchObject({ state: "cancelled", errorCode: "run_deadline_expired" });
      slot.release();
      await sleep(200);
      expect(slot.ran).toEqual(["blocker"]);
      expect(await d.client.runDeadline(found.id, { action: "read" })).toMatchObject({
        state: "expired",
      });
    } finally {
      slot.release();
      await d.close();
    }
  });

  it("trial 2: preparation longer than the deadline never launches", async () => {
    let launched = false;
    const d = daemon(async (_params, ctx) => {
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        setTimeout(resolve, 5_000);
      });
      if (!ctx.signal.aborted) launched = true;
      return { lifecycle: ctx.signal.aborted ? "cancelled" : "succeeded" };
    });
    try {
      const accepted = await d.client.enqueue(
        { label: "prep", deadline: { at: inMs(300) } },
        { idempotencyKey: "p", clientId: "t" },
      );
      const ended = await until(
        () => d.client.status(accepted.id),
        (record) => !live(record),
      );
      expect(ended.state).toBe("cancelled");
      expect(launched).toBe(false);
      expect(await d.client.runDeadline(accepted.id, { action: "read" })).toMatchObject({
        state: "expired",
      });
    } finally {
      await d.close();
    }
  });

  it("refuses a start whose deadline already passed and accepts nothing", async () => {
    const d = daemon(async () => ({ lifecycle: "succeeded" }));
    try {
      const request = { label: "past", deadline: { at: inMs(-1_000) } };
      expect(
        await errorCode(d.client.enqueue(request, { idempotencyKey: "x", clientId: "t" })),
      ).toBe("run_deadline_passed");
      expect(await d.client.findAccepted(request, { idempotencyKey: "x", clientId: "t" })).toBe(
        null,
      );
    } finally {
      await d.close();
    }
  });

  it("item 1: a deadline passing right after the commit expires through the queue, and a replay returns the receipt", async () => {
    const slot = slotRunner();
    const time = steppedClock();
    const d = daemon(slot.runner, { clock: time.clock });
    try {
      await d.client.enqueue({ label: "blocker" }, { idempotencyKey: "b", clientId: "t" });
      const request = { label: "edge", deadline: { at: inMs(5_000) } };
      // The commit converts the instant (one host reading); every later reading
      // is past it, as if the host stalled right after the commit.
      time.advanceHostAfterNextRead(10_000);
      const receipt = await d.client.enqueue(request, { idempotencyKey: "k", clientId: "t" });
      const ended = await until(
        () => d.client.status(receipt.id),
        (record) => !live(record),
      );
      expect(ended).toMatchObject({ state: "cancelled", errorCode: "run_deadline_expired" });
      expect(await d.client.enqueue(request, { idempotencyKey: "k", clientId: "t" })).toMatchObject(
        { id: receipt.id, reused: true },
      );
      slot.release();
      await sleep(100);
      expect(slot.ran).toEqual(["blocker"]);
    } finally {
      slot.release();
      await d.close();
    }
  });

  it("trial 5: a stale revision is a conflict and the deadline stays", async () => {
    const slot = slotRunner();
    const d = daemon(slot.runner, { deadlineDir: join(temp(), "deadlines") });
    try {
      await d.client.enqueue({ label: "blocker" }, { idempotencyKey: "b", clientId: "t" });
      const accepted = await d.client.enqueue(
        { label: "q", deadline: { at: inMs(60_000) } },
        { idempotencyKey: "q", clientId: "t" },
      );
      const moved = await d.client.runDeadline(accepted.id, {
        action: "set",
        at: inMs(90_000),
        expectedRevision: 0,
      });
      expect(moved.revision).toBe(1);
      expect(
        await errorCode(
          d.client.runDeadline(accepted.id, { action: "set", at: inMs(120_000), expectedRevision: 0 }),
        ),
      ).toBe("run_deadline_revision_conflict");
      expect(await d.client.runDeadline(accepted.id, { action: "read" })).toMatchObject({
        at: moved.at,
        revision: 1,
      });
    } finally {
      slot.release();
      await d.close();
    }
  });

  it("trial 6: a run queued longer than one period starts when renewed and expires when not", async () => {
    const slot = slotRunner();
    const d = daemon(slot.runner);
    const period = 400;
    try {
      await d.client.enqueue({ label: "blocker" }, { idempotencyKey: "b", clientId: "t" });
      const renewed = await d.client.enqueue(
        { label: "renewed", deadline: { at: inMs(period) } },
        { idempotencyKey: "r", clientId: "t" },
      );
      const abandoned = await d.client.enqueue(
        { label: "abandoned", deadline: { at: inMs(period) } },
        { idempotencyKey: "a", clientId: "t" },
      );
      let revision = 0;
      for (let i = 0; i < 6; i += 1) {
        const next = await d.client.runDeadline(renewed.id, {
          action: "set",
          at: inMs(period),
          expectedRevision: revision,
        });
        revision = next.revision;
        await sleep(period / 2);
      }
      expect(await d.client.status(abandoned.id)).toMatchObject({
        state: "cancelled",
        errorCode: "run_deadline_expired",
      });
      expect(await d.client.status(renewed.id)).toMatchObject({ state: "queued" });
      await d.client.runDeadline(renewed.id, { action: "set", at: inMs(30_000), expectedRevision: revision });
      slot.release();
      const ended = await until(
        () => d.client.status(renewed.id),
        (record) => !live(record),
      );
      expect(ended.state).toBe("succeeded");
      expect(slot.ran).toEqual(["blocker", "renewed"]);
    } finally {
      slot.release();
      await d.close();
    }
  });

  it("trial 7: changing a finished run's deadline is refused, typed; one without a deadline is absent", async () => {
    const d = daemon(async () => ({ lifecycle: "succeeded" }));
    try {
      const accepted = await d.client.enqueue(
        { label: "done", deadline: { at: inMs(60_000) } },
        { idempotencyKey: "d", clientId: "t" },
      );
      const plain = await d.client.enqueue({ label: "plain" }, { idempotencyKey: "n", clientId: "t" });
      for (const id of [accepted.id, plain.id])
        await until(
          () => d.client.status(id),
          (record) => !live(record),
        );
      expect(
        await errorCode(
          d.client.runDeadline(accepted.id, { action: "set", at: inMs(90_000), expectedRevision: 0 }),
        ),
      ).toBe("run_deadline_closed");
      expect(await d.client.runDeadline(accepted.id, { action: "read" })).toMatchObject({
        state: "closed",
        revision: 0,
      });
      expect(
        await errorCode(
          d.client.runDeadline(plain.id, { action: "set", at: inMs(90_000), expectedRevision: 0 }),
        ),
      ).toBe("run_deadline_absent");
    } finally {
      await d.close();
    }
  });

  it("item 6: a set after the deadline passed, before the timer fired, expires the run and refuses", async () => {
    const slot = slotRunner();
    const time = steppedClock();
    const d = daemon(slot.runner, { clock: time.clock });
    try {
      await d.client.enqueue({ label: "blocker" }, { idempotencyKey: "b", clientId: "t" });
      const accepted = await d.client.enqueue(
        { label: "late", deadline: { at: inMs(5_000) } },
        { idempotencyKey: "l", clientId: "t" },
      );
      time.advanceHost(6_000); // past the target; the 1 s timer has not looked yet
      expect(
        await errorCode(
          d.client.runDeadline(accepted.id, { action: "set", at: inMs(60_000), expectedRevision: 0 }),
        ),
      ).toBe("run_deadline_expired");
      expect(await d.client.status(accepted.id)).toMatchObject({
        state: "cancelled",
        errorCode: "run_deadline_expired",
      });
    } finally {
      slot.release();
      await d.close();
    }
  });

  it("item 6: a job whose deadline passed while queued never starts when its slot frees", async () => {
    const slot = slotRunner();
    const time = steppedClock();
    const d = daemon(slot.runner, { clock: time.clock });
    try {
      await d.client.enqueue({ label: "blocker" }, { idempotencyKey: "b", clientId: "t" });
      const accepted = await d.client.enqueue(
        { label: "late", deadline: { at: inMs(5_000) } },
        { idempotencyKey: "l", clientId: "t" },
      );
      time.advanceHost(6_000);
      slot.release(); // the slot frees before the entry's own timer looks
      const ended = await until(
        () => d.client.status(accepted.id),
        (record) => !live(record),
      );
      expect(ended).toMatchObject({ state: "cancelled", errorCode: "run_deadline_expired" });
      expect(slot.ran).toEqual(["blocker"]);
    } finally {
      slot.release();
      await d.close();
    }
  });

  it("trial 9: a backwards wall-clock step does not postpone the stop", async () => {
    const time = steppedClock();
    const d = daemon(
      async (_params, ctx) => {
        await new Promise<void>((resolve) =>
          ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return { lifecycle: "cancelled" };
      },
      { clock: time.clock },
    );
    try {
      const at = inMs(600);
      const accepted = await d.client.enqueue(
        { label: "clock", deadline: { at } },
        { idempotencyKey: "c", clientId: "t" },
      );
      time.stepWall(-3_600_000); // the server clock jumps one hour back
      const read = await d.client.runDeadline(accepted.id, { action: "read" });
      expect(Date.parse(read.serverNow)).toBeLessThan(Date.parse(at) - 3_000_000);
      expect(read.at).toBe(at);
      const ended = await until(
        () => d.client.status(accepted.id),
        (record) => !live(record),
        5_000,
      );
      expect(ended.state).toBe("cancelled");
      expect(Date.now()).toBeLessThan(Date.parse(at) + 2_000);
    } finally {
      await d.close();
    }
  });

  it("item 2: after a restart the replayed receipt and the deadline read answer from the durable record", async () => {
    const slot = slotRunner();
    const dir = temp();
    const deadlineDir = join(dir, "deadlines");
    const a = daemon(slot.runner, { dir, deadlineDir });
    await a.client.enqueue({ label: "blocker" }, { idempotencyKey: "b", clientId: "t" });
    const request = { label: "remote", deadline: { at: inMs(600_000) } };
    const accepted = await a.client.enqueue(request, { idempotencyKey: "k", clientId: "t" });
    const moved = await a.client.runDeadline(accepted.id, {
      action: "set",
      at: inMs(900_000),
      expectedRevision: 0,
    });
    const untouched = await a.client.enqueue(
      { label: "rev0", deadline: { at: inMs(700_000) } },
      { idempotencyKey: "r0", clientId: "t" },
    );
    await a.close();

    const b = daemon(async () => ({ lifecycle: "succeeded" }), { dir, deadlineDir });
    try {
      expect(await b.client.findAccepted(request, { idempotencyKey: "k", clientId: "t" })).toMatchObject({
        id: accepted.id,
        state: "interrupted",
      });
      expect(await b.client.runDeadline(accepted.id, { action: "read" })).toMatchObject({
        at: moved.at,
        revision: 1,
        state: "closed",
      });
      expect(await b.client.runDeadline(untouched.id, { action: "read" })).toMatchObject({
        revision: 0,
        state: "closed",
      });
      expect(
        await errorCode(
          b.client.runDeadline(accepted.id, { action: "set", at: inMs(999_000), expectedRevision: 1 }),
        ),
      ).toBe("run_deadline_closed");
    } finally {
      await b.close();
    }
  });

  it("item 7: a revision whose durable write failed is not confirmed", async () => {
    const slot = slotRunner();
    const deadlineDir = join(temp(), "deadlines");
    const d = daemon(slot.runner, { deadlineDir });
    try {
      await d.client.enqueue({ label: "blocker" }, { idempotencyKey: "b", clientId: "t" });
      const accepted = await d.client.enqueue(
        { label: "q", deadline: { at: inMs(60_000) } },
        { idempotencyKey: "q", clientId: "t" },
      );
      chmodSync(deadlineDir, 0o500); // the write cannot land
      try {
        expect(
          await errorCode(
            d.client.runDeadline(accepted.id, { action: "set", at: inMs(90_000), expectedRevision: 0 }),
          ),
        ).not.toBe("resolved");
      } finally {
        chmodSync(deadlineDir, 0o700);
      }
      expect(await d.client.runDeadline(accepted.id, { action: "read" })).toMatchObject({
        revision: 0,
      });
    } finally {
      slot.release();
      await d.close();
    }
  });

  it("item 3: a queued thread turn its deadline ended records the reason on the turn", async () => {
    const slot = slotRunner();
    const turns: Array<{ turnId: string; problem: unknown }> = [];
    const d = daemon(slot.runner, { onTurnEnqueueFailed: (turnId, problem) => turns.push({ turnId, problem }) });
    try {
      await d.client.enqueue({ label: "blocker" }, { idempotencyKey: "b", clientId: "t" });
      const accepted = await d.client.enqueue(
        { label: "turn", turnId: "turn-1", deadline: { at: inMs(300) } },
        { idempotencyKey: "t1", clientId: "t" },
      );
      await until(
        () => d.client.status(accepted.id),
        (record) => !live(record),
      );
      expect(turns).toEqual([
        { turnId: "turn-1", problem: expect.objectContaining({ code: "run_deadline_expired", retryable: false }) },
      ]);
    } finally {
      slot.release();
      await d.close();
    }
  });

  it("item 5: a continuation without its own deadline inherits the predecessor's, and is refused once it passed", async () => {
    const time = steppedClock();
    const d = daemon(
      async (_params, ctx) => {
        ctx.onRunStart({ runId: `run-${ctx.jobId}`, taskId: "t", runDir: "/tmp/none" });
        return { lifecycle: "succeeded" };
      },
      { clock: time.clock },
    );
    try {
      const finished = async (key: string) => {
        const accepted = await d.client.enqueue(
          { label: key, deadline: { at: inMs(60_000) } },
          { idempotencyKey: key, clientId: "t" },
        );
        return until(
          () => d.client.status(accepted.id),
          (record) => !live(record),
        );
      };
      const first = await finished("first");
      const successor = await d.client.enqueue(
        { label: "next", continueFrom: first.runId },
        { idempotencyKey: "s", clientId: "t" },
      );
      expect(await d.client.runDeadline(successor.id, { action: "read" })).toMatchObject({
        at: (await d.client.runDeadline(first.id, { action: "read" })).at,
      });
      const second = await finished("second");
      time.advanceHost(61_000);
      time.stepWall(61_000);
      expect(
        await errorCode(
          d.client.enqueue(
            { label: "late", continueFrom: second.runId },
            { idempotencyKey: "z", clientId: "t" },
          ),
        ),
      ).toBe("run_deadline_passed");
    } finally {
      await d.close();
    }
  });
});

describe("RunDeadlines registry", () => {
  const registry = (opts: Partial<ConstructorParameters<typeof RunDeadlines>[0]> = {}) =>
    new RunDeadlines({ onExpire: () => {}, ...opts });

  it("caps a Delegate child by its parent's current deadline and follows an extension", async () => {
    const deadlines = registry();
    try {
      deadlines.admit("parent", deadlines.toPoint(inMs(10_000)), null);
      deadlines.admit("child", deadlines.toPoint(inMs(60_000)), "parent");
      const parentAt = deadlines.snapshot("parent")!.at;
      expect(deadlines.snapshot("child")).toMatchObject({ at: parentAt, inheritedFrom: "parent" });
      const extended = await deadlines.set(
        "parent",
        { at: inMs(30_000), expectedRevision: 0 },
        { live: true, delegated: false },
      );
      expect(deadlines.snapshot("child")).toMatchObject({ at: extended.at, inheritedFrom: "parent" });
      await expect(
        deadlines.set("child", { at: inMs(20_000), expectedRevision: 0 }, { live: true, delegated: true }),
      ).rejects.toMatchObject({ code: "delegated_deadline_forbidden" });
    } finally {
      deadlines.dispose();
    }
  });

  it("item 9: a finished child keeps the deadline it ended under; the parent's removal breaks nothing", async () => {
    const deadlines = registry();
    try {
      deadlines.admit("parent", deadlines.toPoint(inMs(10_000)), null);
      deadlines.admit("child", null, "parent");
      const before = deadlines.snapshot("child")!;
      deadlines.close("child");
      await deadlines.set("parent", { at: inMs(30_000), expectedRevision: 0 }, { live: true, delegated: false });
      expect(deadlines.snapshot("child")).toMatchObject({
        at: before.at,
        inheritedFrom: "parent",
        state: "closed",
      });
      deadlines.forget("parent");
      expect(deadlines.snapshot("child")).toMatchObject({ at: before.at, state: "closed" });
    } finally {
      deadlines.dispose();
    }
  });

  it("item 6: a warden ready after the deadline refuses the launch", async () => {
    const dir = temp();
    const deadlines = registry({
      dir,
      spawnWarden: () => new Promise((resolve) => setTimeout(() => resolve({ pid: 1 }), 400)),
    });
    try {
      deadlines.admit("job", deadlines.toPoint(inMs(150)), null);
      await expect(
        deadlines.attachScope("job", `CLAUDEXOR_RUN_SCOPE_${"b".repeat(32)}`),
      ).rejects.toMatchObject({ code: "run_deadline_expired" });
      expect(deadlines.snapshot("job")?.state).toBe("expired");
    } finally {
      deadlines.dispose();
    }
  });

  it("item 12: declares the capability only on Linux after the boundary check, naming the boundary", async () => {
    const dir = temp();
    const linux = registry({
      dir,
      platform: "linux",
      clock: systemDeadlineClock("darwin"),
      probeBoundary: async () => ({ kind: "marker", reason: "test" }),
    });
    expect(linux.capabilities()).toEqual([]);
    await linux.prepare();
    expect(linux.capabilities()).toEqual([
      { name: "run-deadline/1", stopGraceSec: RUN_DEADLINE_STOP_GRACE_SEC, boundary: "marker" },
    ]);
    const cgroup = registry({
      dir,
      platform: "linux",
      clock: systemDeadlineClock("darwin"),
      probeBoundary: async () => ({ kind: "cgroup", runsDir: join(dir, "runs") }),
    });
    await cgroup.prepare();
    expect(cgroup.capabilities()[0]).toMatchObject({ boundary: "cgroup" });
    for (const platform of ["darwin", "win32"] as const) {
      const other = registry({ dir, platform, probeBoundary: async () => ({ kind: "marker", reason: "x" }) });
      await other.prepare();
      expect(other.capabilities()).toEqual([]);
    }
    mkdirSync(join(dir, "runs"), { recursive: true });
  });
});
