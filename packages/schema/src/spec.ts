import { z } from "zod";
import { Id, IsoTimestamp, SchemaVersion } from "./primitives.js";
import { TestCommand } from "./task.js";

/**
 * SpecPack — the frozen, versioned, diffable specification produced by the
 * spec interview (the hierarchical clarify-quiz). It is the SSOT a run is held
 * to: a SpecPack maps deterministically into a TaskContract. Unlike spec-first
 * tools that regenerate an opaque blob, this is spec-anchored: versioned with
 * section-level diffs across revisions.
 */

export const InterviewQuestionKind = z
  .enum(["single", "multi", "text"])
  .describe("Answer shape of an interview question: single choice, multiple choice, or free text.");
export type InterviewQuestionKind = z.infer<typeof InterviewQuestionKind>;

export const InterviewOption = z
  .object({
    id: Id.describe("Option id."),
    label: z.string().describe("Human-readable option label."),
  })
  .describe("One selectable option of an interview question.");
export type InterviewOption = z.infer<typeof InterviewOption>;

/** One quiz card. `tier` expresses the hierarchical depth (0 = foundational). */
export const InterviewQuestion = z
  .object({
    id: Id.describe("Question id."),
    tier: z.number().int().nonnegative().default(0).describe("Hierarchical depth of the question (0 = foundational)."),
    prompt: z.string().describe("The question text shown to the user."),
    kind: InterviewQuestionKind.default("single"),
    options: z.array(InterviewOption).default([]).describe("Selectable options; empty for pure free-text questions."),
    /** Whether free-text is accepted in addition to / instead of options. */
    allow_text: z.boolean().default(false).describe("Whether free-text is accepted in addition to or instead of options."),
    rationale: z.string().optional().describe("Why this question matters for the spec."),
  })
  .describe("One quiz card of the spec interview.");
export type InterviewQuestion = z.infer<typeof InterviewQuestion>;

export const InterviewAnswer = z
  .object({
    question_id: Id.describe("Id of the question being answered."),
    option_ids: z.array(Id).default([]).describe("Ids of the selected options."),
    text: z.string().nullable().default(null).describe("Free-text answer; null when only options were selected."),
  })
  .describe("The user's answer to one interview question.");
export type InterviewAnswer = z.infer<typeof InterviewAnswer>;

/**
 * An explicit unresolved ambiguity (NEEDS_CLARIFICATION). The interview refuses
 * to freeze while any of these are `open` — nothing is silently guessed.
 */
export const ClarificationItem = z
  .object({
    id: Id.describe("Clarification id."),
    claim: z.string().describe("The ambiguous claim or open question that needs resolution."),
    status: z.enum(["open", "resolved"]).default("open").describe("Whether the ambiguity is still open or has been resolved."),
    resolution: z.string().nullable().default(null).describe("How the ambiguity was resolved; null while open."),
  })
  .describe("An explicit unresolved ambiguity (NEEDS_CLARIFICATION); the interview refuses to freeze while any is open.");
export type ClarificationItem = z.infer<typeof ClarificationItem>;

/** Acceptance criterion in EARS style ("WHEN <cond>, THE SYSTEM SHALL <behavior>"). */
export const SpecAcceptanceCriterion = z
  .object({
    id: Id.describe("Criterion id."),
    behavior: z.string().describe("Required behavior, EARS style (WHEN <condition>, THE SYSTEM SHALL <behavior>)."),
    required: z.boolean().default(true).describe("Whether this criterion is required (vs advisory)."),
  })
  .describe("Acceptance criterion in EARS style.");
export type SpecAcceptanceCriterion = z.infer<typeof SpecAcceptanceCriterion>;

/** A dependency-ordered task in the implementation checklist. */
export const SpecTask = z
  .object({
    id: Id.describe("Task id."),
    title: z.string().describe("Human-readable task title."),
    depends_on: z.array(Id).default([]).describe("Ids of tasks that must complete first."),
    done: z.boolean().default(false).describe("Whether the task has been completed."),
  })
  .describe("A dependency-ordered task in the implementation checklist.");
export type SpecTask = z.infer<typeof SpecTask>;

export const SpecConstraints = z
  .object({
    /** Spec-owned protected paths can raise review risk; per-run approvals cannot be frozen into a spec. */
    protected_paths: z
      .array(z.string())
      .default([])
      .describe("Spec-owned protected path globs that raise review risk; per-run approvals cannot be frozen into a spec."),
  })
  .strict()
  .describe("Constraints frozen into the spec.");
export type SpecConstraints = z.infer<typeof SpecConstraints>;

const SpecPackBase = z.object({
  schema_version: SchemaVersion,
  id: Id.describe("SpecPack id."),
  created_at: IsoTimestamp.describe("When this SpecPack revision was created."),
  /** Monotonic revision; each freeze increments it (spec-anchored history). */
  version: z.number().int().positive().default(1).describe("Monotonic revision; each freeze increments it."),
  frozen: z.boolean().default(false).describe("Whether the spec is frozen (immutable and runnable)."),
  intent: z
    .object({
      raw: z.string().describe("The user's original request, verbatim."),
      normalized: z.string().optional().describe("Optional normalized restatement of the request."),
    })
    .describe("The user intent this spec captures."),
  summary: z.string().default("").describe("Short human-readable summary of the spec."),
  success_criteria: z.array(SpecAcceptanceCriterion).default([]).describe("Acceptance criteria the implementation is held to."),
  non_goals: z.array(z.string()).default([]).describe("Explicitly out-of-scope outcomes."),
  forbidden_approaches: z.array(z.string()).default([]).describe("Approaches the implementation must not take."),
  decided_tradeoffs: z.array(z.string()).default([]).describe("Tradeoffs already decided during the interview."),
  constraints: SpecConstraints.default({}),
  tests: z.array(TestCommand).default([]).describe("Deterministic test commands frozen into the spec."),
  tasks: z.array(SpecTask).default([]).describe("Dependency-ordered implementation checklist."),
  open_questions: z.array(ClarificationItem).default([]).describe("Unresolved ambiguities; must all be resolved before freezing."),
  interview: z
    .object({
      questions: z.array(InterviewQuestion).default([]).describe("Questions asked during the interview."),
      answers: z.array(InterviewAnswer).default([]).describe("The user's answers."),
    })
    .default({ questions: [], answers: [] })
    .describe("The clarify-quiz transcript this spec was built from."),
});

/**
 * Schema-level invariants (SSOT, enforced on every parse — even when loaded from
 * disk, not just via the engine): a frozen spec cannot carry open clarifications,
 * and a "resolved" clarification must record a non-empty resolution. This makes a
 * frozen-but-ambiguous SpecPack unrepresentable — no silent guessing.
 */
export const SpecPack = SpecPackBase.superRefine((data, ctx) => {
  if (data.frozen && data.open_questions.some((q) => q.status === "open")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["open_questions"],
      message: "a frozen SpecPack cannot have open clarifications",
    });
  }
  data.open_questions.forEach((q, i) => {
    if (q.status === "resolved" && (q.resolution === null || q.resolution.trim() === "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["open_questions", i, "resolution"],
        message: "a resolved clarification must have a non-empty resolution",
      });
    }
  });
}).describe(
  "The frozen, versioned, diffable specification produced by the spec interview; the SSOT a run is held to, mapping deterministically into a TaskContract.",
);
export type SpecPack = z.infer<typeof SpecPack>;
