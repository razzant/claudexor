import { z } from "zod";
import { DirtyPolicy, Id, IsoTimestamp } from "./primitives.js";

export const SandboxMode = z.enum(["none", "native", "docker", "devcontainer", "remote"]);
export type SandboxMode = z.infer<typeof SandboxMode>;

export const ServiceSpec = z.object({
  name: z.string(),
  start_command: z.string(),
  health_check: z.string().nullable().default(null),
});
export type ServiceSpec = z.infer<typeof ServiceSpec>;

/**
 * An isolated execution envelope. A git worktree isolates files; the envelope
 * additionally isolates env/HOME/harness-config dirs, ports, and services —
 * because "worktree != runtime isolation".
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
  env_dir: z.string(),
  home_dir: z.string(),
  harness_config_dirs: z.record(z.string(), z.string()).default({}),
  ports: z.object({ allocated: z.array(z.number().int()).default([]) }).default({ allocated: [] }),
  services: z.array(ServiceSpec).default([]),
  sandbox: z.object({ mode: SandboxMode.default("none") }).default({ mode: "none" }),
  policy_profile: z.string().default("workspace_write"),
  dirty_policy: DirtyPolicy.default("refuse"),
  logs_dir: z.string(),
  artifacts_dir: z.string(),
  created_at: IsoTimestamp,
});
export type WorkspaceEnvelope = z.infer<typeof WorkspaceEnvelope>;
