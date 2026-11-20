/**
 * The shared row shape of the daemon's run-scope index (`daemon/run-scopes.json`,
 * schema_version 1): the entry a host may rely on while the daemon is dead, its
 * strict parsing (a malformed row is UNKNOWN, never partially loaded) and the
 * reap sources an entry hands the scope reaper. The CLI's index owns writing;
 * the run-deadline warden reads it read-only (`readRunScopeEntries`).
 */
import { readFileSync } from "node:fs";
import { isKnownProcessIdentity, type KnownProcessIdentity } from "./process-identity.js";
import { isRunScopeMarkerName } from "./process-scope.js";
import type { ScopeReapOutcome } from "./process-scope-census.js";
import type { CapturedProcess } from "./process-table.js";

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
  /** The attempt's single deadline expired before every source was read (#613). */
  incomplete: boolean;
  completeness_reason: string | null;
  duration_ms: number;
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
  /** The harness roots' groups in force: seeded at spawn (fix round 1 item 2),
   * and gone again once proven empty at the root's own close. */
  root_groups: RunScopeRootGroup[];
  /** Recorded descendants; `pgid` -1 (`NO_GROUP_BASIS`): by pid and birth only. */
  captured: CapturedProcess[];
  outcome?: RunScopeOutcomeSummary;
  /** Later, separately bounded attempts this owner made after the terminal (#613). */
  late_attempts?: number;
  last_attempt_at?: string;
}

/** A persisted outcome steers later attempts; fields newer than its writer may be absent. */
function validOutcome(value: unknown): value is RunScopeOutcomeSummary {
  if (!value || typeof value !== "object") return false;
  const outcome = value as Partial<RunScopeOutcomeSummary>;
  const pidList = (list: unknown) =>
    list === undefined || (Array.isArray(list) && list.every(Number.isSafeInteger));
  return (
    ["ok", "failed", "unsupported"].includes(outcome.census as string) &&
    [outcome.survivors, outcome.unreadable, outcome.reused_groups].every(pidList)
  );
}

/** One strictly validated index row; null for anything malformed. */
export function parseEntry(value: unknown): RunScopeEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<RunScopeEntry>;
  if (
    typeof entry.marker !== "string" ||
    !isRunScopeMarkerName(entry.marker) ||
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
  // Later-attempt facts (#613) likewise: a present malformed one is never normalized away.
  const attempts = entry.late_attempts;
  if (attempts !== undefined && !(Number.isSafeInteger(attempts) && attempts >= 0)) return null;
  if (entry.last_attempt_at !== undefined && typeof entry.last_attempt_at !== "string") return null;
  if (entry.outcome !== undefined && !validOutcome(entry.outcome)) return null;
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
    ...(entry.outcome !== undefined ? { outcome: entry.outcome } : {}),
    ...(attempts !== undefined ? { late_attempts: attempts } : {}),
    ...(entry.last_attempt_at !== undefined ? { last_attempt_at: entry.last_attempt_at } : {}),
  };
}

/** The recorded sources of one entry as the reaper takes them: its rows are the
 * bases in force (a group proven empty left them, `DaemonRunScopeIndex.retireRootGroup`). */
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

/**
 * The parseable rows of an index file, read-only: null when the file is
 * missing or unusable as a whole (the owner of the file moves such a file aside;
 * a reader only learns that no recorded sources are available).
 */
export function readRunScopeEntries(path: string): RunScopeEntry[] | null {
  let raw: { schema_version?: unknown; entries?: unknown };
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as typeof raw;
  } catch {
    return null;
  }
  if (!raw || raw.schema_version !== 1 || !Array.isArray(raw.entries)) return null;
  const entries: RunScopeEntry[] = [];
  for (const value of raw.entries) {
    const entry = parseEntry(value);
    if (entry) entries.push(entry);
  }
  return entries;
}
