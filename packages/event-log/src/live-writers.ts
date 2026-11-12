import type { RunEvent, RunEventType } from "@claudexor/schema";
import { RunEvent as RunEventSchema } from "@claudexor/schema";
import { appendLine, nowIso } from "@claudexor/util";
import { lastSeqInFile, readEventFile, terminalEventInFile, withUnlanded } from "./event-file.js";
import type { EventLog, TerminalRunEventType } from "./index.js";

export function terminalTypeOf(type: RunEventType): TerminalRunEventType | null {
  return type === "run.completed" || type === "run.failed" || type === "run.blocked" ? type : null;
}

/**
 * Live writers by events.jsonl path (one daemon process hosts the
 * orchestrator AND the control API). While a run is active its EventLog owns
 * the in-memory seq counter; any other same-process appender stamping from
 * the file tail would duplicate ids the moment the live counter is ahead.
 */
export const activeEventLogs = new Map<string, EventLog>();

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

/**
 * Append an out-of-band event (e.g. a control-api audit record) into a run's
 * canonical log WITHOUT corrupting the seq space: routes through the live
 * EventLog when the run is still active (same counter, same onEmit sink), and
 * falls back to file-tail stamping for terminal runs.
 */
export function appendRunEvent(
  path: string,
  runId: string,
  taskId: string,
  type: RunEventType,
  payload: Record<string, unknown> = {},
): RunEvent {
  const live = liveEventLog(path);
  return live ? live.emit(type, payload) : appendAfterTail(path, runId, taskId, type, payload);
}

/** `appendRunEvent`, settled once the line has landed and the live writer's
 * `onPersist` accepted it (`EventLog.emitLanded`). */
export async function appendRunEventLanded(
  path: string,
  runId: string,
  taskId: string,
  type: Exclude<RunEventType, TerminalRunEventType>,
  payload: Record<string, unknown> = {},
): Promise<RunEvent> {
  const live = liveEventLog(path);
  return live
    ? live.emitLanded(type, payload)
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
