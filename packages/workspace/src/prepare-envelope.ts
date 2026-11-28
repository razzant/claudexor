import { stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  AccessProfile,
  DirtyPolicy,
  WorkspaceEnvelope,
  WorkspaceKind,
} from "@claudexor/schema";
import { WorkspaceEnvelope as WorkspaceEnvelopeSchema } from "@claudexor/schema";
import { WorkspaceError } from "@claudexor/core";
import { ensureDirAsync, newId, nowIso, writeTextAsync } from "@claudexor/util";
import { discardUnstartedEnvelope, noteCleanupFault } from "./cleanup-fault.js";
import { isolatedBaseCustody } from "./capture-objects.js";
import { repositoryObjectFormat } from "./git-result.js";
import { assertProjectObjectFormat } from "./object-store.js";
import { ensureHarnessHomeAsync } from "./harness-home.js";
import { createDirectoryEnvelope } from "./directory-workspace.js";
import type { RunContentIndex } from "./content-index.js";
import { fileSpaceFailure } from "./file-copy.js";
import { processStartTime } from "./envelope-recovery.js";
import { liveEnvelopeCustody, writeEnvelopeCustodyAsync } from "./envelope-custody.js";
import { snapshotLegacyDirectoryBaseline } from "./plain-diff.js";
import { rawAcceptedPaths, rawAwareSnapshot, transferRawRecords } from "./raw-patch.js";
import { ensureClaudeBridge, writeBridgeCreatedMarker } from "./claude-bridge.js";
import {
  afterScopeSettled,
  scopeMarkerOf,
  throwIfCancelled,
  unconfirmedTerminationOf,
} from "./git-run.js";
import {
  holdEnvelopePreparation,
  releaseEnvelopeBase,
  updateEnvelopePreparationAsync,
} from "./envelope-preparation.js";
import { writeAtomicAsync } from "./preparation-hold.js";
import { preparationUnderWay } from "./preparation-release.js";
import { isolatedCloneAdd, isGitRepo, revParse, statusPorcelain, stashCreate } from "./git.js";

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
  /** Copy this source's Raw membership into a fresh isolated Git candidate before
   * handoff. In-place and directory envelopes need no transfer. */
  seedRawRecords?: boolean;
  /** The run's stop. Checked before anything is made and between steps; a running
   * Git child is stopped (`PreparationStopped`); its Git children join the scope the
   * signal carries (`withScopeMarker`). */
  signal?: AbortSignal;
  /** Set by the run's manager: a directory baseline shares the run's immutable bytes. */
  contentIndex?: RunContentIndex;
}

/**
 * Prepare one envelope at `base`: scoped HOME and per-harness config dirs, plus
 * the in-place snapshot, the copied directory footprint, or the isolated private
 * clone with its base custody. Any failure, a stop included, removes a base this
 * call made (#501). An isolated base is not removed from under what may still run
 * (#694): after a stop whose end was not proven it is held (owner.json
 * `preparation`), and one prepared in a process scope is released by a read once
 * that scope settled, since a filter that left the failed Git's group is the
 * scope's to end.
 */
export async function prepareEnvelope(input: {
  repoRoot: string;
  projectRoot: string | undefined;
  base: string;
  opts: CreateEnvelopeOptions;
}): Promise<{ envelope: WorkspaceEnvelope; bridgeCreated: boolean }> {
  const { base, opts } = input;
  throwIfCancelled(opts.signal);
  // Lane start awaits the disk (#688); only an envelope this call made is removed on refusal.
  const madeHere = (await stat(base).catch(() => null)) === null;
  // A sibling's dispose prunes the task folder only while it is empty, also
  // while this makes it: a parent gone under the mkdir is made again (#704).
  await ensureDirAsync(base)
    .catch((error: { code?: string }) =>
      error?.code === "ENOENT" ? ensureDirAsync(base) : Promise.reject(error),
    )
    .catch((error: unknown) => Promise.reject(directorySpaceFailure(opts, error)));
  // Under way until this call returns: an operator's confirmation never takes it.
  const done = preparationUnderWay(base);
  try {
    return await prepareOrKeep(input, madeHere);
  } finally {
    done();
  }
}

