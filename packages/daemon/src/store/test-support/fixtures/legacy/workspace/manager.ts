import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type {
  AccessProfile,
  DirtyPolicy,
  WorkspaceEnvelope,
  WorkspaceKind,
} from "../schema/index.js";
import { WorkspaceEnvelope as WorkspaceEnvelopeSchema } from "../schema/index.js";
import { runCaptureRaw, WorkspaceError } from "../core/index.js";
import { ensureDir, newId, nowIso, projectRuntimeDir } from "../util/index.js";
import { ensureLaneHomeEnv, type LaneHomeEnv } from "./lanes.js";
import { ensureHarnessHome, harnessHomeEnv } from "./harness-home.js";
import { ArtifactOwnership } from "./artifact-ownership.js";
import {
  captureDirectoryWorkspace,
  createDirectoryEnvelope,
  type CapturedWorkspaceFiles,
} from "./directory-workspace.js";
import { processStartTime, readEnvelopeRecoveryRecord } from "./envelope-recovery.js";
import {
  isRetainedEnvelope,
  liveEnvelopeCustody,
  writeEnvelopeCustody,
} from "./envelope-custody.js";
import {
  excludePlainDiffPathPrefix,
  plainDiffFlaggedBinaries,
  relativizePlainDiffHeaders,
  snapshotLegacyDirectoryBaseline,
} from "./plain-diff.js";
import {
  CLAUDE_BRIDGE_BASENAME,
  bridgeCreatedMarkerMatches,
  ensureClaudeBridge,
  isGeneratedClaudeBridge,
  writeBridgeCreatedMarker,
} from "./claude-bridge.js";
import {
  branchDelete,
  captureWorkingTreeTransient,
  isolatedCloneAdd,
  isGitRepo,
  revParse,
  snapshotTree,
  statusPorcelain,
  stashCreate,
  worktreePrune,
  worktreeRemove,
} from "./git.js";

/** One candidate capture. `diff` is always the EXACT patch (apply, synthesis,
 * digests); what a saved copy must hide is derived from it downstream. */
export interface CapturedWorkspaceDiff {
  diff: string;
  /** Changed binaries whose bytes hold (or cannot be proven free of)
   * secret-like content; a persisted copy withholds their payload. */
  binarySecretPaths: string[];
  /** The capture could not observe the candidate's changes at all (no legacy
   * baseline, a failed `diff`): an honest capture refusal, never "no changes". */
  captureIncomplete: boolean;
}

export interface CreateEnvelopeOptions {
  taskId: string;
  attemptId: string;
  baseRef?: string;
  accessProfile?: AccessProfile;
  dirtyPolicy?: DirtyPolicy;
  workspaceKind?: WorkspaceKind;
  scopePaths?: string[];
  /**
   * Run against the live `repoRoot` directly instead of an isolated git worktree.
   * Used for external stateful environments that may not be git repositories
   * and whose runtime STATE, not a patch, is the deliverable.
   * `dispose()` never deletes the live tree in this mode; a best-effort baseline
   * snapshot backs `diff()` and reviewers also read the live tree directly.
   */
  inPlace?: boolean;
  /** Holder run of an isolated Git envelope whose stopped work may be kept for
   * continuation: `live` custody is recorded before any harness runs. */
  custody?: { runId: string; runDir: string };
}

/**
 * Manages WorkspaceEnvelopes: an isolated Git checkout plus scoped HOME and
 * per-harness config dirs, and dirty-tree handling. Claudexor owns these
 * envelopes (it does not rely on a harness's native --worktree).
 */
export { processStartTime } from "./envelope-recovery.js";

export class WorkspaceManager {
  private readonly runtimeRoot: string;
  private readonly artifactOwnership: ArtifactOwnership;

  /** Current-prep bridge ownership, also persisted beside owner.json for recovery.
   * Only a bridge created here and still byte-identical is excluded from capture. */
  private readonly bridgeCreatedEnvelopes = new Set<string>();
  private readonly retainedEnvelopes = new Set<string>();

