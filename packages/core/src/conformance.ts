import { HarnessEvent } from "@claudexor/schema";

/**
 * Typed-event conformance stats for one parsed adapter stream. Shared by the
 * per-adapter fixture parity tests: every adapter must emit schema-valid
 * events, tool_results MUST carry a status (a statusless result is treated as
 * dropped/diagnostic by the engine, never as ok), and streams that perform
 * tool work must surface typed tool_call/tool_result pairs.
 */
export interface StreamConformanceStats {
  total: number;
  started: number;
  messages: number;
  toolCalls: number;
  toolResults: number;
  statuslessToolResults: number;
  errorToolResults: number;
  fileChanges: number;
  usageEvents: number;
  errors: number;
  completed: number;
}

/** Validate every event against the HarnessEvent schema and aggregate stats. */
export function validateTypedStream(events: unknown[]): StreamConformanceStats {
  const stats: StreamConformanceStats = {
    total: 0,
    started: 0,
    messages: 0,
    toolCalls: 0,
    toolResults: 0,
    statuslessToolResults: 0,
    errorToolResults: 0,
    fileChanges: 0,
    usageEvents: 0,
    errors: 0,
    completed: 0,
  };
  for (const raw of events) {
    const ev = HarnessEvent.parse(raw); // throws loudly on contract violations
    stats.total += 1;
    switch (ev.type) {
      case "started": stats.started += 1; break;
      case "message": stats.messages += 1; break;
      case "tool_call": stats.toolCalls += 1; break;
      case "tool_result":
        stats.toolResults += 1;
        if (!ev.tool?.status) stats.statuslessToolResults += 1;
        if (ev.tool?.status === "error") stats.errorToolResults += 1;
        break;
      case "file_change": stats.fileChanges += 1; break;
      case "usage": stats.usageEvents += 1; break;
      case "error": stats.errors += 1; break;
      case "completed": stats.completed += 1; break;
      default: break;
    }
  }
  return stats;
}
