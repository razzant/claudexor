import { existsSync, lstatSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { WorkspaceError, type ScopeReapOutcome } from "@claudexor/core";
import { ensureDir, ownedProjectRuntimeDir, projectRuntimeDir } from "@claudexor/util";
import {
  branchDeleteIfPresent,
  ensureGitRepository,
  git,
  gitCommonDir,
  GitInitializationError,
  PreparationCancelled,
  PreparationStopped,
  revParse,
  snapshotTree,
  throwIfCancelled,
  worktreeAdd,
  worktreeAddExisting,
  worktreeRegistered,
  worktreeRemoveRegistered,
  worktreeRepository,
  unconfirmedTerminationOf,
} from "./git.js";
import { terminationDisclosure, withScopeMarker } from "./git-run.js";
import {
  assertThreadTreeReady,
  holdThreadPreparation,
  PreparationCleanupFailed,
  PreparationHeld,
  readThreadPreparation,
  releaseThreadPreparation,
  removeEmptyDir,
  removeThreadPreparationRecord,
  threadPreparationRecordPath,
  threadTreeState,
  writeThreadPreparation,
  type PreparationQuietRead,
  type ThreadPreparationRecord,
} from "./preparation-hold.js";
import type { EnsureGitRepositoryResult } from "./git.js";
import { noteCleanupFault } from "./cleanup-fault.js";
import { diskProgress, gitObserved } from "./git-observed.js";

export interface ThreadWorktreeResult {
  /** Absolute path to the thread's persistent worktree (the execution root). */
  path: string;
  /** Snapshot sha the worktree was branched from (the apply base). */
  baseSha: string;
  /** True when the worktree was just created (vs reused). */
  created: boolean;
  /** Project initialization performed before this worktree could exist. */
  projectGitInitialization?: EnsureGitRepositoryResult | null;
}

/** A thread's tree as its preparation spells it: under the config root as
 * configured (`projectRuntimeDir`). The preparation's record names this spelling
 * and its current child is owned under it, so its releases are addressed by it. */
function preparedTree(projectRoot: string, threadId: string): string {
  return join(projectRuntimeDir(projectRoot), "threads", threadId, "tree");
}

/**
 * Lazily create (or reuse) the persistent git worktree backing an ISOLATED
 * thread. Turns run in-place WITHIN this worktree so each sees the previous
 * one's work; `apply` later diffs the worktree against `baseSha` and delivers
 * the cumulative patch to the project. Race candidates still branch off the
 * worktree's current state into throwaway envelopes.
 *
 * The worktree lives in Claudexor's external per-project runtime namespace;
 * the project's own git and ignore files are never used as a runtime boundary.
 *
 * `signal` is the turn's stop: checked before anything changes and between
 * steps, handed to each Git step (`PreparationStopped`). A stop never removes
 * an existing worktree or a surviving branch. The preparation BEGINS before its
 * first Git step that can start a hook or a filter: at once when the tree is
 * not ready (the project's initialization, the base snapshot and the lookups
 * follow), and for a ready tree only if the project must first be initialized.
 * Beginning opens its process scope (`openScope`) and writes its record
 * (`preparation.json`, naming that scope), both durably: a failure of either
 * refuses with nothing spawned. That first record is `early` — it owns nothing
 * of the thread — and is rewritten with what the preparation owns before the
 * first step that changes the thread. The record goes last, on success, and
 * only after `settleScope` proved that what the scope's processes started has
 * ended — otherwise the tree is held, not handed over. A tree with a record is
 * never reused: the record's release runs first and, while what an earlier stop
 * left may still run, refuses with what is held. A failed preparation settles
 * its scope and then releases what it made, or refuses with what stays held
 * (`afterFailedPreparation`).
 */
export async function ensureThreadWorktree(
  projectRoot: string,
  threadId: string,
  options: {
    signal?: AbortSignal;
    /** Open the process scope of this preparation's Git children (only when the
     * tree is really made); a failure refuses before anything is spawned. */
    openScope?: () => Promise<{ marker: string }>;
    /** Settle that scope (its owner's reap, once): after success before the tree
     * is handed over, after a failure before what it made is released. */
    settleScope?: () => Promise<ScopeReapOutcome | null>;
    /** The release criterion (the daemon also reads the scope's index row). */
    quiet?: PreparationQuietRead;
    /** Test seam: the platform whose step-boundary rule applies (`userLockStep`). */
    platform?: NodeJS.Platform;
  } = {},
): Promise<ThreadWorktreeResult> {
  const { signal, platform } = options;
  if (!/^[A-Za-z0-9._-]+$/.test(threadId) || threadId === "." || threadId === "..") {
    throw new WorkspaceError(`threadId '${threadId}' is not a safe path segment`);
  }
  throwIfCancelled(signal);
  const path = preparedTree(projectRoot, threadId);
  const threadDir = dirname(path);
  // An unfinished preparation (stopped, or its daemon died midway) is released
  // first, or refused while what it started may still run.
  // A complete checkout whose scope's end is now proven is handed over as made.
  const handover =
    threadTreeState(path) === "held" &&
    (await releaseThreadPreparation(projectRoot, path, options.quiet)) === "completed";
  let scope: { marker: string } | null = null;
  let record: ThreadPreparationRecord | null = null;
  let stepSignal = signal;
  const begin = async (): Promise<AbortSignal | undefined> => {
    if (record) return stepSignal;
    throwIfCancelled(signal);
    if (options.openScope) scope = await options.openScope();
    const early: ThreadPreparationRecord = {
      schema: 1,
      thread_id: threadId,
      tree: path,
      scope,
      opened_at: new Date().toISOString(),
      early: true,
      own_registration: null,
      own_branch: null,
    };
    try {
      ensureDir(threadDir);
      writeThreadPreparation(early);
    } catch (error) {
      removeEmptyDir(threadDir);
      throw error;
    }
    record = early;
    if (scope) stepSignal = withScopeMarker(signal, scope.marker);
    return stepSignal;
  };
  const ready = threadTreeState(path) === "ready";
  let made: ThreadWorktreeResult | null = null;
  let projectGitInitialization: EnsureGitRepositoryResult | null = null;
  try {
    if (!ready) await begin();
    // Explicitly choosing an isolated thread authorizes this one idempotent
    // project mutation — on a plausible root: the canonical initializer refuses
    // the user home directory and filesystem roots with a typed error
    // (INV-075). In-place read-only work remains untouched.
    const gitInitialization = await ensureGitRepository(projectRoot, {
      signal: stepSignal,
      beforeMutation: begin,
      ...(platform ? { platform } : {}),
    });
    if (gitInitialization.initialized || gitInitialization.baselineCommitted)
      projectGitInitialization = gitInitialization;
    if (!ready) made = await makeTree();
  } catch (error) {
    // A scope that opened without its record (the record's write failed) is
    // settled too: nothing was spawned in it and no entry of it is left behind.
    if (!record) await options.settleScope?.().catch(() => null);
    throw record ? await afterFailedPreparation(projectRoot, path, error, options) : error;
  }
  if (record) {
    // A hook or filter the preparation started may still write in the tree: one
    // its scope's settlement saw alive (or could not read) keeps it held.
    if (scope) await settledScope(options.settleScope, path);
    // The tree is handed over only once its record is gone: a record that stays
    // over a used tree would have it released as unfinished later.
    removeThreadPreparationRecord(path);
  }
  // A ready tree: turns never commit on the branch (in-place envelopes leave
  // changes in the working tree), so HEAD still points at the original base snapshot.
  return (
    made ?? {
      path,
      baseSha: await revParse(path, "HEAD", signal),
      created: handover,
      projectGitInitialization,
    }
  );

  /** The base snapshot, the lookups and the checkout, through its durable `complete`. */
  async function makeTree(): Promise<ThreadWorktreeResult> {
    throwIfCancelled(signal);
    const baseSha = await snapshotTree(projectRoot, [], [], stepSignal);
    const branch = `claudexor/thread-${threadId}`;
    // Thread branches are PERSISTENT live-thread state. When the branch
    // survives but the worktree directory was lost, RECOVER by recreating the
    // worktree FROM the branch (its tip is the thread's base — turns never
    // commit on it) instead of failing `worktree add -b` on the collision.
    // A stopped lookup is the stop, never "no branch".
    const branchExisted = await revParse(projectRoot, branch, stepSignal).then(
      () => true,
      (error: unknown) => {
        if (error instanceof PreparationStopped || unconfirmedTerminationOf(error)) throw error;
        return false;
      },
    );
    // Only a registration this call creates is its own to remove after a killed add.
    // The recovery add drops the lost directory's stale registration first, so it
    // reads this only then (beforeAdd); until that read, nothing registered is ours.
    const registeredBefore = branchExisted || (await worktreeRegistered(projectRoot, path));
    throwIfCancelled(signal);
    // From here the thread changes: the record names what this preparation owns.
    const owning: ThreadPreparationRecord = {
      ...record!,
      own_registration: branchExisted ? null : !registeredBefore,
      own_branch: branchExisted ? null : { name: branch, tip: baseSha },
    };
    delete owning.early;
    writeThreadPreparation(owning);
    if (branchExisted) {
      await worktreeAddExisting(
        projectRoot,
        path,
        branch,
        stepSignal,
        async () => {
          const before = await worktreeRegistered(projectRoot, path);
          writeThreadPreparation({ ...owning, own_registration: !before });
        },
        platform,
      );
    } else {
      await worktreeAdd(projectRoot, path, branch, baseSha, stepSignal, platform);
    }
    const created = branchExisted ? await revParse(path, "HEAD") : baseSha;
    // The checkout is complete (durably, before its scope settles): a later release
    // after a proven end then frees only the record and keeps this tree.
    writeThreadPreparation({ ...(readThreadPreparation(path) ?? owning), complete: true });
    return { path, baseSha: created, created: true, projectGitInitialization };
  }
}

/**
 * After a successful preparation, its scope's settlement: a member it found
 * alive after the ladder, or a known member it could not read, may still write
 * in the tree — the record stays (held) and the turn is refused with them; the
 * next attempt hands the tree over once a read proves their end. A settlement
 * that only could not prove the scope empty (a failed or deadline-bound census,
 * a settlement that threw, a host with no census) names no such member: a
 * healthy preparation goes on, and the scope's index entry stays unresolved for
 * the existing later settlement and the next start (INV-144).
 */
async function settledScope(
  settle: (() => Promise<ScopeReapOutcome | null>) | undefined,
  tree: string,
): Promise<void> {
  const outcome = await settle?.().catch(() => null);
  if (!outcome || (outcome.survivors.length === 0 && outcome.unreadable.length === 0)) return;
  const unresolved = scopeUnresolved(outcome);
  holdThreadPreparation(tree, { reason: "scope_unsettled", groups: [] });
  throw new PreparationHeld(
    `the thread worktree preparation finished, but what its processes started was not proven ended: ${unresolved.join("; ")}`,
    { tree, record: threadPreparationRecordPath(tree), unresolved },
    { reason: "scope_unsettled", groups: [] },
  );
}

function scopeUnresolved(outcome: ScopeReapOutcome): string[] {
  const reasons: string[] = [];
  if (outcome.census === "failed")
    reasons.push(`census failed${outcome.censusFailure ? ` (${outcome.censusFailure})` : ""}`);
  if (outcome.survivors.length > 0)
    reasons.push(`survivors ${outcome.survivors.map((member) => member.pid).join(", ")}`);
  if (outcome.unreadable.length > 0)
    reasons.push(`unreadable ${outcome.unreadable.map((member) => member.pid).join(", ")}`);
  if (outcome.incomplete) reasons.push("settlement incomplete (its deadline expired)");
  return reasons.length > 0 ? reasons : ["not settled"];
}

/**
 * A preparation that failed after its record was written, at any step. A stop
 * whose end was not proven is recorded at the record first (its groups, why).
 * Then, in this order and each once: the scope's own settlement, which ends
 * what the failed steps left by measured identity, and the one release, whose
 * read then finds them gone instead of waiting on them. Returns the error to
 * throw:
 *
 * - released: the failure itself — for a stop whose end the settlement has now
 *   proven, the ordinary stop (`PreparationCancelled`), or the partial
 *   initialization without an unconfirmed termination;
 * - still held after an unconfirmed stop: the typed refusal
 *   (`termination_unconfirmed`, what is held, the partial initialization) —
 *   also where the release's read could prove nothing (Windows has no group
 *   probe and no census): then only an operator's confirmation releases it
 *   (`release_requires`); when the stop's facts could not be put on the record
 *   (its write was refused, or the record could not be read), no read is made
 *   from it and the refusal carries the stop's own facts;
 * - the end proven but the record (or something else) not removable, after a
 *   stop: the typed cleanup refusal (`preparation_cleanup_failed`, retryable,
 *   the partial initialization), never an unconfirmed termination;
 * - still held, or not removable, after any other failure: that failure, with
 *   what stays held (or was left) added to its message; the next attempt's
 *   release reads again and refuses, typed, while the record stands. After an
 *   ordinary failure (no stop) this call alone may release under the platform's
 *   tree-only limit where nothing can be read (`platformLimit`).
 *
 * A surviving branch, a tree or a registration that was there before this
 * preparation is never removed: the record names only what it made.
 */
async function afterFailedPreparation(
  projectRoot: string,
  path: string,
  error: unknown,
  options: {
    settleScope?: () => Promise<ScopeReapOutcome | null>;
    quiet?: PreparationQuietRead;
  },
): Promise<unknown> {
  const unconfirmed = unconfirmedTerminationOf(error);
  let recorded = true;
  if (unconfirmed) {
    try {
      // False: the record stands but could not be read, so it did not take the stop.
      recorded = holdThreadPreparation(path, unconfirmed);
    } catch (fault) {
      // Without its recorded groups the release would read too little: it stays.
      recorded = false;
      noteCleanupFault(error, fault);
    }
  }
  await options.settleScope?.().catch((fault: unknown) => noteCleanupFault(error, fault));
  let left: unknown;
  try {
    // An unconfirmed stop is on the record by now: only a proven end releases it.
    if (recorded)
      await releaseThreadPreparation(projectRoot, path, options.quiet, { platformLimit: true });
    else assertThreadTreeReady(path);
  } catch (fault) {
    left = fault;
  }
  if (left === undefined) {
    if (!unconfirmed) return error;
    if (error instanceof GitInitializationError) return error.withEndProven();
    if (error instanceof PreparationStopped) return new PreparationCancelled(error.reason);
    if (error instanceof Error) error.message = `${error.message}; what it started has since ended`;
    return error;
  }
  noteCleanupFault(error, left);
  const stopped = unconfirmed !== undefined || error instanceof PreparationStopped;
  if (
    (unconfirmed && left instanceof PreparationHeld) ||
    (stopped && left instanceof PreparationCleanupFailed)
  ) {
    // The stop's own facts, when the record could not take them (no read was made).
    if (unconfirmed && !recorded && left instanceof PreparationHeld)
      left.context.termination_unconfirmed = terminationDisclosure(unconfirmed);
    if (error instanceof GitInitializationError) {
      left.context.project_git_initialization = error.context.project_git_initialization;
      const step = left instanceof PreparationCleanupFailed ? error.withEndProven() : error;
      left.message = `${step.message}; ${left.message}`;
    }
    return left;
  }
  const why = left instanceof Error ? left.message : String(left);
  if (error instanceof Error) error.message = `${error.message}; ${why}`;
  return error;
}

/** Advance the persistent thread branch to the project state just delivered,
 * then realign its daemon-owned worktree. The branch ref makes snapshot
 * commits survive aggressive Git GC; the returned SHA is the journal base. */
export async function advanceThreadWorktree(
  projectRoot: string,
  threadId: string,
  worktreePath: string,
  targetSha: string,
): Promise<string> {
  if (!/^[A-Za-z0-9._-]+$/.test(threadId) || threadId === "." || threadId === "..") {
    throw new WorkspaceError(`threadId '${threadId}' is not a safe path segment`);
  }
  const branch = `refs/heads/claudexor/thread-${threadId}`;
  const oldTip = await revParse(projectRoot, branch);
  // Materialize the target in the daemon-owned index/worktree without moving
  // HEAD. Publishing the persistent branch first would make a failed reset or
  // clean look authoritative even though the worktree still held older work.
  const realign = await gitObserved(worktreePath, ["read-tree", "--reset", "-u", targetSha], {
    label: "read-tree --reset -u (thread)",
    progress: diskProgress(worktreePath),
    allowFailure: true,
  });
  if (realign.code !== 0) {
    throw new WorkspaceError(`thread worktree realignment failed: ${realign.stderr.trim()}`);
  }
  const clean = await git(worktreePath, ["clean", "-fd"]);
  if (clean.code !== 0) {
    throw new WorkspaceError(`thread worktree cleanup failed: ${clean.stderr.trim()}`);
  }
  const update = await git(projectRoot, ["update-ref", branch, targetSha, oldTip]);
  if (update.code !== 0) {
    throw new WorkspaceError(`thread branch advanced concurrently: ${update.stderr.trim()}`);
  }
  const observed = await revParse(worktreePath, "HEAD");
  if (observed !== targetSha) {
    throw new WorkspaceError("thread branch and worktree did not converge on the delivered SHA");
  }
  return targetSha;
}

/** Whether an isolated thread's directory is still on disk: its purge failed
 * after the journal commit, and the next retention pass retries it. */
export function threadWorktreeDirExists(projectRoot: string, threadId: string): boolean {
  return existsSync(join(projectRuntimeDir(projectRoot), "threads", threadId));
}

/** The repository a purge attempt asked, kept by its caller for the next one:
 * the common Git directory, and that directory's inode, which tells it apart
 * from another repository later put at the same path. Unlike the device
 * number, an inode survives a restart; null where the filesystem has none. */
export interface PurgeRepositoryRecord {
  gitDir: string;
  identity: string | null;
}

/** Explicit purge of daemon-owned isolated-thread resources. Lifecycle
 * authority lives in the journal; the generic orphan sweeper never guesses.
 * Git drops the worktree registration and then the branch before the
 * directory goes: a refusal (a locked worktree, a held ref lock) throws with
 * the directory still on disk, so the purge stays pending instead of reporting
 * what Git still records as deleted. What is already gone counts as done, but
 * only where it was looked for: in the repository the worktree's own `.git`
 * file names (`worktreeRepository`), else the one an earlier attempt recorded
 * (`repository`), else the project folder's. Git deletes that file with the
 * worktree and a project folder can be replaced, so the repository asked goes
 * to `recordRepository` before Git's first change in it, wherever it was
 * found: a retry after a refused branch deletion asks the same repository,
 * not whatever is at the project path by then. That holds after Git deleted
 * the registration but not the directory too: the `.git` file left behind
 * names a registration that is gone, and when it was in the recorded
 * repository, still at its path, that one is asked. Where Git has nothing of the
 * thread to change, nothing is recorded. A repository that cannot be
 * reached, or a recorded one replaced at its path, keeps the purge pending. A
 * link above the thread directory is refused (`ownedProjectRuntimeDir`); one
 * at the directory or its tree is unlinked first, so Git sees a missing
 * worktree and neither Git nor rm follows it. `worktreeRecorded`: the thread
 * record names a worktree; a thread that never had one leaves no Git state to
 * look for. Returns the common Git directory the cleanup asked, null when
 * there was none. */
export async function purgeThreadWorktree(
  projectRoot: string,
  threadId: string,
  {
    worktreeRecorded = true,
    repository = null,
    recordRepository = async () => {},
    quiet,
  }: {
    worktreeRecorded?: boolean;
    repository?: PurgeRepositoryRecord | null;
    recordRepository?: (repository: PurgeRepositoryRecord) => Promise<void>;
    /** The release criterion of an unfinished preparation (see ensureThreadWorktree). */
    quiet?: PreparationQuietRead;
  } = {},
): Promise<string | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(threadId) || threadId === "." || threadId === "..") {
    throw new WorkspaceError(`threadId '${threadId}' is not a safe path segment`);
  }
  const threadDir = join(ownedProjectRuntimeDir(projectRoot, "threads"), threadId);
  const path = join(threadDir, "tree");
  for (const entry of [threadDir, path]) {
    const stat = lstatSync(entry, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) unlinkSync(entry);
    if (!stat?.isDirectory()) break;
  }
  // An unfinished preparation is released through its own record first, and
  // refused while what a stop left may still run there. Its record names the
  // tree, and this process owns its current child, in the preparation's own
  // spelling: the config root as configured, which may be a link to, or another
  // case of, the canonical one walked above. No component below that root is a
  // link here, so both spellings name this one directory.
  const prepared = preparedTree(projectRoot, threadId);
  if (threadTreeState(prepared) === "held")
    await releaseThreadPreparation(projectRoot, prepared, quiet);
  const recorded = () => recordedRepository(repository, threadId);
  const owner =
    worktreeRepository(path, recorded) ??
    recorded() ??
    (await projectRepository(projectRoot, worktreeRecorded));
  if (owner !== null) {
    const record = { gitDir: owner, identity: directoryIdentity(owner) };
    let kept = record.gitDir === repository?.gitDir && record.identity === repository.identity;
    const keep = async () => {
      if (!kept) await recordRepository(record);
      kept = true;
    };
    await worktreeRemoveRegistered(owner, path, keep);
    await branchDeleteIfPresent(owner, `claudexor/thread-${threadId}`, keep);
  }
  rmSync(threadDir, { recursive: true, force: true });
  return owner;
}

