import { makeOutcomeFacts } from "@claudexor/schema";
import type { GateResult, ReviewFinding, RunOutcomeFacts, TaskContract } from "@claudexor/schema";
import type { CandidateEvidence } from "@claudexor/arbitration";
import type { AttemptOutcomeClass } from "./attemptFinalize.js";
import type { AttemptTelemetry } from "./attemptTelemetry.js";
import type { DeclaredFailure } from "./runTerminalResults.js";
import type { AppliedAttemptFacts } from "./delegatedHome.js";
import type { ProducedOmission } from "./candidateOutputs.js";
import type { CaptureRefusal } from "./secretDiff.js";
import { toolWarnings } from "./attemptTelemetry.js";
import { directoryHasOutput, type DirectoryCandidate } from "./directoryCandidate.js";
import { gatesPassed } from "@claudexor/review";

import type { ContinuityTerminalFacts } from "./continuity-terminal.js";

export interface CandidateRun extends ContinuityTerminalFacts {
  attemptId: string;
  harnessId: string;
  label: string;
  diff: string;
  files?: DirectoryCandidate;
  answerText?: string;
  reviewCwd?: string;
  baseSha?: string;
  producedFiles?: string[];
  /** Produced images that were not saved, with size and reason. */
  producedOmitted?: ProducedOmission[];
  gates: GateResult[];
  cost: number;
  errored: boolean;
  costEstimated: boolean;
  errors: string[];
  telemetry: AttemptTelemetry;
  infraPhase?: "workspace" | "harness";
  /** The candidate's changes could not be captured at all. Secret-like content
   * is never a refusal; this is the honest name of a failed capture. */
  captureRefusal?: CaptureRefusal;
  /** Where the exact bytes of an isolated candidate still are when its capture
   * was incomplete (the envelope is kept, not deleted). */
  exactBytesRetainedAt?: string;
  /** Untracked nested repositories the capture left out of `diff` (exact
   * paths); the attempt record and the final work product disclose them. */
  excludedNestedRepositories?: string[];
  /** D-16 r7: the finalizer's outcome class for THIS attempt. An `interrupted`
   * candidate (terminal context exhaustion with NO completed WorkReport) is
   * never reviewed/arbitrated/adopted as clean — it terminalizes the run
   * `interrupted` unless a CLEAN continuation superseded it upstream. */
  outcomeClass?: AttemptOutcomeClass;
  /** The TYPED refusal this attempt died on (a spent subscription window and
   * when it reopens), when it declared one. The per-slot catch otherwise
   * reduces the error to a message string, and the run terminal would have to
   * read prose to recover what the thrower already knew. */
  declaredFailure?: DeclaredFailure;
  /** What this attempt's harness process actually ran under (HOME, access,
   * credential profile, and historical/deliberate outer-boundary evidence).
   * Present on success and per-slot failure so a delegated caller reads the
   * applied fact instead of inferring it from the request. */
  applied?: AppliedAttemptFacts;
}

/**
 * The one typed refusal a run may speak with when NO candidate produced work.
 *
 * UNANIMITY is the whole rule. Promoting one slot's refusal to speak for a run
 * whose other slots died of something else would tell the caller to wait out a
 * quota window for a failure no timer fixes — so mixed causes keep the honest
 * mixed-cause harness terminal instead. When the causes DO agree, the run
 * carries the LATEST reset: waiting for the earliest would leave every other
 * exhausted window still exhausted. An unknown reset anywhere makes the run's
 * reset unknown — a partial answer here is worse than none.
 */
