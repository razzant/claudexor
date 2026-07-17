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
  deniedToolResults: number;
  cancelledToolResults: number;
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
    deniedToolResults: 0,
    cancelledToolResults: 0,
    fileChanges: 0,
    usageEvents: 0,
    errors: 0,
    completed: 0,
  };
  for (const raw of events) {
    const ev = HarnessEvent.parse(raw); // throws loudly on contract violations
    stats.total += 1;
    switch (ev.type) {
      case "started":
        stats.started += 1;
        break;
      case "message":
        stats.messages += 1;
        break;
      case "tool_call":
        stats.toolCalls += 1;
        break;
      case "tool_result":
        stats.toolResults += 1;
        if (!ev.tool?.status) stats.statuslessToolResults += 1;
        if (ev.tool?.status === "error") stats.errorToolResults += 1;
        if (ev.tool?.status === "denied") stats.deniedToolResults += 1;
        if (ev.tool?.status === "cancelled") stats.cancelledToolResults += 1;
        break;
      case "file_change":
        stats.fileChanges += 1;
        break;
      case "usage":
        stats.usageEvents += 1;
        break;
      case "error":
        stats.errors += 1;
        break;
      case "completed":
        stats.completed += 1;
        break;
      default:
        break;
    }
  }
  return stats;
}

/**
 * Per-fixture STREAM SEMANTICS expectations (W3.8): the fixture manifest
 * declares them next to provenance, and every adapter conformance test
 * asserts them through this one owner — finality/dedup/lifecycle regressions
 * (the "fixed it three times" class) change these counts on a deterministic
 * fixture and fail loudly instead of shipping. `final_source` documents the
 * vendor mechanism for humans; the machine truth is the counts.
 */
export interface FixtureStreamExpectations {
  /** Exact count of `final: true` messages (the typed final answer). */
  final_messages?: number;
  /** Vendor mechanism carrying finality (documentation; e.g. "result"). */
  final_source?: string;
  /** Exact count of thinking events — lifecycle frames must never inflate it. */
  thinking_events?: number;
  /** Exact count of display-stream delta chunks (payload.delta === true). */
  delta_messages?: number;
  /** Whether the stream surfaces a typed rate_limit signal. */
  typed_rate_limit?: boolean;
}

/** Violations of the declared expectations over an already-parsed stream. */
export function streamExpectationViolations(
  events: unknown[],
  expectations: FixtureStreamExpectations,
): string[] {
  let finals = 0;
  let thinking = 0;
  let deltas = 0;
  let rateLimits = 0;
  for (const raw of events) {
    const ev = HarnessEvent.parse(raw);
    if (ev.type === "message" && ev.final === true) finals += 1;
    if (ev.type === "thinking") thinking += 1;
    if (ev.type === "message" && ev.payload?.["delta"] === true) deltas += 1;
    if (ev.rate_limit !== undefined) rateLimits += 1;
  }
  const violations: string[] = [];
  const check = (name: string, expected: number | undefined, actual: number): void => {
    if (expected !== undefined && actual !== expected) {
      violations.push(`${name}: expected ${expected}, got ${actual}`);
    }
  };
  check("final_messages", expectations.final_messages, finals);
  check("thinking_events", expectations.thinking_events, thinking);
  check("delta_messages", expectations.delta_messages, deltas);
  if (expectations.typed_rate_limit !== undefined) {
    const has = rateLimits > 0;
    if (has !== expectations.typed_rate_limit) {
      violations.push(
        `typed_rate_limit: expected ${expectations.typed_rate_limit}, got ${has} (${rateLimits} events)`,
      );
    }
  }
  return violations;
}
