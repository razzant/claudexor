/**
 * The one durable record of a run's deadline (run-deadline/1).
 *
 * Every job with a deadline, its own or inherited, has exactly one record from
 * acceptance: `daemon/run-deadlines/<job>.json`, written BEFORE the command is
 * committed. Only the daemon writes it (temporary file, fsync, rename,
 * directory flush) and it confirms nothing before that write is durable. Every
 * answer — PATCH and GET, the start, replay and lookup receipts, the startup
 * reconciliation — is a projection of the record; the daemon's memory is a
 * cache of it.
 *
 * States are linear per job: armed → enforcing → expired, or armed → closed
 * (a terminal before the deadline); a terminal at or after the deadline is
 * expired. They are written explicitly, never inferred from another flag.
 *
 * The warden writes no record. The enforcement claim (`<record>.enforcing`,
 * exclusive create) is the one durable fact that a deadline won: the warden
 * makes it before its first stop of a live run, the daemon when it decides the
 * deadline won. It names the deadline that won and is a FLOOR: whatever record
 * is published afterwards, the governing deadline is never later than the
 * claim's, so a failed restoring write or a daemon death cannot postpone it.
 *
 * Why a set and the warden cannot both win, without a lock a SIGKILLed daemon
 * would leave held: both read one host clock. The daemon decides a renewal
 * BEFORE anything is visible (no terminal, no claim, and the clock before the
 * replaced deadline), only then publishes it, and confirms it only when, after
 * the publication, the clock is still before the replaced deadline plus the
 * warden's head start and no claim of the replaced revision exists; otherwise
 * it claims the replaced deadline, restores it as `enforcing` and refuses. The
 * warden reads the clock BEFORE the record and acts only once the clock passed
 * the deadline plus its head start. So a warden acting on a revision read it
 * before a later one was published, which put that publication past the head
 * start: refused, with the claim keeping the replaced deadline in force; and a
 * confirmed revision was published before the head start ran out, so every
 * warden read after its acting reading sees it. A warden never sees a revision
 * the daemon had not first decided on the host clock.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { open as openFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  RunDeadlineEnforcement,
  RunDeadlineSnapshot,
  RunDeadlineState,
} from "@claudexor/schema";
import { fsyncDirectory, fsyncDirectoryAsync } from "@claudexor/util";
import type { HostClockKind } from "./run-deadline-clock.js";

export const RECORD_VERSION = 3;

export interface PointState {
  at: string;
  /** Host clock reading of `at`, decimal nanoseconds (`clock` of the record). */
  targetNs: string;
}

export interface DeadlineRecord {
  version: typeof RECORD_VERSION;
  jobId: string;
  clock: HostClockKind;
  bootId: string | null;
  state: RunDeadlineState;
  /** Revision of the run's own deadline: 0 at acceptance, +1 per confirmed set. */
  revision: number;
  /** The run's own deadline; null when it only inherits one from its parent. */
  own: PointState | null;
  /** The predecessor whose deadline `own` was taken from at acceptance. */
  successorOf: string | null;
  /** Record file of the Delegate parent whose CURRENT deadline also caps this run. */
  parent: string | null;
  parentJobId: string | null;
  /** The parent's deadline when this record was written: used only if the
   * parent's record can no longer be read (it can only make the stop earlier). */
  inherited: (PointState & { from: string }) | null;
  /** The deadline the run's terminal ended it under (closed or expired). */
  frozen: (PointState & { inheritedFrom: string | null; successorOf: string | null }) | null;
  markers: string[];
  cgroup: string | null;
  runScopes: string | null;
}

/** A deadline with the source it came from. */
export interface Bound {
  at: string;
  target: bigint;
  inheritedFrom: string | null;
  successorOf: string | null;
}

/** The warden's final report (its own file beside the record). */
export interface WardenOutcome {
  reason: "reaped" | "released" | "removed" | "unresolved";
  at: string;
  /** confirmed: the boundary was proven empty; else why it could not be. */
  confirmed: boolean;
  detail: string | null;
  ended: number;
  survivors: number;
}

export const recordFileName = (jobId: string) => `${jobId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`;
export const claimPath = (recordPath: string) => `${recordPath}.enforcing`;
export const wardenOutcomePath = (recordPath: string) => `${recordPath}.outcome.json`;
export const wardenReadyPath = (recordPath: string) => `${recordPath}.ready`;
export const wardenDonePath = (recordPath: string) => `${recordPath}.done`;

/** The record files of a directory listing (no claim, outcome, marker or temporary file). */
export const isRecordFileName = (name: string) =>
  name.endsWith(".json") && !name.includes(".json.");

