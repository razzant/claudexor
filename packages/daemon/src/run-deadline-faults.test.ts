/**
 * run-deadline/1 under faults: the four invariants (ARCHITECTURE "Run
 * deadlines"), checked over generated plans instead of one test per race.
 *
 * Every record file operation the daemon makes (stage, publish, flush, discard,
 * claim, remove — `RecordIo`) is numbered. A plan is a sequence of events at
 * operation numbers: a failure (the operation throws), a death (it and every
 * later operation never happen; a fresh generation reconciles the directory,
 * itself possibly with failing or dying writes), or a concurrent event right
 * after the operation (the host clock passes the replaced deadline, passes the
 * warden's head start too, the warden claims, the terminal arrives). Plans are
 * grown from dry runs, so every planned event exists in its run, and every case
 * asserts that each planned event fired. The clock is frozen and moves only by
 * the plan; event-loop timers are faked inside a scenario.
 *
 * Invariants, checked against what the warden itself enforces (`governingBound`
 * over the files on disk: the record in force — its prior while a change is not
 * committed — and its claim):
 * 1. publication: the new revision is renamed into place only before both the
 *    replaced and the requested deadline, with no claim and no terminal;
 * 2. confirmation: a set answered ok committed (the prior's removal, decided
 *    before the replaced deadline plus the head start with no claim and no
 *    terminal) and flushed that commit; a commit that was visible but not
 *    flushed answers outcome unknown and GET reports it;
 * 3. terminal: a terminal before the commit wins — the set is refused and every
 *    answer reports the terminal's own facts (closed or expired, the revision
 *    and deadline in force when it arrived); one after it ends the new revision;
 * 4. in force: until a commit, the warden enforces the deadline replaced (the
 *    prior is the record in force; a claim only floors it), whatever failed and
 *    whoever died, and every answer names the same one; it moves only at the
 *    commit.
 * After a restart (itself with failing or dying writes) every answer of the new
 * generation agrees with the others and with the terminal's facts.
 *
 * The renewal matrix is split by its first event over this file,
 * `run-deadline-faults-claims.test.ts` and `run-deadline-faults-io.test.ts`
 * (they run side by side); the harness is `test-support/run-deadline-faults.ts`.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  RunScopeSpentError,
  SCOPE_MARKER_VALUE,
  spawnRunOwned,
  withinRunScope,
} from "@claudexor/core";
import { DaemonLocalClient } from "./daemon-local-client.js";
import {
  fileRecordIo,
  priorPath,
  readRecord,
  wardenReadyPath,
  writeJsonAtomic,
  type DeadlineRecord,
  type RecordIo,
} from "./run-deadline-record.js";
import type { RunDeadlines } from "./run-deadlines.js";
import { DaemonServer } from "./server.js";
import { sqlFixture } from "./store/test-support/sql-fixture.js";
import { CAPS, legacyDaemon, terminalEvent, until } from "./test-support/run-deadline-daemon.js";
import {
  MARKER,
  Ops,
  frozenClock,
  generation,
  hold,
  outcome,
  registry,
  removeTemps,
  temp,
  wardenBound,
  withFakeTimers,
  type Clock,
  type Kind,
} from "./test-support/run-deadline-faults.js";
import { setCase, setMatrix } from "./test-support/run-deadline-fault-checks.js";

afterAll(removeTemps, 0);

const CASES = await setMatrix(["deadline", "head-start"], true);

describe("run-deadline/1 under faults: one renewal, plans that start with the clock passing a deadline", () => {
  it.each(CASES)("$name", ({ plan }) => setCase(plan));
});

// ---------------------------------------------------------------------------
// A record's removal, file by file.
// ---------------------------------------------------------------------------

describe("run-deadline/1 under faults: a record's files go one by one", () => {
  /** A finished, expired job with every file: prior, claim, warden outcome, ready, done. */
  async function finished(dir: string, time: Clock) {
    const deadlines = registry(dir, time);
    await hold(deadlines, "job", time.iso(10_000));
    const path = join(dir, "job.json");
    const record = readRecord(path) as DeadlineRecord;
    writeJsonAtomic(priorPath(path), record);
    time.advance(11_000);
    deadlines.close("job"); // after its deadline: claimed, expired
    await deadlines.dispose();
    for (const file of [`${path}.outcome.json`, wardenReadyPath(path), `${path}.done`])
      writeJsonAtomic(file, { reason: "reaped" });
    return deadlines;
  }

  for (const kind of ["throw", "crash"] as const)
    for (const at of [1, 2, 3, 4, 5, 6])
      it(`${kind} at removal ${at}`, async () => {
        const dir = temp();
        const time = frozenClock();
        await finished(dir, time);
        const ops = new Ops([{ at, kind }]);
        ops.counting = true;
        const deadlines = registry(dir, time, ops.io());
        deadlines.forgetAll(["job"]);
        ops.assertFired();
        expect(ops.names.slice(1, at + 1).every((n) => n === "remove")).toBe(true);
        if (readRecord(join(dir, "job.json"))) {
          // What is left still answers the terminal's facts.
          expect(deadlines.durableSnapshot("job")!.state).toBe("expired");
          expect(wardenBound(dir, "job.json")!.target).toBeDefined();
        }
        // The next start removes what a cut-short removal left.
        const next = await generation(dir, time, {});
        expect(readdirSync(dir)).toEqual([]);
        await next.dispose();
      });
});

