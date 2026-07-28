import { z } from "zod/v3";
import { ApplyEligibility } from "./apply-eligibility.js";
import { ReviewState, RunOutcomeFacts } from "./decision.js";
import { Id, IsoTimestamp, ModeKind, SchemaVersion } from "./primitives.js";
import { RequiredAction, needsDecision, requiredActionsFor } from "./status-projection.js";

/**
 * Canonical role of one model invocation in a terminal run. In particular,
 * council draft lanes are planners while the synthesis invocation is a merge;
 * reviewer and merge invocations can therefore never inflate planner counts.
 */
export const RunParticipantRole = z
  .enum(["planner", "merge", "candidate", "scout", "reducer", "reviewer"])
  .describe("Canonical role of one participant in the terminal run graph.");
export type RunParticipantRole = z.infer<typeof RunParticipantRole>;

export const RunParticipantStatus = z
  .enum(["success", "success_with_warnings", "blocked", "failed"])
  .describe("Terminal outcome recorded for one run participant.");
export type RunParticipantStatus = z.infer<typeof RunParticipantStatus>;

export const RunParticipant = z
  .object({
    attempt_id: Id.nullable().describe(
      "Attempt id when the participant owns an orchestrator attempt; null for reviewer-panel members.",
    ),
    harness_id: Id.describe("Harness that served this participant role."),
    role: RunParticipantRole,
    deliverable_present: z
      .boolean()
      .default(false)
      .describe("Whether this participant produced the deliverable its role requested."),
    status: RunParticipantStatus.nullable()
      .default(null)
      .describe("Participant outcome when recorded; null for artifact-only reviewer membership."),
  })
  .strict()
  .describe("One role-labelled participant in the terminal run graph.");
export type RunParticipant = z.infer<typeof RunParticipant>;

export const RunDeliverableFacts = z
  .object({
    present: z.boolean().describe("Whether the canonical primary deliverable exists."),
    kind: z
      .enum(["answer", "report", "plan", "patch", "structured_output"])
      .nullable()
      .describe("Kind of canonical primary deliverable; null when none exists."),
    path: z
      .string()
      .nullable()
      .describe("Run-relative path of the canonical primary deliverable; null when absent."),
    producer_attempt_id: Id.nullable()
      .default(null)
      .describe("Attempt that produced the deliverable, when known."),
  })
  .strict()
  .describe("Canonical primary-output presence and identity for a terminal run.");
export type RunDeliverableFacts = z.infer<typeof RunDeliverableFacts>;

export const RunParticipantsFacts = z
  .object({
    planners: z
      .number()
      .int()
      .nonnegative()
      .describe("Number of participants whose canonical role is planner."),
    attempts: z.array(RunParticipant).default([]).describe("Role-labelled participant roster."),
  })
  .strict()
  .describe("Terminal participant graph plus its planner-lane count.");
export type RunParticipantsFacts = z.infer<typeof RunParticipantsFacts>;

export const RunGateState = z
  .enum(["not_configured", "passed", "failed", "skipped"])
  .describe("Terminal state of the configured deterministic gate set.");
export type RunGateState = z.infer<typeof RunGateState>;

export const RunGateFacts = z
  .object({
    configured: z.boolean().describe("Whether the frozen task configured deterministic gates."),
    required: z.number().int().nonnegative().describe("Number of configured required gates."),
    total: z.number().int().nonnegative().describe("Total configured deterministic gates."),
    executed: z.boolean().describe("Whether the terminal attempt executed the gate set."),
    state: RunGateState,
    receipt_attempt_id: Id.nullable()
      .default(null)
      .describe("Attempt whose gate receipt decides this projection; null when no gates executed."),
  })
  .strict()
  .describe("Canonical gate configuration and terminal receipt projection.");
export type RunGateFacts = z.infer<typeof RunGateFacts>;

export const RunReviewFacts = z
  .object({
    state: ReviewState,
    blocker_ids: z
      .array(Id)
      .default([])
      .describe("Stable ids of accepted evidence-backed blocking findings."),
    blockers: z.number().int().nonnegative().describe("Number of blocking findings."),
  })
  .strict()
  .describe("Canonical terminal review verdict and blocking-finding identity.");
export type RunReviewFacts = z.infer<typeof RunReviewFacts>;

