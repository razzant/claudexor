/**
 * run-deadline/1 protocol under faults: one systematic matrix instead of one
 * test per race. Every record file operation the daemon makes (stage, publish,
 * flush, discard, claim, remove — `RecordIo`) is numbered; a plan fails one of
 * them (an exception), "kills the process" at one (it and everything after it
 * never happens; a fresh registry then reconciles the directory), or runs a
 * concurrent event right after one (the host clock jumps, the warden claims,
 * the terminal arrives). The clock is frozen and moved only by the plan.
 *
 * After every case the same invariants are checked against what the warden
 * itself would enforce (`governingBound` over the files on disk, the claim
 * floor included):
 * - agreement: the answer, the live read, the record on disk and the warden's
 *   deadline name the same deadline;
 * - no late deadline: what is enforced is never later than the last renewal
 *   decided in time (before the replaced deadline), and after a refusal never
 *   later than the replaced deadline;
 * - a terminal that arrived before a set was decided wins: the set is refused
 *   and the job's record is closed, never turned expired by the set;
 * - a Delegate child's deadline never rises because its parent's record went;
 * - an acceptance whose deadline passed before its commit is refused and
 *   takes no idempotency key.
 */
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DaemonLocalClient } from "./daemon-local-client.js";
import type { RunDeadlineClock } from "./run-deadline-clock.js";
import {
  diskReader,
  fileRecordIo,
  governingBound,
  readClaim,
  readRecord,
  wardenReadyPath,
  writeJsonAtomic,
  type DeadlineRecord,
  type RecordIo,
} from "./run-deadline-record.js";
import { RunDeadlines } from "./run-deadlines.js";
import { DaemonServer, type RunnerFn } from "./server.js";
import { DurableJournal } from "./store/test-support/fixtures/legacy/journal/index.js";
import { CommandStore } from "./store/test-support/fixtures/legacy/daemon/command-store.js";
import { legacyCommandFixture } from "./store/test-support/legacy-command-fixture.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0);
const temp = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "d-rdf-")));
  dirs.push(dir);
  return dir;
};

const SEC = 1_000_000_000n;
const HEAD_MS = 1_000;

/** A frozen clock the plan moves: host and wall together. */
function frozenClock() {
  let host = 1_000n * SEC;
  let wall = Date.parse("2026-11-22T12:00:00.000Z");
  const clock: RunDeadlineClock = {
    kind: "boottime",
    bootId: () => "boot-fault",
    hostNow: () => host,
    wallNow: () => wall,
  };
  return {
    clock,
    advance(ms: number) {
      host += BigInt(ms) * 1_000_000n;
      wall += ms;
    },
    host: () => host,
    iso: (ms: number) => new Date(wall + ms).toISOString(),
  };
}

class ProcessDied extends Error {
  readonly code = "EPROCESSDIED";
}

type Event =
  | { at: number; kind: "throw" }
  | { at: number; kind: "crash" }
  | { at: number; kind: "hook"; name: string; run: () => void };

/**
 * Number every record operation from `start()` on; apply the plan's events to
 * them. `hostAfter[n]` is the host clock when operation n (and its hook) ended.
 */
function faultyIo(events: Event[], now: () => bigint = () => 0n) {
  let n = 0;
  let counting = false;
  let dead = false;
  const ops: string[] = [];
  const hostAfter: bigint[] = [];
  const enter = (name: string): Event | undefined => {
    if (dead) throw new ProcessDied(`${name} after the process died`);
    if (!counting) return undefined;
    n += 1;
    ops.push(name);
    const event = events.find((e) => e.at === n);
    if (event?.kind === "throw")
      throw Object.assign(new Error(`injected ${name} failure`), { code: "EIO" });
    if (event?.kind === "crash") {
      dead = true;
      throw new ProcessDied(`the process died at ${name}`);
    }
    return event;
  };
  const after = (event: Event | undefined) => {
    if (event?.kind === "hook") event.run();
    if (counting) hostAfter[n] = now();
  };
  const io: RecordIo = {
    async stage(path, record) {
      const event = enter("stage");
      const tmp = await fileRecordIo.stage(path, record);
      after(event);
      return tmp;
    },
    async publish(tmp, path) {
      const event = enter("publish");
      await fileRecordIo.publish(tmp, path);
      after(event);
    },
    async flush(dir) {
      const event = enter("flush");
      await fileRecordIo.flush(dir);
      after(event);
    },
    async discard(tmp) {
      const event = enter("discard");
      await fileRecordIo.discard(tmp);
      after(event);
    },
    claim(path, claim) {
      const event = enter("claim");
      const made = fileRecordIo.claim(path, claim);
      after(event);
      return made;
    },
    remove(path) {
      const event = enter("remove");
      fileRecordIo.remove(path);
      after(event);
    },
  };
  return {
    io,
    ops,
    hostAfter,
    dead: () => dead,
    start: () => {
      counting = true;
    },
  };
}

