/**
 * D-16 unified attempt finalizer.
 *
 * ONE owner for the "did this attempt deliver, and in what work_state?" decision
 * — replacing the three divergent deliverable predicates (candidate diff||answer;
 * planner no-error⇒delivered; read-only nonempty-report). It folds the raw
 * intent-specific deliverable evidence with the model-authored WorkReport, the
 * typed context signals, the harness error state, and the gates into:
 *   - a final `deliverablePresent`,
 *   - a `work_state` axis (orthogonal to lifecycle, INV-116),
 *   - a typed reason,
 *   - and the class of outcome (clean / veto / contract-failure / interrupted).
 *
 * The module is PURE (no I/O, no clock). The envelope compile/unwrap half lives
 * in `workReportEnvelope.ts`; the spec-build decision, the unwrap and this
 * finalizer read one contract (`WorkReportEnvelopeMode` / `UnwrappedAnswer`).
 */
import type { RunReason, WorkReport, WorkReportSource, WorkState } from "@claudexor/schema";
import type { AttemptTelemetry, ToolErrorRecord, WebEvidenceState } from "./attemptTelemetry.js";
import type { UnverifiedWorkReport } from "./workReportEnvelope.js";

/** A typed vendor limit that ended an attempt's work before it completed. */
export type AttemptInterruption = Extract<
  RunReason,
  "context_capacity_exhausted" | "turn_limit_reached"
>;

/**
 * The one owner of WHICH typed limit interrupted an attempt, read from its
 * telemetry: terminal context exhaustion, else the max-turns cap (#299). Every
 * lane terminal reports this reason instead of naming one limit itself.
 */
export function attemptInterruption(
  t: Pick<AttemptTelemetry, "contextExhausted" | "turnLimitReached"> | null | undefined,
): AttemptInterruption | null {
  if (t?.contextExhausted) return "context_capacity_exhausted";
  return t?.turnLimitReached ? "turn_limit_reached" : null;
}

/** Plain wording of an interruption for failure records and summaries (INV-141). */
export const INTERRUPTION_DETAIL: Record<AttemptInterruption, string> = {
  context_capacity_exhausted: "context capacity exhausted before the work completed",
  turn_limit_reached: "the max-turns limit ended the work before it completed",
};

/** The wording of a finalizer's `interrupted` reason; context when it names no cap. */
export function interruptionDetail(reason: RunReason | null): string {
  return INTERRUPTION_DETAIL[
    reason === "turn_limit_reached" ? "turn_limit_reached" : "context_capacity_exhausted"
  ];
}

/**
 * QA-036: the terminal outcome facts for a read-only run that produced NO
 * successful attempt. The D8 legacy mapping treated ANY web-blocked run as a
 * succeeded/review_blocked terminal (exit 0, "Needs review"); a blocked Ask that
 * delivered nothing then read as done, and Plan later repeated the same error
 * without a final/plan.md. This re-checks the DELIVERABLE: only a blocked
 * attempt that actually produced a canonical read-only output is a
 * review-blocked SUCCESS; an empty blocked (or plain failed) run is a failure.
 */
export function readOnlyNoSuccessTerminal(opts: {
  webBlocked: boolean;
  hasDeliverable: boolean;
  budgetStopped: boolean;
  attemptsCount: number;
}): { lifecycle: "succeeded" | "failed"; review?: "blocked"; reason: RunReason } {
  if (opts.webBlocked && opts.hasDeliverable) {
    return { lifecycle: "succeeded", review: "blocked", reason: "review_blocked" };
  }
  if (opts.budgetStopped && opts.attemptsCount === 0) {
    return { lifecycle: "failed", reason: "budget_exhausted" };
  }
  return { lifecycle: "failed", reason: "harness_failed" };
}

/** Everything the finalizer folds for one attempt. The gate/web/belt axes are
 * NOT folded here — the finalizer decides deliverable+work_state, and
 * `setAttemptOutcome` runs the status math over gates/web/belt on top (so a
 * `completed` claim with a failed gate still yields a failed status there). */
export interface FinalizeAttemptInput {
  /** Raw intent-specific deliverable evidence (diff/answer/report present). */
  deliverableEvidence: boolean;
  harnessErrored: boolean;
  workReport: WorkReport | null;
  workReportSource: WorkReportSource;
  /** Non-null when an active NATIVE route failed its WorkReport contract. */
  workReportViolation: string | null;
  /** An instructed footer yielded no valid report (owner decision 2026-10-05):
   * disclosed as an unverified work_state with this reason, never a failure.
   * Ignored when a valid report is present. */
  workReportUnverified?: UnverifiedWorkReport | null;
  /** The typed limit that ended this attempt (`attemptInterruption`), or null. */
  interruption: AttemptInterruption | null;
}

/** Outcome class the run-level terminal maps onto lifecycle/facts. */
export type AttemptOutcomeClass = "clean" | "veto" | "contract_failure" | "interrupted";

export interface FinalizeAttemptResult {
  /** Final deliverable presence (a completed claim never invents evidence). */
  deliverablePresent: boolean;
  /** Final harness-error state (a contract failure elevates it). */
  harnessErrored: boolean;
  workState: WorkState;
  /** Typed reason for the veto/failure; null on a clean outcome. */
  reason: RunReason | null;
  outcomeClass: AttemptOutcomeClass;
}

