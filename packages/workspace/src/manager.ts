import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AccessProfile, DirtyPolicy, WorkspaceEnvelope } from "@claudex/schema";
import { WorkspaceEnvelope as WorkspaceEnvelopeSchema } from "@claudex/schema";
import { WorkspaceError } from "@claudex/core";
import { ensureDir, newId, nowIso } from "@claudex/util";
import {
  diffStaged,
  isGitRepo,
  revParse,
  statusPorcelain,
  stashCreate,
  worktreeAdd,
  worktreePrune,
  worktreeRemove,
} from "./git.js";
import { allocatePorts } from "./ports.js";

export interface CreateEnvelopeOptions {
  taskId: string;
  attemptId: string;
  baseRef?: string;
  accessProfile?: AccessProfile;
  dirtyPolicy?: DirtyPolicy;
  ports?: number;
}

/**
 * Manages WorkspaceEnvelopes: an isolated git worktree plus scoped HOME and
 * per-harness config dirs, allocated ports, and dirty-tree handling. Claudex
 * owns these envelopes (it does not rely on a harness's native --worktree).
 */
export class WorkspaceManager {
  constructor(private readonly repoRoot: string) {}

  private workspacesDir(): string {
    return join(this.repoRoot, ".claudex", "workspaces");
  }

  async create(opts: CreateEnvelopeOptions): Promise<WorkspaceEnvelope> {
    if (!(await isGitRepo(this.repoRoot))) {
      throw new WorkspaceError(`not a git repository: ${this.repoRoot}`);
    }
    const baseRef = opts.baseRef ?? "HEAD";
    const dirtyPolicy: DirtyPolicy = opts.dirtyPolicy ?? "refuse";
    let baseSha = await revParse(this.repoRoot, baseRef);

    const porcelain = await statusPorcelain(this.repoRoot);
    const dirty = porcelain.trim().length > 0;
    if (dirty) {
      if (dirtyPolicy === "refuse") {
        throw new WorkspaceError(
          "working tree is dirty; commit/stash or set a dirty_policy (include|snapshot|copy|stash)",
        );
      }
      if (dirtyPolicy === "snapshot" || dirtyPolicy === "include" || dirtyPolicy === "stash") {
        const snap = await stashCreate(this.repoRoot);
        if (snap) baseSha = snap;
      }
    }

    // Envelope base holds the worktree plus scoped dirs as SIBLINGS. The worktree
    // is a subdir so that harness-written HOME state (auth tokens, caches, plugins,
    // session logs) lives outside the git working tree and never lands in the diff.
    const base = join(this.workspacesDir(), opts.taskId, opts.attemptId);
    ensureDir(base);
    const path = join(base, "tree");
    const branch = `claudex/${opts.taskId}/${opts.attemptId}`;
    await worktreeAdd(this.repoRoot, path, branch, baseSha);

    // dirty "copy" brings untracked + modified files into the worktree explicitly.
    if (dirty && dirtyPolicy === "copy") {
      this.copyDirtyFiles(porcelain, path);
    }

    const homeDir = join(base, "home");
    const envDir = join(base, "env");
    const logsDir = join(base, "logs");
    const artifactsDir = join(base, "artifacts");
    const codexHome = join(homeDir, ".codex");
    const claudeConfig = join(homeDir, ".claude");
    const cursorConfig = join(homeDir, ".cursor");
    const opencodeConfig = join(homeDir, ".config", "opencode");
    for (const d of [homeDir, envDir, logsDir, artifactsDir, codexHome, claudeConfig, cursorConfig, opencodeConfig]) {
      ensureDir(d);
    }

    const ports = await allocatePorts(opts.ports ?? 0);

    return WorkspaceEnvelopeSchema.parse({
      id: newId("env"),
      task_id: opts.taskId,
      attempt_id: opts.attemptId,
      repo_root: this.repoRoot,
      base_ref: baseRef,
      base_sha: baseSha,
      worktree_path: path,
      branch_name: branch,
      env_dir: envDir,
      home_dir: homeDir,
      harness_config_dirs: {
        codex_home: codexHome,
        claude_config: claudeConfig,
        cursor_config: cursorConfig,
        opencode_config: opencodeConfig,
      },
      ports: { allocated: ports },
      services: [],
      sandbox: { mode: "none" },
      policy_profile: opts.accessProfile ?? "workspace_write",
      dirty_policy: dirtyPolicy,
      logs_dir: logsDir,
      artifacts_dir: artifactsDir,
      created_at: nowIso(),
    });
  }

  private copyDirtyFiles(porcelain: string, destRoot: string): void {
    for (const line of porcelain.split("\n")) {
      const rel = line.slice(3).trim();
      if (!rel || rel.includes(" -> ")) continue; // skip renames (handled by base)
      try {
        cpSync(join(this.repoRoot, rel), join(destRoot, rel), { recursive: true });
      } catch {
        /* file may be deleted; ignore */
      }
    }
  }

  /** Env vars that scope a child harness to this envelope (HOME + per-harness config dirs). */
  envFor(env: WorkspaceEnvelope): Record<string, string> {
    return {
      HOME: env.home_dir,
      CODEX_HOME: env.harness_config_dirs["codex_home"] ?? join(env.home_dir, ".codex"),
      CLAUDE_CONFIG_DIR: env.harness_config_dirs["claude_config"] ?? join(env.home_dir, ".claude"),
      CLAUDEX_ENV_DIR: env.env_dir,
    };
  }

  async diff(env: WorkspaceEnvelope): Promise<string> {
    return diffStaged(env.worktree_path);
  }

  async dispose(env: WorkspaceEnvelope): Promise<void> {
    try {
      await worktreeRemove(this.repoRoot, env.worktree_path);
    } catch {
      /* best-effort */
    }
    // Remove the whole envelope base (worktree + scoped home/env/logs/artifacts),
    // including any seeded credentials, so nothing sensitive lingers on disk.
    // Invariant: create() is the sole producer of worktree_path and always sets it to
    // `<workspacesDir>/<taskId>/<attemptId>/tree`, so dirname() is exactly that unique base.
    try {
      rmSync(dirname(env.worktree_path), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    await worktreePrune(this.repoRoot);
  }

  async prune(): Promise<void> {
    await worktreePrune(this.repoRoot);
  }
}