export const RunApplyFacts = z
  .object({
    eligibility: ApplyEligibility.nullable()
      .default(null)
      .describe("Delivery-gate eligibility at terminalization; null when nothing is applyable."),
    operator_decision_present: z
      .boolean()
      .default(false)
      .describe("Whether a valid operator decision was present when the receipt was finalized."),
  })
  .strict()
  .describe("Terminal apply eligibility and operator-decision state.");
export type RunApplyFacts = z.infer<typeof RunApplyFacts>;

/**
 * Immutable terminal RunFacts receipt (GH #29). The orchestrator builds this
 * once from the attempt graph and canonical artifacts, validates its cross-axis
 * invariants, then persists the exact object consumed by machine surfaces.
 */
export const RunFacts = z
  .object({
    schema_version: SchemaVersion,
    run_id: Id,
    task_id: Id,
    mode: ModeKind,
    outcome: RunOutcomeFacts,
    deliverable: RunDeliverableFacts,
    participants: RunParticipantsFacts,
    gates: RunGateFacts,
    review: RunReviewFacts,
    apply: RunApplyFacts,
    required_actions: z
      .array(RequiredAction)
      .default([])
      .describe("Typed actions required to unblock this terminal outcome."),
    generated_at: IsoTimestamp.describe("When this immutable terminal receipt was finalized."),
  })
  .strict()
  .describe("Validated immutable terminal facts for one run.");
export type RunFacts = z.infer<typeof RunFacts>;

/** Identity a canonical receipt must match before any surface may serve it:
 * the daemon/CLI-known run and task ids plus, when the caller holds a settled
 * terminal state, the exact lifecycle. Undefined fields are simply not
 * asserted (e.g. a legacy caller that knows only the run id). */
export interface ExpectedRunFactsIdentity {
  runId?: string;
  taskId?: string;
  lifecycle?: RunOutcomeFacts["lifecycle"];
}

/** Typed refusal for a PRESENT-but-untrustworthy canonical receipt: wrong
 * shape, violated cross-axis invariants, or an identity that contradicts the
 * caller's authority. The pure core carries the stable machine fields
 * (code/retryable/evidenceRefs); each surface adds its own transport mapping
 * (control-api: HTTP 500 + requiredActions; CLI: renderCliFailure exit). */
export class RunFactsInvalidError extends Error {
  readonly code = "run_facts_invalid";
  readonly retryable = false;
  readonly evidenceRefs = ["final/run_facts.yaml"];

  constructor() {
    super("canonical RunFacts receipt is invalid; inspect final/run_facts.yaml before retrying");
    this.name = "RunFactsInvalidError";
  }
}

/**
 * THE shared pure validation owner for reading a canonical receipt back on any
 * surface: wire shape, cross-axis invariants, and identity binding in one
 * place. Filesystem access, root resolution, and transport/error mapping stay
 * with the callers — this function never touches disk.
 */
export function validateRunFactsReceipt(
  value: unknown,
  expected: ExpectedRunFactsIdentity = {},
): RunFacts {
  let facts: RunFacts;
  try {
    facts = validateRunFactsInvariants(value);
  } catch {
    throw new RunFactsInvalidError();
  }
  if (
    (expected.runId !== undefined && facts.run_id !== expected.runId) ||
    (expected.taskId !== undefined && facts.task_id !== expected.taskId) ||
    (expected.lifecycle !== undefined && facts.outcome.lifecycle !== expected.lifecycle)
  ) {
    throw new RunFactsInvalidError();
  }
  return facts;
}

/** Typed invariant refusal raised before a contradictory RunFacts receipt can
 * be persisted. `violations` is stable diagnostic evidence for tests/logs; it
 * is not a surface vocabulary. */
export class RunFactsInvariantError extends Error {
  readonly code = "run_facts_invariant";

  constructor(readonly violations: string[]) {
    super(`RunFacts invariant violation: ${violations.join("; ")}`);
    this.name = "RunFactsInvariantError";
  }
}

/**
 * Validate both the RunFacts wire shape and the relationships its individual
 * Zod fields cannot express. Returns the parsed/defaulted receipt on success.
 */