function directoryIdentity(dir: string): string | null {
  const { ino } = statSync(dir, { bigint: true });
  return ino === 0n ? null : String(ino);
}

function recordedRepository(
  repository: PurgeRepositoryRecord | null,
  threadId: string,
): string | null {
  if (repository === null) return null;
  const now = statSync(repository.gitDir, { bigint: true, throwIfNoEntry: false });
  if (
    now &&
    (repository.identity === null || now.ino === 0n || String(now.ino) === repository.identity)
  )
    return repository.gitDir;
  throw new WorkspaceError(
    `repository ${repository.gitDir}, which this cleanup recorded as holding thread ${threadId}'s worktree registration and branch, is gone or another one is there now; returning it there lets the next attempt finish this cleanup`,
  );
}

/** Without the worktree's own record of its repository: the project folder's
 * repository, which may be a larger one around it. None there is no proof for
 * a recorded worktree, since a moved or deleted repository looks the same. */
async function projectRepository(
  projectRoot: string,
  worktreeRecorded: boolean,
): Promise<string | null> {
  if (existsSync(projectRoot)) {
    for (let current = resolve(projectRoot); ; current = dirname(current)) {
      if (existsSync(join(current, ".git"))) return gitCommonDir(projectRoot);
      if (dirname(current) === current) break;
    }
  }
  if (!worktreeRecorded) return null;
  throw new WorkspaceError(
    `project folder ${projectRoot} is gone or in no Git repository, so the thread's worktree registration and branch cannot be checked; restoring the folder there lets the next attempt finish this cleanup`,
  );
}
