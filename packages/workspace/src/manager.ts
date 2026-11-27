import { existsSync, mkdtempSync } from "node:fs";
import { rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type {
  CaptureChangeInventory,
  GitObjectResult,
  PatchViewUnavailable,
  WorkspaceEnvelope,
} from "@claudexor/schema";
import { captureObjectFacts as objectFacts } from "./git-transient-capture.js";
import { WorkspaceEnvelope as WorkspaceEnvelopeSchema } from "@claudexor/schema";
import { WorkspaceError } from "@claudexor/core";
import { newId, nowIso, projectRuntimeDir, removeTree, withPoolWriteSlot } from "@claudexor/util";
import { ensureLaneHomeEnv, type LaneHomeEnv } from "./lanes.js";
import { ensureHarnessHome, harnessHomeEnv } from "./harness-home.js";
import { ArtifactOwnership } from "./artifact-ownership.js";
import { captureDirectoryWorkspace, type CapturedWorkspaceFiles } from "./directory-workspace.js";
import {
  envelopeBaseIn,
  physicalEnvelopeBase,
  readEnvelopeRecoveryRecord,
} from "./envelope-recovery.js";
import { isRetainedEnvelope } from "./envelope-custody.js";
import { rawAcceptedPaths } from "./raw-patch.js";
import { capturePlainDiff } from "./plain-diff-capture.js";
import {
  CLAUDE_BRIDGE_BASENAME,
  CURRENT_CLAUDE_BRIDGE_GENERATION,
  bridgeCreatedMarkerGeneration,
  isGeneratedClaudeBridge,
  type ClaudeBridgeGeneration,
} from "./claude-bridge.js";
import { prepareEnvelope, type CreateEnvelopeOptions } from "./prepare-envelope.js";
import { RunContentIndex } from "./content-index.js";
import { branchDelete, captureWorkingTreeTransient, worktreePrune, worktreeRemove } from "./git.js";

/** One candidate capture. `diff` is the exact patch every consumer (apply,
 * synthesis, review, digests, saved copies) reads (INV-146). */
export interface CapturedWorkspaceDiff {
  diff: string;
  /** The capture could not observe the candidate's changes at all (no legacy
   * baseline, a failed `diff`): an honest capture refusal, never "no changes". */
  captureIncomplete: boolean;
  captureFailure?: Error;
  /** Untracked nested repositories left out of `diff` (a patch cannot carry
   * another repository); disclosed with the attempt. */
  excludedNestedRepositories?: string[];
  /** The exact candidate as Git objects (#535): canonical whenever present;
   * `diff` is then only its rendered view, "" when `patchViewUnavailable`. */
  result?: GitObjectResult;
  patchViewUnavailable?: PatchViewUnavailable;
  inventory?: CaptureChangeInventory;
  changedPaths?: string[];
  existingPaths?: string[];
}

export type { CreateEnvelopeOptions } from "./prepare-envelope.js";

/** Manages WorkspaceEnvelopes: an isolated Git checkout plus scoped HOME and per-harness
 * config dirs, and dirty-tree handling; Claudexor owns them (no native --worktree). */
export { processStartTime } from "./envelope-recovery.js";

export class WorkspaceManager {
  private readonly runtimeRoot: string;
  /** The project whose object store keeps this manager's Git objects, when it is
   * not the root Git runs in (a delegated run, an isolated thread). */
  private readonly projectRoot: string | undefined;
  private readonly artifactOwnership: ArtifactOwnership;

  /** Current-prep bridge ownership, also persisted beside owner.json for recovery.
   * Only a bridge created here and still byte-identical is excluded from capture. */
  private readonly bridgeCreatedEnvelopes = new Set<string>();
  private readonly retainedEnvelopes = new Set<string>();
  private readonly keptArtifactDirectories = new Set<string>();
  /** This run's engine-owned immutable directory bytes, one payload per digest:
   * one manager serves one run, so the index ends with it. */
  readonly contentIndex = new RunContentIndex();

  constructor(
    private readonly repoRoot: string,
    options: { runtimeRoot?: string; projectRoot?: string } = {},
  ) {
    this.runtimeRoot = options.runtimeRoot ?? projectRuntimeDir(repoRoot);
    this.projectRoot = options.projectRoot;
    this.artifactOwnership = new ArtifactOwnership((env) =>
      join(this.baseOf(env), "artifact-created.json"),
    );
  }

  private workspacesDir(): string {
    return join(this.runtimeRoot, "workspaces");
  }

  /** The envelope base under this manager's namespace (ids fenced, `envelopeBaseIn`). */
  private envelopeBase(taskId: string, attemptId: string): string {
    return envelopeBaseIn(this.workspacesDir(), taskId, attemptId);
  }

  /** Where `env` physically is: its recorded engine-owned base, else this namespace's. */
  private baseOf(env: WorkspaceEnvelope): string {
    return physicalEnvelopeBase(env, this.workspacesDir());
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
    const { envelope, bridgeCreated } = await prepareEnvelope({
      repoRoot: this.repoRoot,
      projectRoot: this.projectRoot,
      base: this.envelopeBase(opts.taskId, opts.attemptId),
      opts: { ...opts, contentIndex: this.contentIndex },
    });
    // Record the created-this-run fact keyed by envelope id, so diff() gates the
    // bridge exclusion on POSITIVE PROOF rather than on content bytes alone.
    if (bridgeCreated) this.bridgeCreatedEnvelopes.add(envelope.id);
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
   * state when the run ends, off the main thread (#704); making the small fixed
   * home stays synchronous for its synchronous callers.
   */
  readOnlyHomeEnv(): { env: Record<string, string>; dispose: () => Promise<void> } {
    // A throwaway temp base — never under the project / synthetic repo root, so a
    // no-project Ask leaves nothing in its cwd (§7) and nothing in any worktree (§6).
    const base = mkdtempSync(join(tmpdir(), "claudexor-ro-"));
    const homeDir = join(base, "home");
    return {
      env: harnessHomeEnv(homeDir, ensureHarnessHome(homeDir)),
      // Best-effort: a leftover scoped home is harmless and gc-able.
      dispose: () => removeTree(base).catch(() => undefined),
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

  /** `owner`: the path (run directory) whose existence keeps the result's objects. */
  async captureDiff(env: WorkspaceEnvelope, owner?: string): Promise<CapturedWorkspaceDiff> {
    if (env.workspace_kind === "directory")
      throw new WorkspaceError(
        "Directory results use captureFiles; a text diff is not their work product",
      );
    const incomplete: CapturedWorkspaceDiff = {
      diff: "",
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
          { projectRoot: this.projectRoot ?? env.repo_root, owner },
        );
        return {
          diff: captured.patch,
          captureIncomplete: captured.captureIncomplete,
          captureFailure: captured.captureFailure,
          ...objectFacts(captured),
        };
      }
      // Non-git fallback: diff the best-effort cpSync baseline against the live
      // tree. Missing or failed capture is an INCOMPLETE capture, never a safe
      // no-change result.
      const baseline = join(this.baseOf(env), "baseline");
      return capturePlainDiff(baseline, env.repo_root, artifactRelative);
    }
    // Exclude the envelope-local generated CLAUDE.md bridge (INV-113) from the
    // candidate patch — by EXACT path, and only when BOTH conditions hold: (1)
    // THIS run's prep actually created the bridge (the recorded created-this-run
    // fact), and (2) the worktree file is still BYTE-IDENTICAL to the bytes
    // that fact says were written (current, or legacy for a pre-CX590
    // envelope). A git pathspec cannot express either condition, so the
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
    const bridgeGeneration = this.bridgeCreatedGeneration(env);
    const bridgeExcludes =
      bridgeGeneration !== null && isGeneratedClaudeBridge(env.worktree_path, bridgeGeneration)
        ? [`:(exclude,top)${CLAUDE_BRIDGE_BASENAME}`]
        : [];
    // What an accepted raw patch wrote is the candidate's, ignored or not (#594).
    const keep = await rawAcceptedPaths(env.worktree_path, env.base_sha ?? "HEAD");
    const captured = await captureWorkingTreeTransient(
      env.worktree_path,
      env.base_sha ?? "HEAD",
      [...artifactExcludes, ...bridgeExcludes],
      { projectRoot: this.projectRoot ?? env.repo_root, owner, keep },
    );
    return {
      diff: captured.patch,
      captureIncomplete: captured.captureIncomplete,
      captureFailure: captured.captureFailure,
      ...objectFacts(captured),
    };
  }

  async diff(env: WorkspaceEnvelope): Promise<string> {
    const captured = await this.captureDiff(env);
    if (captured.captureIncomplete)
      throw captured.captureFailure ?? new WorkspaceError("Workspace diff capture is incomplete");
    return captured.diff;
  }

  /** Directory work products retain full files, independently of diff previews. */
  async captureFiles(
    env: WorkspaceEnvelope,
    runRoot: string,
    options: {
      observedPaths?: string[];
      retainContent?: boolean;
    } = {},
  ): Promise<CapturedWorkspaceFiles> {
    if (env.workspace_kind !== "directory")
      throw new WorkspaceError("captureFiles requires a directory workspace");
    const owned = this.ownedArtifactRelativeDirectory(env);
    return captureDirectoryWorkspace({
      executionRoot: env.worktree_path,
      envelopeRoot: this.baseOf(env),
      runRoot,
      ...options,
      contentIndex: this.contentIndex,
      excludedPaths: owned ? [owned] : [],
    });
  }

  /** The created-this-run bridge fact for diff(), naming the generation whose
   *  bytes were written: in-memory set first (this process's writer), else the
   *  persisted envelope-id-bound marker (survives manager recreation). */
  private bridgeCreatedGeneration(env: WorkspaceEnvelope): ClaudeBridgeGeneration | null {
    if (this.bridgeCreatedEnvelopes.has(env.id)) return CURRENT_CLAUDE_BRIDGE_GENERATION;
    return bridgeCreatedMarkerGeneration(this.baseOf(env), env.id);
  }

  /** Keep this envelope on disk past `dispose()`: it holds the only exact copy
   * of candidate bytes (the private exact patch object could not be written). */
  retainEnvelope(env: WorkspaceEnvelope): void {
    this.retainedEnvelopes.add(env.id);
  }

  /** Keep an in-place envelope's run-owned artifact directory in the live tree
   * past `dispose()`: when the run's changes were not captured, its media may
   * be the only copy (the run's own copies are bounded). */
  keepArtifactDirectory(env: WorkspaceEnvelope): void {
    this.keptArtifactDirectories.add(env.id);
  }

  async dispose(env: WorkspaceEnvelope): Promise<void> {
    if (this.retainedEnvelopes.has(env.id) || isRetainedEnvelope(env)) return;
    // Drop the created-this-run bridge fact so a long-lived manager doesn't
    // accumulate envelope ids (a disposed envelope is never diffed again).
    this.bridgeCreatedEnvelopes.delete(env.id);
    const keepArtifacts = this.keptArtifactDirectories.delete(env.id);
    // In-place envelopes point worktree_path at the live repo root; NEVER remove a
    // worktree or the tree itself in that case.
    const inPlace = env.worktree_path === env.repo_root;
    if (inPlace && !keepArtifacts) this.artifactOwnership.removeDirectory(env);
    if (!inPlace && env.workspace_kind !== "directory") {
      const privateClone = existsSync(join(this.baseOf(env), "private-clone-v1"));
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
    // dispose() from ever deleting the live tree. Off the main thread, owner.json last (#688).
    try {
      await removeTree(this.baseOf(env), { lastEntry: "owner.json" });
    } catch {
      /* best-effort */
    }
    // Prune the now-empty per-task parent dir (envelopeBase = <task>/<attempt>),
    // guarded to stay strictly inside the workspaces dir. The kernel removes it
    // only while it is empty, so a sibling another `create` makes meanwhile
    // stays (#704); best-effort: ENOTEMPTY and ENOENT leave nothing to prune.
    const taskDir = join(this.workspacesDir(), env.task_id);
    if (taskDir.startsWith(this.workspacesDir() + sep))
      await withPoolWriteSlot(undefined, () => rmdir(taskDir)).catch(() => undefined);
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
