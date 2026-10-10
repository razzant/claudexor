import { z } from "zod/v3";
import { DirtyPolicy, Id, IsoTimestamp } from "./primitives.js";
import { WorkspaceKind, WorkspaceScopePath } from "./files-manifest.js";

/**
 * The execution tree and its scoped HOME/configs. Git retains repository
 * identity; ordinary directory execution records a selected copy or live path.
 */
export const WorkspaceEnvelope = z
  .object({
    id: Id.describe("Envelope id."),
    task_id: Id.describe("Task the envelope belongs to."),
    attempt_id: Id.describe("Attempt the envelope belongs to."),
    repo_root: z.string().describe("Absolute path of the source repository root."),
    base_ref: z.string().nullable().describe("Git base ref; null for directory execution."),
    base_sha: z
      .string()
      .nullable()
      .default(null)
      .describe("Resolved base commit SHA; null when not recorded."),
    worktree_path: z
      .string()
      .describe("Absolute actual execution directory, whether Git-backed or plain."),
    branch_name: z
      .string()
      .nullable()
      .describe("Clone-local branch; null for directory execution."),
    workspace_kind: WorkspaceKind.optional(),
    scope_paths: z.array(WorkspaceScopePath).optional(),
    home_dir: z
      .string()
      .describe("Scoped HOME directory for the harness process (kept outside the checkout)."),
    harness_config_dirs: z
      .record(z.string(), z.string())
      .default({})
      .describe(
        "Scoped per-harness config directories keyed by harness id (kept outside the checkout).",
      ),
    policy_profile: z
      .string()
      .default("workspace_write")
      .describe("Access profile the envelope enforces."),
    dirty_policy: DirtyPolicy.default("refuse"),
    created_at: IsoTimestamp.describe("When the envelope was created."),
  })
  .describe(
    "Execution directory and scoped HOME/configs. Git checkouts retain their Git identity; directory execution uses a selected copy or the live source without Git initialization.",
  );
export type WorkspaceEnvelope = z.infer<typeof WorkspaceEnvelope>;
