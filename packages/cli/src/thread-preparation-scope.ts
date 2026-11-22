/**
 * The short process scope of a thread turn's worktree preparation, which runs
 * before any run exists (#694 r10). It is opened durably before its first
 * spawn (a failed record refuses) and settled once (memoized here):
 * - an ordinary turn opens it only when the tree is really made or recovered,
 *   or a ready tree's project must be initialized; the preparation settles it
 *   on success before the tree is handed over (an unsettled scope holds the
 *   tree instead) and after a failure before what it made is released;
 * - a turn whose job holds a run-deadline/1 record opens it first, hands its
 *   marker to the warden before any Git child, and runs the whole preparation
 *   (the Git preflight, a ready tree's checks) inside it
 *   (`withinPreparationScope`);
 * - every successful preparation settles a scope it opened that the tree's
 *   preparation did not take over (`withinPreparationScope`), so no turn leaves
 *   an open row in the run-scope index.
 * Settlement ends what the scope still holds by measured identity (background
 * hook and filter processes included); the preparation's one release then
 * frees its resources, or the turn is refused with what stays held and its next
 * attempt releases them once a read proves the end (`ensureThreadWorktree`).
 * `closeAfter` settles a scope whose turn failed before a run existed.
 */
import {
  noteCleanupFault,
  probeGitCapability,
  type PreparationQuietRead,
} from "@claudexor/workspace";
import { preparationQuiet, withinRunScope, type ScopeReapOutcome } from "@claudexor/core";
import type { RunScopeEntry } from "./run-scope-index-rows.js";
import type { DaemonRunScopeIndex } from "./run-scope-index.js";
import { reapSources } from "./run-scope-index-rows.js";

/** The release criterion with the scope's index row while it exists (r10 B). */
export function daemonPreparationQuiet(index: DaemonRunScopeIndex): PreparationQuietRead {
  return preparationQuietFor(index);
}

/** The same over anything that lists the index's entries. */
export function preparationQuietFor(index: { list(): RunScopeEntry[] }): PreparationQuietRead {
  return (facts) => {
    const entry = facts.marker
      ? index.list().find((item) => item.marker === facts.marker)
      : undefined;
    return preparationQuiet(facts, entry ? { sources: reapSources(entry) } : {});
  };
}

export interface ThreadPreparationScope {
  openScope: () => Promise<{ marker: string }>;
  /** Settle the scope (once; null when none was opened): the preparation calls
   * it before handing the tree over, and after a failure before its release. */
  settleScope: () => Promise<ScopeReapOutcome | null>;
  quiet: PreparationQuietRead;
  /** After the turn failed before its run: the scope is settled (if it was not
   * yet), then the same error is returned to throw. */
  closeAfter(error: unknown): Promise<unknown>;
}

export function threadPreparationScope(
  index: DaemonRunScopeIndex,
  jobId: string,
  /** run-deadline/1: hand the marker to the run's warden before the first Git child. */
  onOpened?: (marker: string) => Promise<void>,
): ThreadPreparationScope {
  const scopeId = `thread-preparation:${jobId}`;
  const quiet = daemonPreparationQuiet(index);
  let marker: string | null = null;
  let opened: Promise<{ marker: string }> | null = null;
  let settlement: Promise<ScopeReapOutcome | null> | null = null;
  const settle = (): Promise<ScopeReapOutcome | null> => {
    if (marker === null) return Promise.resolve(null);
    settlement ??= index.settle(scopeId, marker);
    return settlement;
  };
  return {
    quiet,
    settleScope: settle,
    // Once: the turn's Git preflight may open it before the worktree preparation.
    openScope: () =>
      (opened ??= (async () => {
        ({ marker } = await index.open(scopeId, { requireDurable: true }));
        await onOpened?.(marker);
        return { marker };
      })()),
    closeAfter: async (error) => {
      // A settlement that threw changes no verdict; its fault stays beside the error.
      await settle().catch((fault: unknown) => noteCleanupFault(error, fault));
      return error;
    },
  };
}

/**
 * The preparation of a thread turn, from its Git preflight to the handed-over
 * workspace. For a job with a deadline the scope is opened first and the whole
 * preparation runs inside it; any failure settles the scope before it is
 * thrown again; success settles a scope the tree's preparation did not take
 * over (its settlement is memoized, so a settled one is not reaped twice).
 */
export async function withinPreparationScope<T>(
  preparation: Pick<ThreadPreparationScope, "openScope" | "settleScope" | "closeAfter">,
  deadlineHeld: boolean,
  work: () => Promise<T>,
): Promise<T> {
  let result: T;
  try {
    if (deadlineHeld) {
      const { marker } = await preparation.openScope();
      result = await withinRunScope(marker, work);
    } else result = await work();
  } catch (error) {
    throw await preparation.closeAfter(error);
  }
  await preparation.settleScope();
  return result;
}

/**
 * A thread turn's Git preflight as the preparation's first child: the scope is
 * opened first (a deadline's warden takes it over), the probe's Git child
 * carries its marker (and so enters a run cgroup where one is proven), and the
 * job's abort stops it.
 */
export function preparationGitCapability(
  preparation: Pick<ThreadPreparationScope, "openScope">,
  signal: AbortSignal,
  probe: typeof probeGitCapability = probeGitCapability,
): () => ReturnType<typeof probeGitCapability> {
  return async () => {
    const { marker } = await preparation.openScope();
    return withinRunScope(marker, () => probe({ abortSignal: signal }));
  };
}
