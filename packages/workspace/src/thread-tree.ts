import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceError } from "@claudexor/core";
import { ensureDir } from "@claudexor/util";
import { isGitRepo, revParse, snapshotTree, worktreeAdd } from "./git.js";

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
  ensureDir(join(projectRoot, ".claudexor", "threads", threadId));
  // Self-ignore the project's `.claudexor/` so the user's own `git add -A` never
  // captures the thread worktree (a `.gitignore` with `*` makes the dir invisible
  // to git even in a pre-existing repo — same trick as WorkspaceManager) (D3).
  const selfIgnore = join(projectRoot, ".claudexor", ".gitignore");
  if (!existsSync(selfIgnore)) {
    try {
      writeFileSync(selfIgnore, "*\n", { flag: "wx" });
    } catch {
      /* already present (concurrent create) */
    }
  }
  await worktreeAdd(projectRoot, path, `claudexor/thread-${threadId}`, baseSha);
  return { path, baseSha, created: true };
}
