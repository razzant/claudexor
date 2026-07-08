import { z } from "zod";
import { DirtyPolicy, Id, IsoTimestamp } from "./primitives.js";

/**
 * An isolated execution envelope. A git worktree isolates files; the envelope
 * additionally isolates env/HOME/harness-config dirs. (Container/
 * service-sandbox isolation is a future scoped feature, not modeled here.
 * The dead `env_dir`/`logs_dir`/`artifacts_dir`/`ports` fields — created but
 * never read anywhere — were deleted per the staged-field rule.)
 */
export const WorkspaceEnvelope = z.object({
  id: Id,
  task_id: Id,
  attempt_id: Id,
  repo_root: z.string(),
  base_ref: z.string(),
  base_sha: z.string().nullable().default(null),
  worktree_path: z.string(),
  branch_name: z.string(),
  home_dir: z.string(),
  harness_config_dirs: z.record(z.string(), z.string()).default({}),
  policy_profile: z.string().default("workspace_write"),
  dirty_policy: DirtyPolicy.default("refuse"),
  created_at: IsoTimestamp,
});
export type WorkspaceEnvelope = z.infer<typeof WorkspaceEnvelope>;