export function unanimousDeclaredFailure(
  runs: readonly Pick<CandidateRun, "declaredFailure">[],
): DeclaredFailure | null {
  const first = runs[0]?.declaredFailure;
  if (!first || (!first.code && first.category !== "config_error")) return null;
  const declared = runs.map((run) => run.declaredFailure);
  const agrees = declared.every((d) => d?.code === first.code && d?.category === first.category);
  if (!agrees) return null;
  // One quota basis speaks for the run only when every candidate shares it. Its
  // window, usage and threshold survive only where every candidate agrees, so
  // one candidate's window is never paired with another candidate's reset.
  const { quotaRefusal, ...rest } = first;
  const refusals = declared.map((d) => d?.quotaRefusal);
  const common = <K extends "constraintId" | "usedRatio" | "threshold">(key: K) =>
    refusals.every((r) => r?.[key] === quotaRefusal?.[key]) ? (quotaRefusal?.[key] ?? null) : null;
  const shared =
    quotaRefusal && refusals.every((r) => r?.basis === quotaRefusal.basis)
      ? {
          basis: quotaRefusal.basis,
          constraintId: common("constraintId"),
          usedRatio: common("usedRatio"),
          threshold: common("threshold"),
        }
      : null;
  const resets = declared.map((d) => d?.resetsAt ?? null);
  const known = resets.filter((at): at is string => at !== null);
  const resetsAt =
    known.length > 0 && known.length === resets.length
      ? known.reduce((latest, at) => (Date.parse(at) > Date.parse(latest) ? at : latest))
      : null;
  return { ...rest, ...(shared ? { quotaRefusal: shared } : {}), resetsAt };
}

/** A pre-work corpse (harness error, no diff) AND an `interrupted` partial
 * (D-16 r7: terminal context exhaustion with NO completed WorkReport) are both
 * excluded from review: an interrupted candidate carries untrustworthy
 * half-finished work, so — like the empty-diff corpse — it must never be
 * reviewed/arbitrated/adopted as clean. THE single owner of "may this candidate
 * be reviewed/arbitrated/adopted?", shared by the race, convergence, and
 * synthesis lanes (D-16 r8) so no sibling path re-derives the veto. */
export function isWorkingCandidate(run: CandidateRun): boolean {
  return (
    !run.captureRefusal &&
    run.outcomeClass !== "interrupted" &&
    (!run.errored || run.diff.length > 0 || directoryHasOutput(run.files))
  );
}

/**
 * Split the produced candidates into the set the reviewer panel / arbiter may
 * see, plus the terminal to fall back on when that set is EMPTY. When nothing
 * survives BECAUSE a candidate was interrupted (context exhaustion, no clean
 * continuation), the run terminalizes lifecycle `interrupted` /
 * `context_capacity_exhausted` — parity with the read-only terminal and the
 * D-16 finalizer (INV-116: lifecycle/outcome orthogonal); otherwise it is a
 * harness failure. `why` is honest per candidate: an interrupted attempt ran
 * out of context AFTER partial work, never "failed before producing work".
 *
 * `noChanges` is DIFF-AWARE (D-16 r8): an interrupted candidate that produced a
 * REAL partial diff (or answer) is not "no changes" — the fallback facts must
 * tell the truth about the retained partial work, never a blanket noChanges:true
 * that contradicts an on-disk partial patch. It is no_changes only when EVERY
 * candidate produced neither a diff nor an answer.
 */
export function partitionCandidates(runs: CandidateRun[]): {
  working: CandidateRun[];
  facts: RunOutcomeFacts;
  why: string;
} {
  const working = runs.filter(isWorkingCandidate);
  const noChanges = runs.some((r) => r.captureRefusal || r.files?.noChanges === null)
    ? null
    : runs.every((r) =>
        r.files
          ? r.files.noChanges === true && !r.answerText
          : r.diff.trim().length === 0 && !r.answerText,
      );
  const facts = runs.some((r) => r.outcomeClass === "interrupted")
    ? makeOutcomeFacts("interrupted", { reason: "context_capacity_exhausted", noChanges })
    : makeOutcomeFacts("failed", {
        reason:
          runs.length > 0 && runs.every((r) => r.captureRefusal)
            ? "workspace_unavailable"
            : "harness_failed",
        noChanges,
      });
  const why = runs
    .map((r) => {
      const reason =
        r.outcomeClass === "interrupted"
          ? "context capacity exhausted before the work completed"
          : (r.errors[0] ?? "failed before producing work");
      return `${r.attemptId}/${r.harnessId}: ${reason}`;
    })
    .join("; ");
  return { working, facts, why };
}

