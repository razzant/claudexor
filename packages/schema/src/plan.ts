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
