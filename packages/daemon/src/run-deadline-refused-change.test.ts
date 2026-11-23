/**
 * run-deadline/1: a refused change of the deadline leaves the record in force
 * for every reader — every answer and the warden (`governingBound` over the
 * files on disk) name the same deadline. That holds also when the record file
 * holds an earlier change that became visible and never committed: its prior
 * is the record in force, and a later refusal leaves the prior in place until
 * the next durable write of the record.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { priorPath, readRecord, type DeadlineRecord } from "./run-deadline-record.js";
import type { RunDeadlines } from "./run-deadlines.js";
import {
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
  type Planned,
} from "./test-support/run-deadline-faults.js";

afterAll(removeTemps, 0);

/** One change's record operations: stage, prior (stage, publish, flush), publish, flush. */
const CHANGE_OPS = ["stage", "stage", "publish", "flush", "publish", "flush"];

type Bound0 = NonNullable<ReturnType<typeof wardenBound>>;

async function scenario(
  plan: Planned[],
  work: (d: RunDeadlines, time: Clock, dir: string, t0: Bound0) => Promise<void>,
) {
  return withFakeTimers(async () => {
    const dir = temp();
    const time = frozenClock();
    // "requested": the clock passes a 5 s shortening's instant, not the 10 s deadline.
    const ops = new Ops(plan, (kind) => kind === "requested" && time.advance(6_000), time.host);
    const deadlines = registry(dir, time, ops.io());
    await hold(deadlines, "job", time.iso(10_000));
    const t0 = wardenBound(dir, "job.json")!;
    ops.counting = true;
    await work(deadlines, time, dir, t0);
    ops.assertFired();
    return { dir, time, ops, deadlines, t0 };
  });
}

/** Every answer of the live registry and the warden name `at`. */
function agree(dir: string, deadlines: RunDeadlines, at: string) {
  expect(deadlines.peek("job")!.at, "GET").toBe(at);
  expect(wardenBound(dir, "job.json")!.at, "the warden").toBe(at);
}

describe("run-deadline/1: a refused change leaves the record in force for every reader", () => {
  for (const second of ["passed", "publish failed"] as const)
    it(`an extension left visible but uncommitted is never opened by a later refusal (${second})`, async () => {
      const plan: Planned[] =
        second === "passed"
          ? [
              { at: 6, kind: "throw" }, // the extension's flush after its rename
              { at: 10, kind: "requested" }, // the shortening's prior is durable, then its instant passes
            ]
          : [
              { at: 6, kind: "throw" },
              { at: 11, kind: "throw" }, // the shortening's rename
            ];
      let first: unknown;
      let refusal: unknown;
      const { dir, time, ops, deadlines, t0 } = await scenario(plan, async (d, clock, at, t) => {
        first = await outcome(
          d.set("job", { at: clock.iso(60_000), expectedRevision: 0 }, { delegated: false }),
        );
        agree(at, d, t.at); // the extension did not commit: its prior is in force
        refusal = await outcome(
          d.set("job", { at: clock.iso(5_000), expectedRevision: 0 }, { delegated: false }),
        );
      });
      expect(ops.names.slice(1, 7)).toEqual(CHANGE_OPS);
      expect(first).toEqual({ ok: false, code: "run_deadline_record_unavailable" });
      expect(refusal).toEqual({
        ok: false,
        code: second === "passed" ? "run_deadline_passed" : "run_deadline_record_unavailable",
      });
      // The record file still holds the extension that never committed: only
      // its prior keeps the 10 s deadline in force, so the refusal kept it.
      const path = join(dir, "job.json");
      expect((readRecord(path) as DeadlineRecord).revision).toBe(1);
      expect(existsSync(priorPath(path)), "the refusal kept the prior").toBe(true);
      agree(dir, deadlines, t0.at);
      expect((await deadlines.read("job"))!.revision).toBe(0);
      // The next renewal commits over it, and the prior goes with that commit.
      const next = await deadlines.set(
        "job",
        { at: time.iso(30_000), expectedRevision: 0 },
        { delegated: false },
      );
      expect(next.revision).toBe(1);
      expect(existsSync(priorPath(path))).toBe(false);
      agree(dir, deadlines, time.iso(30_000));
      await deadlines.dispose();
    });

  it("a shortening that won while it was being written is in force on disk too, even when its claim and record writes fail", async () => {
    let answer: unknown;
    const { dir, time, ops, deadlines } = await scenario(
      [
        { at: 6, kind: "requested" }, // after the rename's flush: the 5 s instant plus the head start passed
        { at: 7, kind: "throw" }, // the claim of the deadline that won
        { at: 9, kind: "throw" }, // the record of its stop
      ],
      async (d, clock) => {
        answer = await outcome(
          d.set("job", { at: clock.iso(5_000), expectedRevision: 0 }, { delegated: false }),
        );
      },
    );
    expect(ops.names.slice(7, 10)).toEqual(["claim", "remove", "stage"]);
    expect(answer).toEqual({ ok: false, code: "run_deadline_expired" });
    // The daemon stops the run under the 5 s deadline that won; so does the
    // warden, although neither the claim nor the record of the stop was written.
    expect(deadlines.peek("job")).toMatchObject({ state: "enforcing", at: time.iso(-1_000) });
    agree(dir, deadlines, time.iso(-1_000));
    await deadlines.dispose();
  });

  it("a refused shortening that became visible: GET and the warden both keep the replaced deadline", async () => {
    let answer: unknown;
    const { dir, time, deadlines, t0 } = await scenario(
      [{ at: 6, kind: "throw" }], // the shortening's flush after its rename
      async (d, clock) => {
        answer = await outcome(
          d.set("job", { at: clock.iso(5_000), expectedRevision: 0 }, { delegated: false }),
        );
      },
    );
    expect(answer).toEqual({ ok: false, code: "run_deadline_record_unavailable" });
    const path = join(dir, "job.json");
    expect((readRecord(path) as DeadlineRecord).own!.at, "visible").toBe(time.iso(5_000));
    agree(dir, deadlines, t0.at);
    // The 5 s instant passes: nothing stops the run there — not the daemon
    // (its timer and its answers keep 10 s), and not the warden.
    time.advance(7_000);
    expect((await deadlines.read("job"))!.state).toBe("armed");
    expect(wardenBound(dir, "job.json")!.target).toBe(t0.target);
    await deadlines.dispose();
    // After a restart the run's terminal freezes the record in force: one deadline everywhere.
    const next = await generation(dir, time, { job: "interrupted" });
    expect(next.durableSnapshot("job")!.at).toBe(t0.at);
    expect(wardenBound(dir, "job.json")!.at).toBe(t0.at);
    await next.dispose();
  });
});
