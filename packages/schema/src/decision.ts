import { z } from "zod";
import { Id } from "./primitives.js";
import { WorkState } from "./work-report.js";

export const PairwiseComparison = z
  .object({
    candidate_a: Id.describe("First candidate in the comparison."),
    candidate_b: Id.describe("Second candidate in the comparison."),
    criteria: z
      .record(
        z.string(),
        z.object({
          winner: z.enum(["a", "b", "tie"]).describe("Which candidate won this criterion, or tie."),
          reason: z.string().describe("Why this criterion was decided that way."),
        }),
      )
      .describe("Per-criterion verdicts keyed by criterion name."),
  })
  .describe("Pairwise comparison of two race candidates across named criteria.");
export type PairwiseComparison = z.infer<typeof PairwiseComparison>;

/** Deterministic-checks axis (D18: "Checks", the ex-"gates" vocabulary).
 * not_configured is a NAMED state — the old "ungated" collapse (which hid
 * accepted review blockers behind one word) is unrepresentable now. */
export const ChecksState = z
  .enum(["passed", "failed", "not_configured"])
  .describe(
    "Deterministic checks axis: configured project checks passed, failed, or none are configured (a named state, never a stand-in for review results).",
  );
export type ChecksState = z.infer<typeof ChecksState>;

/** Review axis (D18): the cross-family review's verdict, independent of
 * checks and lifecycle. Accepted blockers are ALWAYS `blocked` here. */
export const ReviewState = z
  .enum(["approved", "blocked", "not_run"])
  .describe(
    "Review axis: approved (clean cross-family verified review), blocked (open accepted findings), or not_run.",
  );
export type ReviewState = z.infer<typeof ReviewState>;

/** Typed reason on non-clean terminals (replaces the old reason-as-status
 * values exhausted/not_converged/stuck_no_progress/...). Null on a clean
 * success. */
export const RunReason = z
  .enum([
    "harness_failed",
    "no_changes",
    "review_blocked",
    "checks_failed",
    "budget_exhausted",
    "budget_overshoot",
    "cost_unverifiable",
    "not_converged",
    "stuck_no_progress",
    "wall_clock_exceeded",
    "user_cancelled",
    "crash_interrupted",
    // D-16 work_state / context reasons.
    "input_required",
    "work_incomplete",
    "context_capacity_exhausted",
    "work_report_contract",
  ])
  .describe("Typed reason qualifying a non-clean terminal; null on a clean success.");
export type RunReason = z.infer<typeof RunReason>;

/** The v3 terminal truth (D8): independent axes instead of one mixed enum.
 * lifecycle says how far the PROCESS got; noChanges/checks/review say what
 * the work amounted to; reason qualifies; delivery lives separately on
 * RunApplyState. Every surface projects these through status-projection.ts. */
export const RunOutcomeFacts = z
  .object({
    lifecycle: z
      .enum(["succeeded", "failed", "cancelled", "interrupted"])
      .describe("Terminal lifecycle of the run."),
    noChanges: z
      .boolean()
      .default(false)
      .describe("True when the run finished without changing any files (the ex no_op fact)."),
    checks: ChecksState.default("not_configured"),
    review: ReviewState.default("not_run"),
    reason: RunReason.nullable()
      .default(null)
      .describe("Typed reason qualifying a non-clean terminal; null on a clean success."),
    /**
     * D-16 work_state axis (INV-116): the model-attested work outcome,
     * orthogonal to `lifecycle`. Absent on runs with no work_report transport
     * (legacy/pre-D16 terminals). A `needs_input`/`incomplete` state makes an
     * otherwise-succeeded run non-applyable and forces a non-zero CLI exit via
     * the outcome-aware exit projection, WITHOUT flipping the lifecycle.
     */
    work_state: WorkState.optional().describe(
      "D-16 model-attested work outcome, orthogonal to lifecycle; a needs_input/incomplete state vetoes applyability and exit 0. Absent on runs with no work_report transport.",
    ),
  })
  .strict()
  .describe("Independent terminal outcome axes of a run (D8/D18).");
export type RunOutcomeFacts = z.infer<typeof RunOutcomeFacts>;

export const ApplyRecommendation = z
  .enum(["apply", "inspect", "continue", "human_review"])
  .describe(
    "Recommended next action for the run's work product: apply it, inspect first, continue working, or get human review.",
  );
export type ApplyRecommendation = z.infer<typeof ApplyRecommendation>;

// What backed a `ready`/applyable outcome: a clean cross-family verified review,
// or both deterministic gates AND that review. `none` for non-applyable outcomes.
// Surfaced honestly so a no-test run adopted on review evidence never reads as
// "tests passed" (CLAUDEXOR_BIBLE §5 evidence, §11 delivery). A gates-ONLY basis
// is intentionally absent: a `ready` run always carries a verified review (a
// gate-pass without cross-family verification resolves to review_not_run, not
// ready), so the enum ships only values the arbitrator actually produces.
export const VerificationBasis = z
  .enum(["none", "cross_family_review", "both"])
  .describe(
    "What backed an applyable outcome: none (non-applyable), cross_family_review (a clean cross-family verified review), or both (deterministic gates and that review).",
  );
export type VerificationBasis = z.infer<typeof VerificationBasis>;

/**
 * FinalVerifier record (INV-115): the winner's patch was applied onto a
 * FRESH worktree at the candidate's own base sha and the deterministic gates
 * were re-run there. Producer: orchestrator (race adoption preflight).
 * Consumers: validateApplyGate (a failed final verify refuses apply) and the
 * inspect/UI surfaces. Deterministic-first: no model involvement.
 */
