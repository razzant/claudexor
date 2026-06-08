import type { RunEvent, RunEventType } from "@claudexor/schema";
import { RunEvent as RunEventSchema } from "@claudexor/schema";
import { appendLine, nowIso, readTextSafe, redactSecrets } from "@claudexor/util";

/**
 * Append-only JSONL event log for a single run. Terminal output and human
 * summaries are projections; this file is the canonical event stream.
 */
export class EventLog {
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
  ) {}

  /** Append a typed run event. Validates against the schema before writing. */
  emit(type: RunEventType, payload: Record<string, unknown> = {}): RunEvent {
    const event = RunEventSchema.parse({
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