/**
 * The unified finalizer. Precedence (hardest signal wins):
 *   1. terminal context exhaustion or the max-turns cap with no completed
 *      report ⇒ interrupted, with that limit as the reason;
 *   2. a broken WorkReport contract on a NATIVE route ⇒ hard failure
 *      (never prose-success);
 *   3. a valid needs_input/incomplete report ⇒ veto (lifecycle stays, run is
 *      non-applyable, exit non-zero) — a `completed` claim NEVER overrides a
 *      harness error / failed gate / missing evidence;
 *   4. otherwise the disclosed work_state: completed, or unverified — always
 *      with the route's own source (`absent` only when the route carries no
 *      transport), plus the typed reason when an INSTRUCTED footer was missing
 *      or broken. An errored attempt with no accepted final keeps its route's
 *      source and gets no footer reason (`unwrapAttemptAnswer`).
 */
export function finalizeAttempt(input: FinalizeAttemptInput): FinalizeAttemptResult {
  const completed = input.workReport?.state === "completed";

  if (input.interruption && !completed) {
    return {
      deliverablePresent: input.deliverableEvidence,
      harnessErrored: input.harnessErrored,
      workState: { state: "unverified", source: input.workReportSource },
      reason: input.interruption,
      outcomeClass: "interrupted",
    };
  }

  if (input.workReportViolation) {
    return {
      deliverablePresent: false,
      // A constrained route that promised a WorkReport and broke the contract
      // failed the attempt — it must never terminalize as a prose success.
      harnessErrored: true,
      workState: { state: "unverified", source: input.workReportSource },
      reason: "work_report_contract",
      outcomeClass: "contract_failure",
    };
  }

  const report = input.workReport;
  if (report && (report.state === "needs_input" || report.state === "incomplete")) {
    return {
      deliverablePresent: input.deliverableEvidence,
      harnessErrored: input.harnessErrored,
      workState: {
        state: report.state,
        source: input.workReportSource,
        ...(report.required_inputs.length > 0 ? { required_inputs: report.required_inputs } : {}),
      },
      reason: report.state === "needs_input" ? "input_required" : "work_incomplete",
      outcomeClass: "veto",
    };
  }

  const unverified = report ? null : (input.workReportUnverified ?? null);
  return {
    deliverablePresent: input.deliverableEvidence,
    harnessErrored: input.harnessErrored,
    workState: {
      state: report?.state === "completed" ? "completed" : "unverified",
      source: input.workReportSource,
      ...(unverified ? { unverified_reason: unverified.reason } : {}),
    },
    reason: null,
    outcomeClass: "clean",
  };
}

/**
 * The deliverable exception for tool hygiene (INV-043/INV-044), shared by every
 * read-only intent so planner and explorer cannot drift apart again.
 *
 * An unrecovered tool error is tool hygiene, not a terminal state: on an attempt
 * that DELIVERED its contracted deliverable it stays disclosed warning evidence
 * (`toolWarnings` counts it and `setAttemptOutcome` lands `success_with_warnings`)
 * instead of discarding a produced answer or plan. Only a deliverable-LESS
 * attempt escalates the FIRST unrecovered error into a hard harness error.
 *
 * `deliverableEvidence` MUST be the same raw evidence boolean `finalizeAttempt`
 * folds — the unwrapped D-16 deliverable, never the pre-envelope answer text —
 * so the WorkReport contract stays the one owner of what "delivered" means.
 * This decides ONLY the non-web tool-error axis: optional web failures never
 * determine terminal state, while an explicitly required-but-unsatisfied web
 * contract keeps its separate hard gate. The finalizer's contract-failure and
 * interrupted classes still outrank whatever this returns.
 *
 * Returns the harness-error message to escalate, or null to leave the errors as
 * warning evidence.
 */
export function unrecoveredToolErrorFailure(
  unrecovered: readonly ToolErrorRecord[],
  deliverableEvidence: boolean,
): string | null {
  if (deliverableEvidence) return null;
  const first = unrecovered.find((error) => error.kind !== "web");
  return first ? `${first.tool} failed without recovery: ${first.summary}` : null;
}

/**
 * The harness-error message for required-but-unsatisfied web evidence, shared by
 * every lane that reports it so the web axis has the SAME single owner as the
 * tool-error axis above and the two cannot drift apart.
 *
 * This is a message builder only — it neither decides that the evidence is
 * unsatisfied (`webUnsatisfied` owns that) nor changes the axis precedence: web
 * stays a HARD gate that an attempt cannot buy off with a deliverable, unlike
 * the tool-error exception, and the finalizer's contract-failure and interrupted
 * classes still outrank it at the call site.
 *
 * The reason falls back through the telemetry the same way in every lane: the
 * recorded `errorSummary` when there is one, else an unrecovered-web-tool reason
 * when web was attempted at all, else a never-attempted reason.
 */
export function webEvidenceFailure(
  web: Pick<WebEvidenceState, "attempted" | "errorSummary">,
): string {
  return `web evidence unsatisfied: ${web.errorSummary ?? (web.attempted ? "web tool failed without verified recovery" : "web evidence required but never attempted")}`;
}
