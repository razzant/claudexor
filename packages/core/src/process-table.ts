/**
 * Asynchronous process-table reads for the scope custodian: `pid`, `ppid`,
 * `pgid` and the kernel birth time of every live process in ONE `ps` call,
 * off the event loop. This is the second membership source of a run scope
 * (DIRECTIVE 1): macOS SIP hides the environment of Apple platform binaries
 * (`/bin/sleep`, `/bin/bash`, `/usr/bin/find`) from the marker census, so the
 * daemon also CAPTURES each live run's descendants (pid, pgid, birth) while
 * the parent chain is intact and ends them later by recorded group and birth.
 *
 * Birth here is `ps -o lstart=` under the C locale (`Mon Oct 12 14:08:47 2026`,
 * 1 s resolution — a disclosed limit) and is only ever compared with another
 * `lstart` reading from this reader, never with the proc-identity helper's
 * token: the two birth sources are kept apart on purpose.
 *
 * The pgid-reuse rule over one such snapshot (`capturedCandidates`) lives here too.
 */
import { execFile } from "node:child_process";
import type { KnownProcessIdentity } from "./process-identity.js";

export interface ProcessTableRow {
  pid: number;
  ppid: number;
  pgid: number;
  /** `lstart` text under the C locale; compared byte-for-byte with other rows. */
  birth: string;
}

/** One descendant recorded while its run was live (persisted in the scope index). */
export interface CapturedProcess {
  pid: number;
  pgid: number;
  birth: string;
}

export interface ProcessTableReader {
  /** The whole table, or null when it could not be read completely. */
  snapshot(): Promise<ProcessTableRow[] | null>;
  /** One pid right now: its row, null when gone, "unreadable" on a read failure. */
  row(pid: number): Promise<ProcessTableRow | null | "unreadable">;
}

// `ps` resolved through the pinned child PATH (`/usr/bin:/bin`), exactly like
// `process-tree.ts`: both readers find or miss `ps` the same way (a host that
// keeps it elsewhere — NixOS — is a disclosed, consistent miss).
const PS_COMMAND = "ps";
const TABLE_TIMEOUT_MS = 5_000;
const ROW_RE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s*$/;

/** Parse one `ps -o pid=,ppid=,pgid=,lstart=` row; null for anything else. */
export function parseProcessTableRow(line: string): ProcessTableRow | null {
  const match = ROW_RE.exec(line);
  if (!match) return null;
  const pid = Number(match[1]);
  const ppid = Number(match[2]);
  const pgid = Number(match[3]);
  if (![pid, ppid, pgid].every(Number.isSafeInteger) || pid <= 0) return null;
  return { pid, ppid, pgid, birth: match[4]!.replace(/\s+/g, " ") };
}

