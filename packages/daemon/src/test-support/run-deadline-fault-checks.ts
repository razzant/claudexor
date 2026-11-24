/**
 * The invariant checks of the run-deadline/1 fault matrix (`checkSet`,
 * `checkRestarts`) and the matrix itself (`setMatrix`, `setCase`), over the
 * scenarios `run-deadline-faults.ts` runs. The invariants are stated in
 * `run-deadline-faults.test.ts`.
 */
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { claimPath, priorPath, readClaim } from "../run-deadline-record.js";
import {
  HEAD,
  Ops,
  generation,
  growPlans,
  label,
  outcome,
  runSet,
  temp,
  wardenBound,
  type Kind,
  type Planned,
  type SetRun,
  type TerminalFacts,
} from "./run-deadline-faults.js";

/** The set's commit: the prior removed while the new revision is the armed record, unclaimed. */
export function commitOf(run: SetRun): number | undefined {
  const path = join(run.dir, "job.json");
  return run.ops.changes.find(
    (c) =>
      c.name === "remove" &&
      c.path === priorPath(path) &&
      c.record?.revision === 1 &&
      c.record.state === "armed" &&
      !c.claimed,
  )?.op;
}

/** The four invariants over one finished change. */
export function checkSet(run: SetRun) {
  const { ops, answer, live, T0, t0At, R, rAt, terminal, dir } = run;
  const path = join(dir, "job.json");
  const earlier = R < T0 ? R : T0;
  ops.assertFired();
  const recordChanges = ops.changes.filter((c) => c.path === path);
  // 1. Publication: the new revision is renamed into place only before both
  //    deadlines, with no claim and no terminal.
  for (const c of recordChanges.filter(
    (c) => c.name === "publish" && c.record?.revision === 1 && c.record.state === "armed",
  )) {
    expect(c.host < earlier, "renamed before both deadlines").toBe(true);
    expect(c.claimed, "no claim at the rename").toBe(false);
    expect(c.terminal, "no terminal at the rename").toBe(false);
  }
  // 4. In force: the warden's deadline moves only at the commit — the prior's
  //    removal — decided before the replaced deadline plus the head start.
  const raises = ops.changes.filter(
    (c) => c.before !== null && c.after !== null && c.after > c.before,
  );
  const commitOp = commitOf(run);
  expect(raises.filter((c) => c.after! > T0).length <= 1, "at most one commit").toBe(true);
  // Past the replaced deadline only at the commit.
  for (const c of raises)
    if (c.after! > T0) expect(c.op, "the deadline rises only at the commit").toBe(commitOp);
  const commit = ops.changes.find((c) => c.op === commitOp && c.name === "remove");
  if (commit) {
    expect(
      commit.host < T0 + HEAD,
      "committed before the replaced deadline plus the head start",
    ).toBe(true);
    expect(commit.claimed, "no claim at the commit").toBe(false);
    expect(commit.terminal, "no terminal at the commit").toBe(false);
  }
  const bound = wardenBound(dir, "job.json");
  expect(bound, "the warden has a deadline").not.toBeNull();
  // Uncommitted, the replaced deadline is in force: exactly it unless a claim floors it.
  if (commitOp === undefined && existsSync(claimPath(path)))
    expect(bound!.target <= T0, "uncommitted: never later than the replaced deadline").toBe(true);
  else if (commitOp === undefined) expect(bound!.target, "uncommitted: the replaced one").toBe(T0);
  else if (!existsSync(claimPath(path))) expect(bound!.target, "committed").toBe(R);
  if (ops.dead) return;

  const terminalOp = run.plan.find((e) => e.kind === "terminal")?.at;
  const terminalFirst = terminal !== null && (commitOp === undefined || terminalOp! < commitOp);
  const flushThrew = (op: number) => ops.fired.some((e) => e.at === op && e.kind === "throw");
  // 2. Confirmation.
  if (answer.ok) {
    expect(commitOp, "a confirmed set committed").toBeDefined();
    expect(ops.names[commitOp! + 1]).toBe("flush");
    expect(flushThrew(commitOp! + 1), "its commit was flushed").toBe(false);
    expect(answer.value.revision).toBe(1);
    expect(answer.value.at).toBe(rAt);
    expect(live!.revision).toBe(1);
    // A claim afterwards may only be the confirmed revision's own (its deadline won later).
    const claim = readClaim(path);
    if (!terminal)
      expect(claim === null || claim.revision === 1, "no claim stands against it").toBe(true);
    if (!terminal) expect(bound!.target).toBe(R);
  } else if (answer.code === "run_deadline_outcome_unknown") {
    expect(commitOp, "outcome unknown only after a commit").toBeDefined();
    expect(flushThrew(commitOp! + 1), "its commit's flush failed").toBe(true);
    expect(live!.revision, "GET reports the commit").toBe(1);
  } else {
    expect([
      "run_deadline_expired",
      "run_deadline_closed",
      "run_deadline_passed",
      "run_deadline_record_unavailable",
    ]).toContain(answer.code);
    // A refusal changes nothing — except that a shortening which became visible
    // and then won stays in force as enforcing (its earlier deadline).
    const published = recordChanges.some(
      (c) => c.name === "publish" && c.record?.revision === 1 && c.record.state === "armed",
    );
    if (commitOp === undefined && !terminal) {
      const kept = answer.code === "run_deadline_expired" && R < T0 && published;
      expect(live!.revision, "a refusal changes nothing").toBe(kept ? 1 : 0);
      expect(live!.at).toBe(kept ? rAt : t0At);
    }
  }
  // 3. Terminal.
  if (terminal) {
    const t = terminal as TerminalFacts;
    if (terminalFirst) {
      const expected = t.expiredBefore || t.claim || t.at >= T0 ? "expired" : "closed";
      expect(answer.ok, "a terminal before the commit refuses the set").toBe(false);
      expect([`run_deadline_${expected}`, "run_deadline_record_unavailable"]).toContain(
        (answer as { code: string }).code,
      );
      expect(live!.state).toBe(expected);
      expect(live!.revision).toBe(0);
      expect(live!.at).toBe(t0At);
    } else if (t.expiredBefore) {
      // The earlier deadline won after the commit, before the terminal came: the
      // record with that deadline (the replaced one of an extension the warden
      // claimed, the new one of a shortening) is in force as enforcing.
      expect(live!.state).toBe("expired");
      expect(live!.revision).toBe(R < T0 ? 1 : 0);
      expect(live!.at).toBe(R < T0 ? rAt : t0At);
    } else {
      // After the commit the terminal ends the new revision; a claim it saw
      // (the warden acted on the prior) floors it at the replaced deadline.
      const expected = t.claim || t.at >= R ? "expired" : "closed";
      expect(live!.revision, "a terminal after the commit ends the new revision").toBe(1);
      expect(live!.state).toBe(expected);
      expect(live!.at).toBe(t.claim && T0 < R ? t0At : rAt);
      if (expected === "expired")
        expect(answer).toEqual({ ok: false, code: "run_deadline_expired" });
    }
  }
  // Agreement: every answer and the warden name one deadline — the record in
  // force, also while a refused change left its prior (a claim only floors).
  if (!existsSync(claimPath(path)))
    expect(live!.at, "every answer and the warden name one deadline").toBe(bound!.at);
}