// ---------------------------------------------------------------------------
// A Delegate family: removal, a pending close, the parent's renewal.
// ---------------------------------------------------------------------------

describe("run-deadline/1 under faults: a Delegate family", () => {
  /** Parent and child held; the parent shortened after the child was made, both finished. */
  async function family(dir: string, time: Clock) {
    const deadlines = registry(dir, time);
    await hold(deadlines, "a-parent", time.iso(100_000));
    await hold(deadlines, "b-child", null, "a-parent");
    await deadlines.set(
      "a-parent",
      { at: time.iso(40_000), expectedRevision: 0 },
      { delegated: false },
    );
    // The child's warden still guards survivors; the parent's is done.
    writeJsonAtomic(wardenReadyPath(join(dir, "b-child.json")), { pid: 1 });
    deadlines.close("b-child"); // while its refresh may still be pending
    deadlines.close("a-parent");
    await deadlines.dispose();
    return deadlines;
  }

  for (const fault of [null, "throw", "crash"] as const)
    for (const at of fault ? [1, 2, 3, 4, 5, 6] : [null])
      it(`retention forgets the parent first, then the child (${fault ? `${fault} at removal ${at}` : "no fault"})`, async () => {
        const dir = temp();
        const time = frozenClock();
        await family(dir, time);
        const cap = wardenBound(dir, "b-child.json")!.target;
        const ops = new Ops(fault && at ? [{ at, kind: fault }] : []);
        const deadlines = registry(dir, time, ops.io());
        const check = () => {
          const bound = wardenBound(dir, "b-child.json");
          if (bound) expect(bound.target <= cap, "the child's deadline never rises").toBe(true);
        };
        ops.counting = true;
        deadlines.forgetAll(["a-parent"]);
        check();
        if (readRecord(join(dir, "b-child.json")))
          expect(
            readRecord(join(dir, "a-parent.json")),
            "the parent stays while the child's warden may act",
          ).not.toBeNull();
        // The child's warden finishes; the next retention pass forgets the child.
        writeJsonAtomic(`${join(dir, "b-child.json")}.done`, { reason: "released" });
        deadlines.forgetAll(["b-child"]);
        check();
        if (fault) ops.assertFired();
        // Whatever the faults left, a later generation's startup sweep removes both.
        const next = await generation(dir, time, {});
        expect(readdirSync(dir)).toEqual([]);
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
    const next = await generation(dir, time, { "b-child": "interrupted" });
    const child = readRecord(join(dir, "b-child.json")) as DeadlineRecord;
    expect(child.state).toBe("closed");
    expect(BigInt(child.frozen!.targetNs)).toBe(cap);
    expect(readRecord(join(dir, "a-parent.json"))).not.toBeNull();
    await next.dispose();
  });

  /**
   * The parent extends 40 s → 100 s; the child's terminal arrives at one of the
   * parent's renewal operations. The child freezes the parent's deadline in
   * force at that instant: 40 s before the parent's commit, 100 s after it —
   * never a value the parent confirmed later.
   */
  const RENEWAL_OPS = 8; // stage, prior (stage, publish, flush), publish, flush, commit, flush
  for (let at = 1; at <= RENEWAL_OPS; at++)
    it(`a child's terminal at the parent's renewal op ${at} freezes the parent's deadline in force then`, async () => {
      await withFakeTimers(async () => {
        const dir = temp();
        const time = frozenClock();
        let deadlines!: RunDeadlines;
        let committedBefore = false;
        const ops = new Ops([{ at, kind: "child-terminal" }], (kind) => {
          if (kind !== "child-terminal") return;
          committedBefore = !existsSync(priorPath(join(dir, "a-parent.json"))) && at > 4;
          deadlines.close("b-child");
        });
        deadlines = registry(dir, time, ops.io());
        await hold(deadlines, "a-parent", time.iso(40_000));
        await hold(deadlines, "b-child", null, "a-parent");
        ops.counting = true;
        const answer = await deadlines.set(
          "a-parent",
          { at: time.iso(100_000), expectedRevision: 0 },
          { delegated: false },
        );
        expect(answer.at).toBe(time.iso(100_000));
        await deadlines.dispose();
        ops.assertFired();
        const child = deadlines.peek("b-child")!;
        expect(child.state).toBe("closed");
        expect(child.at).toBe(committedBefore ? time.iso(100_000) : time.iso(40_000));
        const frozen = (readRecord(join(dir, "b-child.json")) as DeadlineRecord).frozen!;
        expect(frozen.at).toBe(child.at);
      });
    });

  it("a child's terminal while its refresh is pending freezes the parent's deadline in force then, not a later one", async () => {
    await withFakeTimers(async () => {
      const dir = temp();
      const time = frozenClock();
      let gate: Promise<void> | null = null;
      let open!: () => void;
      const io: RecordIo = {
        ...fileRecordIo,
        // The child's record writes wait: its chain is busy when the terminal arrives.
        stage: async (path, record) => {
          if (gate && path.endsWith("b-child.json")) await gate;
          return fileRecordIo.stage(path, record);
        },
      };
      const deadlines = registry(dir, time, io);
      await hold(deadlines, "a-parent", time.iso(40_000));
      await hold(deadlines, "b-child", null, "a-parent");
      gate = new Promise<void>((resolve) => (open = resolve));
      await deadlines.set(
        "a-parent",
        { at: time.iso(50_000), expectedRevision: 0 },
        { delegated: false },
      ); // the child's refresh to 50 s waits on its chain
      deadlines.close("b-child"); // ended under the parent's 50 s
      // The extension commits only once the child's frozen deadline is durable.
      const extension = deadlines.set(
        "a-parent",
        { at: time.iso(100_000), expectedRevision: 1 },
        { delegated: false },
      );
      open();
      await extension;
      await deadlines.dispose();
      const frozen = (readRecord(join(dir, "b-child.json")) as DeadlineRecord).frozen!;
      expect(frozen.at, "the deadline in force when the child ended").toBe(time.iso(50_000));
      expect(deadlines.peek("b-child")).toMatchObject({ state: "closed", at: time.iso(50_000) });
    });
  });

  /**
   * The parent renews (extension or shortening) with an event at each of the
   * child's refresh operations: the child's deadline as the warden enforces it
   * never exceeds its parent's, whatever failed.
   */
  for (const target of [100_000, 20_000])
    for (const kind of ["throw", "crash", "head-start"] as const)
      for (let at = 9; at <= 11; at++)
        it(`the child's refresh after the parent's renewal to ${target / 1000} s, ${kind} at op ${at}`, async () => {
          await withFakeTimers(async () => {
            const dir = temp();
            const time = frozenClock();
            const ops = new Ops([{ at, kind }], (k) => {
              if (k === "head-start") time.advance(12_000);
            });
            const deadlines = registry(dir, time, ops.io());
            await hold(deadlines, "a-parent", time.iso(40_000));
            await hold(deadlines, "b-child", null, "a-parent");
            ops.counting = true;
            await outcome(
              deadlines.set(
                "a-parent",
                { at: time.iso(target), expectedRevision: 0 },
                { delegated: false },
              ),
            );
            if (!ops.dead) await deadlines.dispose();
            ops.assertFired();
            const parent = wardenBound(dir, "a-parent.json")!.target;
            const child = wardenBound(dir, "b-child.json")!.target;
            expect(child <= parent, "the child never outlives its parent's deadline").toBe(true);
          });
        });
});

