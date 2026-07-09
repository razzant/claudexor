import { z } from "zod";
import { DirtyPolicy, Id, IsoTimestamp } from "./primitives.js";

/**
 * An isolated execution envelope. A git worktree isolates files; the envelope
 * additionally isolates env/HOME/harness-config dirs. (Container/
 * service-sandbox isolation is a future scoped feature, not modeled here.
 * The dead `env_dir`/`logs_dir`/`artifacts_dir`/`ports` fields — created but
 * never read anywhere — were deleted per the staged-field rule.)
 */
export const WorkspaceEnvelope = z
  .object({
    id: Id.describe("Envelope id."),
    task_id: Id.describe("Task the envelope belongs to."),
    attempt_id: Id.describe("Attempt the envelope belongs to."),
    repo_root: z.string().describe("Absolute path of the source repository root."),
    base_ref: z.string().describe("Git ref the worktree was created from."),
    base_sha: z.string().nullable().default(null).describe("Resolved base commit SHA; null when not recorded."),
    worktree_path: z.string().describe("Absolute path of the isolated git worktree."),
    branch_name: z.string().describe("Branch created for the worktree."),
    home_dir: z.string().describe("Scoped HOME directory for the harness process (kept outside the worktree)."),
    harness_config_dirs: z
      .record(z.string(), z.string())
      .default({})
      .describe("Scoped per-harness config directories keyed by harness id (kept outside the worktree)."),
    policy_profile: z.string().default("workspace_write").describe("Access profile the envelope enforces."),
    dirty_policy: DirtyPolicy.default("refuse"),
    created_at: IsoTimestamp.describe("When the envelope was created."),
  })
  .describe("An isolated execution envelope: a git worktree for files plus scoped env/HOME/harness-config isolation.");
export type WorkspaceEnvelope = z.infer<typeof WorkspaceEnvelope>;
