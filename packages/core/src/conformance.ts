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
 * vendor mechanism for humans; every other field is machine truth.
 */
export interface FixtureStreamExpectations {
  /** Exact count of `final: true` messages (the typed final answer). */
  final_messages?: number;
  /**
   * The typed identity of the wire event finality came from — the adapter
   * stamps `payload.final_source` on every final message ("result",
   * "structured_output", "last_agent_message", "assistant_message"). Machine-checked: a parser
   * that starts finalizing from a different wire event fails this even when
   * the count and position happen to survive (final sol review #5).
   */
  final_source?: string;
  /**
   * Whether the typed final is the LAST message of the stream. Finality comes
   * from the vendor's TERMINAL event: a parser that marks mid-run narration
   * final keeps the count right while answering from the wrong event, and only
   * this catches it.
   */
  final_is_last_message?: boolean;
  /** Exact count of thinking events — lifecycle frames must never inflate it. */
  thinking_events?: number;
  /** Exact count of display-stream delta chunks (payload.delta === true). */
  delta_messages?: number;
  /** Whether the stream surfaces a typed rate_limit signal. */
  typed_rate_limit?: boolean;
  /**
   * Typed retry classification the stream must carry — the vendor category on
   * a transient `status` event, or `rate_limit` from the rate-limit signal
   * (e.g. "rate_limit"). Presence alone is not the contract: the CLASS is what
   * bounded-retry policy consumes, and a regression that keeps the signal but
   * loses its category passes a presence check.
   */
  retry_class?: string;
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
  let lastMessageWasFinal = false;
  const finalSources = new Set<string>();
  const retryClasses = new Set<string>();
  for (const raw of events) {
    const ev = HarnessEvent.parse(raw);
    if (ev.type === "message") {
      if (ev.final === true) {
        finals += 1;
        const source = ev.payload?.["final_source"];
        finalSources.add(typeof source === "string" ? source : "unstamped");
      }
      if (ev.payload?.["delta"] === true) deltas += 1;
      // EVERY message moves this, deltas included: a display chunk arriving
      // AFTER the typed final means the final was not the last word.
      lastMessageWasFinal = ev.final === true;
    }
    if (ev.type === "thinking") thinking += 1;
    if (ev.rate_limit !== undefined) rateLimits += 1;
    // The typed retry CLASS is ONLY the adapter's classification. Deriving a
    // class from the mere presence of a rate_limit signal would make this
    // check a restatement of `typed_rate_limit` — true whenever that is, and
    // unable to fail on its own (triad round 2, fable #1).
    const category = ev.status?.error_category;
    if (category) retryClasses.add(category);
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
  if (expectations.final_source !== undefined) {
    const got = [...finalSources];
    if (got.length !== 1 || got[0] !== expectations.final_source) {
      violations.push(
        `final_source: expected ${expectations.final_source}, got [${got.join(", ") || "none"}]`,
      );
    }
  }
  if (
    expectations.final_is_last_message !== undefined &&
    lastMessageWasFinal !== expectations.final_is_last_message
  ) {
    violations.push(
      `final_is_last_message: expected ${expectations.final_is_last_message}, got ${lastMessageWasFinal}`,
    );
  }
  if (expectations.typed_rate_limit !== undefined) {
    const has = rateLimits > 0;
    if (has !== expectations.typed_rate_limit) {
      violations.push(
        `typed_rate_limit: expected ${expectations.typed_rate_limit}, got ${has} (${rateLimits} events)`,
      );
    }
  }
  if (expectations.retry_class !== undefined && !retryClasses.has(expectations.retry_class)) {
    violations.push(
      `retry_class: expected ${expectations.retry_class}, got [${[...retryClasses].join(", ") || "none"}]`,
    );
  }
  return violations;
}