// ---------------------------------------------------------------------------
// attachScope under faults.
// ---------------------------------------------------------------------------

describe("run-deadline/1 under faults: handing a scope marker to the warden", () => {
  const ATTACH_OPS = 3; // the marker's record write: stage, publish, flush
  const cases: Array<{ kind: Kind | "warden-spawn"; at: number }> = [
    { kind: "warden-spawn", at: 0 },
  ];
  for (let at = 1; at <= ATTACH_OPS; at++)
    for (const kind of ["throw", "crash", "head-start"] as const) cases.push({ kind, at });
  it.each(cases)("$kind at op $at", async ({ kind, at }) => {
    await withFakeTimers(async () => {
      const dir = temp();
      const time = frozenClock();
      let spawned = 0;
      const ops = new Ops(kind === "warden-spawn" ? [] : [{ at, kind: kind as Kind }], (k) => {
        if (k === "head-start") time.advance(12_000);
      });
      const deadlines = registry(dir, time, ops.io(), {
        spawnWarden: async () => {
          if (kind === "warden-spawn") throw new Error("no warden");
          spawned += 1;
          return { pid: 1 };
        },
      });
      await hold(deadlines, "job", time.iso(10_000));
      ops.counting = true;
      const answer = await outcome(deadlines.attachScope("job", MARKER));
      if (kind !== "warden-spawn") ops.assertFired();
      if (ops.dead) {
        await deadlines.dispose();
        // Whatever the death left, the next generation closes the record.
        const next = await generation(dir, time, { job: "interrupted" });
        expect(["closed", "expired"]).toContain(next.durableSnapshot("job")!.state);
        await next.dispose();
        return;
      }
      const record = readRecord(join(dir, "job.json")) as DeadlineRecord;
      if (answer.ok) {
        // Resolved: the marker is durable and its warden runs.
        expect(record.markers).toContain(MARKER);
        expect(spawned).toBe(1);
      } else {
        expect([
          "run_deadline_record_unavailable",
          "run_deadline_expired",
          undefined,
          "Error: no warden",
        ]).toContain(answer.code);
      }
      // From the deadline on, nothing carrying the marker launches.
      time.advance(20_000);
      const launch = () =>
        spawnRunOwned(
          "/bin/true",
          [],
          { env: { [MARKER]: SCOPE_MARKER_VALUE } },
          { spawnFn: () => ({ pid: undefined }) as never },
        );
      if (record.markers.includes(MARKER)) expect(launch).toThrow(RunScopeSpentError);
      await deadlines.dispose();
    });
  });
});