/** What the warden enforces for a record file now (its own function over the disk). */
function wardenBound(dir: string, file: string) {
  const record = readRecord(join(dir, file));
  if (!record || record === "unreadable") return null;
  return governingBound(record, diskReader(dir));
}

const registry = (
  dir: string,
  time: ReturnType<typeof frozenClock>,
  io: RecordIo = fileRecordIo,
  onExpire: (jobId: string) => void = () => {},
) =>
  new RunDeadlines({
    dir,
    clock: time.clock,
    io,
    headStartMs: HEAD_MS,
    spawnWarden: async () => ({ pid: 1 }),
    platform: "linux",
    onExpire,
  });

async function hold(
  deadlines: RunDeadlines,
  jobId: string,
  at: string | null,
  parentJobId: string | null = null,
) {
  await deadlines.stage(jobId, {
    own: at ? deadlines.toPoint(at) : null,
    successorOf: null,
    parentJobId,
  });
  deadlines.admit(jobId);
}

const outcome = <T>(work: Promise<T>) =>
  work.then(
    (value) => ({ ok: true as const, value }),
    (error: { code?: string }) => ({ ok: false as const, code: error.code ?? String(error) }),
  );

/** A fresh daemon generation over the same directory: reconcile with the job's state. */
async function restart(
  dir: string,
  time: ReturnType<typeof frozenClock>,
  states: Record<string, string>,
) {
  const next = registry(dir, time);
  await next.reconcile(
    (ids) => new Map(ids.filter((id) => states[id]).map((id) => [id, states[id]!])),
  );
  return next;
}

