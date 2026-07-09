import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceError } from "@claudexor/core";
import { ensureDir } from "@claudexor/util";
import { branchDelete, isGitRepo, revParse, snapshotTree, worktreeAdd, worktreeAddExisting } from "./git.js";
import { ensureSelfIgnore } from "./self-ignore.js";

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
 * The worktree lives under the project's self-ignored `.claudexor/`, so the
 * project's own git never sees it and snapshots exclude it.
 */
export async function ensureThreadWorktree(projectRoot: string, threadId: string): Promise<ThreadWorktreeResult> {
  if (!/^[A-Za-z0-9._-]+$/.test(threadId) || threadId === "." || threadId === "..") {
    throw new WorkspaceError(`threadId '${threadId}' is not a safe path segment`);
  }
  if (!(await isGitRepo(projectRoot))) {
    throw new WorkspaceError(`isolated threads require a git project: ${projectRoot}`);
  }
  const path = join(projectRoot, ".claudexor", "threads", threadId, "tree");
  if (existsSync(join(path, ".git"))) {
    // Turns never commit on the branch (in-place envelopes leave changes in the
    // working tree), so HEAD still points at the original base snapshot.
    return { path, baseSha: await revParse(path, "HEAD"), created: false };
  }
  const baseSha = await snapshotTree(projectRoot);
  const threadDir = join(projectRoot, ".claudexor", "threads", threadId);
  ensureDir(threadDir);
  // Self-ignore the project's `.claudexor/` so the user's own `git add -A` never
  // captures the thread worktree (shared content-checked owner with
  // WorkspaceManager: a user-edited/emptied file is repaired, not trusted).
  ensureSelfIgnore(join(projectRoot, ".claudexor"));
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
