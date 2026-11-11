/**
 * The ONE owner of thread byte deletion (owner decision E2): the purge route
 * and the retention pass both call it. The purge is journaled FIRST, so the
 * explicit authority exists before any byte goes, and validation can never
 * fail after user state was removed. Then the thread's daemon-owned
 * directories go: the isolated worktree with its `claudexor/thread-*` branch,
 * and every lane home (INV-034 lifecycle owner (a)).
 *
 * A directory error after the journal commit (ENOTEMPTY, EBUSY, a Windows
 * lock), a Git refusal to drop the worktree or branch (a locked worktree, a
 * held ref lock), a repository that registered the worktree but can no longer
 * be reached (moved or deleted) or a runtime directory that is a link (never
 * followed) makes the effect throw: the cleanup stays pending, never reported
 * complete, and every listing hides the purged thread while its directories
 * remain. Calling the owner again journals nothing new (the reducer keeps a
 * purged thread as it is) and deletes what is left; `hasPurgeLeftovers` names
 * exactly the directories this owner deletes, so the retention pass retries a
 * purge until they are gone and never loops on a directory it cannot own.
 */
import type { ProjectThreadPort } from "@claudexor/daemon";
import type { Thread, ThreadExportDigestEntry } from "@claudexor/schema";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { verifyLaneRemoval } from "@claudexor/control-api";
import { ownedProjectRuntimeDir, projectRuntimeDir } from "@claudexor/util";
import {
  purgeThreadLanes,
  purgeThreadWorktree,
  threadLanesExist,
  threadWorktreeDirExists,
  type PurgeRepositoryRecord,
} from "@claudexor/workspace";

/** What the purge obligation keeps of the thread's repository until it clears. */
export interface ThreadPurgeRepository {
  readonly recorded: PurgeRepositoryRecord | null;
  record(repository: PurgeRepositoryRecord): Promise<void>;
  /** A retirement's accepted lane entries: only their bytes may be deleted. */
  readonly acceptedLane?: readonly ThreadExportDigestEntry[];
}

/** The lane's exact credential stores for its HOME; null when undeclared. */
export type LaneCredentialStores = (laneSegment: string) => readonly string[] | null;

export interface ThreadPurgeDurability {
  complete(
    id: string,
    perform: (thread: Thread, repository?: ThreadPurgeRepository) => Promise<readonly string[]>,
  ): Promise<void>;
}

export function threadPurgeOwner(
  threads: Pick<ProjectThreadPort, "getThread" | "purgeThread">,
  noProjectRoot: string,
  durability?: ThreadPurgeDurability,
  laneStores?: LaneCredentialStores,
) {
  const isolatedRoot = (thread: Thread): string | null =>
    thread.repo && thread.workspace.mode === "isolated" ? thread.repo.root : null;
  const lanesRoot = (thread: Thread): string => thread.repo?.root ?? noProjectRoot;
  const perform = threadPurgeEffect(noProjectRoot, laneStores);
  /** Deletes the directories of a committed purge, given its pre-purge record.
   * `signal` stops a retirement's lane verification; the cleanup then stays open. */
  const finishPurge = async (thread: Thread, signal?: AbortSignal): Promise<void> => {
    const attempt = (record: Thread, repository?: ThreadPurgeRepository) =>
      perform(record, repository, signal);
    if (durability) await durability.complete(thread.id, attempt);
    else await attempt(thread);
  };
  return {
    /** `signal` is the caller's Stop, for a caller that has one (the retention pass
     * does; the purge route passes none). It ends a retirement's lane verification
     * and leaves the cleanup pending, never undoing the acceptance. */
    purgeThread: async (id: string, signal?: AbortSignal) => {
      const thread = threads.getThread(id);
      if (!thread) throw Object.assign(new Error(`no such thread: ${id}`), { status: 404 });
      const purged = threads.purgeThread(id);
      await finishPurge(thread, signal);
      return purged;
    },
    finishPurge,
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
 * recovery. A delegated workspace is never a deletion target. The Git
 * directories reported for syncing are those of the repository the cleanup
 * actually asked, which a moved repository's worktree names, not the
 * recorded project root's; the obligation's `repository` keeps it for every
 * retry until the obligation clears. */
export function threadPurgeEffect(noProjectRoot: string, laneStores?: LaneCredentialStores) {
  return async (
    thread: Thread,
    repository?: ThreadPurgeRepository,
    signal?: AbortSignal,
  ): Promise<string[]> => {
    const root = thread.repo?.root ?? noProjectRoot;
    const parents = [join(projectRuntimeDir(root), "lanes")];
    // A conditional retirement deletes only lane bytes its export holds. On every
    // attempt, a retry after a partial deletion included, each entry still on
    // disk must be one acceptance read, byte for byte; one already gone is
    // expected. Anything else stays, and the cleanup stays pending with why.
    if (thread.retirement && !repository?.acceptedLane)
      throw Object.assign(
        new Error(
          `thread ${thread.id} was retired, but no accepted lane inventory reached its cleanup`,
        ),
        { code: "thread_lane_changed" },
      );
    const laneUnchanged = repository?.acceptedLane
      ? await verifyLaneRemoval(
          thread.id,
          ownedProjectRuntimeDir(root, "lanes", thread.id),
          laneStores ?? (() => null),
          repository.acceptedLane,
          signal,
        )
      : null;
    if (thread.repo && thread.workspace.mode === "isolated") {
      const gitDir = await purgeThreadWorktree(thread.repo.root, thread.id, {
        worktreeRecorded: thread.workspace.worktree_path !== null,
        repository: repository?.recorded ?? null,
        recordRepository: repository ? (record) => repository.record(record) : undefined,
      });
      parents.push(join(projectRuntimeDir(thread.repo.root), "threads"));
      if (gitDir)
        parents.push(gitDir, join(gitDir, "worktrees"), join(gitDir, "refs", "heads", "claudexor"));
    }
    // No await between this recheck and the deletion.
    const changed = laneUnchanged?.();
    if (changed)
      throw Object.assign(
        new Error(
          `thread ${thread.id} lane entry ${changed} changed while its cleanup was verified`,
        ),
        { code: "thread_lane_changed" },
      );
    purgeThreadLanes(root, thread.id);
    return [...new Set(parents.map(survivingDirectory))];
  };
}

/**
 * The effect the daemon registers with its storage graph. A start replays every open
 * purge obligation through it with no signal of its own, and the daemon's Stop waits for
 * that replay, so it is built over that Stop: the Stop ends a retirement's lane
 * verification here as everywhere else, and the obligation stays open for the next start.
 * `stop` is required, so a registration that nothing can end is not written by omission.
 */
export function startupPurgeEffect(
  noProjectRoot: string,
  laneStores: LaneCredentialStores,
  stop: AbortSignal,
) {
  const perform = threadPurgeEffect(noProjectRoot, laneStores);
  return (thread: Thread, repository?: ThreadPurgeRepository): Promise<string[]> =>
    perform(thread, repository, stop);
}

function survivingDirectory(path: string): string {
  for (let current = path; ; current = dirname(current)) {
    if (existsSync(current) && statSync(current).isDirectory()) return current;
    if (dirname(current) === current) throw new Error(`no surviving parent directory of ${path}`);
  }
}
