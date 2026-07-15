import { z } from "zod";
import { Id } from "./primitives.js";

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

export const RunStatus = z
  .enum([
    "success",
    "no_op",
    "ungated",
    "review_not_run",
    "blocked",
    "failed",
    "interrupted_unknown",
    "cost_unverifiable",
    "exhausted_overshoot",
    "exhausted",
    "not_converged",
    "stuck_no_progress",
    "cancelled",
  ])
  .describe(
    "Terminal status of a run, including truthful blocked, interrupted-unknown, cost-unverifiable, overshoot, exhaustion, non-convergence, failure, and cancellation outcomes.",
  );
export type RunStatus = z.infer<typeof RunStatus>;

export const ApplyRecommendation = z
  .enum(["apply", "inspect", "continue", "split_task", "human_review"])
  .describe(
    "Recommended next action for the run's work product: apply it, inspect first, continue working, split the task, or get human review.",
  );
export type ApplyRecommendation = z.infer<typeof ApplyRecommendation>;

export const DecisionOutcome = z
  .enum(["ready", "no_op", "ungated", "review_not_run", "blocked"])
  .describe(
    "Arbitration outcome for the winning candidate: ready (verified applyable), no_op (no changes), ungated (no gates configured), review_not_run, or blocked.",
  );
export type DecisionOutcome = z.infer<typeof DecisionOutcome>;

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
    status: RunStatus,
    outcome: DecisionOutcome.default("blocked"),
    why_winner: z.string().default("").describe("Why the winner was chosen."),
    why_not_others: z
      .record(z.string(), z.string())
      .default({})
      .describe("Per-candidate reasons the others lost, keyed by candidate id."),
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
    "The arbitration decision for a run: winner, status/outcome, reasons, spend, and the verification that backs applyability.",
  );
export type DecisionRecord = z.infer<typeof DecisionRecord>;
