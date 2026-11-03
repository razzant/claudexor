import type { HarnessEvent } from "@claudexor/schema";
import { normalizeRetryDelayMs, redactSecrets } from "@claudexor/util";

const CLAUDE_TRANSIENT_RE =
  /overloaded|temporar(?:y|ily) unavailable|network|econnreset|etimedout|enotfound|eai_again|stream/i;
const CLAUDE_RETRY_CATEGORIES = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "billing_error",
  "rate_limit",
  "overloaded",
  "invalid_request",
  "model_not_found",
  "server_error",
  "max_output_tokens",
  "unknown",
]);

/** Translate Claude's native retry frame into the shared typed retry signals. */
export function claudeApiRetryEvents(
  obj: Record<string, unknown>,
  sessionId: string,
  ts: string,
): HarnessEvent[] {
  const errText = String(obj["error"] ?? "");
  const retryDelayMs = normalizeRetryDelayMs(obj["retry_delay_ms"]);
  const event: HarnessEvent = {
    type: "status",
    session_id: sessionId,
    ts,
    text: `api_retry: ${redactSecrets(errText).slice(0, 500)}`,
    status: {
      kind: "api_retry",
      attempt: nonnegativeSafeIntegerOrUndef(obj["attempt"]),
      max_retries: nonnegativeSafeIntegerOrUndef(obj["max_retries"]),
      ...(retryDelayMs === null ? {} : { retry_delay_ms: retryDelayMs }),
      error_category: claudeRetryCategory(obj["error"]),
    },
    payload: {
      api_retry: true,
      retry_delay_ms: retryDelayMs,
      // Only the vendor's exact code proves subscription access is denied. The
      // category's prose fallback below can name a single model, so it keeps the
      // category for diagnostics and retry without this proof.
      ...(obj["error"] === "oauth_org_not_allowed" ? { entitlement_denied: true } : {}),
    },
  };
  if (/rate.?limit|overloaded|too many requests|quota/i.test(errText)) {
    event.rate_limit = { resets_at: null, retry_delay_ms: retryDelayMs };
  }
  if (CLAUDE_TRANSIENT_RE.test(errText)) {
    event.transient = {
      kind: /overloaded|temporar(?:y|ily) unavailable/i.test(errText)
        ? "service_unavailable"
        : "network",
      retry_delay_ms: retryDelayMs,
    };
  }
  return [event];
}

/**
 * A1: the org-disabled entitlement failure arrives as PLAIN prose ("Your
 * organization has disabled Claude subscription access for Claude Code · Use
 * an Anthropic API key instead…") on the assistant/result path with exit 1 —
 * never as an api_retry frame — so `claudeRetryCategory` never sees it and the
 * run died as an untyped generic failure (live incident 2026-08-17,
 * run-ea06645118d7). Classify the non-success result's prose into a typed
 * status event with `error_category: "oauth_org_not_allowed"` so downstream
 * consumers (attemptTelemetry → classifyStatusError → capability_refused) see
 * a machine fact instead of prose. The message events themselves keep flowing
 * unchanged (adapter output hygiene is a later phase).
 *
 * `kind: "api_retry"` is the only status kind the frozen schema carries today, and
 * a dedicated kind would be a schema change deliberately out of A1 scope. Consumers
 * read `error_category`; `entitlement_denied` adds the proof that this credential's
 * subscription access is denied, which the category's prose fallback cannot give.
 */
const CLAUDE_ORG_DISABLED_RE = /organization has disabled claude subscription access/i;

export function claudeEntitlementEvents(
  resultText: unknown,
  successResult: boolean,
  sessionId: string,
  ts: string,
): HarnessEvent[] {
  if (successResult || typeof resultText !== "string") return [];
  if (!CLAUDE_ORG_DISABLED_RE.test(resultText)) return [];
  return [
    {
      type: "status",
      session_id: sessionId,
      ts,
      text: `entitlement: ${redactSecrets(resultText).slice(0, 500)}`,
      status: { kind: "api_retry", error_category: "oauth_org_not_allowed" },
      payload: { entitlement_denied: true },
    },
  ];
}

function nonnegativeSafeIntegerOrUndef(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function claudeRetryCategory(
  raw: unknown,
):
  | "authentication_failed"
  | "oauth_org_not_allowed"
  | "billing_error"
  | "rate_limit"
  | "overloaded"
  | "invalid_request"
  | "model_not_found"
  | "server_error"
  | "max_output_tokens"
  | "unknown"
  | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw);
  if (CLAUDE_RETRY_CATEGORIES.has(value)) return value as ReturnType<typeof claudeRetryCategory>;
  if (/rate.?limit|too many requests|(?:^|\D)429(?:\D|$)/i.test(value)) return "rate_limit";
  if (/overloaded|(?:^|\D)529(?:\D|$)/i.test(value)) return "overloaded";
  if (/authentication|unauthorized|(?:^|\D)401(?:\D|$)/i.test(value))
    return "authentication_failed";
  if (/oauth.*org|org.*not.*allowed/i.test(value)) return "oauth_org_not_allowed";
  if (/billing|payment|credit balance|(?:^|\D)402(?:\D|$)/i.test(value)) return "billing_error";
  if (/model.{0,20}not.{0,10}found/i.test(value)) return "model_not_found";
  if (/max.?output.?tokens/i.test(value)) return "max_output_tokens";
  if (/invalid.?request|(?:^|\D)400(?:\D|$)/i.test(value)) return "invalid_request";
  if (/internal server error|server.?error|(?:^|\D)5\d\d(?:\D|$)/i.test(value))
    return "server_error";
  return "unknown";
}
