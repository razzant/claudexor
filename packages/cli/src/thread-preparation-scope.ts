/**
 * The short process scope of an isolated thread's worktree preparation, which
 * runs before any run exists (#694 r10): opened only when the tree is really
 * made or recovered, or a ready tree's project must be initialized (durably,
 * before the first spawn — a failed record refuses), its marker carried by the
 * preparation's Git children from the first one, and settled once (memoized
 * here) by the preparation itself: on success before the tree is handed over
 * (an unsettled scope holds the tree instead), after a failure before what it
 * made is released. Settlement ends what the scope still holds by measured
 * identity (background hook and filter processes included); the preparation's
 * one release then frees its resources, or the turn is refused with what stays
 * held and its next attempt releases them once a read proves the end
 * (`ensureThreadWorktree`). `closeAfter` settles a scope whose turn failed
 * anywhere else before a run existed.
 */
import { noteCleanupFault, type PreparationQuietRead } from "@claudexor/workspace";
import { preparationQuiet, type ScopeReapOutcome } from "@claudexor/core";
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
): ThreadPreparationScope {
  const scopeId = `thread-preparation:${jobId}`;
  const quiet = daemonPreparationQuiet(index);
  let marker: string | null = null;
  let settlement: Promise<ScopeReapOutcome | null> | null = null;
  const settle = (): Promise<ScopeReapOutcome | null> => {
    if (marker === null) return Promise.resolve(null);
    settlement ??= index.settle(scopeId, marker);
    return settlement;
  };
  return {
    quiet,
    settleScope: settle,
    openScope: async () => {
      ({ marker } = await index.open(scopeId, { requireDurable: true }));
      return { marker };
    },
    closeAfter: async (error) => {
      // A settlement that threw changes no verdict; its fault stays beside the error.
      await settle().catch((fault: unknown) => noteCleanupFault(error, fault));
      return error;
    },
  };
}
