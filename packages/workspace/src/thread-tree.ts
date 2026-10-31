import { existsSync, lstatSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { WorkspaceError } from "@claudexor/core";
import { ensureDir, ownedProjectRuntimeDir, projectRuntimeDir } from "@claudexor/util";
import {
  branchDelete,
  branchDeleteIfPresent,
  ensureGitRepository,
  git,
  gitCommonDir,
  revParse,
  snapshotTree,
  worktreeAdd,
  worktreeAddExisting,
  worktreeRemoveRegistered,
  worktreeRepository,
} from "./git.js";
import type { EnsureGitRepositoryResult } from "./git.js";
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

/**
 * Lazily create (or reuse) the persistent git worktree backing an ISOLATED
 * thread. Turns run in-place WITHIN this worktree so each sees the previous
 * one's work; `apply` later diffs the worktree against `baseSha` and delivers
 * the cumulative patch to the project. Race candidates still branch off the
 * worktree's current state into throwaway envelopes.
 *
 * The worktree lives in Claudexor's external per-project runtime namespace;
 * the project's own git and ignore files are never used as a runtime boundary.
 */
export async function ensureThreadWorktree(
  projectRoot: string,
  threadId: string,
): Promise<ThreadWorktreeResult> {
  if (!/^[A-Za-z0-9._-]+$/.test(threadId) || threadId === "." || threadId === "..") {
    throw new WorkspaceError(`threadId '${threadId}' is not a safe path segment`);
  }
  // Explicitly choosing an isolated thread authorizes this one idempotent
  // project mutation — on a plausible root: the canonical initializer refuses
  // the user home directory and filesystem roots with a typed error
  // (INV-075). In-place read-only work remains untouched.
  const gitInitialization = await ensureGitRepository(projectRoot);
  const projectGitInitialization =
    gitInitialization.initialized || gitInitialization.baselineCommitted ? gitInitialization : null;
  const threadDir = join(projectRuntimeDir(projectRoot), "threads", threadId);
  const path = join(threadDir, "tree");
  if (existsSync(join(path, ".git"))) {
    // Turns never commit on the branch (in-place envelopes leave changes in the
    // working tree), so HEAD still points at the original base snapshot.
    return {
      path,
      baseSha: await revParse(path, "HEAD"),
      created: false,
      projectGitInitialization,
    };
  }
  const baseSha = await snapshotTree(projectRoot);
  ensureDir(threadDir);
  const branch = `claudexor/thread-${threadId}`;
  // Thread branches are PERSISTENT live-thread state. When the branch
  // survives but the worktree directory was lost, RECOVER by recreating the
  // worktree FROM the branch (its tip is the thread's base — turns never
  // commit on it) instead of failing `worktree add -b` on the collision.
  const branchExisted = await revParse(projectRoot, branch)
    .then(() => true)
    .catch(() => false);
  if (branchExisted) {
    try {
      await worktreeAddExisting(projectRoot, path, branch);
    } catch (err) {
      rmSync(threadDir, { recursive: true, force: true });
      throw err; // never delete the surviving branch
    }
    return {
      path,
      baseSha: await revParse(path, "HEAD"),
      created: true,
      projectGitInitialization,
    };
  }
  try {
    await worktreeAdd(projectRoot, path, branch, baseSha);
  } catch (err) {
    // A failed worktree add must not leave a partial thread dir (whose `.git`
    // check above would then be false forever) or a stale OWN branch behind
    // (this call created the branch attempt; a surviving branch is handled
    // by the recovery path above and never deleted here).
    rmSync(threadDir, { recursive: true, force: true });
    await branchDelete(projectRoot, branch).catch(() => {});
    throw err;
  }
  return { path, baseSha, created: true, projectGitInitialization };
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
  }: {
    worktreeRecorded?: boolean;
    repository?: PurgeRepositoryRecord | null;
    recordRepository?: (repository: PurgeRepositoryRecord) => Promise<void>;
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
