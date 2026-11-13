import type { RunEvent, RunEventType } from "@claudexor/schema";
import { RunEvent as RunEventSchema } from "@claudexor/schema";
import { resolve } from "node:path";
import { appendLine, nowIso } from "@claudexor/util";
import { lastSeqInFile, readEventFile, terminalEventInFile, withUnlanded } from "./event-file.js";
import type { EventLog } from "./index.js";
import type { TerminalRunEventType } from "./types.js";

export function terminalTypeOf(type: RunEventType): TerminalRunEventType | null {
  return type === "run.completed" || type === "run.failed" || type === "run.blocked" ? type : null;
}

/**
 * Live writers by events.jsonl path (one daemon process hosts the
 * orchestrator AND the control API). While a run is active its EventLog owns
 * the in-memory seq counter; any other same-process appender stamping from
 * the file tail would duplicate ids the moment the live counter is ahead.
 * Keyed by the absolute path, as the ordered appender keys the file, so two
 * spellings of one path name one writer (#704).
 */
class LiveWriters {
  private readonly byPath = new Map<string, EventLog>();
  get(path: string): EventLog | undefined {
    return this.byPath.get(resolve(path));
  }
  set(path: string, log: EventLog): void {
    this.byPath.set(resolve(path), log);
  }
  delete(path: string): void {
    this.byPath.delete(resolve(path));
  }
}
export const activeEventLogs = new LiveWriters();

function liveEventLog(path: string): EventLog | null {
  const live = activeEventLogs.get(path);
  return live && !live.releaseRecoveredTerminalFence() ? live : null;
}

/**
 * Shared reader for live terminal preparation and selected interrupted-run
 * recovery. A live writer answers with its file followed by the events it has
 * stamped and not yet landed (`EventLog.readAll`); any other path is read raw.
 */
export function readRunEvents(path: string): { events: RunEvent[]; malformed: number } {
  return activeEventLogs.get(path)?.readAll() ?? withUnlanded(readEventFile(path), []);
}

/** A landing nobody hears: an out-of-band append that is best-effort. */
const unheard = { resolve: () => undefined, reject: () => undefined };

/**
 * Append an out-of-band event (e.g. a control-api audit record) into a run's
 * canonical log WITHOUT corrupting the seq space: routes through the live
 * EventLog when the run is still active (same counter, same onEmit sink), and
 * falls back to file-tail stamping for terminal runs. Through a live writer it
 * is best-effort and leaves the run's failures to the run (#704): it never
 * consumes a failure held for the run's own lines, and a failure of its own
 * line at landing is dropped, as the audit's catch-all drops a thrown one. A
 * caller that must hear its line land uses `appendRunEventLanded`. A terminal
 * type is the run's own and is emitted as such.
 */
export function appendRunEvent(
  path: string,
  runId: string,
  taskId: string,
  type: RunEventType,
  payload: Record<string, unknown> = {},
): RunEvent {
  const live = liveEventLog(path);
  if (!live) return appendAfterTail(path, runId, taskId, type, payload);
  return terminalTypeOf(type)
    ? live.emit(type, payload)
    : live.emitAside(type as Exclude<RunEventType, TerminalRunEventType>, payload, unheard);
}

/** `appendRunEvent`, settled once the line has landed and the live writer's
 * `onPersist` accepted it (its failure rejects this await alone). It neither
 * consumes nor leaves a failure for the run's own lines (#704). */
export async function appendRunEventLanded(
  path: string,
  runId: string,
  taskId: string,
  type: Exclude<RunEventType, TerminalRunEventType>,
  payload: Record<string, unknown> = {},
): Promise<RunEvent> {
  const live = liveEventLog(path);
  return live
    ? new Promise((landed, refused) =>
        live.emitAside(type, payload, { resolve: landed, reject: refused }),
      )
    : appendAfterTail(path, runId, taskId, type, payload);
}

function appendAfterTail(
  path: string,
  runId: string,
  taskId: string,
  type: RunEventType,
  payload: Record<string, unknown>,
): RunEvent {
  if (terminalTypeOf(type) && terminalEventInFile(path)) {
    throw new Error("run terminal event is already committed");
  }
  const event = RunEventSchema.parse({
    seq: lastSeqInFile(path) + 1,
    ts: nowIso(),
    run_id: runId,
    task_id: taskId,
    type,
    payload: payload,
  });
  appendLine(path, JSON.stringify(event));
  return event;
}

/**
 * A registered live writer's authoritative in-memory cursor, or null when no
 * live writer owns this path. This never reads files or initiates recovery;
 * a poisoned writer keeps its conservative counter until recovery releases it.
 */
export function liveRunEventSeq(path: string): number | null {
  return activeEventLogs.get(path)?.lastSeq() ?? null;
}

/**
 * The run's highest event `seq` for snapshot fencing. A live writer answers from
 * its in-memory counter (the one seq owner; its file holds exactly the events up
 * to that seq); any other log answers from its file through `lastSeqInFile`.
 */
export function lastRunEventSeq(path: string): number {
  return liveEventLog(path)?.lastSeq() ?? lastSeqInFile(path);
}
