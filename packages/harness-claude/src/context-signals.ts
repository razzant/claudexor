import type { HarnessEvent } from "@claudexor/schema";
import { claudeQuotaFamilyScope } from "@claudexor/schema";
import { claudeQuotaEvents, claudeQuotaReset } from "./quota.js";

/**
 * D-16c: claude 2.1.165 typed context / rate-limit signal mapping, extracted
 * from the main stream parser so each concern stays a small, testable owner.
 * These map FIXTURE-PROVEN vendor frames onto typed HarnessEvents — no prose
 * matching. Context signals are a sibling of the transient-retry taxonomy and
 * NEVER enter the transient_retry loop.
 */
type Json = any;

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

/**
 * `system/compact_boundary` → a typed compaction context event. The boundary is
 * the COMPLETION of a compaction; `trigger` (auto|manual) and `pre_tokens` ride
 * through as evidence. The frame states no cause, so cause stays `unknown`.
 */
export function claudeCompactBoundaryEvents(
  obj: Json,
  sessionId: string,
  ts: string,
): HarnessEvent[] {
  const meta =
    obj.compact_metadata && typeof obj.compact_metadata === "object" ? obj.compact_metadata : {};
  const trigger = (meta as Json).trigger;
  return [
    {
      type: "context",
      session_id: sessionId,
      ts,
      context: {
        kind: "compaction_completed",
        cause: "unknown",
        native_code: null,
        trigger: trigger === "manual" || trigger === "auto" ? trigger : null,
        pre_tokens: numberOrNull((meta as Json).pre_tokens),
      },
    },
  ];
}

/**
 * Numeric observations and rejection are independent. Allowed/warning frames
 * may report measured windows without arming a cooldown. A rejecting frame
 * retains its existing typed rate_limit signal alongside any measurements.
 */
export function claudeRateLimitEvents(obj: Json, sessionId: string, ts: string): HarnessEvent[] {
  const info =
    obj.rate_limit_info && typeof obj.rate_limit_info === "object" ? obj.rate_limit_info : null;
  const status = info ? (info as Json).status : undefined;
  const measurements = claudeQuotaEvents(info, sessionId, ts);
  if (status !== "rejected" && status !== "blocked") return measurements;
  const resetsRaw = info ? (info as Json).resetsAt : undefined;
  const resetsAt = claudeQuotaReset(resetsRaw);
  const rateLimitType = info ? (info as Json).rateLimitType : undefined;
  const modelFamily =
    rateLimitType === "seven_day_opus"
      ? "Opus"
      : rateLimitType === "seven_day_sonnet"
        ? "Sonnet"
        : null;
  const familyScope = modelFamily ? claudeQuotaFamilyScope(modelFamily) : null;
  return [
    ...measurements,
    {
      type: "status",
      session_id: sessionId,
      ts,
      text: `rate_limit_event: ${String(status)}`,
      rate_limit: {
        resets_at: resetsAt,
        retry_delay_ms: null,
        ...(familyScope ? { constraint_id: String(rateLimitType), ...familyScope } : {}),
      },
      payload: { rate_limit_event: true },
    },
  ];
}

/**
 * Map the FIXTURE-PROVEN result `terminal_reason` values onto a typed
 * context-exhaustion event (or null for `completed`/unrecognized). No prose
 * matching — only the typed vendor enum. `prompt_too_long` is an irreducible-
 * packet exhaustion (NOT continuation-eligible); `rapid_refill_breaker` is the
 * SDK's repeated-refill breaker (the continuation-eligible cause).
 */
export function claudeTerminalContextEvent(
  terminalReason: unknown,
  sessionId: string,
  ts: string,
): HarnessEvent | null {
  if (terminalReason === "prompt_too_long") {
    return {
      type: "context",
      session_id: sessionId,
      ts,
      context: {
        kind: "capacity_exhausted",
        cause: "prompt_too_long",
        native_code: "prompt_too_long",
        trigger: null,
        pre_tokens: null,
      },
    };
  }
  if (terminalReason === "rapid_refill_breaker") {
    return {
      type: "context",
      session_id: sessionId,
      ts,
      context: {
        kind: "capacity_exhausted",
        cause: "repeated_refill",
        native_code: "rapid_refill_breaker",
        trigger: null,
        pre_tokens: null,
      },
    };
  }
  return null;
}

/**
 * D-16c side_tool: a `{work_report}`-ONLY structured_output (no `output` key) is
 * the claude StructuredOutput-tool WorkReport envelope — the report rides the
 * tool while the markdown final message stays the deliverable. Returns the raw
 * work_report value, or undefined when the structured_output is a full
 * `{work_report, output}` envelope / a plain caller-schema answer (both of
 * which surface AS the final message).
 */
/**
 * The final-message events a `result` frame emits (D-16c). Precedence:
 * - a full `{work_report, output}` envelope / plain structured answer surfaces
 *   AS the final message (`structured_output` finality);
 * - otherwise the markdown `result` is the final message (side_tool rides its
 *   WorkReport on the message payload);
 * - a side_tool report with no deliverable text still surfaces (rare).
 * Finality is stamped only for a success result. A NON-SUCCESS result's text
 * is failure evidence, not answer material (A3 deliverable hygiene): it rides
 * a `status` event — visible in the timeline, typed by the entitlement/error
 * signals alongside — and never a `message` the answer assembly could adopt.
 */
export function claudeResultMessageEvents(
  obj: Json,
  successResult: boolean,
  sessionId: string,
  ts: string,
): HarnessEvent[] {
  const so = obj.structured_output;
  const sideToolReport = claudeSideToolReport(so);
  if (so !== undefined && so !== null && sideToolReport === undefined) {
    if (!successResult) {
      return [
        {
          type: "status",
          session_id: sessionId,
          ts,
          text: JSON.stringify(so),
          payload: { structured_output: true, non_success_result: true },
        },
      ];
    }
    return [
      {
        type: "message",
        session_id: sessionId,
        ts,
        text: JSON.stringify(so),
        final: true,
        payload: {
          structured_output: true,
          final_source: "structured_output",
        },
      },
    ];
  }
  if (typeof obj.result === "string" && obj.result.trim()) {
    if (!successResult) {
      return [
        {
          type: "status",
          session_id: sessionId,
          ts,
          text: obj.result,
          payload: {
            non_success_result: true,
            ...(sideToolReport !== undefined ? { work_report_side_tool: sideToolReport } : {}),
          },
        },
      ];
    }
    return [
      {
        type: "message",
        session_id: sessionId,
        ts,
        text: obj.result,
        final: true,
        payload: {
          final_source: "result",
          ...(sideToolReport !== undefined ? { work_report_side_tool: sideToolReport } : {}),
        },
      },
    ];
  }
  if (sideToolReport !== undefined) {
    return [
      {
        type: "status",
        session_id: sessionId,
        ts,
        text: "work_report (side_tool, no deliverable text)",
        payload: { work_report_side_tool: sideToolReport },
      },
    ];
  }
  return [];
}

export function claudeSideToolReport(structuredOutput: unknown): unknown {
  if (
    structuredOutput &&
    typeof structuredOutput === "object" &&
    !Array.isArray(structuredOutput) &&
    "work_report" in (structuredOutput as Json) &&
    !("output" in (structuredOutput as Json))
  ) {
    return (structuredOutput as Json).work_report;
  }
  return undefined;
}
