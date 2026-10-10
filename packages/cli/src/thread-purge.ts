/**
 * The ONE owner of thread byte deletion (owner decision E2): the purge route
 * and the retention pass both call it. The purge is journaled FIRST, so the
 * explicit authority exists before any byte goes, and validation can never
 * fail after user state was removed. Then the thread's daemon-owned
 * directories go: the isolated worktree with its `claudexor/thread-*` branch,
 * and every lane home (INV-034 lifecycle owner (a)).
 *
 * A directory error after the journal commit (ENOTEMPTY, EBUSY, a Windows
 * lock) leaves a purged thread that every listing hides while its directories
 * remain. Calling the owner again journals nothing new (the reducer keeps a
 * purged thread as it is) and deletes what is left; `hasPurgeLeftovers` names
 * exactly the directories this owner deletes, so the retention pass retries a
 * purge until they are gone and never loops on a directory it cannot own.
 */
import type { ProjectThreadPort } from "@claudexor/daemon";
import type { Thread } from "@claudexor/schema";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { projectRuntimeDir } from "@claudexor/util";
import {
  purgeThreadLanes,
  purgeThreadWorktree,
  threadLanesExist,
  threadWorktreeDirExists,
  git,
} from "@claudexor/workspace";

export interface ThreadPurgeDurability {
  complete(id: string, perform: (thread: Thread) => Promise<readonly string[]>): Promise<void>;
}

export function threadPurgeOwner(
  threads: Pick<ProjectThreadPort, "getThread" | "purgeThread">,
  noProjectRoot: string,
  durability?: ThreadPurgeDurability,
) {
  const isolatedRoot = (thread: Thread): string | null =>
    thread.repo && thread.workspace.mode === "isolated" ? thread.repo.root : null;
  const lanesRoot = (thread: Thread): string => thread.repo?.root ?? noProjectRoot;
  const perform = threadPurgeEffect(noProjectRoot);
  return {
    purgeThread: async (id: string) => {
      const thread = threads.getThread(id);
      if (!thread) throw Object.assign(new Error(`no such thread: ${id}`), { status: 404 });
      const purged = threads.purgeThread(id);
      if (durability) await durability.complete(id, perform);
      else await perform(thread);
      return purged;
    },
    /** Whether a directory this owner deletes for the thread is still on disk. */
    hasPurgeLeftovers: (thread: Thread): boolean => {
      const worktreeRoot = isolatedRoot(thread);
      return (
        (worktreeRoot !== null && threadWorktreeDirExists(worktreeRoot, thread.id)) ||
        threadLanesExist(lanesRoot(thread), thread.id)
      );
    },
  };
}

/** The same exact directory owner is used for immediate purge and obligation
 * recovery. A delegated workspace is never a deletion target. */
export function threadPurgeEffect(noProjectRoot: string) {
  return async (thread: Thread): Promise<string[]> => {
    const root = thread.repo?.root ?? noProjectRoot;
    const parents = [join(projectRuntimeDir(root), "lanes")];
    if (thread.repo && thread.workspace.mode === "isolated") {
      const gitDir = await git(thread.repo.root, ["rev-parse", "--git-common-dir"])
        .then((result) =>
          result.code === 0 ? resolve(thread.repo!.root, result.stdout.trim()) : null,
        )
        .catch(() => null);
      await purgeThreadWorktree(thread.repo.root, thread.id);
      parents.push(join(projectRuntimeDir(thread.repo.root), "threads"));
      if (gitDir)
        parents.push(gitDir, join(gitDir, "worktrees"), join(gitDir, "refs", "heads", "claudexor"));
    }
    purgeThreadLanes(root, thread.id);
    return [...new Set(parents.map(survivingDirectory))];
  };
}

function survivingDirectory(path: string): string {
  for (let current = path; ; current = dirname(current)) {
    if (existsSync(current) && statSync(current).isDirectory()) return current;
    if (dirname(current) === current) throw new Error(`no surviving parent directory of ${path}`);
  }
}
