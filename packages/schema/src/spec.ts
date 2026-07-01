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

export const InterviewQuestionKind = z.enum(["single", "multi", "text"]);
export type InterviewQuestionKind = z.infer<typeof InterviewQuestionKind>;

export const InterviewOption = z.object({
  id: Id,
  label: z.string(),
});
export type InterviewOption = z.infer<typeof InterviewOption>;

/** One quiz card. `tier` expresses the hierarchical depth (0 = foundational). */
export const InterviewQuestion = z.object({
  id: Id,
  tier: z.number().int().nonnegative().default(0),
  prompt: z.string(),
  kind: InterviewQuestionKind.default("single"),
  options: z.array(InterviewOption).default([]),
  /** Whether free-text is accepted in addition to / instead of options. */
  allow_text: z.boolean().default(false),
  rationale: z.string().optional(),
});
export type InterviewQuestion = z.infer<typeof InterviewQuestion>;

export const InterviewAnswer = z.object({
  question_id: Id,
  option_ids: z.array(Id).default([]),
  text: z.string().nullable().default(null),
});
export type InterviewAnswer = z.infer<typeof InterviewAnswer>;

/**
 * An explicit unresolved ambiguity (NEEDS_CLARIFICATION). The interview refuses
 * to freeze while any of these are `open` — nothing is silently guessed.
 */
export const ClarificationItem = z.object({
  id: Id,
  claim: z.string(),
  status: z.enum(["open", "resolved"]).default("open"),
  resolution: z.string().nullable().default(null),
});
export type ClarificationItem = z.infer<typeof ClarificationItem>;

/** Acceptance criterion in EARS style ("WHEN <cond>, THE SYSTEM SHALL <behavior>"). */
export const SpecAcceptanceCriterion = z.object({
  id: Id,
  behavior: z.string(),
  required: z.boolean().default(true),
});
export type SpecAcceptanceCriterion = z.infer<typeof SpecAcceptanceCriterion>;

/** A dependency-ordered task in the implementation checklist. */
export const SpecTask = z.object({
  id: Id,
  title: z.string(),
  depends_on: z.array(Id).default([]),
  done: z.boolean().default(false),
});
export type SpecTask = z.infer<typeof SpecTask>;

export const SpecConstraints = z
  .object({
    /** Spec-owned protected paths can raise review risk; per-run approvals cannot be frozen into a spec. */
    protected_paths: z.array(z.string()).default([]),
  })
  .strict();
export type SpecConstraints = z.infer<typeof SpecConstraints>;

const SpecPackBase = z.object({
  schema_version: SchemaVersion,
  id: Id,
  created_at: IsoTimestamp,
  /** Monotonic revision; each freeze increments it (spec-anchored history). */
  version: z.number().int().positive().default(1),
  frozen: z.boolean().default(false),
  intent: z.object({
    raw: z.string(),
    normalized: z.string().optional(),
  }),
  summary: z.string().default(""),
  success_criteria: z.array(SpecAcceptanceCriterion).default([]),
  non_goals: z.array(z.string()).default([]),
  forbidden_approaches: z.array(z.string()).default([]),
  decided_tradeoffs: z.array(z.string()).default([]),
  constraints: SpecConstraints.default({}),
  tests: z.array(TestCommand).default([]),
  tasks: z.array(SpecTask).default([]),
  open_questions: z.array(ClarificationItem).default([]),
  interview: z
    .object({
      questions: z.array(InterviewQuestion).default([]),
      answers: z.array(InterviewAnswer).default([]),
    })
    .default({ questions: [], answers: [] }),
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
});
export type SpecPack = z.infer<typeof SpecPack>;