async function prepareOrKeep(
  input: Parameters<typeof prepareEnvelope>[0],
  madeHere: boolean,
): Promise<{ envelope: WorkspaceEnvelope; bridgeCreated: boolean }> {
  const { base, opts } = input;
  try {
    const prepared = await prepareAt(input);
    // Handed over: the preparation is complete (a failed write fails it).
    await updateEnvelopePreparationAsync(base, (facts) =>
      facts ? { ...facts, preparing: false } : null,
    );
    return prepared;
  } catch (thrown) {
    // Before the removal below, so its cleanup facts join the typed refusal.
    const error = directorySpaceFailure(opts, thrown);
    if (!madeHere) throw error;
    const isolated = !opts.inPlace && opts.workspaceKind !== "directory";
    // An isolated base whose stopped Git (or what it started) may still run is
    // kept with that fact, never removed under it nor reused (its path is
    // unique): released after the run's scope settled, else by the startup sweep —
    // and where no read can prove its end, only on an operator's confirmation.
    const unconfirmed = unconfirmedTerminationOf(error);
    if (unconfirmed && isolated) {
      try {
        await holdEnvelopePreparation(base, unconfirmed);
      } catch (fault) {
        // owner.json still says `preparing`: the sweep reads its scope anyway.
        noteCleanupFault(error, fault);
      }
      afterScopeSettled(
        opts.signal,
        async () => {
          await releaseEnvelopeBase(base);
        },
        base,
      );
      throw Object.assign(error as object, { heldBase: base });
    }
    // The failed step's own end (its pipes closed, its group empty) says nothing of
    // a filter or hook it started that left both and still carries the scope's
    // marker. A base prepared in a scope therefore goes the way a held one does:
    // by the read-only release (owner.json still says `preparing`), after its
    // owner settled the scope, never from under what may still run there. Windows
    // has no scope census: there the removal attempt itself is all that can tell.
    if (isolated && scopeMarkerOf(opts.signal) && process.platform !== "win32")
      throw await releaseFailedScopedBase(base, opts.signal, error);
    throw await discardUnstartedEnvelope(base, error);
  }
}

/** A directory workspace's preparation that ran out of room, at any step (its
 * base, owner.json, the scoped home, the copies), is the typed space refusal; its
 * cause keeps the system's code. Git preparations keep their own errors. */
function directorySpaceFailure(opts: CreateEnvelopeOptions, error: unknown): unknown {
  return opts.workspaceKind === "directory"
    ? fileSpaceFailure(error, "directory preparation")
    : error;
}

/**
 * The base of a failed (or stopped) isolated preparation whose Git children joined
 * a scope. With an owner of that scope (a run), the release waits for its
 * settlement, which ends what the scope still holds, and the failure is thrown as
 * it is. Without one, the release's read decides now: quiet removes the base;
 * otherwise it stays for the startup sweep and the failure names it (`heldBase`).
 * Resolves to what to throw.
 */
async function releaseFailedScopedBase(
  base: string,
  signal: AbortSignal | undefined,
  error: unknown,
): Promise<unknown> {
  const release = (): Promise<boolean> => releaseEnvelopeBase(base);
  if (afterScopeSettled(signal, () => release().then(() => {}))) return error;
  let kept = "what its preparation started may still run";
  try {
    if (await release()) return error;
  } catch (fault) {
    noteCleanupFault(error, fault);
    kept = fault instanceof Error ? fault.message : String(fault);
  }
  if (error instanceof Error)
    error.message = `${error.message}; its never-started envelope ${base} is kept: ${kept}`;
  return Object.assign(error as object, { heldBase: base });
}

