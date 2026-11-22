/**
 * run-deadline/1 at the scheduler: contract trials 1, 2, 5, 6, 7 and 9, and
 * the review rounds' cases around the one durable record (acceptance, sets,
 * the terminal, restarts, inheritance). These run an in-process DaemonServer
 * through its local client (no socket; the warden is a stub unless a test
 * runs one in-process); real wardens are proven in `run-deadline-process.test.ts`.
 */
import { existsSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DaemonLocalClient } from "./daemon-local-client.js";
import { systemDeadlineClock, type RunDeadlineClock } from "./run-deadline-clock.js";
import { RunDeadlines } from "./run-deadlines.js";
import { SchedulerDeadlines } from "./run-deadline-scheduler.js";
import {
  claimEnforcement,
  fileRecordIo,
  governingBound,
  diskReader,
  readRecord,
  writeJsonAtomic,
  type DeadlineRecord,
  type RecordIo,
} from "./run-deadline-record.js";
import { RUN_DEADLINE_STOP_GRACE_SEC, runWarden } from "./run-deadline-warden.js";
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

/** A deterministic write failure: the directory is replaced by a regular file. */
function failWrites(dir: string): () => void {
  const moved = `${dir}.moved`;
  renameSync(dir, moved);
  writeFileSync(dir, "not a directory");
  return () => {
    rmSync(dir, { force: true });
    renameSync(moved, dir);
  };
}

const CAPS = {
  max_concurrent: 1,
  max_concurrent_non_model_jobs: 1,
  max_concurrent_model_operations: 1,
  max_parallel_candidates: 1,
  max_deep_scan_width: 1,
  max_council_members: 2,
};

