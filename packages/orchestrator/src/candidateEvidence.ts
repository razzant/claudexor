import { makeOutcomeFacts } from "@claudexor/schema";
import type { GateResult, ReviewFinding, RunOutcomeFacts, TaskContract } from "@claudexor/schema";
import type { CandidateEvidence } from "@claudexor/arbitration";
import type { AttemptOutcomeClass } from "./attemptFinalize.js";
import type { AttemptTelemetry } from "./attemptTelemetry.js";
import { toolWarnings } from "./attemptTelemetry.js";

export interface CandidateRun {
  attemptId: string;
  harnessId: string;
  label: string;
  diff: string;
  answerText?: string;
  reviewCwd?: string;
  baseSha?: string;
  producedFiles?: string[];
  gates: GateResult[];
  cost: number;
  errored: boolean;
  costEstimated: boolean;
  errors: string[];
  telemetry: AttemptTelemetry;
  infraPhase?: "workspace" | "harness";
  /** D-16 r7: the finalizer's outcome class for THIS attempt. An `interrupted`
   * candidate (terminal context exhaustion with NO completed WorkReport) is
   * never reviewed/arbitrated/adopted as clean — it terminalizes the run
   * `interrupted` unless a CLEAN continuation superseded it upstream. */
  outcomeClass?: AttemptOutcomeClass;
}

/** A pre-work corpse (harness error, no diff) AND an `interrupted` partial
 * (D-16 r7: terminal context exhaustion with NO completed WorkReport) are both
 * excluded from review: an interrupted candidate carries untrustworthy
 * half-finished work, so — like the empty-diff corpse — it must never be
 * reviewed/arbitrated/adopted as clean. */
function isWorkingCandidate(run: CandidateRun): boolean {
  return run.outcomeClass !== "interrupted" && (!run.errored || run.diff.length > 0);
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
 */
export function partitionCandidates(runs: CandidateRun[]): {
  working: CandidateRun[];
  facts: RunOutcomeFacts;
  why: string;
} {
  const working = runs.filter(isWorkingCandidate);
  const facts = runs.some((r) => r.outcomeClass === "interrupted")
    ? makeOutcomeFacts("interrupted", { reason: "context_capacity_exhausted", noChanges: true })
    : makeOutcomeFacts("failed", { reason: "harness_failed", noChanges: true });
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
    testsPassed: gates.filter((gate) => gate.status === "passed").length,
    testsTotal: gates.length,
    finalReviewClean,
    reviewVerified,
    toolWarningsCount:
      run.telemetry.outcome?.toolWarningsCount ?? toolWarnings(run.telemetry).length,
    diffSize: run.diff.split("\n").length,
    diffBytes: Buffer.byteLength(run.diff, "utf8"),
    costUsd: run.cost,
    ...(run.telemetry.outcome?.workState ? { workState: run.telemetry.outcome.workState } : {}),
  };
}