export const FinalVerifyRecord = z
  .object({
    attempted: z.boolean().describe("Whether the final verify was attempted."),
    /** Base the verify tree was created from (the winner envelope's base_sha). */
    base_sha: z
      .string()
      .nullable()
      .default(null)
      .describe("Base SHA the verify tree was created from (the winner envelope's base)."),
    applied_cleanly: z
      .boolean()
      .nullable()
      .default(null)
      .describe("Whether the patch applied cleanly onto the fresh tree; null when not attempted."),
    gates_passed: z
      .boolean()
      .nullable()
      .default(null)
      .describe("Whether the re-run deterministic gates passed; null when not attempted."),
    gates: z
      .array(
        z.object({
          id: z.string().describe("Gate id."),
          status: z.string().describe("Gate status."),
        }),
      )
      .default([])
      .describe("Per-gate re-run results."),
    duration_ms: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .default(null)
      .describe("How long the verify took, in milliseconds."),
    /** Typed reason when attempted=false (e.g. no_patch, no_base_sha) or a failure detail. */
    reason: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "Typed reason when attempted=false (e.g. no_patch, no_base_sha) or a failure detail.",
      ),
  })
  .describe(
    "FinalVerifier record: the winner's patch was applied onto a fresh worktree at the candidate's own base SHA and the deterministic gates were re-run there; no model involvement.",
  );
export type FinalVerifyRecord = z.infer<typeof FinalVerifyRecord>;

export const DecisionRecord = z
  .object({
    winner: Id.nullable().describe("Winning attempt/candidate id; null when nothing won."),
    /** The independent terminal axes (D8) — replaces the old mixed
     * status/outcome pair; the collapse classes (`ungated`, gate failures
     * masked by `review_not_run`) are unrepresentable. */
    facts: RunOutcomeFacts,
    why_winner: z.string().default("").describe("Why the winner was chosen."),
    why_not_others: z
      .record(z.string(), z.string())
      .default({})
      .describe("Per-candidate reasons the others lost, keyed by candidate id."),
    // QA-028 transparency: the full, versioned ranking scorecard so a decision is
    // self-contained. `score_axes` names every compared ranking axis in
    // precedence order; `ranking_scorecard` carries every axis value for every
    // candidate; `decisive_axis` names the FIRST axis that separated the winner
    // from the runner-up (null on an exact tie, where route order — disclosed in
    // final_checks — decided). Producer: arbitration. A hidden non-tie axis can
    // no longer read as an unexplained pick among equals.
    ranking_policy_version: z
      .number()
      .int()
      .positive()
      .default(1)
      .describe("Version of the ranking axis registry the scorecard was produced under."),
    score_axes: z
      .array(z.string())
      .default([])
      .describe("Every compared ranking axis key, in precedence (best-first) order."),
    ranking_scorecard: z
      .array(
        z.object({
          attempt_id: Id.describe("Candidate attempt id (stable key; labels may localize)."),
          label: z.string().describe("Anonymized candidate label shown to the arbiter."),
          axes: z
            .record(z.string(), z.string())
            .describe("Formatted value for every ranking axis, keyed by axis key."),
        }),
      )
      .default([])
      .describe("Per-candidate full ranking scorecard, in final ranking order."),
    decisive_axis: z
      .object({
        key: z.string().describe("The first ranking axis that separated winner from runner-up."),
        winner_value: z.string().describe("The winner's formatted value on the decisive axis."),
        runner_up_value: z
          .string()
          .describe("The runner-up's formatted value on the decisive axis."),
      })
      .nullable()
      .default(null)
      .describe(
        "The axis that actually decided the winner vs the runner-up; null on an exact tie (route order decided, disclosed in final_checks).",
      ),
    accepted_risks: z
      .array(z.string())
      .default([])
      .describe("Risks explicitly accepted in the decision."),
    final_checks: z
      .array(z.string())
      .default([])
      .describe("Final checks performed before the decision."),
    evidence_facts: z
      .array(z.string())
      .default([])
      .describe("Evidence facts the decision rests on."),
    budget_summary: z
      .object({
        // Total settled spend. `estimated` is true when any of it is token-derived
        // (e.g. codex) rather than natively reported — never present an estimate as exact.
        spend_usd: z
          .number()
          .nullable()
          .default(null)
          .describe("Total settled spend in USD; null when unknown."),
        estimated: z
          .boolean()
          .default(false)
          .describe("True when any of the spend is token-derived rather than natively reported."),
      })
      .default({ spend_usd: null, estimated: false })
      .describe("Settled spend for the run; estimates are disclosed, never presented as exact."),
    apply_recommendation: ApplyRecommendation.default("inspect"),
    // Honest disclosure of WHAT verified an applyable run (gates, cross-family
    // review, or both). Producer: arbitration. Consumer: CLI/UI apply affordance.
    verification_basis: VerificationBasis.default("none"),
    // Present only for write runs with a patch where the verifier ran (or
    // recorded WHY it did not). Absent for answer-only/no-patch runs.
    final_verify: FinalVerifyRecord.nullable()
      .default(null)
      .describe(
        "Final verify record; present only for write runs with a patch (or a recorded reason why the verifier did not run).",
      ),
  })
  .describe(
    "The arbitration decision for a run: winner, outcome axes, reasons, spend, and the verification that backs applyability.",
  );
export type DecisionRecord = z.infer<typeof DecisionRecord>;
