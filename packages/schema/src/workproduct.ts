import { z } from "zod";
import { Id } from "./primitives.js";

export const MutationMode = z.enum([
  "native_live",
  "envelope_live",
  "artifact_only",
  "branch",
  "commit",
  "pr",
  "new_repo_materialize",
  "native",
]);
export type MutationMode = z.infer<typeof MutationMode>;

export const ApplyPolicy = z.enum([
  "never",
  "ask",
  "auto_if_green",
  "auto_if_consilium_approves",
  "always",
  "native",
]);
export type ApplyPolicy = z.infer<typeof ApplyPolicy>;

export const ApplyScope = z.enum(["all", "selected_files", "selected_hunks", "interactive"]);
export type ApplyScope = z.infer<typeof ApplyScope>;

export const MaterializePolicy = z.enum(["ask", "auto_if_green", "always"]);
export type MaterializePolicy = z.infer<typeof MaterializePolicy>;

export const DeliveryPolicy = z.object({
  mutation_mode: MutationMode.default("envelope_live"),
  apply_policy: ApplyPolicy.default("ask"),
  apply_scope: ApplyScope.default("all"),
  materialize_policy: MaterializePolicy.default("ask"),
});
export type DeliveryPolicy = z.infer<typeof DeliveryPolicy>;

export const WorkProductKind = z.enum([
  "patch",
  "new_repo",
  "branch",
  "commit",
  "pr",
  "report",
  "artifact_bundle",
  "benchmark_submission",
]);
export type WorkProductKind = z.infer<typeof WorkProductKind>;

export const WorkProduct = z.object({
  id: Id,
  kind: WorkProductKind,
  source_task_id: Id,
  producer_attempt_id: Id.optional(),
  manifest_path: z.string().optional(),
  evidence_dir: z.string().optional(),
  decision_record_path: z.string().optional(),
  /** Kind-specific payload (validated loosely here; specialized per kind by callers). */
  files: z.record(z.string(), z.string()).default({}),
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type WorkProduct = z.infer<typeof WorkProduct>;