/** The telemetry-roster shape ({attemptId, harnessId, telemetry}) that
 * `writeRunTelemetry` and the cancelled terminals consume. ONE owner so the
 * race lane's several hand-offs don't each re-spell the same map (behavior-
 * identical to the inline form). */
export function candidateRoster(
  runs: CandidateRun[],
): { attemptId: string; harnessId: string; telemetry: AttemptTelemetry }[] {
  return runs.map((r) => ({
    attemptId: r.attemptId,
    harnessId: r.harnessId,
    telemetry: r.telemetry,
  }));
}

/** Candidate status projection shared by normal and cancelled race results. */
export function candidateStatuses(runs: readonly CandidateRun[]) {
  return runs.map((run) => ({
    attemptId: run.attemptId,
    harnessId: run.harnessId,
    status: gatesPassed(run.gates) && !run.errored ? "green" : "red",
  }));
}

export function toCandidateEvidence(
  run: CandidateRun,
  contract: TaskContract,
  findings: ReviewFinding[],
  finalReviewClean: boolean,
  reviewVerified = false,
): CandidateEvidence {
  // Success criteria were a spec-only producer (retired with the spec
  // machinery); the acceptance axis is now always empty.
  const acceptanceCovered: string[] = [];
  // A harness error is an explicit failed required gate — never vacuous 0/0.
  const gates = run.errored
    ? [
        ...run.gates,
        {
          id: "harness",
          command: "harness",
          exit_code: 1,
          status: "failed" as const,
          duration_ms: 0,
          required: true,
          stdout_tail: null,
          stderr_tail: null,
          output_truncated: false,
        },
      ]
    : run.gates;
  return {
    attemptId: run.attemptId,
    label: run.label,
    gates,
    acceptanceCovered,
    acceptanceTotal: 0,
    findings,
    // Test counts come from the CONFIGURED gates only (pre-augmentation): the
    // synthetic harness pseudo-gate above is lifecycle evidence, and counting
    // it here made a zero-configured-gate errored run report testsTotal=1 →
    // "tests=0% / gates 0/1" instead of an honest "n/a / not_configured".
    testsPassed: run.gates.filter((gate) => gate.status === "passed").length,
    testsTotal: run.gates.length,
    finalReviewClean,
    reviewVerified,
    toolWarningsCount:
      run.telemetry.outcome?.toolWarningsCount ?? toolWarnings(run.telemetry).length,
    diffSize: run.files ? run.files.changedPaths.length : run.diff.split("\n").length,
    diffBytes: run.files
      ? run.files.manifest.entries
          .filter((entry) => run.files!.changedPaths.includes(entry.path))
          .reduce(
            (sum, entry) =>
              sum + (entry.after?.kind === "file" ? Math.max(1, entry.after.sizeBytes) : 1),
            0,
          )
      : Buffer.byteLength(run.diff, "utf8"),
    costUsd: run.cost,
    ...(run.telemetry.outcome?.workState ? { workState: run.telemetry.outcome.workState } : {}),
  };
}

/** Convergence-loop terminal facts, ONE precedence owner (D-16 r8):
 * converged > interrupted (context exhausted, never arbitrated) >
 * stuck_no_progress > operator cancel > budget_exhausted > not_converged. */
export function convergenceOutcomeFacts(
  state: {
    converged: boolean;
    interrupted: boolean;
    stuckNoProgress: boolean;
    aborted: boolean;
    exhausted: boolean;
  },
  cancelFacts: () => RunOutcomeFacts,
): RunOutcomeFacts {
  if (state.converged) return makeOutcomeFacts("succeeded");
  if (state.interrupted) {
    return makeOutcomeFacts("interrupted", { reason: "context_capacity_exhausted" });
  }
  if (state.stuckNoProgress) return makeOutcomeFacts("failed", { reason: "stuck_no_progress" });
  if (state.aborted) return cancelFacts();
  if (state.exhausted) return makeOutcomeFacts("failed", { reason: "budget_exhausted" });
  return makeOutcomeFacts("failed", { reason: "not_converged" });
}
