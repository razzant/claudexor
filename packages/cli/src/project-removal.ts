/**
 * The `DELETE /v2/projects/:id` service (QA-049, #333). The active-run root set
 * is read in process, with no await before the synchronous store removal
 * (project-scoped, non-terminal runs), canonicalized to match the store's
 * realpath'd roots. The thread fence lives in the store. With the explicit
 * `trashedThreads=purge` opt-in, the store purges the threads already in the
 * trash in the same commit that retires the project; the one thread purge owner
 * then deletes each purge's directories, and a cleanup it cannot finish stays
 * a pending obligation that daemon startup replays.
 */
import { realpathSync } from "node:fs";
import type { ProjectControlPort } from "@claudexor/daemon";
import {
  type ControlProjectPurgedThread,
  type ControlProjectRemoveReceipt,
  type ControlProjectRemoveTrashedThreads,
  RunScope,
  TERMINAL_LIFECYCLES,
  type Thread,
} from "@claudexor/schema";
import { safeProblemMessage } from "@claudexor/util";

type ActivityRecord = { runId?: string; state: string; params?: unknown };

/**
 * The project ROOT a non-terminal job runs against (project-remove active-run
 * fence), or null when it holds no project. Parsed via the typed `RunScope`
 * schema, not a widening `{scope?:{kind?;root?}}` cast (Ф2 finding 7): a project
 * scope always carries a root, so a live project run can't silently drop out of
 * the fence. A live RUN whose scope can't be parsed FAILS CLOSED (we can't prove
 * it doesn't reference the project); a non-run job (no runId) is ignored.
 */
function activeRunProjectRoot(job: ActivityRecord): string | null {
  const scope = (job.params as { scope?: unknown } | null | undefined)?.scope;
  const parsed = RunScope.safeParse(scope);
  if (parsed.success) return parsed.data.kind === "project" ? parsed.data.root : null;
  if (job.runId) {
    throw Object.assign(
      new Error(`cannot resolve the scope of active run ${job.runId} for the project-remove fence`),
      { code: "active_run_scope_unresolved", status: 409 },
    );
  }
  return null;
}

export function projectRemovalService(
  threads: Pick<ProjectControlPort, "removeProject" | "removeProjectWithTrashedThreads">,
  daemonJobs: () => ActivityRecord[],
  finishPurge: (thread: Thread) => Promise<void>,
) {
  return async (
    id: string,
    options?: { trashedThreads: ControlProjectRemoveTrashedThreads },
  ): Promise<ControlProjectRemoveReceipt> => {
    const activeRunRoots = new Set<string>();
    for (const job of daemonJobs()) {
      if ((TERMINAL_LIFECYCLES as ReadonlySet<string>).has(job.state)) continue;
      const root = activeRunProjectRoot(job);
      if (root === null) continue;
      try {
        activeRunRoots.add(realpathSync(root));
      } catch {
        activeRunRoots.add(root);
      }
    }
    if (options?.trashedThreads !== "purge") return threads.removeProject(id, activeRunRoots);
    const { receipt, purged } = threads.removeProjectWithTrashedThreads(id, activeRunRoots);
    const purgedThreads: ControlProjectPurgedThread[] = [];
    // One at a time: isolated purges remove worktrees and branches of one repository.
    for (const thread of purged) {
      try {
        await finishPurge(thread);
        purgedThreads.push({ threadId: thread.id, cleanup: "completed", cleanupError: null });
      } catch (error) {
        purgedThreads.push({
          threadId: thread.id,
          cleanup: "pending",
          cleanupError: safeProblemMessage(error),
        });
      }
    }
    return { ...receipt, purgedThreads };
  };
}
