import { z } from "zod";
import { Id } from "./primitives.js";

export const PairwiseComparison = z.object({
  candidate_a: Id,
  candidate_b: Id,
  criteria: z.record(
    z.string(),
    z.object({
      winner: z.enum(["a", "b", "tie"]),
      reason: z.string(),
    }),
  ),
});
export type PairwiseComparison = z.infer<typeof PairwiseComparison>;

export const RunStatus = z.enum([
  "success",
  "no_op",
  "ungated",
  "review_not_run",
  "blocked",
  "not_converged",
  "failed",
  "exhausted",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const ApplyRecommendation = z.enum([
  "apply",
  "inspect",
  "continue",
  "split_task",
  "human_review",
]);
export type ApplyRecommendation = z.infer<typeof ApplyRecommendation>;

export const DecisionOutcome = z.enum([
  "ready",
  "no_op",
  "ungated",
  "review_not_run",
  "blocked",
]);
export type DecisionOutcome = z.infer<typeof DecisionOutcome>;

export const DecisionRecord = z.object({
  winner: Id.nullable(),
  status: RunStatus,
  outcome: DecisionOutcome.default("blocked"),
  why_winner: z.string().default(""),
  why_not_others: z.record(z.string(), z.string()).default({}),
  accepted_risks: z.array(z.string()).default([]),
  final_checks: z.array(z.string()).default([]),
  evidence_facts: z.array(z.string()).default([]),
  budget_summary: z
    .object({
      // Total settled spend. `estimated` is true when any of it is token-derived
      // (e.g. codex) rather than natively reported — never present an estimate as exact.
      spend_usd: z.number().nullable().default(null),
      estimated: z.boolean().default(false),
    })
    .default({ spend_usd: null, estimated: false }),
  apply_recommendation: ApplyRecommendation.default("inspect"),
});
export type DecisionRecord = z.infer<typeof DecisionRecord>;
