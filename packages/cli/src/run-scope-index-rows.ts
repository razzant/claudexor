/**
 * Rows of the daemon's run-scope index (`run-scope-index.ts`): the entry
 * shape a host may rely on, strict row parsing (a malformed row is UNKNOWN,
 * never partially loaded), the reap sources an entry hands the custodian,
 * and the summaries the index persists and discloses.
 */
import {
  birthEpochSeconds,
  isKnownProcessIdentity,
  type CapturedProcess,
  type KnownProcessIdentity,
  type ScopeReapOutcome,
} from "@claudexor/core";

export interface RunScopeOutcomeSummary {
  coverage: ScopeReapOutcome["coverage"];
  census: ScopeReapOutcome["census"];
  census_failure: string | null;
  ended: number;
  survivors: number[];
  unreadable: number[];
  reused_groups: number[];
  restricted: boolean;
  completeness: ScopeReapOutcome["completeness"];
}

/**
 * A harness root's own process group, recorded SYNCHRONOUSLY at registration
 * from the registry handle (pgid + the leader's measured identity), and
 * completed with the leader's `lstart` once a table read confirmed it.
 */
export interface RunScopeRootGroup {
  pgid: number;
  leader_pid: number;
  /** The leader's `lstart` birth text (C locale, local time, 1 s resolution); null until a table read confirmed it. */
  leader_birth: string | null;
  /** The leader's spawn-time measured identity (proc identity token). */
  leader_identity?: KnownProcessIdentity;
}

export interface RunScopeEntry {
  marker: string;
  run_id: string;
  /** The daemon that opened the scope; null when its own identity was unreadable. */
  owner: KnownProcessIdentity | null;
  state: "open" | "unresolved";
  opened_at: string;
  /** First settlement, never advanced by a retry: the recorded group's upper birth bound. */
  settled_at?: string;
  /** Birth floor of the scope: the earliest harness root's `lstart`. */
  scope_start: string | null;
  /** Every harness root the run spawned, seeded at spawn (fix round 1 item 2). */
  root_groups: RunScopeRootGroup[];
  captured: CapturedProcess[];
  outcome?: RunScopeOutcomeSummary;
}

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
  };
}

/** One strictly validated index row; null for anything malformed. */
export function parseEntry(value: unknown): RunScopeEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<RunScopeEntry>;
  if (
    typeof entry.marker !== "string" ||
    typeof entry.run_id !== "string" ||
    (entry.state !== "open" && entry.state !== "unresolved")
  )
    return null;
  // A MISSING membership container is the deliberate compatibility default
  // (an older row); a PRESENT one that is not an array is a malformed row and
  // takes the preservation path like any other, never a silent rewrite to [].
  if (entry.root_groups !== undefined && !Array.isArray(entry.root_groups)) return null;
  if (entry.captured !== undefined && !Array.isArray(entry.captured)) return null;
  const rootGroups: RunScopeRootGroup[] = [];
  for (const g of entry.root_groups ?? []) {
    const group = g as Partial<RunScopeRootGroup> | null;
    if (
      !group ||
      typeof group !== "object" ||
      !Number.isSafeInteger(group.pgid) ||
      !Number.isSafeInteger(group.leader_pid) ||
      (group.leader_birth !== null && typeof group.leader_birth !== "string")
    )
      return null;
    rootGroups.push({
      pgid: group.pgid as number,
      leader_pid: group.leader_pid as number,
      leader_birth: group.leader_birth ?? null,
      ...(isKnownProcessIdentity(group.leader_identity)
        ? { leader_identity: group.leader_identity }
        : {}),
    });
  }
  const captured: CapturedProcess[] = [];
  for (const c of entry.captured ?? []) {
    const row = c as Partial<CapturedProcess> | null;
    if (
      !row ||
      typeof row !== "object" ||
      !Number.isSafeInteger(row.pid) ||
      !Number.isSafeInteger(row.pgid) ||
      typeof row.birth !== "string"
    )
      return null;
    captured.push({ pid: row.pid as number, pgid: row.pgid as number, birth: row.birth });
  }
  return {
    marker: entry.marker,
    run_id: entry.run_id,
    owner: isKnownProcessIdentity(entry.owner) ? entry.owner : null,
    state: entry.state,
    opened_at: typeof entry.opened_at === "string" ? entry.opened_at : "",
    ...(typeof entry.settled_at === "string" ? { settled_at: entry.settled_at } : {}),
    scope_start: typeof entry.scope_start === "string" ? entry.scope_start : null,
    root_groups: rootGroups,
    captured,
    ...(entry.outcome ? { outcome: entry.outcome } : {}),
  };
}

/** The recorded sources of one entry as the reaper takes them. */
export function reapSources(entry: RunScopeEntry) {
  return {
    captured: entry.captured,
    scopeStart: entry.scope_start,
    scopeStartAt: entry.opened_at || null,
    settledAt: entry.settled_at ?? null,
    rootGroups: entry.root_groups.map((g) => ({
      pgid: g.pgid,
      leaderPid: g.leader_pid,
      leaderBirth: g.leader_birth,
      ...(g.leader_identity ? { leaderIdentity: g.leader_identity } : {}),
    })),
  };
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
