import type { RunEvent, RunEventType } from "@claudexor/schema";
import { RunEvent as RunEventSchema } from "@claudexor/schema";
import { appendLine, nowIso, readTextSafe, redactSecrets } from "@claudexor/util";

/**
 * Append-only JSONL event log for a single run. Terminal output and human
 * summaries are projections; this file is the canonical event stream.
 *
 * Every emitted event carries a monotonic per-run `seq` stamped here — the
 * durable cursor for SSE resume (Last-Event-ID) and snapshot fencing
 * (detail.lastSeq). The counter initializes from the existing file tail so a
 * re-opened log (or an out-of-band appender like the control-api audit
 * writer) continues the sequence instead of restarting it.
 */
export class EventLog {
  private nextSeq: number;

  constructor(
    private readonly path: string,
    private readonly runId: string,
    private readonly taskId: string,
    /**
     * Optional in-process sink invoked after each event is persisted. Lets a
     * long-running service / GUI observe the live RunEvent stream without
     * tailing the file. The file remains the canonical log; a throwing sink
     * must never break a run, so sink errors are swallowed.
     */
    private readonly onEmit?: (event: RunEvent) => void,
  ) {
    this.nextSeq = lastSeqInFile(path) + 1;
    activeEventLogs.set(path, this);
  }

  /**
   * Unregister this log as the live writer for its path. Out-of-band
   * appenders fall back to file-tail stamping afterwards, which is safe once
   * the owning run is terminal (nobody else holds an in-memory counter).
   */
  dispose(): void {
    if (activeEventLogs.get(this.path) === this) activeEventLogs.delete(this.path);
  }

  /** Append a typed run event. Validates against the schema before writing. */
  emit(type: RunEventType, payload: Record<string, unknown> = {}): RunEvent {
    const event = RunEventSchema.parse({
      seq: this.nextSeq++,
      ts: nowIso(),
      run_id: this.runId,
      task_id: this.taskId,
      type,
      payload: redactEventValue(payload),
    });
    appendLine(this.path, JSON.stringify(event));
    if (this.onEmit) {
      try {
        this.onEmit(event);
      } catch {
        /* sink errors must never break the canonical run */
      }
    }
    // Terminal events are emitted exactly once, last (output.ready invariant
    // tests pin this). Self-disposing here hands the seq space back to
    // file-tail appenders without requiring every orchestrator mode to
    // remember a finally block.
    if (type === "run.completed" || type === "run.failed" || type === "run.blocked") this.dispose();
    return event;
  }

  /** Read and parse all events (skipping malformed lines, which are surfaced separately). */
  readAll(): { events: RunEvent[]; malformed: number } {
    const text = readTextSafe(this.path);
    if (text === null) return { events: [], malformed: 0 };
    const events: RunEvent[] = [];
    let malformed = 0;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(RunEventSchema.parse(JSON.parse(trimmed)));
      } catch {
        malformed += 1;
      }
    }
    return { events, malformed };
  }
}

/**
 * Live writers by events.jsonl path (one daemon process hosts the
 * orchestrator AND the control API). While a run is active its EventLog owns
 * the in-memory seq counter; any other same-process appender stamping from
 * the file tail would duplicate ids the moment the live counter is ahead.
 */
const activeEventLogs = new Map<string, EventLog>();

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
  const live = activeEventLogs.get(path);
  if (live) return live.emit(type, payload);
  const event = RunEventSchema.parse({
    seq: lastSeqInFile(path) + 1,
    ts: nowIso(),
    run_id: runId,
    task_id: taskId,
    type,
    payload: redactEventValue(payload),
  });
  appendLine(path, JSON.stringify(event));
  return event;
}

/**
 * Highest `seq` already present in an events.jsonl file (0 for missing/empty).
 * Legacy lines without seq count by position so a continued log never reuses
 * a line number an SSE replayer may have already served as a fallback id.
 */
export function lastSeqInFile(path: string): number {
  const text = readTextSafe(path);
  if (text === null) return 0;
  let last = 0;
  let lineNo = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    lineNo += 1;
    try {
      const parsed = JSON.parse(trimmed) as { seq?: unknown };
      const seq = typeof parsed.seq === "number" && Number.isFinite(parsed.seq) ? parsed.seq : lineNo;
      if (seq > last) last = seq;
    } catch {
      if (lineNo > last) last = lineNo;
    }
  }
  return last;
}

function redactEventValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactEventValue);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactEventValue(child);
  }
  return out;
}