describe("run-deadline/1 under faults: a set racing the deadline, the warden and the terminal", () => {
  // The renewal's own operations (stage, publish, flush) and, when the replaced
  // deadline may have won, the claim and the restoring write after them.
  const POINTS = [1, 2, 3, 4, 5, 6, 7];
  type Concurrent = "deadline" | "head-start" | "warden" | "terminal";
  const cases: Array<{
    name: string;
    hookAt: number | null;
    hook: Concurrent | null;
    fault: "throw" | "crash" | null;
    faultAt: number | null;
  }> = [];
  for (const hook of [null, "deadline", "head-start", "warden", "terminal"] as const)
    for (const hookAt of hook ? [1, 2, 3] : [null])
      for (const fault of [null, "throw", "crash"] as const)
        for (const faultAt of fault
          ? POINTS.filter((p) => hookAt === null || p !== hookAt)
          : [null])
          cases.push({
            name: `${hook ? `${hook} after op ${hookAt}` : "no concurrent event"}, ${fault ? `${fault} at op ${faultAt}` : "no fault"}`,
            hookAt,
            hook,
            fault,
            faultAt,
          });

  it.each(cases)("$name", async ({ hookAt, hook, fault, faultAt }) => {
    const dir = temp();
    const time = frozenClock();
    const path = join(dir, "job.json");
    let T0 = 0n;
    let terminalAt: bigint | null = null;
    const events: Event[] = [];
    let deadlines!: RunDeadlines;
    if (hook && hookAt !== null)
      events.push({
        at: hookAt,
        kind: "hook",
        name: hook,
        run: () => {
          if (hook === "deadline") time.advance(10_500); // past the replaced deadline, inside the head start
          if (hook === "head-start") time.advance(12_000); // past it and the warden's head start
          if (hook === "warden") {
            // The warden judged the replaced revision due and claims it.
            time.advance(12_000);
            writeFileSync(
              `${path}.enforcing`,
              JSON.stringify({ revision: 0, at: "x", targetNs: T0.toString(), by: "warden" }),
            );
          }
          if (hook === "terminal") {
            terminalAt = time.host();
            deadlines.close("job");
          }
        },
      });
    if (fault && faultAt !== null) events.push({ at: faultAt, kind: fault });
    const faulty = faultyIo(events, time.host);
    deadlines = registry(dir, time, faulty.io);
    await hold(deadlines, "job", time.iso(10_000));
    T0 = wardenBound(dir, "job.json")!.target;
    const requestedTarget = T0 + 50n * SEC;
    faulty.start();
    const answer = await outcome(
      deadlines.set("job", { at: time.iso(60_000), expectedRevision: 0 }, { delegated: false }),
    );
    // The renewal was decided right after its staging write (operation 1): in
    // time when the clock was before the replaced deadline and neither the
    // terminal nor a claim came first.
    const decidedAt = faulty.ops[0] === "stage" ? faulty.hostAfter[1] : undefined;
    const timely =
      decidedAt !== undefined &&
      decidedAt < T0 &&
      !(hookAt === 1 && (hook === "terminal" || hook === "warden"));

    if (faulty.dead()) {
      // The process died: no answer stands. What the warden enforces is never
      // later than a renewal decided in time, and a fresh generation agrees.
      const enforced = wardenBound(dir, "job.json");
      expect(enforced).not.toBeNull();
      expect(enforced!.target <= (timely ? requestedTarget : T0)).toBe(true);
      const next = await restart(dir, time, { job: "interrupted" });
      expect(next.durableSnapshot("job")!.at).toBe(enforced!.at);
      expect(wardenBound(dir, "job.json")!.target).toBe(enforced!.target);
      await next.dispose();
      await deadlines.dispose();
      return;
    }

    const live = await deadlines.read("job");
    const disk = readRecord(path);
    const claim = readClaim(path);
    const enforced = wardenBound(dir, "job.json");
    expect(disk, "the record").not.toBe("unreadable");
    expect(live, "the live read").not.toBeNull();
    // Agreement: the live read, the record and the warden name one deadline.
    expect(live!.at).toBe(enforced!.at);
    if (answer.ok) {
      expect(timely, "a confirmed renewal was decided in time").toBe(true);
      expect(answer.value.at).toBe(live!.at);
      expect(answer.value.revision).toBe(live!.revision);
      expect(enforced!.target).toBe(requestedTarget);
      expect(claim, "no claim stands against a confirmed renewal").toBeNull();
    } else {
      // A refusal keeps the replaced deadline in force.
      expect(enforced!.target <= T0).toBe(true);
      expect([
        "run_deadline_expired",
        "run_deadline_closed",
        "run_deadline_record_unavailable",
      ]).toContain(answer.code);
      if (answer.code === "run_deadline_expired")
        expect(["enforcing", "expired"]).toContain(live!.state);
    }
    if (hook === "terminal" && terminalAt !== null && terminalAt < T0) {
      // The terminal arrived before the deadline: never expired by the set.
      if (hookAt === 1) expect(answer).toEqual({ ok: false, code: "run_deadline_closed" });
      const after = readRecord(path) as DeadlineRecord;
      if (after.state !== "armed") expect(after.state).toBe("closed");
      expect(live!.state).toBe("closed");
    }
    await deadlines.dispose();
  });
});