/** Epoch seconds of an `lstart` reading (local time, C locale); null if unparseable. */
export function birthEpochSeconds(birth: string): number | null {
  const ms = Date.parse(birth);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export interface ScopeRootGroup {
  pgid: number;
  leaderPid: number;
  /** `lstart` text of the leader when a table read confirmed it; null if the root never got one. */
  leaderBirth: string | null;
  /** The leader's spawn-time measured identity (proc identity token). */
  leaderIdentity?: KnownProcessIdentity;
}

/** Whether a live process with pid == G is still a group's leader, by its birth. */
export type GroupLeaderVerdict = "same" | "different" | "unknown";

/** The epoch-seconds floor of a scope: the earlier of its `lstart` and wall-clock floors. */
export function scopeFloorSeconds(
  scopeStart: string | null | undefined,
  scopeStartAt: string | null | undefined,
): number | null {
  const fromBirth = scopeStart ? birthEpochSeconds(scopeStart) : null;
  const fromClock = scopeStartAt ? Math.floor(Date.parse(scopeStartAt) / 1000) : null;
  const floors = [fromBirth, fromClock].filter(
    (v): v is number => v !== null && Number.isFinite(v),
  );
  return floors.length ? Math.min(...floors) : null;
}

/**
 * The candidates of the recorded sources against one fresh table snapshot:
 * every individually captured pid still alive with its recorded birth, plus
 * every live member of a recorded group G under the pgid-reuse rule — POSIX
 * does not reuse a pid as a group id while that group has members, so G is
 * still ours when (i) every live member of G was born at or after the scope
 * and (ii) a live process with pid == G has the birth we recorded for G's
 * leader; otherwise G is skipped entirely. A live process with pid == G of
 * ANOTHER birth proves the recorded group gone. Any other skip (no floor, a
 * birth that cannot be read, a member older than the scope, a leader that cannot
 * be told) proves nothing: `unproven` lists the live members that could still be
 * ours, never signalled, keeping the reap from settling. Pure.
 */
export function capturedCandidates(
  captured: readonly CapturedProcess[],
  rows: readonly ProcessTableRow[],
  scopeStart: string | null | undefined,
  options: {
    scopeStartAt?: string | null;
    rootGroups?: ReadonlyArray<ScopeRootGroup>;
    /** For a root group known only by its leader identity (computed by the caller). */
    leaderVerdict?: ReadonlyMap<number, GroupLeaderVerdict>;
  } = {},
): { candidates: Map<number, string>; reusedGroups: number[]; unproven: number[] } {
  const byPid = new Map(rows.map((row) => [row.pid, row] as const));
  const candidates = new Map<number, string>();
  const reusedGroups: number[] = [];
  const unproven: number[] = [];
  for (const item of captured) {
    const row = byPid.get(item.pid);
    if (row && row.birth === item.birth) candidates.set(row.pid, row.birth);
  }
  const floor = scopeFloorSeconds(scopeStart, options.scopeStartAt);
  const age = (row: ProcessTableRow): "older" | "in_scope" | "unknown" => {
    const at = birthEpochSeconds(row.birth);
    if (floor === null || at === null) return "unknown";
    return at < floor ? "older" : "in_scope";
  };
  const rootByPgid = new Map((options.rootGroups ?? []).map((g) => [g.pgid, g] as const));
  const groups = new Set([...captured.map((item) => item.pgid), ...rootByPgid.keys()]);
  for (const group of groups) {
    const members = rows.filter((row) => row.pgid === group);
    if (members.length === 0) continue; // emptied: simply gone
    const root = rootByPgid.get(group);
    const recordedLeaderBirth =
      captured.find((item) => item.pid === group)?.birth ?? root?.leaderBirth ?? undefined;
    const liveLeader = byPid.get(group);
    const verdict = options.leaderVerdict?.get(group);
    // Rule (ii): a live process with pid == G must be the recorded leader —
    // by its `lstart` when one was recorded, else by the caller's identity
    // verdict against the spawn-time handle.
    const recycled =
      liveLeader !== undefined &&
      (recordedLeaderBirth !== undefined
        ? liveLeader.birth !== recordedLeaderBirth
        : verdict === "different");
    if (recycled) {
      reusedGroups.push(group);
      continue;
    }
    const leaderUntold =
      liveLeader !== undefined && recordedLeaderBirth === undefined && verdict !== "same";
    if (leaderUntold || !members.every((row) => age(row) === "in_scope")) {
      reusedGroups.push(group);
      for (const row of members)
        if (age(row) !== "older" && !candidates.has(row.pid)) unproven.push(row.pid);
      continue;
    }
    for (const row of members) candidates.set(row.pid, row.birth);
  }
  return { candidates, reusedGroups, unproven };
}

function runPsRows(args: string[]): Promise<{ rows: ProcessTableRow[]; failure: string | null }> {
  return new Promise((resolve) => {
    execFile(
      PS_COMMAND,
      args,
      {
        encoding: "utf8",
        timeout: TABLE_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      },
      (error, stdout) => {
        const rows: ProcessTableRow[] = [];
        for (const line of (stdout ?? "").split("\n")) {
          const row = parseProcessTableRow(line);
          if (row) rows.push(row);
        }
        if (error) {
          const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
          resolve({ rows, failure: `ps failed: ${String(code ?? error.message)}` });
          return;
        }
        resolve({ rows, failure: null });
      },
    );
  });
}

/** The live reader (POSIX). Windows has no `ps`; the caller never asks there. */
export function createProcessTableReader(): ProcessTableReader {
  return {
    async snapshot() {
      const { rows, failure } = await runPsRows(["-A", "-o", "pid=,ppid=,pgid=,lstart="]);
      return failure ? null : rows;
    },
    async row(pid) {
      const { rows, failure } = await runPsRows([
        "-o",
        "pid=,ppid=,pgid=,lstart=",
        "-p",
        String(pid),
      ]);
      const row = rows.find((r) => r.pid === pid) ?? null;
      if (row) return row;
      // `ps -p <gone>` exits 1 with no row: absent, not unreadable.
      if (failure && /ps failed: 1$/.test(failure)) return null;
      return failure ? "unreadable" : null;
    },
  };
}

/**
 * `rootPid` and every transitive descendant in `rows` (BFS by ppid). Taken
 * while the chain is intact, so a shell that `setsid`-ed into its own group
 * is still found through its parent link.
 */
export function descendantProcessRows(
  rootPid: number,
  rows: readonly ProcessTableRow[],
): ProcessTableRow[] {
  const byPpid = new Map<number, ProcessTableRow[]>();
  const byPid = new Map<number, ProcessTableRow>();
  for (const row of rows) {
    byPid.set(row.pid, row);
    const bucket = byPpid.get(row.ppid);
    if (bucket) bucket.push(row);
    else byPpid.set(row.ppid, [row]);
  }
  const out: ProcessTableRow[] = [];
  const seen = new Set<number>();
  const queue = [rootPid];
  const root = byPid.get(rootPid);
  if (root) out.push(root);
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of byPpid.get(pid) ?? []) {
      if (child.pid === pid) continue;
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}
