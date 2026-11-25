/**
 * Startup reconciliation of run-deadline/1 records (`run-deadline-record.ts`),
 * and the one rule for removing a record.
 *
 * Reconciliation runs before any product request is served, when no job is
 * live yet, in two passes. First every record of an earlier daemon generation
 * whose job is retained reaches its terminal state explicitly, so every later
 * answer is a plain projection; every record is still present, so a Delegate
 * child's deadline is read through its parent's current one. A record that was
 * enforcing, or whose deadline was claimed, is expired; so is one whose job
 * the restart itself interrupted after its deadline passed (on this boot's
 * host clock, or by the wall when the boot changed). Anything else is closed.
 * Then the records of jobs no longer retained are offered for removal.
 *
 * Removal (`sweepRecords`, also the registry's after retention): a record goes
 * only when nothing may act on it any more — its own warden is gone (never
 * ready, done, or of another boot) and no remaining record names it as its
 * Delegate parent while that dependent is held or its warden may still act.
 * A dependent's deadline therefore never rises because its parent's record
 * went; removing a dependent can free its parent in the same sweep. A sweep
 * asks each record's parent at most once; a record whose parent cannot be read
 * while it is needed keeps every candidate until a later sweep reads it.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RunDeadlineClock } from "./run-deadline-clock.js";
import {
  enforcementClaimed,
  fileRecordIo,
  frozenOf,
  isRecordFileName,
  priorPath,
  readRecord,
  readRecordInForce,
  removeRecordFiles,
  sidecarOwner,
  wardenDonePath,
  wardenReadyPath,
  writeRecord,
  type Bound,
  type DeadlineRecord,
  type RecordIo,
} from "./run-deadline-record.js";

export interface ReconcileDeps {
  dir: string;
  clock: RunDeadlineClock;
  /** A job this daemon already holds or stages (never reconciled here). */
  held(jobId: string): boolean;
  governing(record: DeadlineRecord): Bound | null;
  /** The retained jobs' lifecycle states, in one indexed read. */
  states(jobIds: string[]): Map<string, string>;
  io?: RecordIo;
  onFault?: (message: string, error: unknown) => void;
  /** The terminal record decided for an earlier generation's job, written or not:
   * every answer of this generation reads it, so they agree with each other. */
  decided?: (name: string, record: DeadlineRecord) => void;
}

/** Reconcile (pass 1) and return the record files to offer for removal (pass 2). */
export async function reconcileRecords(deps: ReconcileDeps): Promise<string[]> {
  const { dir, clock } = deps;
  let all: string[];
  try {
    all = readdirSync(dir);
  } catch {
    return [];
  }
  const names = all.filter(isRecordFileName);
  // No write is in flight at startup: a temporary file is a cut-short write, and
  // a sidecar whose record is gone is the rest of a cut-short removal.
  const present = new Set(names);
  for (const name of all) {
    const owner = sidecarOwner(name);
    if (owner && (name.endsWith(".tmp") || !present.has(owner)))
      try {
        (deps.io ?? { remove: (path: string) => rmSync(path, { force: true }) }).remove(
          join(dir, name),
        );
      } catch (error) {
        deps.onFault?.(`run-deadline leftover ${name} not removed`, error);
      }
  }
  const records = names.map((name) => {
    const path = join(dir, name);
    // The record in force: a change the earlier generation did not commit is not.
    const record = readRecordInForce(path);
    return {
      name,
      path,
      record,
      jobId: record && record !== "unreadable" ? record.jobId : name.slice(0, -5),
    };
  });
  const retained = deps.states(records.map((item) => item.jobId));
  const removable: string[] = [];
  for (const { name, path, record, jobId } of records) {
    const state = retained.get(jobId);
    if (state === undefined) {
      if (!deps.held(jobId)) removable.push(name);
      continue;
    }
    if (!record || record === "unreadable" || deps.held(jobId)) continue;
    if (record.state === "closed" || record.state === "expired") continue;
    const bound = deps.governing(record);
    const sameClock = record.bootId === clock.bootId() && record.clock === clock.kind;
    const passed =
      bound !== null &&
      (sameClock ? clock.hostNow() >= bound.target : Date.parse(bound.at) <= clock.wallNow());
    const won =
      record.state === "enforcing" ||
      enforcementClaimed(path) ||
      (state === "interrupted" && passed);
    const terminal: DeadlineRecord = {
      ...record,
      state: won ? "expired" : "closed",
      frozen: bound ? frozenOf(bound) : null,
    };
    deps.decided?.(name, terminal);
    try {
      await writeRecord(path, terminal, deps.io);
      if (existsSync(priorPath(path))) (deps.io ?? fileRecordIo).remove(priorPath(path));
    } catch (error) {
      deps.onFault?.(`run-deadline record of ${jobId} not reconciled`, error);
    }
  }
  return removable;
}

/** A record's parent could not be read now: it may name any candidate. */
export const PARENT_UNREADABLE: unique symbol = Symbol("parent unreadable");

export interface SweepDeps {
  dir: string;
  clock: RunDeadlineClock;
  /** Record files offered for removal. */
  candidates: readonly string[];
  /** Every record file now present in the directory. */
  present: readonly string[];
  /** A record this daemon holds or stages: it depends on its parent while it exists. */
  holds(name: string): boolean;
  /** The parent record file a record names: null for none, PARENT_UNREADABLE
   * when the record cannot be read now. Asked at most once per record in one
   * sweep; the next sweep asks again. */
  parentOf(name: string): string | null | typeof PARENT_UNREADABLE;
  io?: RecordIo;
}

/** A record's warden may still act on it: ready, not done, of this boot. */
export function wardenMayAct(path: string, clock: RunDeadlineClock): boolean {
  if (!existsSync(wardenReadyPath(path)) || existsSync(wardenDonePath(path))) return false;
  const record = readRecord(path);
  const otherBoot =
    record && record !== "unreadable" && record.bootId !== null && record.bootId !== clock.bootId();
  return !otherBoot;
}

/** Remove what nothing needs (see the module doc); returns the removed record files. */
export function sweepRecords(deps: SweepDeps): string[] {
  const present = new Set(deps.present);
  const candidates = new Set(deps.candidates.filter((name) => present.has(name)));
  const removed: string[] = [];
  const needs = (name: string) =>
    deps.holds(name) || wardenMayAct(join(deps.dir, name), deps.clock);
  // One answer per record for this sweep only: a record names the same parent
  // for its life, and an unreadable one is asked again by the next sweep.
  const parents = new Map<string, string | null | typeof PARENT_UNREADABLE>();
  const parentOf = (name: string) => {
    let parent = parents.get(name);
    if (parent === undefined) {
      parent = deps.parentOf(name);
      parents.set(name, parent);
    }
    return parent;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const name of candidates) {
      if (needs(name)) continue;
      let needed = false;
      for (const other of present) {
        if (other === name) continue;
        const parent = parentOf(other);
        // A record whose parent cannot be read may name this one: while it is
        // held or its warden may act, nothing it could depend on goes now.
        if ((parent === name || parent === PARENT_UNREADABLE) && needs(other)) {
          needed = true;
          break;
        }
      }
      if (needed) continue;
      try {
        removeRecordFiles(join(deps.dir, name), deps.io);
      } catch {
        continue;
      }
      candidates.delete(name);
      present.delete(name);
      removed.push(name);
      changed = true;
    }
  }
  return removed;
}
