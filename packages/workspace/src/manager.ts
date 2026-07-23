import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { AccessProfile, DirtyPolicy, WorkspaceEnvelope } from "@claudexor/schema";
import { WorkspaceEnvelope as WorkspaceEnvelopeSchema } from "@claudexor/schema";
import { CLAUDEXOR_ARTIFACT_DIR, runCaptureRaw, WorkspaceError } from "@claudexor/core";
import { ensureDir, newId, nowIso, projectRuntimeDir } from "@claudexor/util";
import { ensureLaneHomeEnv, type LaneHomeEnv } from "./lanes.js";
import {
  CLAUDE_BRIDGE_BASENAME,
  ensureClaudeBridge,
  isGeneratedClaudeBridge,
} from "./claude-bridge.js";
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

export interface CreateEnvelopeOptions {
  taskId: string;
  attemptId: string;
  baseRef?: string;
  accessProfile?: AccessProfile;
  dirtyPolicy?: DirtyPolicy;
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
 * per-harness config dirs, and dirty-tree handling. Claudexor owns these
 * envelopes (it does not rely on a harness's native --worktree).
 */
/** `ps` start time for a pid, or null when unavailable. Pid+start-time
 * equality is the recycling-proof liveness identity for envelope owners
 * (command names/titles mutate; the kernel start time never does). */
export function processStartTime(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export class WorkspaceManager {
  private readonly runtimeRoot: string;

  constructor(
    private readonly repoRoot: string,
    options: { runtimeRoot?: string } = {},
  ) {
    this.runtimeRoot = options.runtimeRoot ?? projectRuntimeDir(repoRoot);
  }

  private workspacesDir(): string {
    return join(this.runtimeRoot, "workspaces");
  }

  /**
   * The scoped envelope base for a task/attempt. The sole on-disk root we
   * delete on dispose — so the ids MUST be path-safe segments and the resolved
   * base MUST stay inside the workspaces dir (a crafted `../` id could
   * otherwise turn dispose() into an arbitrary recursive delete).
   */
  private envelopeBase(taskId: string, attemptId: string): string {
    const idPattern = /^[A-Za-z0-9._-]+$/;
    for (const [label, id] of [
      ["taskId", taskId],
      ["attemptId", attemptId],
    ] as const) {
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
    // mode, the worktree as a subdir — so harness-written caches, plugins,
    // transcripts, and route-scoped API auth state live outside the work tree
    // and never land in a diff. Credentials are never copied into this
    // envelope; adapters may add only capability-declared, vendor-specific
    // child context (Claude/Cursor macOS Keychain bridge, INV-067).
    const base = this.envelopeBase(opts.taskId, opts.attemptId);
    ensureDir(base);
    const homeDir = join(base, "home");
    const codexHome = join(homeDir, ".codex");
    const claudeConfig = join(homeDir, ".claude");
    const cursorConfig = join(homeDir, ".cursor");
    const opencodeConfig = join(homeDir, ".config", "opencode");
    for (const d of [homeDir, codexHome, claudeConfig, cursorConfig, opencodeConfig]) {
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
      JSON.stringify({
        pid: process.pid,
        started: processStartTime(process.pid),
        created_at: nowIso(),
      }) + "\n",
    );

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
        home_dir: homeDir,
        harness_config_dirs: harnessConfigDirs,
        policy_profile: opts.accessProfile ?? "workspace_write",
        // Record the EFFECTIVE policy, not the ignored request: in-place runs
        // always fold dirty state into the per-turn base snapshot above.
        dirty_policy: "snapshot",
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

    // AGENTS.md bridge (INV-113): a worktree materializes only the COMMITTED
    // tree, so the project-root bridge (an untracked file) never reaches this
    // envelope — a Claude Code candidate here would otherwise lack CLAUDE.md.
    // Write an envelope-local bridge into the worktree so the candidate reads the
    // same AGENTS.md instructions. Self-fenced (acts only with a committed
    // AGENTS.md and no CLAUDE.md), best-effort (a convenience, never a
    // precondition), and no run event — this envelope is disposable and
    // Claudexor-owned. `diff()` excludes the generated bridge so it never enters
    // the candidate patch.
    try {
      ensureClaudeBridge(path);
    } catch {
      /* a missing bridge is harmless; never fail envelope creation over it */
    }

    return WorkspaceEnvelopeSchema.parse({
      id: newId("env"),
      task_id: opts.taskId,
      attempt_id: opts.attemptId,
      repo_root: this.repoRoot,
      base_ref: baseRef,
      base_sha: baseSha,
      worktree_path: path,
      branch_name: branch,
      home_dir: homeDir,
      harness_config_dirs: harnessConfigDirs,
      policy_profile: opts.accessProfile ?? "workspace_write",
      dirty_policy: dirtyPolicy,
      created_at: nowIso(),
    });
  }

  /**
   * Best-effort baseline copy of the live tree for in-place diff(). Copies each
   * top-level entry individually while skipping only VCS/heavy ephemeral dirs.
   * The baseline is external, so project `.claudexor/` content is ordinary user
   * state and is copied like every other project path. On any failure the
   * baseline is absent and diff() returns empty; reviewers still read the tree.
   */
  private snapshotBaseline(base: string): void {
    const baseline = join(base, "baseline");
    const skip = new Set([".git", "node_modules", "__pycache__", ".venv", "venv"]);
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
    };
  }

  /**
   * Provision a SCOPED, worktree-less harness HOME for READ-ONLY routes (plan,
   * ask, audit, orchestrate, reviewers). Read-only modes build no git worktree,
   * but a harness still writes native state — claude-code plan files, codex
   * session rollouts, transcripts — into `$HOME/.claude`, `$CODEX_HOME`, etc.
   * Without this, those land in the operator's REAL home (a live-caught leak: a
   * read-only `plan` wrote into `~/.claude/plans`). Same env shape as `envFor`:
   * non-native state and injected API-key routes stay scoped. This GENERIC
   * home never bridges the OS Keychain; an adapter that declares
   * `scoped_home_keychain_bridge` may create a vendor-only disposable child
   * HOME without copying credentials (INV-067). Caller disposes all scoped
   * state when the run ends.
   */
  readOnlyHomeEnv(): { env: Record<string, string>; dispose: () => void } {
    // A throwaway temp base — never under the project / synthetic repo root, so a
    // no-project Ask leaves nothing in its cwd (§7) and nothing in any worktree (§6).
    const base = mkdtempSync(join(tmpdir(), "claudexor-ro-"));
    const homeDir = join(base, "home");
    const codexHome = join(homeDir, ".codex");
    const claudeConfig = join(homeDir, ".claude");
    const cursorConfig = join(homeDir, ".cursor");
    const opencodeConfig = join(homeDir, ".config", "opencode");
    for (const d of [homeDir, codexHome, claudeConfig, cursorConfig, opencodeConfig]) ensureDir(d);
    return {
      env: {
        HOME: homeDir,
        CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: claudeConfig,
        XDG_CONFIG_HOME: join(homeDir, ".config"),
      },
      dispose: () => {
        try {
          rmSync(base, { recursive: true, force: true });
        } catch {
          /* best-effort: a leftover scoped home is harmless and gc-able */
        }
      },
    };
  }

  /**
   * Provision the DURABLE per-lane read-only home for a THREAD turn (INV-034).
   * Unlike `readOnlyHomeEnv`, this base is PERSISTENT under the project runtime
   * namespace and keyed by (thread, harness, profile): the next read-only turn
   * of the same lane reuses it, so the harness's recorded native session is
   * reachable for `codex exec resume` / `claude --resume`. Never disposed with
   * the run — the thread-purge / profile-deletion / retention owners remove it.
   */
  laneHomeEnv(threadId: string, harnessId: string, profileId: string | null): LaneHomeEnv {
    return ensureLaneHomeEnv(this.runtimeRoot, threadId, harnessId, profileId);
  }

  /**
   * Header-only rewrite of a plain GNU `diff -ruN <baseline> <live>` document:
   * absolute baseline/live prefixes become git-style `a/<rel>` / `b/<rel>` so
   * repo-relative protected-path and risk globs see the SAME shape they see
   * for git diffs. STATEFUL, mirroring the shared plain-diff parser's
   * structural rules: only the GNU `diff …` command echo, the `--- `/`+++ `
   * pair of a real file-header triple (`--- ` + `+++ ` + `@@` on consecutive
   * lines), and structural `Binary files … differ` lines are rewritten.
   * Hunk CONTENT is never touched — a removed/added content line that merely
   * starts with `-- `/`++ ` (rendering as `--- `/`+++ ` in the diff) keeps
   * its bytes, per the diff-fidelity contract (INV-041).
   */
  private static relativizePlainDiffHeadersFor(
    text: string,
    baselineRoot: string,
    liveRoot: string,
  ): string {
    const base = baselineRoot.endsWith("/") ? baselineRoot : `${baselineRoot}/`;
    const live = liveRoot.endsWith("/") ? liveRoot : `${liveRoot}/`;
    const swap = (s: string): string => s.split(base).join("a/").split(live).join("b/");
    const lines = text.split("\n");
    // Same structural rule as the shared plain-diff parser: INSIDE a hunk the
    // loose triple can be forged by content (a deleted `-- …` line + an added
    // `++ …` line + the next `@@`), so a mid-hunk boundary must also carry a
    // header witness — the GNU tab-separated timestamp (or /dev/null) on both
    // path lines, which +/- content lines never have.
    const headerWitness = (l: string | undefined): boolean =>
      l !== undefined && (l.includes("\t") || l.slice(4).trim() === "/dev/null");
    const isFileHeaderTriple = (idx: number, midHunk: boolean): boolean => {
      const triple =
        (lines[idx]?.startsWith("--- ") ?? false) &&
        (lines[idx + 1]?.startsWith("+++ ") ?? false) &&
        (lines[idx + 2]?.startsWith("@@") ?? false);
      if (!triple) return false;
      return midHunk ? headerWitness(lines[idx]) && headerWitness(lines[idx + 1]) : true;
    };
    let inHunk = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] as string;
      if (line.startsWith("diff ")) {
        // GNU command echo between files: structural, resets hunk state.
        inHunk = false;
        lines[i] = swap(line);
        continue;
      }
      if (isFileHeaderTriple(i, inHunk)) {
        // Real file boundary — same rule as the shared parser (a full triple
        // opens a file even mid-document without a `diff` echo).
        lines[i] = swap(line);
        lines[i + 1] = swap(lines[i + 1] as string);
        inHunk = false;
        i += 1; // the `+++ ` line is handled; `@@` flips state next.
        continue;
      }
      if (line.startsWith("@@")) {
        inHunk = true;
        continue;
      }
      if (line.startsWith("Binary files ") && line.endsWith(" differ") && !inHunk) {
        lines[i] = swap(line);
      }
    }
    return lines.join("\n");
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
          [
            "-ruN",
            "-x",
            ".git",
            "-x",
            "node_modules",
            "-x",
            "__pycache__",
            "-x",
            ".venv",
            "-x",
            "venv",
            baseline,
            env.repo_root,
          ],
          { timeoutMs: 120_000 },
        );
        // Relativize the header paths to the git-style a/<rel> b/<rel> shape.
        // Downstream consumers (diffstat, protected-path/risk gating) match
        // REPO-RELATIVE globs like `test/**`; absolute `/…/repo/test/x`
        // headers would silently bypass every one of them.
        const relativized = WorkspaceManager.relativizePlainDiffHeadersFor(
          r.stdout,
          baseline,
          env.repo_root,
        );
        const CAP = 200_000;
        return relativized.length > CAP
          ? relativized.slice(0, CAP) + "\n... [diff truncated]\n"
          : relativized;
      } catch {
        // best-effort: if `diff` is unavailable the loop still works (reviewers read the live tree)
        return "";
      }
    }
    // Exclude the envelope-local generated CLAUDE.md bridge (INV-113) from the
    // candidate patch — by EXACT path and only when the worktree file is BYTE-
    // IDENTICAL to the generated bridge content (A-3). A git pathspec cannot
    // express content-equality, so the decision is computed in code here: an
    // untouched bridge is excluded, but ANY candidate edit — even one that keeps
    // the ownership marker — differs from the exact bytes, so the exclude is not
    // added and the edit is captured in patch.diff. Same doctrine as the
    // `.claudexor` artifact-dir exclusion.
    const bridgeExcludes = isGeneratedClaudeBridge(env.worktree_path)
      ? [`:(exclude,top)${CLAUDE_BRIDGE_BASENAME}`]
      : [];
    return diffStaged(env.worktree_path, env.base_sha ?? undefined, bridgeExcludes);
  }

  async dispose(env: WorkspaceEnvelope): Promise<void> {
    // In-place envelopes point worktree_path at the live repo root; NEVER remove a
    // worktree or the tree itself in that case.
    const inPlace = env.worktree_path === env.repo_root;
    if (inPlace) {
      // F4: for an in-place run the claudexor-owned artifact dir was
      // written into the user's LIVE repo — its media is already collected into
      // Evidence, so remove it rather than littering the working tree. A git-mode
      // envelope drops the whole worktree below, so this is the in-place-only path.
      try {
        rmSync(join(env.worktree_path, CLAUDEXOR_ARTIFACT_DIR), { recursive: true, force: true });
      } catch {
        /* best-effort: artifact-dir litter is harmless and re-sweepable */
      }
    }
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
    // baseline, including any route-scoped API auth material), derived from task/attempt ids.
    // For git mode this equals dirname(worktree_path); for in-place it is a sibling
    // under the external runtime workspaces root, so deriving from ids prevents
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
   * Dispose an ORPHANED envelope by ids alone (crash GC): a daemon
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
        home_dir: join(base, "home"),
        harness_config_dirs: {
          codex_home: join(base, "home", ".codex"),
          claude_config: join(base, "home", ".claude"),
          cursor_config: join(base, "home", ".cursor"),
          opencode_config: join(base, "home", ".config", "opencode"),
        },
        policy_profile: "workspace_write",
        dirty_policy: "snapshot",
        created_at: nowIso(),
      }),
    );
  }
}
