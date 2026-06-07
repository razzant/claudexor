import { z } from "zod";
import { AccessProfile, DirtyPolicy, Id, IsoTimestamp, ModeKind, SchemaVersion } from "./primitives.js";
import { DeliveryPolicy } from "./workproduct.js";

export const SuccessCriterion = z.object({
  id: Id,
  text: z.string(),
  required: z.boolean().default(true),
});
export type SuccessCriterion = z.infer<typeof SuccessCriterion>;

export const TestCommand = z.object({
  id: Id,
  command: z.string(),
  required: z.boolean().default(true),
});
export type TestCommand = z.infer<typeof TestCommand>;

export const TaskConstraints = z.object({
  allowed_paths: z.array(z.string()).default([]),
  forbidden_paths: z.array(z.string()).default([]),
  protected_paths: z.array(z.string()).default([]),
  compatibility: z.array(z.string()).default([]),
  style: z.array(z.string()).default([]),
});
export type TaskConstraints = z.infer<typeof TaskConstraints>;

export const ConvergencePredicate = z.object({
  require_tests_pass: z.boolean().default(true),
  require_no_accepted_block_open: z.boolean().default(true),
  require_no_accepted_fix_first_open: z.boolean().default(true),
  require_rebuttals_not_overturned: z.boolean().default(true),
  require_final_cross_family_clean_review: z.boolean().default(true),
  require_final_diff_stable_after_review: z.boolean().default(true),
});
export type ConvergencePredicate = z.infer<typeof ConvergencePredicate>;

/**
 * Immutable contract describing a single run. Built once, hashed, never mutated.
 */
export const TaskContract = z.object({
  schema_version: SchemaVersion,
  task_id: Id,
  created_at: IsoTimestamp,
  repo: z.object({
    root: z.string(),
    base_ref: z.string(),
    base_sha: z.string().optional(),
    dirty_policy: DirtyPolicy.default("refuse"),
  }),
  mode: z.object({ kind: ModeKind }),
  user_intent: z.object({
    raw: z.string(),
    normalized: z.string().optional(),
  }),
  success_criteria: z.array(SuccessCriterion).default([]),
  non_goals: z.array(z.string()).default([]),
  forbidden_approaches: z.array(z.string()).default([]),
  decided_tradeoffs: z.array(z.string()).default([]),
  constraints: TaskConstraints.default({}),
  tests: z.object({ commands: z.array(TestCommand).default([]) }).default({ commands: [] }),
  delivery: DeliveryPolicy.default({}),
  access: z.object({ profile: AccessProfile.default("workspace_write") }).default({
    profile: "workspace_write",
  }),
  budget: z
    .object({
      portfolio: z.string().default("subscription-first"),
      max_usd: z.number().nullable().default(null),
      max_attempts: z.number().int().nullable().default(null),
    })
    .default({}),
  convergence: ConvergencePredicate.default({}),
  context_policy: z
    .object({ no_silent_truncation: z.boolean().default(true) })
    .default({ no_silent_truncation: true }),
});
export type TaskContract = z.infer<typeof TaskContract>;