describe("run-deadline/1 under faults: removing a Delegate parent's record", () => {
  /** Parent and child held; the parent shortened after the child was made, both finished. */
  async function family(dir: string, time: ReturnType<typeof frozenClock>) {
    const deadlines = registry(dir, time);
    await hold(deadlines, "a-parent", time.iso(100_000));
    await hold(deadlines, "b-child", null, "a-parent");
    await deadlines.set(
      "a-parent",
      { at: time.iso(40_000), expectedRevision: 0 },
      { delegated: false },
    );
    await deadlines.read("b-child"); // the child's refresh landed
    // The child's warden still guards survivors; the parent's is done.
    writeJsonAtomic(wardenReadyPath(join(dir, "b-child.json")), { pid: 1 });
    deadlines.close("b-child");
    deadlines.close("a-parent");
    await deadlines.read("a-parent");
    await deadlines.read("b-child");
    return deadlines;
  }

  for (const fault of [null, "throw", "crash"] as const)
    for (const faultAt of fault ? [1, 2, 3] : [null])
      it(`retention forgets the parent first, then the child (${fault ? `${fault} at removal ${faultAt}` : "no fault"})`, async () => {
        const dir = temp();
        const time = frozenClock();
        const first = await family(dir, time);
        const cap = wardenBound(dir, "b-child.json")!.target;
        await first.dispose();
        const faulty = faultyIo(fault && faultAt ? [{ at: faultAt, kind: fault }] : []);
        faulty.start();
        const deadlines = registry(dir, time, faulty.io);
        const check = () => {
          const bound = wardenBound(dir, "b-child.json");
          if (bound) expect(bound.target <= cap, "the child's deadline never rises").toBe(true);
        };
        try {
          deadlines.forgetAll(["a-parent"]);
        } catch {
          /* an injected failure */
        }
        check();
        if (readRecord(join(dir, "b-child.json")))
          expect(
            readRecord(join(dir, "a-parent.json")),
            "the parent stays while the child's warden may act",
          ).not.toBeNull();
        // The child's warden finishes; the next retention pass forgets the child.
        writeJsonAtomic(`${join(dir, "b-child.json")}.done`, { reason: "released" });
        try {
          deadlines.forgetAll(["b-child"]);
        } catch {
          /* an injected failure */
        }
        check();
        // Whatever the faults left, a later generation's startup sweep removes both.
        const next = await restart(dir, time, {});
        expect(readdirSync(dir).filter((name) => name.endsWith(".json"))).toEqual([]);
        await next.dispose();
      });

  it("startup reconciles a retained child before it removes its unretained parent", async () => {
    const dir = temp();
    const time = frozenClock();
    const deadlines = registry(dir, time);
    await hold(deadlines, "a-parent", time.iso(100_000));
    await hold(deadlines, "b-child", null, "a-parent");
    await deadlines.set(
      "a-parent",
      { at: time.iso(40_000), expectedRevision: 0 },
      { delegated: false },
    );
    await deadlines.read("b-child");
    writeJsonAtomic(wardenReadyPath(join(dir, "b-child.json")), { pid: 1 });
    const cap = wardenBound(dir, "b-child.json")!.target;
    await deadlines.dispose(); // the daemon died with both live
    // Only the child is retained.
    const next = await restart(dir, time, { "b-child": "interrupted" });
    const child = readRecord(join(dir, "b-child.json")) as DeadlineRecord;
    expect(child.state).toBe("closed");
    expect(BigInt(child.frozen!.targetNs)).toBe(cap);
    expect(wardenBound(dir, "b-child.json")!.target <= cap).toBe(true);
    // The child's warden may still act: the parent stays.
    expect(readRecord(join(dir, "a-parent.json"))).not.toBeNull();
    await next.dispose();
  });
});

