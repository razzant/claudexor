/**
 * Whether what a stopped preparation started has provably ended, by READING only
 * (#694): no signal is ever sent from here (a signal-0 probe delivers nothing).
 * The one release criterion of held preparation resources (a thread tree, an
 * envelope base, a staging directory) — never weaker than the scope's own
 * settlement contract:
 *
 * - every process group recorded at the resource answers ESRCH to signal 0; a
 *   group still answering is gone only when a live process whose pid equals the
 *   group id was born in a LATER second than the direct child's observed exit
 *   (POSIX hands out a pid only while no group of that id has members). `lstart`
 *   is rounded to the second: the same second, an unreadable birth or no
 *   observed exit (a daemon crash) proves nothing;
 * - while the scope's index row exists, its recorded root groups and
 *   individually captured descendants (pid + birth, also after a group change)
 *   and the marker census are read by the existing scope census (a
 *   `ScopeReaper` of its own) with a delivery that sends nothing: any live,
 *   unproven or unreadable KNOWN member, a failed census or an unfinished one
 *   keeps the resource held. After the row is settled away, the resource's
 *   groups and the marker census decide.
 *
 * A same-uid process whose environment the census could not read (Linux: a
 * non-dumpable one, such as the session's own sshd) is not a known member: as
 * for the scope's settlement, it limits what the read can prove and holds
 * nothing (`censusUnreadable` is a count over the host, not over this scope).
 *
 * Three facts stay apart. What the resource's record says of its stop is
 * history, never a measurement. A process this read measures alive holds: a
 * group or member above, and the stopped step's own process where the stop left
 * it running and no group names it (`directWriterPid`: that pid still in use).
 * And where nothing can be read at all — Windows has no process groups to probe
 * and no census — the answer is `quiet` with `unproven`: nothing measured holds
 * the resource, so it is not held for ever, but no end was proven, and a caller
 * must not report one (the platform's tree-only limit, disclosed).
 *
 * The residual, disclosed: a process that closed our pipes, left the group and
 * whose environment the platform hides (macOS SIP), withholds (Linux, above) or
 * erased, and that no capture tick recorded, cannot be seen (INV-144).
 */
import { defaultProbeGroupAlive, defaultProbePidAlive } from "./process-tree.js";
import {
  birthEpochSeconds,
  createProcessTableReader,
  type ProcessTableReader,
} from "./process-table.js";
import {
  ScopeReaper,
  type ScopeReapOptions,
  type ScopeReapOutcome,
} from "./process-scope-census.js";

export interface PreparationHoldFacts {
  /** The scope marker the preparation's processes carried (absent: none). */
  marker?: string;
  /** Process groups recorded at the resource (the direct child's own group). */
  groups: readonly number[];
  /** When the direct child's exit was observed (ms since epoch); absent after a crash. */
  directExitObservedAt?: number;
  /** The stopped step's own process, recorded when the stop left it running and
   * no process group names it (Windows); absent once its exit was observed. */
  directWriterPid?: number;
}

export type PreparationQuietVerdict =
  /** `unproven`: why this read could prove nothing (absent: the end was read). */
  | { status: "quiet"; unproven?: string }
  /** `writerInUse`: the recorded direct writer's pid, when its being in use is one
   * of the reasons (a pid alone, never an identity); `unproven` as above. */
  | { status: "held"; reasons: string[]; writerInUse?: number; unproven?: string };

export interface PreparationQuietOptions {
  /** The scope's index row, while it exists (root groups, captured, floors). */
  sources?: Pick<
    ScopeReapOptions,
    "captured" | "scopeStart" | "scopeStartAt" | "settledAt" | "rootGroups"
  >;
  probeGroupAlive?: (pgid: number) => boolean;
  /** The signal-0 probe of one pid (`defaultProbePidAlive` in production). */
  probePidAlive?: (pid: number) => boolean;
  table?: ProcessTableReader | null;
  /** The census read (the reap with a delivery that sends nothing). */
  census?: (opts: ScopeReapOptions) => Promise<ScopeReapOutcome>;
  /** Bound on the census read; a member still alive at it keeps the hold. */
  deadlineMs?: number;
  platform?: string;
}

export async function preparationQuiet(
  hold: PreparationHoldFacts,
  options: PreparationQuietOptions = {},
): Promise<PreparationQuietVerdict> {
  const platform = options.platform ?? process.platform;
  const reasons: string[] = [];
  let unproven: string | undefined;
  let writerInUse: number | undefined;
  if (
    hold.directWriterPid !== undefined &&
    (options.probePidAlive ?? defaultProbePidAlive)(hold.directWriterPid)
  ) {
    writerInUse = hold.directWriterPid;
    reasons.push(
      `the stopped step's own process ${hold.directWriterPid} had not exited at its stop and that pid is still in use`,
    );
  }
  if (platform === "win32") {
    unproven = "this platform has no process groups to probe and no process census";
  } else {
    const probe = options.probeGroupAlive ?? defaultProbeGroupAlive;
    const alive = hold.groups.filter((pgid) => probe(pgid));
    if (alive.length > 0) {
      const table = options.table === undefined ? createProcessTableReader() : options.table;
      for (const pgid of alive) {
        if (!(await groupProvenGone(pgid, hold.directExitObservedAt, table)))
          reasons.push(`process group ${pgid} still has members`);
      }
    }
  }
  if (hold.marker) {
    // A reaper of its own per read: a read never joins a real settlement's ladder
    // (which signals), nor another read whose sources (an index row's captured
    // members and root groups, a platform, a deadline) may be weaker than its own.
    const outcome = await (options.census ?? ((opts) => new ScopeReaper().reap(opts)))({
      marker: hold.marker,
      ...(options.sources ?? {}),
      ...(options.table ? { table: options.table } : {}),
      // A read: the census finds members, nothing is delivered to them.
      signal: () => {},
      graceMs: 0,
      // A read waits this long only while something it found still runs.
      deadlineMs: options.deadlineMs ?? 10_000,
      ...(options.platform ? { platform: options.platform } : {}),
    });
    if (outcome.census === "unsupported") {
      // No census exists (Windows): nothing was read, so nothing is proven.
      // Only a measured fact above holds; the caller discloses the rest.
      unproven ??= outcome.completenessReason ?? "no process census exists on this platform";
    } else if (outcome.census === "failed") {
      reasons.push(`scope census failed (${outcome.censusFailure ?? "unknown"})`);
    } else {
      for (const member of outcome.survivors) reasons.push(`scope member ${member.pid} is alive`);
      for (const member of outcome.unreadable)
        reasons.push(`scope member ${member.pid} could not be read (${member.reason})`);
      if (outcome.incomplete) reasons.push("scope census did not finish in time");
    }
  }
  if (reasons.length > 0)
    return {
      status: "held",
      reasons,
      ...(writerInUse !== undefined ? { writerInUse } : {}),
      ...(unproven !== undefined ? { unproven } : {}),
    };
  return unproven === undefined ? { status: "quiet" } : { status: "quiet", unproven };
}

/** The recorded group answered signal 0: gone only when its id now names a process
 * born in a later second than the observed exit of our direct child. */
async function groupProvenGone(
  pgid: number,
  exitObservedAt: number | undefined,
  table: ProcessTableReader | null,
): Promise<boolean> {
  if (exitObservedAt === undefined || table === null) return false;
  const row = await table.row(pgid).catch(() => null);
  if (row === null || row === "unreadable") return false;
  const born = birthEpochSeconds(row.birth);
  return born !== null && born > Math.floor(exitObservedAt / 1000);
}