  constructor(
    private readonly repoRoot: string,
    options: { runtimeRoot?: string } = {},
  ) {
    this.runtimeRoot = options.runtimeRoot ?? projectRuntimeDir(repoRoot);
    this.artifactOwnership = new ArtifactOwnership((env) =>
      join(this.envelopeBase(env.task_id, env.attempt_id), "artifact-created.json"),
    );
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

  ensureArtifactDirectory(env: WorkspaceEnvelope): string {
    return this.artifactOwnership.ensureDirectory(env);
  }

  ownedArtifactRelativeDirectory(env: WorkspaceEnvelope): string | null {
    return this.artifactOwnership.relativeDirectory(env);
  }

  async create(opts: CreateEnvelopeOptions): Promise<WorkspaceEnvelope> {
    // Envelope base holds scoped dirs (HOME + per-harness config) and, for git
    // mode, the worktree as a subdir — so harness-written caches, plugins,
    // transcripts, and route-scoped API auth state live outside the work tree
    // and never land in a diff. Credentials are never copied into this
    // envelope; adapters may add only capability-declared, vendor-specific
    // child context (Claude/Cursor macOS Keychain bridge, INV-067).
    const base = this.envelopeBase(opts.taskId, opts.attemptId);
    const envelopeId = newId("env");
    const workspaceMode = opts.inPlace ? "in_place" : "isolated";
    ensureDir(base);
    const homeDir = join(base, "home");
    const harnessConfigDirs = ensureHarnessHome(homeDir);
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
        envelope_id: envelopeId,
        workspace_mode: workspaceMode,
        workspace_kind: opts.workspaceKind,
      }) + "\n",
    );

    if (opts.workspaceKind === "directory") {
      return createDirectoryEnvelope({
        ...opts,
        sourceRoot: this.repoRoot,
        envelopeRoot: base,
        envelopeId,
        homeDir,
        harnessConfigDirs,
      });
    }

    // In-place mode: mutate the live repoRoot directly (no isolated checkout).
    // Used for thread turns (chat-first: the next turn sees this one's work) and
    // for stateful external environments where runtime state is the deliverable.
    // For a git project we record a per-turn snapshot sha so diff() captures only
    // THIS turn's net change; a non-git folder falls back to a cpSync baseline.
    if (opts.inPlace) {
      const gitRepo = await isGitRepo(this.repoRoot);
      // Read-only execution gets a scoped HOME but no write-oriented prep:
      // no dangling Git snapshot, copied baseline, diff/capture, or later
      // delivery. The native adapter policy owns the promised read-only mode.
      const readOnly = opts.accessProfile === "readonly";
      const baseSha = !readOnly && gitRepo ? await snapshotTree(this.repoRoot) : null;
      if (!readOnly && !gitRepo) snapshotLegacyDirectoryBaseline(this.repoRoot, base);
      return WorkspaceEnvelopeSchema.parse({
        id: envelopeId,
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
    await isolatedCloneAdd(this.repoRoot, path, branch, baseSha);
    writeFileSync(join(base, "private-clone-v1"), "private Git authority\n");

    // AGENTS.md bridge (INV-113): the checkout omits the untracked project-root bridge,
    // envelope — a Claude Code candidate here would otherwise lack CLAUDE.md.
    // Write an envelope-local bridge so the candidate reads the same AGENTS.md.
    // Self-fenced (acts only with a committed AGENTS.md and no CLAUDE.md),
    // best-effort, and no run event. `diff()` excludes the generated bridge so it never enters
    // the candidate patch.
    // ONLY when THIS prep actually created the bridge (recorded below) does diff()
    // exclude it; a CLAUDE.md already present is never excluded (A-3 residual).
    let bridgeCreatedHere = false;
    try {
      bridgeCreatedHere = ensureClaudeBridge(path).created;
    } catch {
      /* a missing bridge is harmless; never fail envelope creation over it */
    }

    const envelope = WorkspaceEnvelopeSchema.parse({
      id: envelopeId,
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
    // Record the created-this-run fact keyed by envelope id, so diff() gates the
    // bridge exclusion on POSITIVE PROOF rather than on content bytes alone.
    // Persisted beside owner.json as well (bridge-created.json): the in-memory
    // set dies with THIS manager instance (daemon restart mid-run), and losing
    // the fact CAPTURES a pristine generated bridge into patch.diff.
    if (bridgeCreatedHere) {
      this.bridgeCreatedEnvelopes.add(envelope.id);
      writeBridgeCreatedMarker(base, envelope.id);
    }
    if (opts.custody) writeEnvelopeCustody(base, liveEnvelopeCustody(envelope, opts.custody));
    return envelope;
  }

  /** Env vars that scope a child harness to this envelope (HOME + per-harness config dirs). */
  envFor(env: WorkspaceEnvelope): Record<string, string> {
    return harnessHomeEnv(env.home_dir, env.harness_config_dirs);
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
    return {
      env: harnessHomeEnv(homeDir, ensureHarnessHome(homeDir)),
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

  async captureDiff(env: WorkspaceEnvelope): Promise<CapturedWorkspaceDiff> {
    if (env.workspace_kind === "directory")
      throw new WorkspaceError(
        "Directory results use captureFiles; a text diff is not their work product",
      );
    const incomplete: CapturedWorkspaceDiff = {
      diff: "",
      binarySecretPaths: [],
      captureIncomplete: true,
    };
    if (env.policy_profile === "readonly") {
      return { ...incomplete, captureIncomplete: false };
    }
    // In-place: there is no isolated worktree. Capture the candidate tree in a
    // temporary object database so the capture itself never adds dangling
    // objects to the user's repository. The exact per-turn base still folds
    // prior dirty state out of this turn's diff.
    const artifactRelative = this.ownedArtifactRelativeDirectory(env);
    const artifactExcludes = artifactRelative ? [`:(exclude,top)${artifactRelative}`] : [];
    if (env.worktree_path === env.repo_root) {
      if (env.base_sha) {
        const captured = await captureWorkingTreeTransient(
          env.repo_root,
          env.base_sha,
          artifactExcludes,
        );
        return {
          diff: captured.patch,
          binarySecretPaths: captured.binarySecretPaths,
          captureIncomplete: false,
        };
      }
      // Non-git fallback: diff the best-effort cpSync baseline against the live
      // tree. Missing or failed capture is an INCOMPLETE capture, never a safe
      // no-change result.
      const baseline = join(this.envelopeBase(env.task_id, env.attempt_id), "baseline");
      if (!existsSync(baseline)) return incomplete;
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
        if (r.code !== 0 && r.code !== 1) return incomplete;
        // Relativize the header paths to the git-style a/<rel> b/<rel> shape.
        // Downstream consumers (diffstat, protected-path/risk gating) match
        // REPO-RELATIVE globs like `test/**`; absolute `/…/repo/test/x`
        // headers would silently bypass every one of them.
        const fullDiff = relativizePlainDiffHeaders(r.stdout, baseline, env.repo_root);
        const relativized = artifactRelative
          ? excludePlainDiffPathPrefix(fullDiff, artifactRelative)
          : fullDiff;
        const CAP = 200_000;
        return {
          diff:
            relativized.length > CAP
              ? relativized.slice(0, CAP) + "\n... [diff truncated]\n"
              : relativized,
          // Binary stubs are inspected over the COMPLETE captured text, before
          // it is projected into the bounded artifact.
          binarySecretPaths: plainDiffFlaggedBinaries(relativized, env.repo_root),
          captureIncomplete: false,
        };
      } catch {
        return incomplete;
      }
    }
    // Exclude the envelope-local generated CLAUDE.md bridge (INV-113) from the
    // candidate patch — by EXACT path, and only when BOTH conditions hold: (1)
    // THIS run's prep actually created the bridge (the recorded created-this-run
    // fact), and (2) the worktree file is still BYTE-IDENTICAL to the generated
    // bridge content. A git pathspec cannot express either condition, so the
    // decision is computed in code here. Condition (1) closes the A-3 residual:
    // byte-equality alone cannot tell our freshly written bridge from a candidate
    // that rewrote a PRE-EXISTING committed CLAUDE.md to exactly the bridge bytes,
    // and excluding the latter would silently drop the candidate's real edit. If
    // the created fact is absent (pre-existing file, or a prior run), we NEVER
    // exclude — failing toward CAPTURE. Condition (2) keeps a candidate that
    // EDITED the bridge we DID create in the diff. Same exact-path doctrine as
    // the marker-bound artifact-child exclusion. The fact survives a manager
    // restart via the persisted bridge-created.json marker (envelope-id-bound),
    // read only when the in-memory set lacks the id.
    const bridgeExcludes =
      this.bridgeCreatedFact(env) && isGeneratedClaudeBridge(env.worktree_path)
        ? [`:(exclude,top)${CLAUDE_BRIDGE_BASENAME}`]
        : [];
    const captured = await captureWorkingTreeTransient(env.worktree_path, env.base_sha ?? "HEAD", [
      ...artifactExcludes,
      ...bridgeExcludes,
    ]);
    return {
      diff: captured.patch,
      binarySecretPaths: captured.binarySecretPaths,
      captureIncomplete: false,
    };
  }

  async diff(env: WorkspaceEnvelope): Promise<string> {
    return (await this.captureDiff(env)).diff;
  }

  /** Directory work products retain full files, independently of diff previews. */
  async captureFiles(
    env: WorkspaceEnvelope,
    runRoot: string,
    options: { observedPaths?: string[] } = {},
  ): Promise<CapturedWorkspaceFiles> {
    if (env.workspace_kind !== "directory")
      throw new WorkspaceError("captureFiles requires a directory workspace");
    const owned = this.ownedArtifactRelativeDirectory(env);
    return captureDirectoryWorkspace({
      executionRoot: env.worktree_path,
      envelopeRoot: this.envelopeBase(env.task_id, env.attempt_id),
      runRoot,
      ...options,
      excludedPaths: owned ? [owned] : [],
    });
  }

  /** The created-this-run bridge fact for diff(): in-memory set first, else
   *  the persisted envelope-id-bound marker (survives manager recreation). */
  private bridgeCreatedFact(env: WorkspaceEnvelope): boolean {
    if (this.bridgeCreatedEnvelopes.has(env.id)) return true;
    return bridgeCreatedMarkerMatches(this.envelopeBase(env.task_id, env.attempt_id), env.id);
  }

  /** Keep this envelope on disk past `dispose()`: it holds the only exact copy
   * of candidate bytes (the private exact patch object could not be written). */
  retainEnvelope(env: WorkspaceEnvelope): void {
    this.retainedEnvelopes.add(env.id);
  }

  async dispose(env: WorkspaceEnvelope): Promise<void> {
    if (this.retainedEnvelopes.has(env.id) || isRetainedEnvelope(env)) return;
    // Drop the created-this-run bridge fact so a long-lived manager doesn't
    // accumulate envelope ids (a disposed envelope is never diffed again).
    this.bridgeCreatedEnvelopes.delete(env.id);
    // In-place envelopes point worktree_path at the live repo root; NEVER remove a
    // worktree or the tree itself in that case.
    const inPlace = env.worktree_path === env.repo_root;
    if (inPlace) this.artifactOwnership.removeDirectory(env);
    if (!inPlace && env.workspace_kind !== "directory") {
      const privateClone = existsSync(
        join(this.envelopeBase(env.task_id, env.attempt_id), "private-clone-v1"),
      );
      if (!privateClone) {
        try {
          await worktreeRemove(this.repoRoot, env.worktree_path);
        } catch {
          /* best-effort */
        }
        if (env.branch_name && env.branch_name !== "inplace") {
          try {
            await branchDelete(this.repoRoot, env.branch_name);
          } catch {
            /* best-effort */
          }
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
    if (!inPlace && env.workspace_kind !== "directory") {
      try {
        await worktreePrune(this.repoRoot);
      } catch {
        /* best-effort */
      }
    }
  }

  /**
   * Dispose an ORPHANED envelope by ids alone (crash GC): a daemon
   * crash leaves envelopes with no live job. Reconstructs the disposal
   * surface from the envelope owner record when exact in-place identity is
   * needed, while legacy isolated envelopes retain the deterministic-path
   * fallback. Marker-bearing in-place state without valid recovery identity
   * is preserved for manual recovery rather than partially disposed.
   */
  async disposeOrphan(taskId: string, attemptId: string): Promise<void> {
    const base = this.envelopeBase(taskId, attemptId);
    const recovery = readEnvelopeRecoveryRecord(base);
    const artifactMarkerExists = existsSync(join(base, "artifact-created.json"));
    if (!recovery && artifactMarkerExists) {
      throw new WorkspaceError(
        `refusing to dispose orphan ${taskId}/${attemptId}: artifact ownership exists without valid recovery identity`,
      );
    }
    const inPlace = recovery?.workspaceMode === "in_place";
    const directory = recovery?.workspaceKind === "directory";
    const envelope = WorkspaceEnvelopeSchema.parse({
      id: recovery?.envelopeId ?? newId("env"),
      task_id: taskId,
      attempt_id: attemptId,
      repo_root: this.repoRoot,
      base_ref: directory ? null : "HEAD",
      base_sha: directory || inPlace ? null : "0000000000000000000000000000000000000000",
      workspace_kind: recovery?.workspaceKind,
      worktree_path: inPlace ? this.repoRoot : join(base, "tree"),
      branch_name: directory ? null : inPlace ? "inplace" : `claudexor/${taskId}/${attemptId}`,
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
    });
    if (artifactMarkerExists && this.artifactOwnership.relativeDirectory(envelope) === null) {
      throw new WorkspaceError(
        `refusing to dispose orphan ${taskId}/${attemptId}: artifact ownership does not match recovery identity`,
      );
    }
    await this.dispose(envelope);
  }
}
