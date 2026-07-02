import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { AccessProfile, DirtyPolicy, WorkspaceEnvelope } from "@claudexor/schema";
import { WorkspaceEnvelope as WorkspaceEnvelopeSchema } from "@claudexor/schema";
import { runCaptureRaw, WorkspaceError } from "@claudexor/core";
import { ensureDir, newId, nowIso } from "@claudexor/util";
import {
  branchDelete,
  diffStaged,
  diffTrees,
  isGitRepo,
  revParse,
  snapshotTree,
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
  /**
   * Run against the live `repoRoot` directly instead of an isolated git worktree.
   * Used for external stateful environments that may not be git repositories
   * and whose runtime STATE, not a patch, is the deliverable.
   * `dispose()` never deletes the live tree in this mode; a best-effort baseline
   * snapshot backs `diff()` and reviewers also read the live tree directly.
   */
  inPlace?: boolean;
}

/**
 * Manages WorkspaceEnvelopes: an isolated git worktree plus scoped HOME and
 * per-harness config dirs, allocated ports, and dirty-tree handling. Claudexor
 * owns these envelopes (it does not rely on a harness's native --worktree).
 */
/** `ps` start time for a pid, or null when unavailable. Pid+start-time
 * equality is the recycling-proof liveness identity for envelope owners
 * (command names/titles mutate; the kernel start time never does). */
