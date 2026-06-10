import { z } from "zod";
import { AccessProfile, DirtyPolicy, ExternalContextPolicy, Id, IsoTimestamp, ModeKind, SchemaVersion } from "./primitives.js";
import { Portfolio } from "./budget.js";
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
  spec: z
    .object({
      id: Id.optional(),
      hash: z.string().optional(),
      path: z.string().optional(),
      env_profile: z.string().optional(),
    })
    .optional(),
  success_criteria: z.array(SuccessCriterion).default([]),
  non_goals: z.array(z.string()).default([]),
  forbidden_approaches: z.array(z.string()).default([]),
  decided_tradeoffs: z.array(z.string()).default([]),
  constraints: TaskConstraints.default({}),
  tests: z.object({ commands: z.array(TestCommand).default([]) }).default({ commands: [] }),
  delivery: DeliveryPolicy.default({}),
  access: z
    .object({
      requested_profile: AccessProfile.default("workspace_write"),
      /** Profile actually enforced by the engine (mode/trust clamps applied; never client-supplied). */
      effective_profile: AccessProfile.default("workspace_write"),
    })
    .default({
      requested_profile: "workspace_write",
      effective_profile: "workspace_write",
    }),
  external_context: z
    .object({
      policy: ExternalContextPolicy.default("auto"),
      web_required: z.boolean().default(false),
      /** Mode the selected route actually executes (disclosed upgrades, e.g. claude cached->live). */
      effective_mode: ExternalContextPolicy.default("auto"),
    })
    .default({ policy: "auto", web_required: false, effective_mode: "auto" }),
  tool_permission_policy: z
    .object({
      web: ExternalContextPolicy.default("auto"),
      allow: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
    })
    .default({ web: "auto", allow: [], deny: [] }),
  budget: z
    .object({
      portfolio: Portfolio.default("subscription-first"),
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