async function prepareAt(input: {
  repoRoot: string;
  projectRoot: string | undefined;
  base: string;
  opts: CreateEnvelopeOptions;
}): Promise<{ envelope: WorkspaceEnvelope; bridgeCreated: boolean }> {
  const { repoRoot, projectRoot, base, opts } = input;
  const signal = opts.signal;
  const envelopeId = newId("env");
  const workspaceMode = opts.inPlace ? "in_place" : "isolated";
  // Liveness marker for crash GC, written whole once the base exists and before
  // the scoped home (#704): the sweeper must never dispose an envelope whose
  // creating process (daemon, CLI, MCP/ACP serve) is still alive —
  // startup GC's "nothing can own an envelope" premise only holds for
  // daemon-tracked runs. Pid + ps START TIME form a recycling-proof identity
  // (command names/titles mutate — vitest, daemons and tools retitle
  // themselves; the kernel start time never does).
  await writeAtomicAsync(join(base, "owner.json"), {
    pid: process.pid,
    started: processStartTime(process.pid),
    created_at: nowIso(),
    envelope_id: envelopeId,
    workspace_mode: workspaceMode,
    workspace_kind: opts.workspaceKind,
    execution_root: repoRoot,
    // Unfinished until handed over: a sweep reads its scope before touching it.
    preparation: { scope_marker: scopeMarkerOf(signal) ?? null, preparing: true },
  });
  const homeDir = join(base, "home");
  const harnessConfigDirs = await ensureHarnessHomeAsync(homeDir);

  if (opts.workspaceKind === "directory") {
    const envelope = await createDirectoryEnvelope({
      ...opts,
      sourceRoot: repoRoot,
      envelopeRoot: base,
      envelopeId,
      homeDir,
      harnessConfigDirs,
    });
    return { envelope, bridgeCreated: false };
  }

  // In-place mode: mutate the live repoRoot directly (no isolated checkout).
  // Used for thread turns (chat-first: the next turn sees this one's work) and
  // for stateful external environments where runtime state is the deliverable.
  // For a git project we record a per-turn snapshot sha so diff() captures only
  // THIS turn's net change; a non-git folder falls back to a cpSync baseline.
  if (opts.inPlace) {
    const gitRepo = await isGitRepo(repoRoot, signal);
    // Read-only execution gets a scoped HOME but no write-oriented prep:
    // no dangling Git snapshot, copied baseline, diff/capture, or later
    // delivery. The native adapter policy owns the promised read-only mode.
    const readOnly = opts.accessProfile === "readonly";
    // One project keeps one object format: refused before the turn, not at its capture.
    if (!readOnly && gitRepo && projectRoot && projectRoot !== repoRoot)
      await assertProjectObjectFormat(
        projectRoot,
        await repositoryObjectFormat(repoRoot, undefined, signal),
        signal,
      );
    const baseSha = !readOnly && gitRepo ? await rawAwareSnapshot(repoRoot, signal) : null;
    throwIfCancelled(signal);
    if (!readOnly && !gitRepo) snapshotLegacyDirectoryBaseline(repoRoot, base);
    const envelope = WorkspaceEnvelopeSchema.parse({
      id: envelopeId,
      task_id: opts.taskId,
      attempt_id: opts.attemptId,
      repo_root: repoRoot,
      base_ref: opts.baseRef ?? "HEAD",
      base_sha: baseSha,
      worktree_path: repoRoot,
      branch_name: "inplace",
      home_dir: homeDir,
      harness_config_dirs: harnessConfigDirs,
      policy_profile: opts.accessProfile ?? "workspace_write",
      // Record the EFFECTIVE policy, not the ignored request: in-place runs
      // always fold dirty state into the per-turn base snapshot above.
      dirty_policy: "snapshot",
      created_at: nowIso(),
    });
    return { envelope, bridgeCreated: false };
  }

  if (!(await isGitRepo(repoRoot, signal))) {
    throw new WorkspaceError(`not a git repository: ${repoRoot}`);
  }
  const baseRef = opts.baseRef ?? "HEAD";
  const dirtyPolicy: DirtyPolicy = opts.dirtyPolicy ?? "refuse";
  let baseSha = await revParse(repoRoot, baseRef, signal);

  const porcelain = await statusPorcelain(repoRoot, signal);
  const dirty = porcelain.trim().length > 0;
  if (dirty && dirtyPolicy === "refuse") {
    throw new WorkspaceError("working tree is dirty; commit/stash or set dirty_policy: snapshot");
  }
  // A snapshot base holds what an accepted raw patch left in this tree: status
  // cannot show an ignored one, and the next candidate would start without it (#594).
  const keep = dirtyPolicy === "snapshot" ? await rawAcceptedPaths(repoRoot, baseRef, signal) : [];
  if (dirty || keep.length > 0) {
    // snapshot: a stash-create commit becomes the base SHA without touching
    // the live tree. (The include/stash aliases and the untested `copy`
    // variant were retired in the v0.15 triage.)
    const snap = await stashCreate(repoRoot, {}, [], keep, signal);
    if (snap) baseSha = snap;
  }

  const path = join(base, "tree");
  const branch = `claudexor/${opts.taskId}/${opts.attemptId}`;
  // D2: a dirty base's own closure enters the project store BEFORE the clone,
  // whose second alternate is that store (never the user repo's).
  const storeObjects = await isolatedBaseCustody(
    repoRoot,
    projectRoot ?? repoRoot,
    baseSha,
    [base, ...(opts.custody ? [opts.custody.runDir] : [])],
    signal,
  );
  await isolatedCloneAdd(repoRoot, path, branch, baseSha, storeObjects, signal);
  throwIfCancelled(signal);
  await writeTextAsync(join(base, "private-clone-v1"), "private Git authority\n");

  // Still preparation: a failed transfer must keep the whole private base under
  // prepareOrKeep, before either the caller or continuation custody owns it.
  if (opts.seedRawRecords) {
    await transferRawRecords(repoRoot, path, signal);
    throwIfCancelled(signal);
  }

  // AGENTS.md compatibility bridge (INV-113): the checkout omits any
  // untracked project-root file, so a Claude Code candidate may need an
  // envelope-local bridge. Never mutate the user's live project root here.
  // Self-fenced (acts only with a committed AGENTS.md and no CLAUDE.md),
  // best-effort, and no run event. `diff()` excludes the generated bridge so it never enters
  // the candidate patch.
  // ONLY when THIS prep actually created the bridge (recorded below) does diff()
  // exclude it; a CLAUDE.md already present is never excluded (A-3 residual).
  let bridgeCreated = false;
  try {
    bridgeCreated = (await ensureClaudeBridge(path)).created;
  } catch {
    /* a missing bridge is harmless; never fail envelope creation over it */
  }

  const envelope = WorkspaceEnvelopeSchema.parse({
    id: envelopeId,
    task_id: opts.taskId,
    attempt_id: opts.attemptId,
    repo_root: repoRoot,
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
  // Persisted beside owner.json as well (bridge-created.json): the manager's
  // in-memory fact dies with its instance (daemon restart mid-run), and losing
  // the fact CAPTURES a pristine generated bridge into patch.diff.
  if (bridgeCreated) await writeBridgeCreatedMarker(base, envelope.id);
  if (opts.custody)
    await writeEnvelopeCustodyAsync(base, liveEnvelopeCustody(envelope, opts.custody));
  return { envelope, bridgeCreated };
}