export function parseRecord(text: string): DeadlineRecord | "unreadable" {
  try {
    const value = JSON.parse(text) as DeadlineRecord;
    if (value?.version !== RECORD_VERSION || !Array.isArray(value.markers)) return "unreadable";
    for (const point of [value.own, value.frozen, value.inherited])
      if (point) BigInt(point.targetNs);
    return value;
  } catch {
    return "unreadable";
  }
}

export function readRecord(path: string): DeadlineRecord | null | "unreadable" {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? null : "unreadable";
  }
  return parseRecord(text);
}

let tmpSequence = 0;

/**
 * Every file operation the daemon makes on a record, in the order a durable
 * replace takes them. Injectable: the fault test fails or "crashes" each one.
 */
export interface RecordIo {
  /** Write a complete record to a fresh temporary file beside `path` and fsync
   * it. Nothing is visible yet; returns the temporary file. */
  stage(path: string, record: DeadlineRecord): Promise<string>;
  /** Make a staged file the live record (atomic rename): from here every reader sees it. */
  publish(tmp: string, path: string): Promise<void>;
  /** Flush the directory entry (durability of a publication). */
  flush(dir: string): Promise<void>;
  /** Drop a staged file that is never published. */
  discard(tmp: string): Promise<void>;
  /** The enforcement claim beside `path` (exclusive create, fsync, directory flush). */
  claim(path: string, claim: ClaimContent): boolean;
  /** Remove every file of a record. */
  remove(path: string): void;
}

