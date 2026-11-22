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

/**
 * Retire or keep a settled-or-not row; returns the disclosure, which names a
 * retirement without proof. A row whose settlement was proven is retired and
 * handed (a copy, with its outcome) to every `retired` observer: a deadline
 * warden still needs its recorded groups once it left the index.
 */
export function retireOrKeepRow(
  entries: RunScopeEntry[],
  entry: RunScopeEntry,
  outcome: ScopeReapOutcome,
  now: () => string,
  retired: Iterable<(row: RunScopeEntry) => void>,
): string {
  // A host with no census at all (`unsupported`, Windows) can never settle
  // an entry: keeping it would re-reap it at every start and grow the file
  // without bound, so it is retired once its outcome has been disclosed.
  if (outcome.settled || outcome.census === "unsupported") {
    const at = entries.indexOf(entry);
    if (at >= 0) entries.splice(at, 1);
    if (outcome.settled)
      for (const listener of retired)
        try {
          const settledAt = entry.settled_at ?? now();
          listener({
            ...structuredClone(entry),
            settled_at: settledAt,
            outcome: summarize(outcome),
          });
        } catch {
          /* an observer never changes the index */
        }
    return outcome.settled
      ? describe(entry, outcome)
      : `${describe(entry, outcome)}; retired without proof (no environment census on this platform)`;
  }
  entry.state = "unresolved";
  entry.settled_at ??= now();
  entry.outcome = summarize(outcome);
  return describe(entry, outcome);
}
