import { z } from "zod";

/**
 * Typed plan-question artifacts (v3 plan lifecycle, D17/D31): the planner's
 * tagged `## Open Questions` block is parsed by the ENGINE into
 * `final/questions.json`, and readiness is DERIVED from that artifact by one
 * server-side projection — surfaces consume the projection, never re-parse.
 */

export const PlanQuestionKind = z
  .enum(["single", "multi", "text"])
  .describe("Question kind: pick exactly one, pick one or more, or free text.");
export type PlanQuestionKind = z.infer<typeof PlanQuestionKind>;

export const PlanQuestionOption = z
  .object({
    id: z.string().min(1).describe("Stable option id within the question."),
    label: z.string().min(1).describe("Option label shown to the user."),
  })
  .strict()
  .describe("One selectable option of a plan question.");
export type PlanQuestionOption = z.infer<typeof PlanQuestionOption>;

export const PlanQuestion = z
  .object({
    id: z.string().min(1).describe("Stable question id within the plan revision."),
    kind: PlanQuestionKind,
    prompt: z.string().min(1).describe("The question text."),
    options: z
      .array(PlanQuestionOption)
      .default([])
      .describe("Options for single/multi questions; empty for free text."),
    allow_text: z
      .boolean()
      .default(false)
      .describe("True when a free-text answer is accepted (text questions)."),
  })
  .strict()
  .describe("One open question surfaced by a plan revision.");
export type PlanQuestion = z.infer<typeof PlanQuestion>;

export const PlanQuestionsArtifact = z
  .object({
    /** Whether a tagged Open Questions block was found at all. `none_found`
     * is DISCLOSED, never silently equated with "ready" (zen: honest states). */
    parse: z
      .enum(["found", "none_found"])
      .describe("Whether the planner emitted a parseable Open Questions block."),
    questions: z.array(PlanQuestion).default([]).describe("Open questions of this plan revision."),
  })
  .strict()
  .describe("Engine-parsed open questions of one plan run (final/questions.json).");
export type PlanQuestionsArtifact = z.infer<typeof PlanQuestionsArtifact>;

export const PlanReadinessState = z
  .enum(["ready", "needs_answers", "unverified"])
  .describe(
    "Derived plan readiness: ready (block parsed, zero open questions), needs_answers (open questions remain), unverified (no parseable block — the planner ignored the format).",
  );
export type PlanReadinessState = z.infer<typeof PlanReadinessState>;

export const PlanReadiness = z
  .object({
    state: PlanReadinessState,
    questionCount: z.number().int().nonnegative().default(0),
  })
  .strict()
  .describe("Server-derived readiness of a plan run (one derivation owner; D17).");
export type PlanReadiness = z.infer<typeof PlanReadiness>;

/** One council member's role and outcome (INV-031). `primary` is the merger;
 * `member` is a draft-only participant. A council with one surviving member
 * still merges (the primary normalizes the format + extracts questions). */
export const CouncilMember = z
  .object({
    harnessId: z.string().min(1).describe("Harness that drafted (or merged) this member's plan."),
    role: z
      .enum(["primary", "member"])
      .describe("primary = the merger that synthesizes the unified plan; member = draft only."),
    status: z
      .enum(["drafted", "failed", "merged"])
      .describe("drafted = draft landed; merged = this member produced the unified plan; failed."),
    error: z
      .string()
      .nullable()
      .default(null)
      .describe("First redacted draft error; null unless the member failed."),
  })
  .strict()
  .describe("One council member's role and draft/merge outcome.");
export type CouncilMember = z.infer<typeof CouncilMember>;

/** Council membership + merge projection (INV-031), projected from
 * `council/membership.yaml`. Present only for `--council` plan runs; the
 * downstream plan artifacts (final/plan.md, questions.json, readiness) are
 * shape-identical to a solo plan, so this field is purely additive disclosure. */
export const CouncilProjection = z
  .object({
    requested: z.number().int().positive().describe("Requested member count (n; 2..4)."),
    drafted: z.number().int().nonnegative().describe("Members whose draft survived to the merge."),
    degraded: z
      .boolean()
      .default(false)
      .describe("True when fewer members drafted than requested (failures disclosed per member)."),
    mergedBy: z
      .string()
      .nullable()
      .default(null)
      .describe("Harness that produced the unified plan (the primary); null if the merge failed."),
    members: z.array(CouncilMember).default([]).describe("Per-member role and outcome."),
  })
  .strict()
  .describe("Council membership + merge disclosure for a --council plan run.");
export type CouncilProjection = z.infer<typeof CouncilProjection>;

/** THE single derivation authority for plan readiness (declared per the v3
 * plan-lifecycle decision): every surface consumes this projection of
 * final/questions.json; nothing re-parses plan text. */
export function derivePlanReadiness(artifact: PlanQuestionsArtifact): PlanReadiness {
  if (artifact.parse === "none_found") {
    return { state: "unverified", questionCount: 0 };
  }
  return artifact.questions.length === 0
    ? { state: "ready", questionCount: 0 }
    : { state: "needs_answers", questionCount: artifact.questions.length };
}