export function validateRunFactsInvariants(value: unknown): RunFacts {
  const facts = RunFacts.parse(value);
  const violations: string[] = [];
  const { deliverable, participants, gates, review, apply, outcome } = facts;

  const hasDeliverableIdentity = deliverable.kind !== null && deliverable.path !== null;
  if (deliverable.present !== hasDeliverableIdentity) {
    violations.push("deliverable.present must match non-null deliverable kind and path");
  }
  if (deliverable.present) {
    if (deliverable.producer_attempt_id === null) {
      if (facts.mode === "plan" && outcome.lifecycle === "succeeded") {
        violations.push("a succeeded plan deliverable must identify its producer attempt");
      }
    } else {
      const producer = participants.attempts.find(
        (participant) => participant.attempt_id === deliverable.producer_attempt_id,
      );
      if (!producer) {
        violations.push("deliverable producer must exist in the participant roster");
      } else if (outcome.lifecycle === "succeeded") {
        const successfulProducer =
          producer.status === "success" || producer.status === "success_with_warnings";
        const honestNonCleanProducer =
          (producer.status === "blocked" || producer.status === "failed") &&
          (outcome.review === "blocked" ||
            outcome.checks === "failed" ||
            outcome.work_state?.state === "needs_input" ||
            outcome.work_state?.state === "incomplete");
        if (!successfulProducer && !honestNonCleanProducer) {
          violations.push("deliverable producer must have a successful participant status");
        }
        if (!producer.deliverable_present) {
          violations.push("deliverable producer must record deliverable_present=true");
        }
      }
    }
  } else if (deliverable.producer_attempt_id !== null) {
    violations.push("an absent deliverable cannot identify a producer attempt");
  }
  if (
    outcome.lifecycle === "succeeded" &&
    outcome.review !== "blocked" &&
    facts.mode === "plan" &&
    !deliverable.present
  ) {
    violations.push("a succeeded plan must have a canonical deliverable");
  }

  const plannerCount = participants.attempts.filter((p) => p.role === "planner").length;
  if (participants.planners !== plannerCount) {
    violations.push(
      `participants.planners=${participants.planners} does not match planner roles=${plannerCount}`,
    );
  }

  if (gates.required > gates.total) {
    violations.push("gates.required cannot exceed gates.total");
  }
  if (!gates.configured) {
    if (gates.total !== 0 || gates.required !== 0) {
      violations.push("an unconfigured gate set must have zero total and required gates");
    }
    if (gates.executed || gates.state !== "not_configured" || gates.receipt_attempt_id !== null) {
      violations.push("an unconfigured gate set cannot be executed or carry a receipt");
    }
    // outcome.checks aggregates ALL deterministic checks — configured contract
    // gates, FinalVerifier, and the protected live apply — while gates.*
    // describes only the CONFIGURED contract gates. With zero configured gates
    // the checks axis may therefore still fail closed (final verify failed,
    // live delivery refused); what it can never do is claim a green result
    // that no configured gate produced.
    if (outcome.checks === "passed") {
      violations.push("unconfigured gates cannot claim outcome.checks=passed");
    }
  } else {
    if (gates.total === 0) violations.push("a configured gate set must contain at least one gate");
    if (gates.state === "not_configured") {
      violations.push("configured gates cannot have state=not_configured");
    }
    if (gates.executed !== (gates.receipt_attempt_id !== null)) {
      violations.push("gate execution and receipt identity must be present together");
    }
    if (gates.state === "passed" || gates.state === "failed") {
      if (!gates.executed || gates.receipt_attempt_id === null) {
        violations.push("passed/failed gates require execution and a receipt attempt");
      }
    }
    if (
      outcome.lifecycle === "succeeded" &&
      gates.receipt_attempt_id !== null &&
      deliverable.producer_attempt_id !== null &&
      gates.receipt_attempt_id !== deliverable.producer_attempt_id &&
      gates.receipt_attempt_id !== "final-verify"
    ) {
      violations.push(
        "a succeeded run's gate receipt must belong to its deliverable producer or final verify",
      );
    }
    if (gates.state === "passed" && outcome.checks !== "passed") {
      violations.push("passed gates require outcome.checks=passed");
    }
    if ((gates.state === "failed" || gates.state === "skipped") && outcome.checks !== "failed") {
      violations.push("failed/skipped configured gates require fail-closed outcome.checks=failed");
    }
  }

  if (review.state !== outcome.review) {
    violations.push("review.state must match outcome.review");
  }
  if (review.blockers !== review.blocker_ids.length) {
    violations.push("review.blockers must match review.blocker_ids length");
  }
  if (new Set(review.blocker_ids).size !== review.blocker_ids.length) {
    violations.push("review.blocker_ids must be unique");
  }
  if (review.blockers > 0 && review.state !== "blocked") {
    violations.push("blocking finding ids require review.state=blocked");
  }
  if (outcome.reason === "checks_failed" && outcome.checks !== "failed") {
    violations.push("reason=checks_failed requires outcome.checks=failed");
  }
  if (outcome.reason === "review_blocked" && outcome.review !== "blocked") {
    violations.push("reason=review_blocked requires outcome.review=blocked");
  }
  if (outcome.reason === "no_changes" && !outcome.noChanges) {
    violations.push("reason=no_changes requires outcome.noChanges=true");
  }
  const needsInput = outcome.work_state?.state === "needs_input";
  if (outcome.lifecycle === "succeeded" && (outcome.reason === "input_required") !== needsInput) {
    violations.push("reason=input_required iff outcome.work_state.state=needs_input");
  }
  const workIncomplete = outcome.work_state?.state === "incomplete";
  if (
    outcome.lifecycle === "succeeded" &&
    (outcome.reason === "work_incomplete") !== workIncomplete
  ) {
    violations.push("reason=work_incomplete iff outcome.work_state.state=incomplete");
  }
  const lifecycleReasons: Record<
    RunFacts["outcome"]["lifecycle"],
    ReadonlySet<RunFacts["outcome"]["reason"]>
  > = {
    succeeded: new Set([
      null,
      "no_changes",
      "review_blocked",
      "checks_failed",
      "input_required",
      "work_incomplete",
    ]),
    failed: new Set([
      "harness_failed",
      "budget_exhausted",
      "budget_overshoot",
      "cost_unverifiable",
      "not_converged",
      "stuck_no_progress",
      "work_report_contract",
    ]),
    cancelled: new Set(["user_cancelled", "wall_clock_exceeded"]),
    interrupted: new Set(["crash_interrupted", "context_capacity_exhausted"]),
  };
  if (!lifecycleReasons[outcome.lifecycle].has(outcome.reason)) {
    violations.push(
      `reason=${outcome.reason ?? "null"} is incompatible with lifecycle=${outcome.lifecycle}`,
    );
  }
  if (apply.operator_decision_present && !needsDecision(outcome, false)) {
    violations.push("an operator decision is valid only for a needs-decision outcome");
  }
  const actionIds = facts.required_actions.map((action) => action.id);
  if (new Set(actionIds).size !== actionIds.length) {
    violations.push("required_actions ids must be unique");
  }
  const expectedActions = requiredActionsFor(outcome, apply.operator_decision_present);
  if (JSON.stringify(facts.required_actions) !== JSON.stringify(expectedActions)) {
    violations.push("required_actions must equal the canonical terminal outcome projection");
  }
  if (apply.eligibility?.eligible) {
    if (facts.mode !== "agent") {
      violations.push("apply eligibility can be true only for agent mode");
    }
    if (!deliverable.present || deliverable.kind !== "patch") {
      violations.push("apply eligibility can be true only for a patch deliverable");
    }
    if (outcome.lifecycle !== "succeeded") {
      violations.push("apply eligibility cannot be true for a non-succeeded lifecycle");
    }
    if (outcome.noChanges) {
      violations.push("apply eligibility cannot be true when outcome.noChanges=true");
    }
    if (outcome.work_state?.state === "needs_input" || outcome.work_state?.state === "incomplete") {
      violations.push("apply eligibility cannot bypass an unfinished work_state");
    }
    if (!apply.operator_decision_present && outcome.review !== "approved") {
      violations.push(
        "apply eligibility without an operator decision requires outcome.review=approved",
      );
    }
    if (!apply.operator_decision_present && outcome.checks === "failed") {
      violations.push("apply eligibility without an operator decision cannot bypass failed checks");
    }
    if (facts.required_actions.length > 0) {
      violations.push("apply eligibility cannot be true while required actions remain");
    }
    if (apply.eligibility.reason !== null || apply.eligibility.requiredAction !== null) {
      violations.push("eligible apply projection cannot carry refusal guidance");
    }
    const baseEligibilityState =
      outcome.review === "blocked" || outcome.checks === "failed"
        ? "needs_review"
        : outcome.review === "not_run" || outcome.checks === "not_configured"
          ? "not_verified"
          : outcome.noChanges
            ? "no_changes"
            : "ok";
    const allowedEligibilityStates = apply.operator_decision_present
      ? new Set(["needs_review", "verify_pending"])
      : new Set([baseEligibilityState]);
    if (
      apply.eligibility.state === null ||
      !allowedEligibilityStates.has(apply.eligibility.state)
    ) {
      violations.push("eligible apply projection must use its canonical eligibility state");
    }
  }

  if (violations.length > 0) throw new RunFactsInvariantError(violations);
  return facts;
}
