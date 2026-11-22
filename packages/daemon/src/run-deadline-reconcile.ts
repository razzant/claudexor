/**
 * Startup reconciliation of run-deadline/1 records (`run-deadline-record.ts`).
 *
 * It runs before any product request is served, when no job is live yet:
 * every record of an earlier daemon generation whose job is retained reaches
 * its terminal state explicitly, so every later answer is a plain projection.
 * A record that was enforcing, or whose warden claimed its deadline, is
 * expired; so is one whose job the restart itself interrupted after its
 * deadline passed (on this boot's host clock, or by the wall when the boot
 * changed). Anything else is closed. The records of jobs no longer retained
 * go once their warden is gone.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RunDeadlineClock } from "./run-deadline-clock.js";
import {
  enforcementClaimed,
  frozenOf,
  isRecordFileName,
  readRecord,
  removeRecordFiles,
  wardenDonePath,
  wardenReadyPath,
  writeRecord,
  type Bound,
  type DeadlineRecord,
} from "./run-deadline-record.js";

export interface ReconcileDeps {
  dir: string;
  clock: RunDeadlineClock;
  /** A job this daemon already holds (never reconciled here). */
  held(jobId: string): boolean;
  governing(record: DeadlineRecord): Bound | null;
  /** The retained jobs' lifecycle states, in one indexed read. */
  states(jobIds: string[]): Map<string, string>;
  onFault?: (message: string, error: unknown) => void;
}

export async function reconcileRecords(deps: ReconcileDeps): Promise<void> {
  const { dir, clock } = deps;
  let names: string[];
  try {
    names = readdirSync(dir).filter(isRecordFileName);
  } catch {
    return;
  }
  const records = names.map((name) => {
    const path = join(dir, name);
    const record = readRecord(path);
    return {
      path,
      record,
      jobId: record && record !== "unreadable" ? record.jobId : name.slice(0, -5),
    };
  });
  const retained = deps.states(records.map((item) => item.jobId));
  for (const { path, record, jobId } of records) {
    const state = retained.get(jobId);
    if (state === undefined) {
      const otherBoot =
        record &&
        record !== "unreadable" &&
        record.bootId !== null &&
        record.bootId !== clock.bootId();
      const wardenGone =
        !existsSync(wardenReadyPath(path)) || existsSync(wardenDonePath(path)) || otherBoot;
      if (wardenGone) removeRecordFiles(path);
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
    try {
      await writeRecord(path, {
        ...record,
        state: won ? "expired" : "closed",
        frozen: bound ? frozenOf(bound) : null,
      });
    } catch (error) {
      deps.onFault?.(`run-deadline record of ${jobId} not reconciled`, error);
    }
  }
}