// ---------------------------------------------------------------------------
// The daemon: queue promotion, acceptance and the SQL terminal.
// ---------------------------------------------------------------------------

describe("run-deadline/1 under faults: a queued job promoted during a renewal", () => {
  for (const late of [false, true])
    it(`keeps its place while the renewal is pending; ${late ? "a late renewal expires it" : "a timely one starts it"}, and the job behind it is never lost`, async () => {
      const time = frozenClock();
      let release!: () => void;
      let releaseFlush!: () => void;
      const blocked = new Promise<void>((resolve) => (release = resolve));
      let flushes: number | null = null;
      const ran: string[] = [];
      const io: RecordIo = {
        ...fileRecordIo,
        // The renewal's flush after its rename waits until the job was promoted.
        flush: async (dir) => {
          if (flushes !== null && (flushes += 1) === 2)
            await new Promise<void>((resolve) => (releaseFlush = resolve));
          await fileRecordIo.flush(dir);
        },
      };
      const d = await legacyDaemon(time, io, async (params) => {
        const name = (params as { label: string }).label;
        ran.push(name);
        if (name === "blocker") await blocked;
        return { lifecycle: "succeeded" };
      });
      try {
        await d.client.enqueue({ label: "blocker" }, { idempotencyKey: "b", clientId: "t" });
        await until(
          () => Promise.resolve(ran),
          (r) => r.includes("blocker"),
        );
        const job = await d.client.enqueue(
          { label: "job", deadline: { at: time.iso(10_000) } },
          { idempotencyKey: "j", clientId: "t" },
        );
        await d.client.enqueue({ label: "behind" }, { idempotencyKey: "n", clientId: "t" });
        // The renewal reaches the flush after its rename; the clock passes the old deadline.
        flushes = 0;
        const renewal = outcome(
          d.client.runDeadline(job.id, {
            action: "set",
            at: time.iso(60_000),
            expectedRevision: 0,
          }),
        );
        await until(
          () => Promise.resolve(releaseFlush),
          (r) => typeof r === "function",
        );
        flushes = null;
        time.advance(late ? 12_000 : 10_500);
        release(); // the blocker ends: the queue is drained while the renewal is pending
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(ran, "the held job does not start, and nothing overtakes it").toEqual(["blocker"]);
        releaseFlush();
        const answer = await renewal;
        const record = await until(
          () => d.client.status(job.id),
          (r) => r.state !== "queued" && r.state !== "running",
        );
        await until(
          () => Promise.resolve(ran),
          (r) => r.includes("behind"),
        );
        if (late) {
          expect(answer).toEqual({ ok: false, code: "run_deadline_expired" });
          expect(record).toMatchObject({ state: "cancelled", errorCode: "run_deadline_expired" });
          expect(ran).toEqual(["blocker", "behind"]);
        } else {
          expect(answer.ok).toBe(true);
          expect(record.state).toBe("succeeded");
          expect(ran).toEqual(["blocker", "job", "behind"]);
        }
      } finally {
        release();
        releaseFlush?.();
        await d.close();
      }
    });
});

