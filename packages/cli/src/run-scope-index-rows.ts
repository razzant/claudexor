/**
 * Rows of the daemon's run-scope index (`run-scope-index.ts`): the entry
 * shape and strict row parsing live in `@claudexor/core` (`run-scope-entry.ts`,
 * also read by the run-deadline warden); this module keeps the summaries the
 * index persists and discloses and the order rules of its rows.
 */
import {
  birthEpochSeconds,
  type CapturedProcess,
  type RunScopeEntry,
  type RunScopeOutcomeSummary,
  type ScopeReapOutcome,
} from "@claudexor/core";

export {
  parseEntry,
  reapSources,
  type RunScopeEntry,
  type RunScopeOutcomeSummary,
  type RunScopeRootGroup,
} from "@claudexor/core";

export function summarize(outcome: ScopeReapOutcome): RunScopeOutcomeSummary {
  return {
    coverage: outcome.coverage,
    census: outcome.census,
    census_failure: outcome.censusFailure,
    ended: outcome.ended.length,
    survivors: outcome.survivors.map((m) => m.pid),
    unreadable: outcome.unreadable.map((u) => u.pid),
    reused_groups: outcome.reusedGroups,
    restricted: outcome.restricted,
    completeness: outcome.completeness,
    incomplete: outcome.incomplete,
    completeness_reason: outcome.completenessReason,
    duration_ms: outcome.durationMs,
  };
}

/**
 * Keep the one order of `captured` a host of any age relies on: among the rows of
 * one pid, a row without a group basis (`pgid` not above 1: an earlier generation
 * whose group was proven empty) never follows a row with one. A host built before
 * `NO_GROUP_BASIS` takes the LAST row of a pid as that pid's birth when a captured
 * group's leader must vouch for it; with this order that is the live generation's
 * row, so a newly captured leader keeps its group's members. Stable otherwise.
 */
export function orderCaptured(captured: CapturedProcess[]): void {
  const firstBased = new Map<number, number>(); // pid -> index of its first row with a basis
  for (let i = 0; i < captured.length; i += 1) {
    const row = captured[i]!;
    if (row.pgid > 1) {
      if (!firstBased.has(row.pid)) firstBased.set(row.pid, i);
      continue;
    }
    const at = firstBased.get(row.pid);
    if (at === undefined) continue;
    captured.splice(i, 1);
    captured.splice(at, 0, row);
    for (const [pid, index] of firstBased) if (index >= at) firstBased.set(pid, index + 1);
  }
}

/** The earlier of two `lstart` readings (the scope floor keeps the minimum). */
export function earlierBirth(current: string | null, candidate: string): string | null {
  if (current === null) return candidate;
  const a = birthEpochSeconds(current);
  const b = birthEpochSeconds(candidate);
  if (a === null) return candidate;
  if (b === null) return current;
  return b < a ? candidate : current;
}

export function describe(entry: RunScopeEntry, outcome: ScopeReapOutcome): string {
  return (
    `scope ${entry.marker.slice(-8)} of run ${entry.run_id}: ` +
    `${outcome.settled ? "settled" : "UNRESOLVED"} (${outcome.coverage}, census ${outcome.census}` +
    `${outcome.censusFailure ? `: ${outcome.censusFailure}` : ""}; ended ${outcome.ended.length}, ` +
    `survivors ${outcome.survivors.map((m) => m.pid).join(",") || "-"}, ` +
    `unreadable ${outcome.unreadable.map((u) => u.pid).join(",") || "-"}` +
    `${outcome.reusedGroups.length ? `, reused groups ${outcome.reusedGroups.join(",")}` : ""})`
  );
}