describe("run-deadline/1 under faults: an acceptance racing its own deadline", () => {
  const CAPS = {
    max_concurrent: 1,
    max_concurrent_non_model_jobs: 1,
    max_concurrent_model_operations: 1,
    max_parallel_candidates: 1,
    max_deep_scan_width: 1,
    max_council_members: 2,
  };
  async function daemon(time: ReturnType<typeof frozenClock>, io: RecordIo, runner: RunnerFn) {
    const dir = temp();
    const journal = new DurableJournal({ rootDir: join(dir, "journal"), partition: "global" });
    const store = new CommandStore(journal);
    store.recoverAfterStartup();
    const server = new DaemonServer({
      socketPath: join(dir, "unused.sock"),
      token: "token",
      commands: legacyCommandFixture({ current: () => store }),
      runtimeConcurrencyCaps: CAPS,
      runDeadlines: {
        dir: join(dir, "deadlines"),
        clock: time.clock,
        io,
        spawnWarden: async () => ({ pid: 1 }),
        platform: "linux",
        probeBoundary: async () => ({ kind: "marker", reason: "test" }),
      },
      runner,
    });
    await server.deadlines.startup();
    return {
      dir: join(dir, "deadlines"),
      server,
      client: new DaemonLocalClient(() => server),
      async close() {
        await server.stop();
        journal.close();
      },
    };
  }

  for (const kind of ["deadline", "throw", "crash"] as const)
    for (const at of [1, 2, 3])
      it(`${kind === "deadline" ? "the deadline passes after" : `${kind} at`} acceptance op ${at}`, async () => {
        const time = frozenClock();
        const events: Event[] =
          kind === "deadline"
            ? [{ at, kind: "hook", name: "deadline", run: () => time.advance(6_000) }]
            : [{ at, kind }];
        const faulty = faultyIo(events);
        faulty.start();
        let ran = false;
        const d = await daemon(time, faulty.io, async () => {
          ran = true;
          return { lifecycle: "succeeded" };
        });
        try {
          const request = { label: "edge", deadline: { at: time.iso(5_000) } };
          const answer = await outcome(
            d.client.enqueue(request, { idempotencyKey: "k", clientId: "t" }),
          );
          const accepted = await d.client.findAccepted(request, {
            idempotencyKey: "k",
            clientId: "t",
          });
          if (kind === "deadline") {
            // The deadline passed before the commit: refused, the key stays free.
            expect(answer).toEqual({ ok: false, code: "run_deadline_passed" });
            expect(accepted).toBe(null);
          } else if (!answer.ok) {
            expect(accepted).toBe(null);
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
          if (!answer.ok) {
            // A dead process cannot remove what it staged: the next start's sweep does.
            if (faulty.dead()) await (await restart(d.dir, time, {})).dispose();
            expect(readdirSync(d.dir).filter((name) => name.endsWith(".json"))).toEqual([]);
          }
          if (kind === "deadline") expect(ran).toBe(false);
        } finally {
          await d.close();
        }
      });
});

describe("run-deadline/1 under faults: the SQL terminal and a renewal", () => {
  it("a renewal after the run's terminal was committed is refused closed, never answered armed", async () => {
    const time = frozenClock();
    const dir = temp();
    const journal = new DurableJournal({ rootDir: join(dir, "journal"), partition: "global" });
    const store = new CommandStore(journal);
    store.recoverAfterStartup();
    let committed!: () => void;
    let release!: () => void;
    const terminalCommitted = new Promise<void>((resolve) => (committed = resolve));
    const server = new DaemonServer({
      socketPath: join(dir, "unused.sock"),
      token: "token",
      commands: legacyCommandFixture({ current: () => store }),
      runtimeConcurrencyCaps: {
        max_concurrent: 1,
        max_concurrent_non_model_jobs: 1,
        max_concurrent_model_operations: 1,
        max_parallel_candidates: 1,
        max_deep_scan_width: 1,
        max_council_members: 2,
      },
      runDeadlines: {
        dir: join(dir, "deadlines"),
        clock: time.clock,
        spawnWarden: async () => ({ pid: 1 }),
        platform: "linux",
        probeBoundary: async () => ({ kind: "marker", reason: "test" }),
      },
      // The runner's terminal is committed (as the SQL terminal hook does), then
      // it still stages its final update before the scheduler settles it.
      runner: async (_params, ctx) => {
        ctx.onRunStart({ runId: `run-${ctx.jobId}`, taskId: "t", runDir: "/tmp/none" });
        ctx.onTerminalCommitted?.();
        committed();
        await new Promise<void>((resolve) => (release = resolve));
        return { lifecycle: "succeeded" };
      },
    });
    await server.deadlines.startup();
    const client = new DaemonLocalClient(() => server);
    try {
      const accepted = await client.enqueue(
        { label: "run", deadline: { at: time.iso(60_000) } },
        { idempotencyKey: "r", clientId: "t" },
      );
      await terminalCommitted;
      const answer = await outcome(
        client.runDeadline(accepted.id, {
          action: "set",
          at: time.iso(90_000),
          expectedRevision: 0,
        }),
      );
      expect(answer).toEqual({ ok: false, code: "run_deadline_closed" });
      expect(await client.runDeadline(accepted.id, { action: "read" })).toMatchObject({
        state: "closed",
        revision: 0,
      });
      release();
    } finally {
      release?.();
      await server.stop();
      journal.close();
    }
  });
});
