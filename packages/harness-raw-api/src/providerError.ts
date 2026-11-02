import type { HarnessEvent } from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import type { ChatResult } from "./parse.js";

const PROVIDER_DIAGNOSTIC_MAX_CHARS = 500;
const SERVICE_UNAVAILABLE_ERROR_TYPES = new Set([
  "provider_overloaded",
  "provider_unavailable",
  "server",
]);

/** An explicit terminal marker or a structurally valid choice error is authoritative. */
export function isTerminalProviderCompletion(result: ChatResult): boolean {
  return result.finish_reason === "error" || result.provider_error !== null;
}

/** Build the adapter-authored terminal event without persisting raw provider metadata. */
export function providerCompletionErrorEvent(
  id: string,
  sessionId: string,
  ts: string,
  result: ChatResult,
): HarnessEvent {
  const payload: Record<string, unknown> = {};
  if (result.finish_reason !== null) {
    payload["finish_reason"] = redactAndBound(result.finish_reason).value;
  }
  if (result.provider_error) {
    const providerError: Record<string, unknown> = {
      code: result.provider_error.code,
      message: redactAndBound(result.provider_error.message).value,
    };
    if (result.provider_error.error_type !== null) {
      providerError["error_type"] = redactAndBound(result.provider_error.error_type).value;
    }
    if (result.provider_error.provider_code !== null) {
      providerError["provider_code"] = redactAndBound(result.provider_error.provider_code).value;
    }
    payload["provider_error"] = providerError;
  }
  if (result.diagnostic_text) {
    // The model's own partial text: working content, bounded but exact
    // (INV-146). It is evidence only and never becomes the answer.
    const partialOutput = bound(result.diagnostic_text);
    payload["partial_output"] = partialOutput.value;
    payload["partial_output_truncated"] = partialOutput.truncated;
  }

  const event: HarnessEvent = {
    type: "error",
    session_id: sessionId,
    ts,
    error: `${id} provider completion failed`,
    payload,
  };
  const errorType = result.provider_error?.error_type;
  if (errorType === "rate_limit_exceeded") {
    event.rate_limit = { resets_at: null, retry_delay_ms: null };
    event.transient = { kind: "service_unavailable", retry_delay_ms: null };
  } else if (errorType && SERVICE_UNAVAILABLE_ERROR_TYPES.has(errorType)) {
    event.transient = { kind: "service_unavailable", retry_delay_ms: null };
  } else if (errorType === "timeout") {
    event.transient = { kind: "timeout", retry_delay_ms: null };
  }
  return event;
}

/**
 * This adapter's one masked-diagnostic bound: a provider's completion error, a
 * non-OK HTTP body and a failed catalog read's detail. The whole value is
 * masked first; masking a cut value could leave a credential's head that no
 * rule recognizes.
 */
export function redactAndBound(
  value: string,
  max = PROVIDER_DIAGNOSTIC_MAX_CHARS,
): { value: string; truncated: boolean } {
  return bound(redactSecrets(value), max);
}

/** At most `max` UTF-16 code units of `value`. A cut never separates a high
 * surrogate from the low one after it: an astral character is kept or dropped
 * whole, so a well-formed value stays well formed. */
function bound(
  value: string,
  max = PROVIDER_DIAGNOSTIC_MAX_CHARS,
): { value: string; truncated: boolean } {
  if (value.length <= max) return { value, truncated: false };
  const high = value.charCodeAt(max - 1);
  const low = value.charCodeAt(max);
  const splitsPair = high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
  return { value: value.slice(0, splitsPair ? max - 1 : max), truncated: true };
}