export function processStartTime(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export class WorkspaceManager {
  constructor(private readonly repoRoot: string) {}

  private workspacesDir(): string {
    return join(this.repoRoot, ".claudexor", "workspaces");
  }

  /**
   * The scoped envelope base for a task/attempt. The sole on-disk root we
   * delete on dispose — so the ids MUST be path-safe segments and the resolved
   * base MUST stay inside the workspaces dir (a crafted `../` id could
   * otherwise turn dispose() into an arbitrary recursive delete).
   */
  private envelopeBase(taskId: string, attemptId: string): string {
    const idPattern = /^[A-Za-z0-9._-]+$/;
    for (const [label, id] of [["taskId", taskId], ["attemptId", attemptId]] as const) {
      if (!idPattern.test(id) || id === "." || id === "..") {
        throw new WorkspaceError(`${label} '${id}' is not a safe path segment`);
      }
    }
    const base = join(this.workspacesDir(), taskId, attemptId);
    if (!base.startsWith(this.workspacesDir() + sep)) {
      throw new WorkspaceError(`envelope base escapes the workspaces dir: ${base}`);
    }
    return base;
  }

  async create(opts: CreateEnvelopeOptions): Promise<WorkspaceEnvelope> {
    // Envelope base holds scoped dirs (HOME + per-harness config) and, for git
    // mode, the worktree as a subdir — so harness-written HOME state (auth tokens,
    // caches, plugins, session logs) lives outside the work tree and never lands
    // in a diff.
    const base = this.envelopeBase(opts.taskId, opts.attemptId);
    ensureDir(base);
    // Self-ignoring runtime dir: a `.gitignore` with `*` INSIDE .claudexor makes
    // the whole dir invisible to git in PRE-EXISTING repos too (v0.9 widened the
    // seeded credentials from API keys to subscription OAuth copies; a user's
    // `git add -A` in their own repo must never capture them). This is the
    // git-native trick that avoids mutating the user's .gitignore.
    const claudexorDir = join(this.repoRoot, ".claudexor");
    const selfIgnore = join(claudexorDir, ".gitignore");
    if (!existsSync(selfIgnore)) {
      try {
        writeFileSync(selfIgnore, "*\n", { flag: "wx" });
      } catch {
        /* concurrent envelope creation already wrote it */
      }
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
    const harnessConfigDirs = {
      codex_home: codexHome,
      claude_config: claudeConfig,
      cursor_config: cursorConfig,
      opencode_config: opencodeConfig,
    };
    // Liveness marker for crash GC: the sweeper must never dispose an envelope
    // whose creating process (daemon, CLI, MCP/ACP serve) is still alive —
    // startup GC's "nothing can own an envelope" premise only holds for
    // daemon-tracked runs. Pid + ps START TIME form a recycling-proof identity
    // (command names/titles mutate — vitest, daemons and tools retitle
    // themselves; the kernel start time never does).
    writeFileSync(
      join(base, "owner.json"),
      JSON.stringify({ pid: process.pid, started: processStartTime(process.pid), created_at: nowIso() }) + "\n",
    );
    const ports = await allocatePorts(opts.ports ?? 0);

    // In-place mode: mutate the live repoRoot directly (no isolated worktree).
    // Used for thread turns (chat-first: the next turn sees this one's work) and
    // for stateful external environments where runtime state is the deliverable.
    // For a git project we record a per-turn snapshot sha so diff() captures only
    // THIS turn's net change; a non-git folder falls back to a cpSync baseline.
    if (opts.inPlace) {
      const gitRepo = await isGitRepo(this.repoRoot);
      const baseSha = gitRepo ? await snapshotTree(this.repoRoot) : null;
      if (!gitRepo) this.snapshotBaseline(base);
      return WorkspaceEnvelopeSchema.parse({
        id: newId("env"),
        task_id: opts.taskId,
        attempt_id: opts.attemptId,
        repo_root: this.repoRoot,
        base_ref: opts.baseRef ?? "HEAD",
        base_sha: baseSha,
        worktree_path: this.repoRoot,
        branch_name: "inplace",
        env_dir: envDir,
        home_dir: homeDir,
        harness_config_dirs: harnessConfigDirs,
        ports: { allocated: ports },
        policy_profile: opts.accessProfile ?? "workspace_write",
        dirty_policy: opts.dirtyPolicy ?? "refuse",
        logs_dir: logsDir,
        artifacts_dir: artifactsDir,
        created_at: nowIso(),
      });
    }

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
          "working tree is dirty; commit/stash or set dirty_policy: snapshot",
        );
      }
      // snapshot: a stash-create commit becomes the base SHA without touching
      // the live tree. (The include/stash aliases and the untested `copy`
      // variant were retired in the v0.15 triage.)
      const snap = await stashCreate(this.repoRoot);
      if (snap) baseSha = snap;
    }

    const path = join(base, "tree");
    const branch = `claudexor/${opts.taskId}/${opts.attemptId}`;
    await worktreeAdd(this.repoRoot, path, branch, baseSha);

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
      harness_config_dirs: harnessConfigDirs,
      ports: { allocated: ports },
      policy_profile: opts.accessProfile ?? "workspace_write",
      dirty_policy: dirtyPolicy,
      logs_dir: logsDir,
      artifacts_dir: artifactsDir,
      created_at: nowIso(),
    });
  }

  /**
   * Best-effort baseline copy of the live tree for in-place diff(). Copies each
   * top-level entry individually (skipping heavy/ephemeral dirs, notably `.claudexor`
   * which holds this base) — this both prunes noise and avoids Node's "cannot copy
   * a directory into its own subdirectory" guard, since the baseline lives under
   * `.claudexor`. On any failure the baseline is simply absent and diff() returns
   * empty; reviewers still read the live tree directly.
   */
  private snapshotBaseline(base: string): void {
    const baseline = join(base, "baseline");
    const skip = new Set([".git", ".claudexor", "node_modules", "__pycache__", ".venv", "venv"]);
    try {
      ensureDir(baseline);
      for (const entry of readdirSync(this.repoRoot)) {
        if (skip.has(entry)) continue;
        cpSync(join(this.repoRoot, entry), join(baseline, entry), { recursive: true });
      }
    } catch {
      /* baseline unavailable -> diff() falls back to empty */
    }
  }

  /** Env vars that scope a child harness to this envelope (HOME + per-harness config dirs). */
  envFor(env: WorkspaceEnvelope): Record<string, string> {
    return {
      HOME: env.home_dir,
      CODEX_HOME: env.harness_config_dirs["codex_home"] ?? join(env.home_dir, ".codex"),
      CLAUDE_CONFIG_DIR: env.harness_config_dirs["claude_config"] ?? join(env.home_dir, ".claude"),
      // Pin XDG_CONFIG_HOME to the scoped home so an XDG-aware harness
      // (opencode/cursor) cannot follow an INHERITED XDG_CONFIG_HOME back into the
      // operator's real ~/.config under `mirror_native` (§6 containment).
      XDG_CONFIG_HOME: join(env.home_dir, ".config"),
      CLAUDEXOR_ENV_DIR: env.env_dir,
    };
  }

  /**
   * Provision a SCOPED, worktree-less harness HOME for READ-ONLY routes (plan,
   * ask, audit, orchestrate, reviewers). Read-only modes build no git worktree,
   * but a harness still writes native state — claude-code plan files, codex
   * session rollouts, transcripts — into `$HOME/.claude`, `$CODEX_HOME`, etc.
   * Without this, those land in the operator's REAL home (the B10 leak: a
   * read-only `plan` wrote into `~/.claude/plans`). Same env shape as `envFor`,
   * so the adapters seed auth (subscription creds / api key) into these scoped
   * dirs exactly as they do for a write envelope (CLAUDEXOR_BIBLE §6). Caller
   * disposes when the run ends.
   */
  readOnlyHomeEnv(): { env: Record<string, string>; dispose: () => void } {
    // A throwaway temp base — never under the project / synthetic repo root, so a
    // no-project Ask leaves nothing in its cwd (§7) and nothing in any worktree (§6).
    const base = mkdtempSync(join(tmpdir(), "claudexor-ro-"));
    const homeDir = join(base, "home");
    const envDir = join(base, "env");
    const codexHome = join(homeDir, ".codex");
    const claudeConfig = join(homeDir, ".claude");
    const cursorConfig = join(homeDir, ".cursor");
    const opencodeConfig = join(homeDir, ".config", "opencode");
    for (const d of [homeDir, envDir, codexHome, claudeConfig, cursorConfig, opencodeConfig]) ensureDir(d);
    return {
      env: { HOME: homeDir, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeConfig, XDG_CONFIG_HOME: join(homeDir, ".config"), CLAUDEXOR_ENV_DIR: envDir },
      dispose: () => {
        try {
          rmSync(base, { recursive: true, force: true });
        } catch {
          /* best-effort: a leftover scoped home is harmless and gc-able */
        }
      },
    };
  }

  async diff(env: WorkspaceEnvelope): Promise<string> {
    // In-place: there is no isolated worktree. For a git project, diff the
    // per-turn base snapshot against a fresh end snapshot — net change of THIS
    // turn only, untracked included, prior dirty state folded into base.
    if (env.worktree_path === env.repo_root) {
      if (env.base_sha) {
        const end = await snapshotTree(env.repo_root);
        return diffTrees(env.repo_root, env.base_sha, end);
      }
      // Non-git fallback: diff the best-effort cpSync baseline against the live
      // tree; if no baseline was captured, return empty (reviewers read the tree).
      const baseline = join(this.envelopeBase(env.task_id, env.attempt_id), "baseline");
      if (!existsSync(baseline)) return "";
      try {
        const r = await runCaptureRaw(
          "diff",
          ["-ruN", "-x", ".git", "-x", ".claudexor", "-x", ".claudexor-review-evidence", "-x", "node_modules", "-x", "__pycache__", "-x", ".venv", "-x", "venv", baseline, env.repo_root],
          { timeoutMs: 120_000 },
        );
        const CAP = 200_000;
        return r.stdout.length > CAP ? r.stdout.slice(0, CAP) + "\n... [diff truncated]\n" : r.stdout;
      } catch {
        // best-effort: if `diff` is unavailable the loop still works (reviewers read the live tree)
        return "";
      }
    }
    return diffStaged(env.worktree_path, env.base_sha ?? undefined);
  }

  async dispose(env: WorkspaceEnvelope): Promise<void> {
    // In-place envelopes point worktree_path at the live repo root; NEVER remove a
    // worktree or the tree itself in that case.
    const inPlace = env.worktree_path === env.repo_root;
    if (!inPlace) {
      try {
        await worktreeRemove(this.repoRoot, env.worktree_path);
      } catch {
        /* best-effort */
      }
      // Delete the per-attempt branch so re-attempts with the same ids don't
      // collide on `worktree add -b`, and the user's repo doesn't accumulate
      // permanent claudexor/<task>/<attempt> branches (the v0.8 leak).
      if (env.branch_name && env.branch_name !== "inplace") {
        try {
          await branchDelete(this.repoRoot, env.branch_name);
        } catch {
          /* best-effort */
        }
      }
    }
    // Remove only the scoped envelope base (worktree + scoped home/env/logs/artifacts/
    // baseline, including any seeded credentials), derived from task/attempt ids.
    // For git mode this equals dirname(worktree_path); for in-place it is a sibling
    // under `.claudexor/workspaces`, so deriving from ids is exactly what prevents
    // dispose() from ever deleting the live tree.
    try {
      rmSync(this.envelopeBase(env.task_id, env.attempt_id), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    // Prune the now-empty per-task parent dir (envelopeBase = <task>/<attempt>),
    // guarded to stay strictly inside the workspaces dir.
    try {
      const taskDir = join(this.workspacesDir(), env.task_id);
      if (
        taskDir.startsWith(this.workspacesDir() + sep) &&
        existsSync(taskDir) &&
        readdirSync(taskDir).length === 0
      ) {
        rmSync(taskDir, { recursive: true, force: true });
      }
    } catch {
      /* best-effort */
    }
    try {
      await worktreePrune(this.repoRoot);
    } catch {
      /* best-effort (repo may not be git in in-place mode) */
    }
  }

  /**
   * Dispose an ORPHANED envelope by ids alone (crash GC, T3.1#5): a daemon
   * crash leaves envelopes with no live job. Reconstructs the disposal
   * surface (worktree path, branch name, envelope base) from the same id
   * derivation create() used, so the safety invariants (id-validated base,
   * never the live tree) hold without a persisted envelope record.
   */
  async disposeOrphan(taskId: string, attemptId: string): Promise<void> {
    const base = this.envelopeBase(taskId, attemptId);
    await this.dispose(
      WorkspaceEnvelopeSchema.parse({
        id: newId("env"),
        task_id: taskId,
        attempt_id: attemptId,
        repo_root: this.repoRoot,
        base_ref: "HEAD",
        base_sha: "0000000000000000000000000000000000000000",
        worktree_path: join(base, "tree"),
        branch_name: `claudexor/${taskId}/${attemptId}`,
        env_dir: join(base, "env"),
        home_dir: join(base, "home"),
        harness_config_dirs: {
          codex_home: join(base, "home", ".codex"),
          claude_config: join(base, "home", ".claude"),
          cursor_config: join(base, "home", ".cursor"),
          opencode_config: join(base, "home", ".config", "opencode"),
        },
        ports: { allocated: [] },
        policy_profile: "workspace_write",
        dirty_policy: "snapshot",
        logs_dir: join(base, "logs"),
        artifacts_dir: join(base, "artifacts"),
        created_at: nowIso(),
      }),
    );
  }

}
