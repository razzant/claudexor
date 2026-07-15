import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceError } from "@claudexor/core";
import { ensureDir, projectRuntimeDir } from "@claudexor/util";
import {
  branchDelete,
  git,
  isGitRepo,
  revParse,
  snapshotTree,
  worktreeAdd,
  worktreeAddExisting,
  worktreeRemove,
} from "./git.js";

export interface ThreadWorktreeResult {
  /** Absolute path to the thread's persistent worktree (the execution root). */
  path: string;
  /** Snapshot sha the worktree was branched from (the apply base). */
  baseSha: string;
  /** True when the worktree was just created (vs reused). */
  created: boolean;
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
  if (!(await isGitRepo(projectRoot))) {
    throw new WorkspaceError(`isolated threads require a git project: ${projectRoot}`);
  }
  const threadDir = join(projectRuntimeDir(projectRoot), "threads", threadId);
  const path = join(threadDir, "tree");
  if (existsSync(join(path, ".git"))) {
    // Turns never commit on the branch (in-place envelopes leave changes in the
    // working tree), so HEAD still points at the original base snapshot.
    return { path, baseSha: await revParse(path, "HEAD"), created: false };
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
    return { path, baseSha: await revParse(path, "HEAD"), created: true };
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
  return { path, baseSha, created: true };
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
  const update = await git(projectRoot, ["update-ref", branch, targetSha, oldTip]);
  if (update.code !== 0) {
    throw new WorkspaceError(`thread branch advanced concurrently: ${update.stderr.trim()}`);
  }
  const reset = await git(worktreePath, ["reset", "--hard", targetSha]);
  if (reset.code !== 0) {
    throw new WorkspaceError(`thread worktree realignment failed: ${reset.stderr.trim()}`);
  }
  const clean = await git(worktreePath, ["clean", "-fd"]);
  if (clean.code !== 0) {
    throw new WorkspaceError(`thread worktree cleanup failed: ${clean.stderr.trim()}`);
  }
  const observed = await revParse(worktreePath, "HEAD");
  if (observed !== targetSha) {
    throw new WorkspaceError("thread branch and worktree did not converge on the delivered SHA");
  }
  return targetSha;
}

/** Explicit purge of daemon-owned isolated-thread resources. Lifecycle
 * authority lives in the journal; the generic orphan sweeper never guesses. */
export async function purgeThreadWorktree(projectRoot: string, threadId: string): Promise<void> {
  if (!/^[A-Za-z0-9._-]+$/.test(threadId) || threadId === "." || threadId === "..") {
    throw new WorkspaceError(`threadId '${threadId}' is not a safe path segment`);
  }
  const threadDir = join(projectRuntimeDir(projectRoot), "threads", threadId);
  const path = join(threadDir, "tree");
  if (existsSync(join(path, ".git"))) await worktreeRemove(projectRoot, path);
  rmSync(threadDir, { recursive: true, force: true });
  await branchDelete(projectRoot, `claudexor/thread-${threadId}`).catch(() => {});
}
