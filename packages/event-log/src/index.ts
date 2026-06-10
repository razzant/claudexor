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