/**
 * Restarts over copies of the directory: clean, and with each reconcile
 * operation failing or dying (then a further clean generation). Every
 * generation's answers agree, never exceed the floor, and keep the terminal's label.
 */
export async function checkRestarts(
  run: SetRun,
  commitOp: number | undefined,
  faultAtClaim: boolean,
  faultyRestarts: boolean,
) {
  const state = run.terminal ? "cancelled" : "interrupted";
  const labels = new Set<string>();
  const once = async (plan: Planned[]) => {
    const copy = temp();
    cpSync(run.dir, copy, { recursive: true });
    const ops = new Ops(plan);
    ops.counting = true;
    let g = await generation(copy, run.time, { job: state }, ops.io());
    if (ops.dead) g = await generation(copy, run.time, { job: state });
    const snapshot = g.durableSnapshot("job")!;
    expect(["closed", "expired"]).toContain(snapshot.state);
    const patch = await outcome(
      g.set(
        "job",
        { at: run.time.iso(90_000), expectedRevision: snapshot.revision },
        {
          delegated: false,
        },
      ),
    );
    expect(patch).toEqual({ ok: false, code: `run_deadline_${snapshot.state}` });
    const bound = wardenBound(copy, "job.json")!;
    if (commitOp === undefined) expect(bound.target <= run.T0).toBe(true);
    // The warden and the answers agree, also when the reconcile's write failed
    // and a refused change's prior is still beside the record.
    expect(snapshot.at, "the warden and the answers agree after a restart").toBe(bound.at);
    labels.add(snapshot.state);
    await g.dispose();
    return ops;
  };
  const dry = await once([]);
  if (faultyRestarts)
    for (let at = 1; at <= dry.count; at++)
      for (const kind of ["throw", "crash"] as const) (await once([{ at, kind }])).assertFired();
  expect(labels.size, "every generation gives the same label").toBe(1);
  if (run.terminal && !faultAtClaim) {
    const t = run.terminal as TerminalFacts;
    const terminalOp = run.plan.find((e) => e.kind === "terminal")!.at;
    const first = commitOp === undefined || terminalOp < commitOp;
    const floor = run.T0 < run.R ? run.T0 : run.R;
    const bound = first ? run.T0 : t.claim ? floor : run.R;
    const expected = t.expiredBefore || t.claim || t.at >= bound ? "expired" : "closed";
    expect([...labels][0], "a restart keeps the terminal's label").toBe(expected);
  }
}

const KINDS: Kind[] = ["deadline", "head-start", "warden", "terminal", "throw", "crash"];

/**
 * The matrix of one change (an extension to 60 s by default) for the plans
 * whose first event is one of `first` (the matrix is split over test files so
 * they run side by side): every plan of up to `depth` events, the four
 * invariants, and the restarts.
 */
export async function setMatrix(
  first: Kind[],
  withEmpty: boolean,
  {
    target = 60_000,
    depth = 2,
    kinds = KINDS,
  }: { target?: number; depth?: number; kinds?: Kind[] } = {},
) {
  const plans = await growPlans((plan) => runSet(plan, target), kinds, depth, first);
  return (withEmpty ? [[], ...plans] : plans).map((plan) => ({ name: label(plan), plan }));
}

/** One case of the matrix. */
export async function setCase(plan: Planned[], target = 60_000) {
  const run = await runSet(plan, target);
  checkSet(run);
  const commitOp = commitOf(run);
  const faultAtClaim = run.ops.fired.some(
    (e) => (e.kind === "throw" || e.kind === "crash") && run.ops.names[e.at] === "claim",
  );
  // A restart after every single-event plan (with each reconcile write failing
  // or dying in turn) and after every death of a two-event plan.
  if (plan.length <= 1 || run.ops.dead)
    await checkRestarts(run, commitOp, faultAtClaim, plan.length <= 1);
}