describe("run-deadline/1 under faults: an acceptance racing its own deadline", () => {
  for (const kind of ["deadline", "throw", "crash"] as const)
    for (const at of [1, 2, 3])
      it(`${kind === "deadline" ? "the deadline passes after" : `${kind} at`} acceptance op ${at}`, async () => {
        const time = frozenClock();
        const ops = new Ops(
          [{ at, kind: kind === "deadline" ? "head-start" : kind }],
          (k) => k === "head-start" && time.advance(6_000),
        );
        let ran = false;
        const d = await legacyDaemon(time, ops.io(), async () => {
          ran = true;
          return { lifecycle: "succeeded" };
        });
        ops.counting = true;
        try {
          const request = { label: "edge", deadline: { at: time.iso(5_000) } };
          const answer = await outcome(
            d.client.enqueue(request, { idempotencyKey: "k", clientId: "t" }),
          );
          ops.assertFired();
          const accepted = await d.client.findAccepted(request, {
            idempotencyKey: "k",
            clientId: "t",
          });
          if (kind === "deadline") {
            // The deadline passed before the acceptance's transaction: refused, no key.
            expect(answer).toEqual({ ok: false, code: "run_deadline_passed" });
            expect(accepted).toBe(null);
          } else if (!answer.ok) expect(accepted).toBe(null);
          await new Promise((resolve) => setTimeout(resolve, 20));
          if (!answer.ok) {
            if (ops.dead) await (await generation(d.dir, time, {})).dispose();
            expect(readdirSync(d.dir).filter((name) => name.endsWith(".json"))).toEqual([]);
          }
          if (kind === "deadline") expect(ran).toBe(false);
        } finally {
          await d.close();
        }
      });

  it("with the production SQL store: a deadline reached while the transaction is prepared is refused inside it and binds no key", async () => {
    const time = frozenClock();
    const root = temp();
    const sql = await sqlFixture(root);
    // The deadline passes while the store prepares the acceptance, after every
    // check made before the store was entered.
    const request = { label: "sql", deadline: { at: time.iso(5_000) } };
    // The store is made per call: its class's preparation is wrapped for this test.
    const proto = Object.getPrototypeOf(sql.graph.commands.forRequest(request)) as {
      prepareAcceptance(this: unknown, input: unknown): unknown;
    };
    const prepare = proto.prepareAcceptance;
    let passed = false;
    proto.prepareAcceptance = function (input) {
      if (!passed) {
        passed = true;
        time.advance(6_000);
      }
      return prepare.call(this, input);
    };
    const server = new DaemonServer({
      socketPath: join(root, "unused.sock"),
      token: "token",
      commands: sql.graph.commands,
      runtimeConcurrencyCaps: CAPS,
      runDeadlines: {
        dir: join(root, "deadlines"),
        clock: time.clock,
        spawnWarden: async () => ({ pid: 1 }),
        platform: "linux",
        probeBoundary: async () => ({ kind: "marker", reason: "test" }),
      },
      runner: async () => ({ lifecycle: "succeeded" }),
    });
    await server.deadlines.startup();
    const client = new DaemonLocalClient(() => server);
    try {
      const answer = await outcome(client.enqueue(request, { idempotencyKey: "s", clientId: "t" }));
      expect(passed, "the deadline passed during the store's preparation").toBe(true);
      expect(answer).toEqual({ ok: false, code: "run_deadline_passed" });
      expect(await client.findAccepted(request, { idempotencyKey: "s", clientId: "t" })).toBe(null);
      expect(sql.records()).toEqual([]);
      // A request in time is accepted by the same transaction.
      const fresh = { label: "sql", deadline: { at: time.iso(60_000) } };
      expect(
        (await outcome(client.enqueue(fresh, { idempotencyKey: "f", clientId: "t" }))).ok,
      ).toBe(true);
    } finally {
      proto.prepareAcceptance = prepare;
      await server.stop();
      await sql.close();
    }
  });
});