/** An in-process daemon that declares run-deadline/1 (as a proven Linux host would). */
async function daemon(
  runner: RunnerFn,
  opts: {
    dir?: string;
    clock?: RunDeadlineClock;
    deadlineDir?: string;
    platform?: NodeJS.Platform;
    io?: RecordIo;
    onTurnEnqueueFailed?: (turnId: string, problem: unknown) => void;
  } = {},
) {
  const dir = opts.dir ?? temp();
  const deadlineDir = opts.deadlineDir ?? join(dir, "deadlines");
  const journal = new DurableJournal({ rootDir: join(dir, "journal"), partition: "global" });
  const store = new CommandStore(journal);
  store.recoverAfterStartup();
  const server = new DaemonServer({
    socketPath: join(dir, "unused.sock"),
    token: "token",
    commands: legacyCommandFixture({ current: () => store }),
    runtimeConcurrencyCaps: CAPS,
    runDeadlines: {
      dir: deadlineDir,
      spawnWarden: async () => ({ pid: 1 }),
      platform: opts.platform ?? "linux",
      probeBoundary: async () => ({ kind: "marker", reason: "test" }),
      ...(opts.clock ? { clock: opts.clock } : {}),
      ...(opts.io ? { io: opts.io } : {}),
    },
    ...(opts.onTurnEnqueueFailed ? { onTurnEnqueueFailed: opts.onTurnEnqueueFailed } : {}),
    runner,
  });
  await server.deadlines.startup();
  const client = new DaemonLocalClient(() => server);
  return {
    dir,
    deadlineDir,
    server,
    client,
    store,
    record: (jobId: string) => readRecord(join(deadlineDir, `${jobId}.json`)) as DeadlineRecord,
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
const errorOf = async (work: Promise<unknown>) =>
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
function steppedClock(opts: { frozen?: boolean; bootId?: string } = {}) {
  const system = systemDeadlineClock();
  const hostBase = system.hostNow();
  const wallBase = Date.now();
  let hostOffset = 0n;
  let wallOffset = 0;
  const jumps: Array<{ afterReads: number; ns: bigint }> = [];
  let reads = 0;
  const clock: RunDeadlineClock = {
    ...system,
    bootId: () => opts.bootId ?? system.bootId(),
    hostNow: () => {
      reads += 1;
      // Frozen: only the test moves time (`advanceHost`), never the real clock.
      const value = (opts.frozen ? hostBase : system.hostNow()) + hostOffset;
      for (const jump of jumps.splice(0))
        if (reads >= jump.afterReads) hostOffset += jump.ns;
        else jumps.push(jump);
      return value;
    },
    wallNow: () => (opts.frozen ? wallBase : Date.now()) + wallOffset,
  };
  return {
    clock,
    advanceHost: (ms: number) => (hostOffset += BigInt(ms) * 1_000_000n),
    /** The next `n` host readings are the present; every later one is `ms` ahead. */
    advanceHostAfterReads: (n: number, ms: number) =>
      jumps.push({ afterReads: reads + n, ns: BigInt(ms) * 1_000_000n }),
    stepWall: (ms: number) => (wallOffset += ms),
  };
}

describe("run-deadline/1 at the scheduler", () => {
  it("trial 1: a queued start whose answer was lost never starts after its deadline", async () => {
    const slot = slotRunner();
    const d = await daemon(slot.runner);
    try {
      await d.client.enqueue({ label: "blocker" }, { idempotencyKey: "b", clientId: "t" });
      const request = { label: "late", deadline: { at: inMs(1_500) } };
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
      expect(ended).toMatchObject({
        state: "cancelled",
        errorCode: "run_deadline_expired",
        errorStatus: 409,
        errorRetryable: false,
      });
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

  it("trial 2: preparation longer than the deadline never launches; the stop is typed 409, not retryable", async () => {
    let launched = false;
    const turns: Array<{ turnId: string; problem: unknown }> = [];
    const d = await daemon(
      async (_params, ctx) => {
        // A thread worktree preparation: no run is bound yet when the stop comes.
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener("abort", () => resolve(), { once: true });
          setTimeout(resolve, 5_000);
        });
        if (ctx.signal.aborted) throw new Error("preparation cancelled");
        launched = true;
        return { lifecycle: "succeeded" };
      },
      { onTurnEnqueueFailed: (turnId, problem) => turns.push({ turnId, problem }) },
    );
    try {
      const accepted = await d.client.enqueue(
        { label: "prep", turnId: "turn-prep", deadline: { at: inMs(300) } },
        { idempotencyKey: "p", clientId: "t" },
      );
      const ended = await until(
        () => d.client.status(accepted.id),
        (record) => !live(record),
      );
      expect(ended).toMatchObject({
        state: "cancelled",
        errorCode: "run_deadline_expired",
        errorStatus: 409,
        errorRetryable: false,
      });
      expect(launched).toBe(false);
      expect(turns).toEqual([
        {
          turnId: "turn-prep",
          problem: expect.objectContaining({ code: "run_deadline_expired", retryable: false }),
        },
      ]);
      expect(await d.client.runDeadline(accepted.id, { action: "read" })).toMatchObject({
        state: "expired",
      });
    } finally {
      await d.close();
    }
  });

  it("refuses a start whose deadline already passed and accepts nothing", async () => {
    const d = await daemon(async () => ({ lifecycle: "succeeded" }));
    try {
      const request = { label: "past", deadline: { at: inMs(-1_000) } };
      expect(await errorOf(d.client.enqueue(request, { idempotencyKey: "x", clientId: "t" }))).toBe(
        "run_deadline_passed",
      );
      expect(await d.client.findAccepted(request, { idempotencyKey: "x", clientId: "t" })).toBe(
        null,
      );
    } finally {
      await d.close();
    }
  });

  it("refuses an explicit deadline where run-deadline/1 is not declared, before accepting anything", async () => {
    const d = await daemon(async () => ({ lifecycle: "succeeded" }), { platform: "win32" });
    try {
      expect(d.server.deadlines.capabilities()).toEqual([]);
      const request = { label: "remote", deadline: { at: inMs(60_000) } };
      expect(await errorOf(d.client.enqueue(request, { idempotencyKey: "w", clientId: "t" }))).toBe(
        "run_deadline_unsupported",
      );
      expect(await d.client.findAccepted(request, { idempotencyKey: "w", clientId: "t" })).toBe(
        null,
      );
      // Ordinary starts are unchanged.
      const plain = await d.client.enqueue(
        { label: "plain" },
        { idempotencyKey: "n", clientId: "t" },
      );
      expect(
        await until(
          () => d.client.status(plain.id),
          (record) => !live(record),
        ),
      ).toMatchObject({ state: "succeeded" });
    } finally {
      await d.close();
    }
  });

  it("item 1: a deadline passing right after the commit expires through the queue, and a replay returns the receipt", async () => {
    const slot = slotRunner();
    const time = steppedClock();
    const d = await daemon(slot.runner, { clock: time.clock });
    try {
      await d.client.enqueue({ label: "blocker" }, { idempotencyKey: "b", clientId: "t" });
      const request = { label: "edge", deadline: { at: inMs(5_000) } };
      // The acceptance converts the instant and judges it again at the commit
      // (two host readings); every later reading is past it, as if the host
      // stalled right after the commit.
      time.advanceHostAfterReads(2, 10_000);
      const receipt = await d.client.enqueue(request, { idempotencyKey: "k", clientId: "t" });
      const ended = await until(
        () => d.client.status(receipt.id),
        (record) => !live(record),
      );
      expect(ended).toMatchObject({ state: "cancelled", errorCode: "run_deadline_expired" });
      // The replay after the expiry returns the accepted job, not a fresh refusal.
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

  it("item C: a deadline that passed while its acceptance was being prepared refuses at the commit; the key stays free", async () => {
    const time = steppedClock();
    const d = await daemon(async () => ({ lifecycle: "succeeded" }), { clock: time.clock });
    try {
      const request = { label: "late", deadline: { at: inMs(5_000) } };
      // The instant is converted in the present; the commit's reading, after the
      // preparation's durable writes, is past it.
      time.advanceHostAfterReads(1, 10_000);
      expect(await errorOf(d.client.enqueue(request, { idempotencyKey: "k", clientId: "t" }))).toBe(
        "run_deadline_passed",
      );
      expect(await d.client.findAccepted(request, { idempotencyKey: "k", clientId: "t" })).toBe(
        null,
      );
      const { readdirSync } = await import("node:fs");
      expect(readdirSync(d.deadlineDir).filter((name) => name.endsWith(".json"))).toEqual([]);
    } finally {
      await d.close();
    }
  });

  it("trial 5: a stale revision is a conflict and the deadline stays", async () => {
    const slot = slotRunner();
    const d = await daemon(slot.runner);
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
        await errorOf(
          d.client.runDeadline(accepted.id, {
            action: "set",
            at: inMs(120_000),
            expectedRevision: 0,
          }),
        ),
      ).toBe("run_deadline_revision_conflict");
      expect(await d.client.runDeadline(accepted.id, { action: "read" })).toMatchObject({
        at: moved.at,
        revision: 1,
      });
      expect(d.record(accepted.id)).toMatchObject({ revision: 1, state: "armed" });
    } finally {
      slot.release();
      await d.close();
    }
  });

  it("trial 6: a run queued longer than one period starts when renewed and expires when not", async () => {
    // Virtual time: slow disks or a loaded host must not decide whether a renewal
    // arrived in time; the daemon reads only this clock.
    const slot = slotRunner();
    const time = steppedClock({ frozen: true });
    const d = await daemon(slot.runner, { clock: time.clock });
    const period = 1_000;
    const ahead = (ms: number) => new Date(time.clock.wallNow() + ms).toISOString();
    const advance = (ms: number) => {
      time.advanceHost(ms);
      time.stepWall(ms);
    };
    try {
      await d.client.enqueue({ label: "blocker" }, { idempotencyKey: "b", clientId: "t" });
      const renewed = await d.client.enqueue(
        { label: "renewed", deadline: { at: ahead(period) } },
        { idempotencyKey: "r", clientId: "t" },
      );
      const abandoned = await d.client.enqueue(
        { label: "abandoned", deadline: { at: ahead(period) } },
        { idempotencyKey: "a", clientId: "t" },
      );
      let revision = 0;
      for (let i = 0; i < 6; i += 1) {
        const next = await d.client.runDeadline(renewed.id, {
          action: "set",
          at: ahead(period),
          expectedRevision: revision,
        });
        revision = next.revision;
        advance(period / 2); // three periods in all: one renewal every half period
      }
      // The controller keeps renewing while the abandoned run's timer looks.
      await d.client.runDeadline(renewed.id, {
        action: "set",
        at: ahead(30_000),
        expectedRevision: revision,
      });
      expect(
        await until(
          () => d.client.status(abandoned.id),
          (record) => !live(record),
          3_000,
        ),
      ).toMatchObject({ state: "cancelled", errorCode: "run_deadline_expired" });
      expect(await d.client.status(renewed.id)).toMatchObject({ state: "queued" });
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
    const d = await daemon(async () => ({ lifecycle: "succeeded" }));
    try {
      const accepted = await d.client.enqueue(
        { label: "done", deadline: { at: inMs(60_000) } },
        { idempotencyKey: "d", clientId: "t" },
      );
      const plain = await d.client.enqueue(
        { label: "plain" },
        { idempotencyKey: "n", clientId: "t" },
      );
      for (const id of [accepted.id, plain.id])
        await until(
          () => d.client.status(id),
          (record) => !live(record),
        );
      expect(
        await errorOf(
          d.client.runDeadline(accepted.id, {
            action: "set",
            at: inMs(90_000),
            expectedRevision: 0,
          }),
        ),
      ).toBe("run_deadline_closed");
      expect(await d.client.runDeadline(accepted.id, { action: "read" })).toMatchObject({
        state: "closed",
        revision: 0,
      });
      expect(
        await errorOf(
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
    const d = await daemon(slot.runner, { clock: time.clock });
    try {
      await d.client.enqueue({ label: "blocker" }, { idempotencyKey: "b", clientId: "t" });
      const accepted = await d.client.enqueue(
        { label: "late", deadline: { at: inMs(5_000) } },
        { idempotencyKey: "l", clientId: "t" },
      );
      time.advanceHost(6_000); // past the target; the 1 s timer has not looked yet
      expect(
        await errorOf(
          d.client.runDeadline(accepted.id, {
            action: "set",
            at: inMs(60_000),
            expectedRevision: 0,
          }),
        ),
      ).toBe("run_deadline_expired");
      expect(
        await until(
          () => d.client.status(accepted.id),
          (record) => !live(record),
        ),
      ).toMatchObject({ state: "cancelled", errorCode: "run_deadline_expired" });
    } finally {
      slot.release();
      await d.close();
    }
  });

  it("item 6: a job whose deadline passed while queued never starts when its slot frees", async () => {
    const slot = slotRunner();
    const time = steppedClock();
    const d = await daemon(slot.runner, { clock: time.clock });
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
    const d = await daemon(
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
      // Seconds late at most on a loaded host, never the hour the clock stepped back.
      expect(Date.now()).toBeLessThan(Date.parse(at) + 10_000);
    } finally {
      await d.close();
    }
  });

  it("item 3: a queued thread turn its deadline ended records the reason on the turn", async () => {
    const slot = slotRunner();
    const turns: Array<{ turnId: string; problem: unknown }> = [];
    const d = await daemon(slot.runner, {
      onTurnEnqueueFailed: (turnId, problem) => turns.push({ turnId, problem }),
    });
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
        {
          turnId: "turn-1",
          problem: expect.objectContaining({ code: "run_deadline_expired", retryable: false }),
        },
      ]);
    } finally {
      slot.release();
      await d.close();
    }
  });
});

describe("run-deadline/1: one durable record", () => {
  it("every accepted deadline has its record before the receipt; a refused one leaves none", async () => {
    const slot = slotRunner();
    const d = await daemon(slot.runner);
    try {
      await d.client.enqueue({ label: "blocker" }, { idempotencyKey: "b", clientId: "t" });
      const request = { label: "q", deadline: { at: inMs(60_000) } };
      const accepted = await d.client.enqueue(request, { idempotencyKey: "q", clientId: "t" });
      expect(d.record(accepted.id)).toMatchObject({ state: "armed", revision: 0 });
      // A replay never stages a second record; nothing but the accepted one exists.
      expect(await d.client.enqueue(request, { idempotencyKey: "q", clientId: "t" })).toMatchObject(
        { id: accepted.id, reused: true },
      );
      await sleep(50);
      const { readdirSync } = await import("node:fs");
      expect(readdirSync(d.deadlineDir).filter((name) => name.endsWith(".json"))).toEqual([
        `${accepted.id}.json`,
      ]);
    } finally {
      slot.release();
      await d.close();
    }
  });

  it("Stop during a set: the terminal wins unless the set was published first; the answer, the live read and the record after a restart agree", async () => {
    for (const order of ["terminal-first", "before-decision", "after-publication"] as const) {
      const slot = slotRunner();
      let onPublish: (() => void) | null = null;
      const io: RecordIo = {
        ...fileRecordIo,
        publish: async (tmp, path) => {
          await fileRecordIo.publish(tmp, path);
          const hook = onPublish;
          onPublish = null;
          hook?.();
        },
      };
      const a = await daemon(slot.runner, { io });
      await a.client.enqueue({ label: "blocker" }, { idempotencyKey: "b", clientId: "t" });
      const accepted = await a.client.enqueue(
        { label: "q", deadline: { at: inMs(60_000) } },
        { idempotencyKey: "q", clientId: "t" },
      );
      const set = () =>
        a.server.deadlines
          .set(accepted.id, { at: inMs(90_000), expectedRevision: 0 }, { delegated: false })
          .then(
            (snapshot) => ({
              ok: true as const,
              revision: snapshot.revision,
              state: snapshot.state,
            }),
            (error: { code?: string }) => ({ ok: false as const, code: error.code }),
          );
      let answer: Awaited<ReturnType<typeof set>>;
      if (order === "terminal-first") {
        a.server.cancelJob(accepted.id);
        answer = await set();
      } else if (order === "before-decision") {
        // The terminal arrives while the new revision is staged, before the set decided.
        const pending = set();
        a.server.cancelJob(accepted.id);
        answer = await pending;
      } else {
        // The terminal arrives right after the new revision became visible.
        onPublish = () => a.server.cancelJob(accepted.id);
        answer = await set();
      }
      if (order === "after-publication")
        expect(answer).toEqual({ ok: true, revision: 1, state: "closed" });
      else expect(answer).toEqual({ ok: false, code: "run_deadline_closed" });
      const expected = answer.ok ? 1 : 0;
      expect(await a.client.runDeadline(accepted.id, { action: "read" })).toMatchObject({
        revision: expected,
        state: "closed",
      });
      expect(a.record(accepted.id)).toMatchObject({ revision: expected, state: "closed" });
      slot.release();
      await a.close();
      const b = await daemon(async () => ({ lifecycle: "succeeded" }), {
        dir: a.dir,
        deadlineDir: a.deadlineDir,
      });
      try {
        expect(await b.client.runDeadline(accepted.id, { action: "read" })).toMatchObject({
          revision: expected,
          state: "closed",
        });
      } finally {
        await b.close();
      }
    }
  });

  it("a set whose replaced deadline was reached during its publication is refused, and the record restores it as enforcing", async () => {
    const slot = slotRunner();
    const time = steppedClock();
    const d = await daemon(slot.runner, { clock: time.clock });
    try {
      await d.client.enqueue({ label: "blocker" }, { idempotencyKey: "b", clientId: "t" });
      const accepted = await d.client.enqueue(
        { label: "q", deadline: { at: inMs(5_000) } },
        { idempotencyKey: "q", clientId: "t" },
      );
      // The due check and the conversion read the present; the reading after the
      // durable publication is past the replaced deadline.
      time.advanceHostAfterReads(2, 6_000);
      expect(
        await errorOf(
          d.server.deadlines.set(
            accepted.id,
            { at: inMs(60_000), expectedRevision: 0 },
            { delegated: false },
          ),
        ),
      ).toBe("run_deadline_expired");
      expect(d.record(accepted.id)).toMatchObject({ revision: 0 });
      expect(["enforcing", "expired"]).toContain(d.record(accepted.id).state);
      expect(
        await until(
          () => d.client.status(accepted.id),
          (record) => !live(record),
        ),
      ).toMatchObject({ state: "cancelled", errorCode: "run_deadline_expired" });
      expect(await d.client.runDeadline(accepted.id, { action: "read" })).toMatchObject({
        state: "expired",
        revision: 0,
      });
    } finally {
      slot.release();
      await d.close();
    }
  });

  it("a set after the warden claimed enforcement is refused expired; the claim is folded into the record", async () => {
    const slot = slotRunner();
    const d = await daemon(slot.runner);
    try {
      await d.client.enqueue({ label: "blocker" }, { idempotencyKey: "b", clientId: "t" });
      const accepted = await d.client.enqueue(
        { label: "q", deadline: { at: inMs(60_000) } },
        { idempotencyKey: "q", clientId: "t" },
      );
      claimEnforcement(join(d.deadlineDir, `${accepted.id}.json`), {
        revision: 0,
        at: inMs(0),
        targetNs: "0",
        by: "warden",
      });
      expect(
        await errorOf(
          d.client.runDeadline(accepted.id, {
            action: "set",
            at: inMs(90_000),
            expectedRevision: 0,
          }),
        ),
      ).toBe("run_deadline_expired");
      expect(d.record(accepted.id)).toMatchObject({ revision: 0 });
      expect(
        await until(
          () => d.client.status(accepted.id),
          (record) => !live(record),
        ),
      ).toMatchObject({ state: "cancelled", errorCode: "run_deadline_expired", errorStatus: 409 });
      expect(await d.client.runDeadline(accepted.id, { action: "read" })).toMatchObject({
        state: "expired",
      });
    } finally {
      slot.release();
      await d.close();
    }
  });

  it("a running job its deadline stopped reads expired, also after a restart", async () => {
    let reason: unknown;
    const a = await daemon(async (_params, ctx) => {
      ctx.onRunStart({ runId: `run-${ctx.jobId}`, taskId: "t", runDir: "/tmp/none" });
      await new Promise<void>((resolve) =>
        ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      reason = ctx.signal.reason;
      return { lifecycle: "cancelled" };
    });
    const accepted = await a.client.enqueue(
      { label: "run", deadline: { at: inMs(400) } },
      { idempotencyKey: "r", clientId: "t" },
    );
    await until(
      () => a.client.status(accepted.id),
      (record) => !live(record),
    );
    expect(reason).toBe("run_deadline_expired");
    expect(await a.client.runDeadline(accepted.id, { action: "read" })).toMatchObject({
      state: "expired",
    });
    await a.close();
    const b = await daemon(async () => ({ lifecycle: "succeeded" }), {
      dir: a.dir,
      deadlineDir: a.deadlineDir,
    });
    try {
      expect(await b.client.runDeadline(accepted.id, { action: "read" })).toMatchObject({
        state: "expired",
      });
    } finally {
      await b.close();
    }
  });

  it("after a restart a retained continuation's inherited deadline reads from its record, with its origin", async () => {
    const slot = slotRunner();
    const a = await daemon(async (params, ctx) => {
      ctx.onRunStart({ runId: `run-${ctx.jobId}`, taskId: "t", runDir: "/tmp/none" });
      return (params as { label: string }).label === "first"
        ? { lifecycle: "succeeded" }
        : slot.runner(params, ctx);
    });
    const first = await a.client.enqueue(
      { label: "first", deadline: { at: inMs(600_000) } },
      { idempotencyKey: "p", clientId: "t" },
    );
    const done = await until(
      () => a.client.status(first.id),
      (record) => !live(record),
    );
    await a.client.enqueue({ label: "blocker" }, { idempotencyKey: "b", clientId: "t" });
    // Queued behind the blocker, with no deadline of its own.
    const next = await a.client.enqueue(
      { label: "next", continueFrom: done.runId },
      { idempotencyKey: "s", clientId: "t" },
    );
    const before = await a.client.runDeadline(next.id, { action: "read" });
    expect(before).toMatchObject({ successorOf: first.id, inheritedFrom: null, revision: 0 });
    await a.close(); // the continuation is still queued
    slot.release();
    const b = await daemon(async () => ({ lifecycle: "succeeded" }), {
      dir: a.dir,
      deadlineDir: a.deadlineDir,
    });
    try {
      expect(await b.client.runDeadline(next.id, { action: "read" })).toMatchObject({
        at: before.at,
        successorOf: first.id,
        state: "closed",
      });
    } finally {
      await b.close();
    }
  });

  it("a continuation takes its predecessor's host-clock target, unmoved by a backwards wall step across a restart", async () => {
    const time = steppedClock({ bootId: "boot-1" });
    const ran = async (_params: unknown, ctx: Parameters<RunnerFn>[1]) => {
      ctx.onRunStart({ runId: `run-${ctx.jobId}`, taskId: "t", runDir: "/tmp/none" });
      return { lifecycle: "succeeded" };
    };
    const a = await daemon(ran, { clock: time.clock });
    const first = await a.client.enqueue(
      { label: "first", deadline: { at: inMs(60_000) } },
      { idempotencyKey: "p", clientId: "t" },
    );
    const done = await until(
      () => a.client.status(first.id),
      (record) => !live(record),
    );
    // A read runs after the job's pending transitions: the terminal is written.
    expect(await a.client.runDeadline(first.id, { action: "read" })).toMatchObject({
      state: "closed",
    });
    const target = BigInt(a.record(first.id).frozen!.targetNs);
    await a.close();
    // Same boot: the restart follows a one-hour backwards wall step.
    time.stepWall(-3_600_000);
    const b = await daemon(ran, { dir: a.dir, deadlineDir: a.deadlineDir, clock: time.clock });
    try {
      const next = await b.client.enqueue(
        { label: "next", continueFrom: done.runId },
        { idempotencyKey: "s", clientId: "t" },
      );
      expect(b.record(next.id)).toMatchObject({ successorOf: first.id });
      expect(BigInt(b.record(next.id).own!.targetNs)).toBe(target);
      // Once the host clock passes it, the spent authority refuses at the
      // commit, whatever the wall says (the wall is an hour behind here).
      time.advanceHost(61_000);
      const late = { label: "late", continueFrom: done.runId };
      await b.server.deadlines.prepare("job-late", late);
      expect(() => b.server.deadlines.reserve("job-late", late)).toThrow(
        expect.objectContaining({ code: "run_deadline_passed" }),
      );
    } finally {
      await b.close();
    }
  });

  it("an engine-started successor inherits its predecessor's deadline, and expires before it starts once that passed", async () => {
    const time = steppedClock();
    const d = await daemon(
      async (_params, ctx) => {
        ctx.onRunStart({ runId: `run-${ctx.jobId}`, taskId: "t", runDir: "/tmp/none" });
        return { lifecycle: "succeeded" };
      },
      { clock: time.clock },
    );
    try {
      const predecessor = await d.client.enqueue(
        { label: "first", deadline: { at: inMs(60_000) } },
        { idempotencyKey: "p", clientId: "t" },
      );
      const done = await until(
        () => d.client.status(predecessor.id),
        (record) => !live(record),
      );
      const at = (await d.client.runDeadline(predecessor.id, { action: "read" })).at;
      const params = { label: "next", continueFrom: done.runId };
      await d.server.deadlines.prepareSuccessor("job-next-1", params);
      expect(d.record("job-next-1")).toMatchObject({ successorOf: predecessor.id, state: "armed" });
      expect(d.record("job-next-1").own!.at).toBe(at);
      time.advanceHost(61_000);
      time.stepWall(61_000);
      await d.server.deadlines.prepareSuccessor("job-next-2", params);
      const spent = d.record("job-next-2");
      expect(BigInt(spent.own!.targetNs)).toBeLessThanOrEqual(time.clock.hostNow());
    } finally {
      await d.close();
    }
  });

  it("startup reconciles an earlier generation's records explicitly: a passed deadline of an interrupted job expired, else closed", async () => {
    const slot = slotRunner();
    const time = steppedClock();
    const a = await daemon(slot.runner, { clock: time.clock });
    await a.client.enqueue({ label: "blocker" }, { idempotencyKey: "b", clientId: "t" });
    const soon = await a.client.enqueue(
      { label: "soon", deadline: { at: inMs(60_000) } },
      { idempotencyKey: "s", clientId: "t" },
    );
    const later = await a.client.enqueue(
      { label: "later", deadline: { at: inMs(600_000) } },
      { idempotencyKey: "l", clientId: "t" },
    );
    // The daemon stops with both still queued: their records stay armed, and
    // the next start finds the jobs interrupted.
    await a.close();
    slot.release();
    expect(a.record(soon.id).state).toBe("armed");
    expect(a.record(later.id).state).toBe("armed");
    time.advanceHost(61_000); // the daemon was down past the first deadline
    const b = await daemon(async () => ({ lifecycle: "succeeded" }), {
      dir: a.dir,
      deadlineDir: a.deadlineDir,
      clock: time.clock,
    });
    try {
      expect(b.record(soon.id)).toMatchObject({ state: "expired" });
      expect(b.record(later.id)).toMatchObject({ state: "closed" });
      expect(b.record(later.id).frozen).not.toBeNull();
    } finally {
      await b.close();
    }
  });

  it("a set whose durable write failed is not confirmed, and the record is unchanged", async () => {
    const slot = slotRunner();
    const d = await daemon(slot.runner);
    try {
      await d.client.enqueue({ label: "blocker" }, { idempotencyKey: "b", clientId: "t" });
      const accepted = await d.client.enqueue(
        { label: "q", deadline: { at: inMs(60_000) } },
        { idempotencyKey: "q", clientId: "t" },
      );
      const restore = failWrites(d.deadlineDir);
      try {
        expect(
          await errorOf(
            d.client.runDeadline(accepted.id, {
              action: "set",
              at: inMs(90_000),
              expectedRevision: 0,
            }),
          ),
        ).toBe("run_deadline_record_unavailable");
      } finally {
        restore();
      }
      expect(await d.client.runDeadline(accepted.id, { action: "read" })).toMatchObject({
        revision: 0,
      });
      expect(d.record(accepted.id)).toMatchObject({ revision: 0 });
    } finally {
      slot.release();
      await d.close();
    }
  });

  it("an acceptance whose record cannot be written is refused, retryable, and nothing is accepted", async () => {
    const d = await daemon(async () => ({ lifecycle: "succeeded" }));
    try {
      const request = { label: "q", deadline: { at: inMs(60_000) } };
      const restore = failWrites(d.deadlineDir);
      try {
        expect(
          await errorOf(d.client.enqueue(request, { idempotencyKey: "q", clientId: "t" })),
        ).toBe("run_deadline_record_unavailable");
      } finally {
        restore();
      }
      expect(await d.client.findAccepted(request, { idempotencyKey: "q", clientId: "t" })).toBe(
        null,
      );
    } finally {
      await d.close();
    }
  });
});

describe("RunDeadlines registry: Delegate children", () => {
  const registry = (
    dir: string,
    opts: Partial<ConstructorParameters<typeof RunDeadlines>[0]> = {},
  ) =>
    new RunDeadlines({ dir, spawnWarden: async () => ({ pid: 1 }), onExpire: () => {}, ...opts });
  const hold = async (
    deadlines: RunDeadlines,
    jobId: string,
    own: string | null,
    parentJobId: string | null = null,
  ) => {
    await deadlines.stage(jobId, {
      own: own ? deadlines.toPoint(own) : null,
      successorOf: null,
      parentJobId,
    });
    deadlines.admit(jobId);
  };

  it("caps a child by its parent's current deadline and follows an extension", async () => {
    const dir = temp();
    const deadlines = registry(dir);
    try {
      await hold(deadlines, "parent", inMs(10_000));
      await hold(deadlines, "child", inMs(60_000), "parent");
      const parentAt = (await deadlines.read("parent"))!.at;
      expect(await deadlines.read("child")).toMatchObject({
        at: parentAt,
        inheritedFrom: "parent",
      });
      const extended = await deadlines.set(
        "parent",
        { at: inMs(30_000), expectedRevision: 0 },
        { delegated: false },
      );
      expect(await deadlines.read("child")).toMatchObject({
        at: extended.at,
        inheritedFrom: "parent",
      });
      await expect(
        deadlines.set("child", { at: inMs(20_000), expectedRevision: 0 }, { delegated: true }),
      ).rejects.toMatchObject({ code: "delegated_deadline_forbidden" });
    } finally {
      await deadlines.dispose();
    }
  });

  it("a child's inherited deadline is durable from acceptance: a later daemon reads it with its origin", async () => {
    const dir = temp();
    const a = registry(dir);
    await hold(a, "parent", inMs(60_000));
    await hold(a, "child", null, "parent"); // queued: no scope attached yet
    const at = (await a.read("child"))!.at;
    await a.dispose();
    const b = registry(dir);
    expect(b.durableSnapshot("child")).toMatchObject({ at, inheritedFrom: "parent", revision: 0 });
  });

  it("after the parent shortened, a later daemon reports the child's deadline its warden obeys", async () => {
    const dir = temp();
    const a = registry(dir);
    await hold(a, "parent", inMs(120_000));
    await hold(a, "child", null, "parent");
    const shortened = await a.set(
      "parent",
      { at: inMs(60_000), expectedRevision: 0 },
      { delegated: false },
    );
    await a.dispose();
    const b = registry(dir);
    const child = readRecord(join(dir, "child.json")) as DeadlineRecord;
    const warden = governingBound(child, diskReader(dir))!;
    expect(b.durableSnapshot("child")).toMatchObject({
      at: shortened.at,
      inheritedFrom: "parent",
    });
    expect(warden.at).toBe(shortened.at);
  });

  it("a finished child keeps the deadline it ended under; its survivors stay capped by the parent's current one", async () => {
    const dir = temp();
    const deadlines = registry(dir);
    try {
      await hold(deadlines, "parent", inMs(3_600_000));
      await hold(deadlines, "child", null, "parent");
      const before = (await deadlines.read("child"))!;
      deadlines.close("child");
      const shortened = await deadlines.set(
        "parent",
        { at: inMs(30_000), expectedRevision: 0 },
        { delegated: false },
      );
      expect(await deadlines.read("child")).toMatchObject({
        at: before.at,
        inheritedFrom: "parent",
        state: "closed",
      });
      // What the closed child's warden obeys for its surviving processes.
      const child = readRecord(join(dir, "child.json")) as DeadlineRecord;
      expect(governingBound(child, diskReader(dir))!.at).toBe(shortened.at);
      deadlines.forget("parent");
      expect(await deadlines.read("child")).toMatchObject({ at: before.at, state: "closed" });
    } finally {
      await deadlines.dispose();
    }
  });

  it("a parent revision whose write failed leaves the parent and every dependent warden on the old deadline", async () => {
    const dir = temp();
    const deadlines = registry(dir);
    try {
      const first = inMs(300_000);
      await hold(deadlines, "parent", first);
      await deadlines.attachScope("parent", `CLAUDEXOR_RUN_SCOPE_${"1".repeat(32)}`);
      await hold(deadlines, "child", null, "parent");
      await deadlines.attachScope("child", `CLAUDEXOR_RUN_SCOPE_${"2".repeat(32)}`);
      const restore = failWrites(dir);
      try {
        await expect(
          deadlines.set("parent", { at: inMs(120_000), expectedRevision: 0 }, { delegated: false }),
        ).rejects.toMatchObject({ code: "run_deadline_record_unavailable" });
      } finally {
        restore();
      }
      const firstAt = new Date(Date.parse(first)).toISOString();
      expect(await deadlines.read("parent")).toMatchObject({ at: firstAt, revision: 0 });
      expect(await deadlines.read("child")).toMatchObject({ at: firstAt, inheritedFrom: "parent" });
      const child = readRecord(join(dir, "child.json")) as DeadlineRecord;
      expect(governingBound(child, diskReader(dir))!.at).toBe(firstAt);
    } finally {
      await deadlines.dispose();
    }
  });

  it("a warden ready after the deadline refuses the launch", async () => {
    const dir = temp();
    const deadlines = registry(dir, {
      spawnWarden: () => new Promise((resolve) => setTimeout(() => resolve({ pid: 1 }), 400)),
    });
    try {
      await hold(deadlines, "job", inMs(150));
      await expect(
        deadlines.attachScope("job", `CLAUDEXOR_RUN_SCOPE_${"b".repeat(32)}`),
      ).rejects.toMatchObject({ code: "run_deadline_expired" });
      expect((await deadlines.read("job"))?.state).toBe("enforcing");
    } finally {
      await deadlines.dispose();
    }
  });

  it("a warden reads the clock before the record: a set published after its reading is never overtaken", async () => {
    const dir = temp();
    const deadlines = registry(dir);
    try {
      await hold(deadlines, "job", inMs(60_000));
      const path = join(dir, "job.json");
      const original = readRecord(path) as DeadlineRecord;
      const target = BigInt(original.own!.targetNs);
      let reads = 0;
      const outcome = await runWarden(path, {
        // Every reading is past the original deadline and its head start; right
        // after the FIRST reading, before the warden reads the record, a later
        // revision is published (as a confirmed set would have been).
        now: () => {
          reads += 1;
          if (reads === 1)
            writeJsonAtomic(path, {
              ...original,
              revision: 1,
              own: { at: inMs(120_000), targetNs: String(target + 60_000_000_000n) },
            });
          return target + 2_000_000_000n;
        },
        sleep: async () => {
          if (reads > 5) rmSync(path, { force: true });
        },
        reap: async () => {
          throw new Error("the warden must not act on the replaced revision");
        },
        platform: "linux",
      });
      expect(outcome).toBe("removed");
      expect(existsSync(`${path}.enforcing`)).toBe(false);
    } finally {
      await deadlines.dispose();
    }
  });

  it("declares the capability only on Linux after the boundary check, naming the boundary", async () => {
    const dir = temp();
    const linux = registry(dir, {
      platform: "linux",
      probeBoundary: async () => ({ kind: "marker", reason: "test" }),
    });
    expect(linux.capabilities()).toEqual([]);
    await linux.proveBoundary();
    expect(linux.capabilities()).toEqual([
      { name: "run-deadline/1", stopGraceSec: RUN_DEADLINE_STOP_GRACE_SEC, boundary: "marker" },
    ]);
    const cgroup = registry(dir, {
      platform: "linux",
      probeBoundary: async () => ({ kind: "cgroup", runsDir: join(dir, "runs") }),
    });
    await cgroup.proveBoundary();
    expect(cgroup.capabilities()[0]).toMatchObject({ boundary: "cgroup" });
    for (const platform of ["darwin", "win32"] as const) {
      const other = registry(dir, {
        platform,
        probeBoundary: async () => ({ kind: "marker", reason: "x" }),
      });
      await other.proveBoundary();
      expect(other.capabilities()).toEqual([]);
    }
  });
});

describe("run-deadline/1 startup cost", () => {
  it("reconciles and answers by job states read through the indexed scalar query, never hydrating command bodies", async () => {
    const dir = temp();
    const a = new RunDeadlines({ dir, spawnWarden: async () => ({ pid: 1 }) });
    for (const id of ["job-a", "job-b"]) {
      await a.stage(id, {
        own: a.toPoint(inMs(600_000)),
        successorOf: null,
        parentJobId: null,
      });
      a.admit(id);
    }
    await a.dispose();
    const queried: string[][] = [];
    const commands = {
      queries: {
        observationRecords: (ids: readonly string[]) => {
          queried.push([...ids]);
          return ids
            .filter((id) => id === "job-a")
            .map((jobId) => ({
              jobId,
              runId: null,
              partition: "global",
              epoch: "e",
              state: "interrupted",
              createdAt: "x",
            }));
        },
        getByRunId: () => {
          throw new Error("hydrated a command by run id");
        },
        select: () => {
          throw new Error("hydrated commands");
        },
      },
      current: () => ({
        get: () => {
          throw new Error("hydrated a command body");
        },
      }),
    };
    const b = new SchedulerDeadlines(
      {
        dir,
        spawnWarden: async () => ({ pid: 1 }),
        platform: "linux",
        probeBoundary: async () => ({ kind: "marker", reason: "t" }),
      },
      { commands: commands as never },
      { cancel: () => {}, abort: () => {} },
    );
    await b.startup();
    expect(queried[0]?.sort()).toEqual(["job-a", "job-b"]);
    expect(readRecord(join(dir, "job-a.json"))).toMatchObject({ state: "closed" });
    // job-b is not retained: its record went (no warden was ever ready).
    expect(readRecord(join(dir, "job-b.json"))).toBe(null);
    expect(await b.rpc({ id: "job-a", request: { action: "read" } })).toMatchObject({
      state: "closed",
    });
  });
});
