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

export const DecisionRecord = z.object({
  winner: Id.nullable(),
  confidence: z.number().min(0).max(1).default(0),
  status: RunStatus,
  why_winner: z.string().default(""),
  why_not_others: z.record(z.string(), z.string()).default({}),
  accepted_risks: z.array(z.string()).default([]),
  final_checks: z.array(z.string()).default([]),
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
