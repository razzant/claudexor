import type { HarnessEvent } from "@claudexor/schema";

const CODEX_RATE_LIMIT_RE =
  /rate.?limit|usage.?limit|usagelimitexceeded|too many requests|quota[ _-]?(?:exceeded|exhausted|reached)|(?:http|status|code)[ :/]?429|429 too many/i;
const CODEX_TRANSIENT_RE =
  /stream disconnected|request timed out|failed to lookup address information|nodename nor servname|eai_again|enotfound|econnreset|etimedout|temporar(?:y|ily) unavailable|network/i;
const CODEX_RECONNECT_RE =
  /^Reconnecting\.\.\.\s+(\d+)\/(\d+)\s+\((?:request timed out|stream disconnected before completion: idle timeout waiting for SSE)\)\s*$/i;

export function codexReconnectStatus(
  message: string,
  sessionId: string,
  ts: string,
  payload: unknown,
): HarnessEvent | null {
  const match = CODEX_RECONNECT_RE.exec(message);
  if (!match) return null;
  const attempt = Number(match[1]);
  const maxRetries = Number(match[2]);
  if (!Number.isSafeInteger(attempt) || !Number.isSafeInteger(maxRetries)) return null;
  return {
    type: "status",
    session_id: sessionId,
    ts,
    text: message,
    status: { kind: "api_retry", attempt, max_retries: maxRetries, error_category: "timeout" },
    transient: { kind: "timeout", retry_delay_ms: null },
    payload: payload as Record<string, unknown>,
  };
}

/** Codex's own typed error code: the string itself, or a tagged-object
 * variant's one variant name, as the rollout reader reads it; null otherwise. */
export function codexErrorCode(info: unknown): string | null {
  const variants =
    info && typeof info === "object" && !Array.isArray(info) ? Object.keys(info) : [];
  const code = typeof info === "string" ? info : variants.length === 1 ? variants[0] : null;
  return code || null;
}

/**
 * Codex's own TYPED usage refusal (#558): `usage_limit_exceeded` in the rollout,
 * `usageLimitExceeded` on the app-server wire. The one code covers a spent plan
 * window and a workspace out of credits alike (the recorded rollout fixture is
 * the latter) and names no reopening time, so the limit carries none and is
 * never a timed window. Only the typed code is read, never the words.
 */
export function codexUsageRefusal(info: unknown): NonNullable<HarnessEvent["rate_limit"]> | null {
  const code = codexErrorCode(info);
  if (code !== "usage_limit_exceeded" && code !== "usageLimitExceeded") return null;
  return {
    applies_to_request_kinds: ["text"],
    resets_at: null,
    retry_delay_ms: null,
    reopening: "unknown",
  };
}

export function applyCodexRateLimit(event: HarnessEvent, message: string, resetsAt: unknown): void {
  if (!CODEX_RATE_LIMIT_RE.test(message)) return;
  event.rate_limit = {
    applies_to_request_kinds: ["text"],
    resets_at: typeof resetsAt === "string" ? resetsAt : null,
    retry_delay_ms: null,
  };
}

export function applyCodexTransient(event: HarnessEvent, message: string): void {
  if (!CODEX_TRANSIENT_RE.test(message)) return;
  event.transient = {
    kind: /stream disconnected/i.test(message)
      ? "stream_disconnect"
      : /request timed out|etimedout/i.test(message)
        ? "timeout"
        : "network",
    retry_delay_ms: null,
  };
}