describe("run-deadline/1 under faults: a launch the fence refuses", () => {
  it("settles the job as the deadline's expiry at once, even while the record of its stop is still being written", async () => {
    const time = frozenClock();
    let release: (() => void) | null = null;
    let block = false;
    const io: RecordIo = {
      ...fileRecordIo,
      // The stop's record write hangs: settlement must not wait for it.
      stage: async (path, record) => {
        if (block && record.state === "enforcing")
          await new Promise<void>((resolve) => (release = resolve));
        return fileRecordIo.stage(path, record);
      },
    };
    const marker = `CLAUDEXOR_RUN_SCOPE_${"d".repeat(32)}`;
    let refused: unknown = null;
    const d = await legacyDaemon(time, io, async (_params, ctx) => {
      await ctx.deadlineScope!.attach(marker);
      block = true;
      time.advance(11_000); // the deadline passed; no timer has seen it yet
      try {
        withinRunScope(marker, () =>
          spawnRunOwned(
            "git",
            ["status"],
            { env: {} },
            {
              spawnFn: () => {
                throw new Error("launched after the deadline");
              },
            },
          ),
        );
      } catch (error) {
        refused = error;
        // What preparation Git reports for a launch that failed.
        throw Object.assign(new Error("git could not start"), { code: "git_failed" });
      }
      return { lifecycle: "succeeded" };
    });
    try {
      const job = await d.client.enqueue(
        { label: "prep", deadline: { at: time.iso(10_000) } },
        { idempotencyKey: "p", clientId: "t" },
      );
      const record = await until(
        () => d.client.status(job.id),
        (r) => r.state !== "queued" && r.state !== "running",
      );
      expect(refused).toBeInstanceOf(RunScopeSpentError);
      expect(record).toMatchObject({ errorCode: "run_deadline_expired" });
    } finally {
      (release as (() => void) | null)?.();
      await d.close();
    }
  });
});

describe("run-deadline/1 under faults: the SQL terminal and the deadline", () => {
  /** A run whose SQL terminal commits at 1 s; its materialization ends past its 2 s deadline. */
  for (const materialization of ["slow", "failing"] as const)
    it(`closes at the SQL commit, before a ${materialization} file materialization, never expired by it`, async () => {
      const time = frozenClock();
      const root = temp();
      const sql = await sqlFixture(root);
      let notified = 0;
      let persisted: unknown;
      const deadlineAt = time.iso(2_000);
      const server = new DaemonServer({
        socketPath: join(root, "unused.sock"),
        token: "token",
        commands: sql.graph.commands,
        runtimeConcurrencyCaps: CAPS,
        runDeadlines: {
          dir: join(root, "deadlines"),
          clock: time.clock,
          spawnWarden: async () => ({ pid: 1 }),
          platform: "linux",
          probeBoundary: async () => ({ kind: "marker", reason: "test" }),
        },
        runner: async (_params, ctx) => {
          const runId = `run-${ctx.jobId}`;
          ctx.onRunStart({ runId, taskId: `task-${ctx.jobId}`, runDir: join(root, "run") });
          const owner = sql.graph.commands.findById(ctx.jobId)!;
          const files = (
            owner as unknown as { options: { terminalFiles: { materialize(id: string): void } } }
          ).options.terminalFiles;
          const real = files.materialize.bind(files);
          files.materialize = (id: string) => {
            time.advance(1_500); // the materialization ends past the deadline
            if (materialization === "failing") throw new Error("materialization failed");
            real(id);
          };
          time.advance(1_000);
          persisted = owner.persistTerminal(
            ctx.jobId,
            terminalEvent(runId, ctx.jobId),
            null,
            () => {
              notified += 1;
              ctx.deadlineScope?.terminalCommitted();
            },
          );
          return { lifecycle: "succeeded" };
        },
      });
      await server.deadlines.startup();
      const client = new DaemonLocalClient(() => server);
      try {
        const job = await client.enqueue(
          { label: "terminal", deadline: { at: deadlineAt } },
          { idempotencyKey: "t", clientId: "t" },
        );
        await until(
          () => client.status(job.id),
          (r) => r.state !== "queued" && r.state !== "running",
        );
        expect(notified, "told once, at the commit").toBe(1);
        if (materialization === "failing") expect(persisted).toMatchObject({ state: "pending" });
        expect(await client.runDeadline(job.id, { action: "read" })).toMatchObject({
          state: "closed",
          at: deadlineAt,
        });
      } finally {
        await server.stop();
        await sql.close();
      }
    });
});