export const fileRecordIo: RecordIo = {
  async stage(path, record) {
    const tmp = `${path}.${process.pid}.${(tmpSequence += 1)}.tmp`;
    try {
      const handle = await openFile(tmp, "w", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
    return tmp;
  },
  publish: (tmp, path) => rename(tmp, path),
  flush: (dir) => fsyncDirectoryAsync(dir),
  discard: (tmp) => rm(tmp, { force: true }).then(() => {}),
  claim: (path, claim) => claimEnforcement(path, claim),
  remove: (path) => removeRecordFiles(path),
};

/**
 * Replace the record durably: stage, publish, flush. It confirms nothing
 * before it resolves; a failure before the publication changed nothing, a
 * failed flush leaves the published record visible (it is thrown all the same).
 */
export async function writeRecord(
  path: string,
  record: DeadlineRecord,
  io: RecordIo = fileRecordIo,
): Promise<void> {
  const tmp = await io.stage(path, record);
  try {
    await io.publish(tmp, path);
  } catch (error) {
    await io.discard(tmp).catch(() => {});
    throw error;
  }
  await io.flush(dirname(path));
}

/** Synchronous atomic replace of the warden's own evidence files. */
export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${(tmpSequence += 1)}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** What a claim records: the revision it judged and the deadline that won (its floor). */
export interface ClaimContent {
  revision: number;
  at: string;
  /** Host clock reading of the deadline that won, decimal nanoseconds. */
  targetNs: string;
  by: "warden" | "daemon";
}

/** A claim as read: an unreadable one floors at 0 (the deadline already won). */
export interface EnforcementClaim {
  revision: number | null;
  at: string | null;
  target: bigint;
}

/**
 * The claim that the deadline won, before the first stop. Exclusive: true when
 * this call created it, false when it already existed.
 */
export function claimEnforcement(recordPath: string, claim: ClaimContent): boolean {
  let fd: number;
  try {
    fd = openSync(claimPath(recordPath), "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, `${JSON.stringify({ ...claim, pid: process.pid })}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(recordPath));
  return true;
}

export const enforcementClaimed = (recordPath: string) => existsSync(claimPath(recordPath));

export function readClaim(recordPath: string): EnforcementClaim | null {
  const path = claimPath(recordPath);
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    // Present but unreadable: it still says the deadline won.
    return (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? null
      : { revision: null, at: null, target: 0n };
  }
  try {
    const value = JSON.parse(text) as Partial<ClaimContent>;
    return {
      revision: typeof value.revision === "number" ? value.revision : null,
      at: typeof value.at === "string" ? value.at : null,
      target: typeof value.targetNs === "string" ? BigInt(value.targetNs) : 0n,
    };
  } catch {
    return { revision: null, at: null, target: 0n };
  }
}

export function readWardenOutcome(recordPath: string): WardenOutcome | null {
  try {
    return JSON.parse(readFileSync(wardenOutcomePath(recordPath), "utf8")) as WardenOutcome;
  } catch {
    return null;
  }
}

/** Every file of a record: the record, its claim and its warden's evidence. */
export function removeRecordFiles(recordPath: string): void {
  for (const path of [
    recordPath,
    claimPath(recordPath),
    wardenOutcomePath(recordPath),
    wardenReadyPath(recordPath),
    wardenDonePath(recordPath),
  ])
    rmSync(path, { force: true });
}

export interface RecordReader {
  (fileName: string): DeadlineRecord | null | "unreadable";
  /** The enforcement claim beside a record file (its floor); null when there is none. */
  claim?(fileName: string): EnforcementClaim | null;
}

/** Reads records of `dir` (the run's and its Delegate ancestors') and their claims from disk. */
export const diskReader = (dir: string): RecordReader =>
  Object.assign((fileName: string) => readRecord(join(dir, fileName)), {
    claim: (fileName: string) => readClaim(join(dir, fileName)),
  });

const MAX_CHAIN = 8;
const toBound = (
  point: PointState,
  inheritedFrom: string | null,
  successorOf: string | null,
): Bound => ({ at: point.at, target: BigInt(point.targetNs), inheritedFrom, successorOf });

/**
 * The deadline that governs the run's processes now: its base (the frozen
 * deadline after a terminal, else its own) capped by its Delegate parent's
 * governing deadline, read from the parent's current record (the cached
 * `inherited` value when that record can no longer be read), and floored by
 * its enforcement claim (the deadline that already won). The warden obeys
 * this; for a live run it is also what every answer reports.
 */
export function governingBound(
  record: DeadlineRecord,
  read: RecordReader,
  depth = 0,
): Bound | null {
  let base = record.frozen
    ? toBound(record.frozen, record.frozen.inheritedFrom, record.frozen.successorOf)
    : record.own
      ? toBound(record.own, null, record.successorOf)
      : null;
  const claim = read.claim?.(recordFileName(record.jobId)) ?? null;
  if (claim && (!base || claim.target < base.target))
    base = {
      at: claim.at ?? base?.at ?? new Date(0).toISOString(),
      target: claim.target,
      inheritedFrom: base?.inheritedFrom ?? null,
      successorOf: base?.successorOf ?? null,
    };
  let cap: Bound | null = null;
  if (record.parent && depth < MAX_CHAIN) {
    const parent = read(record.parent);
    if (parent && parent !== "unreadable") {
      const bound = governingBound(parent, read, depth + 1);
      if (bound)
        cap = {
          at: bound.at,
          target: bound.target,
          inheritedFrom: bound.inheritedFrom ?? parent.jobId,
          successorOf: null,
        };
    }
  }
  if (!cap && record.inherited) cap = toBound(record.inherited, record.inherited.from, null);
  return cap && (!base || cap.target < base.target) ? cap : base;
}

/** What answers report: the deadline a terminal ended the run under, else the governing one. */
export function reportedBound(record: DeadlineRecord, read: RecordReader): Bound | null {
  if (record.frozen)
    return toBound(record.frozen, record.frozen.inheritedFrom, record.frozen.successorOf);
  return governingBound(record, read);
}

export const frozenOf = (bound: Bound): NonNullable<DeadlineRecord["frozen"]> => ({
  at: bound.at,
  targetNs: bound.target.toString(),
  inheritedFrom: bound.inheritedFrom,
  successorOf: bound.successorOf,
});

export function enforcementOf(outcome: WardenOutcome | null): RunDeadlineEnforcement | null {
  if (!outcome || outcome.reason === "removed") return null;
  return outcome.confirmed
    ? { outcome: "confirmed", detail: null }
    : { outcome: "unresolved", detail: outcome.detail ?? "membership could not be established" };
}

/**
 * The snapshot every answer carries. A live record with a claim reads as
 * `enforcing` until the daemon folds the claim in.
 */
export function snapshotOf(
  record: DeadlineRecord,
  facts: {
    read: RecordReader;
    claimed: boolean;
    outcome: WardenOutcome | null;
    serverNow: string;
    stopGraceSec: number;
  },
): RunDeadlineSnapshot | null {
  const bound = reportedBound(record, facts.read);
  if (!bound) return null;
  return {
    at: bound.at,
    revision: record.revision,
    serverNow: facts.serverNow,
    state: record.state === "armed" && facts.claimed ? "enforcing" : record.state,
    stopGraceSec: facts.stopGraceSec,
    inheritedFrom: bound.inheritedFrom,
    successorOf: bound.successorOf,
    enforcement: enforcementOf(facts.outcome),
  };
}
