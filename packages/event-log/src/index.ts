import type { RunEvent, RunEventType } from "@claudex/schema";
import { RunEvent as RunEventSchema } from "@claudex/schema";
import { appendLine, nowIso, readTextSafe } from "@claudex/util";

/**
 * Append-only JSONL event log for a single run. Terminal output and human
 * summaries are projections; this file is the canonical event stream.
 */
export class EventLog {
  constructor(
    private readonly path: string,
    private readonly runId: string,
    private readonly taskId: string,
  ) {}

  /** Append a typed run event. Validates against the schema before writing. */
  emit(type: RunEventType, payload: Record<string, unknown> = {}): RunEvent {
    const event = RunEventSchema.parse({
      ts: nowIso(),
      run_id: this.runId,
      task_id: this.taskId,
      type,
      payload,
    });
    appendLine(this.path, JSON.stringify(event));
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
