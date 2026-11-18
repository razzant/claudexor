import { constants } from "node:os";
import { getSystemErrorMap } from "node:util";
import { redactSecrets, sensitiveResourcePolicy } from "@claudexor/util";

/**
 * The one public projection of what a Codex diagnostic names (#697). A value
 * is public only when its own vocabulary recognizes it; a token-shaped value
 * no vocabulary knows is as private as free text. Anything else is generic
 * here and stays exact only behind the explicitly private failure capture
 * (`captureFailureEvidence`) and the raw native continuation.
 * - Provider values: this adapter's own vocabularies below.
 * - Engine values: Node's system errors and recognized library codes and classes.
 */

/** Codes the classifiers and consumers read, or the adapter's tests record;
 * `invalid_encrypted_content` is the vendor's own rejection of carried
 * reasoning (continuity.ts). */
const vendorCodes = new Set([
  "context_length_exceeded",
  "cyber_policy",
  "insufficient_quota",
  "invalid_encrypted_content",
  "invalid_request",
  "invalid_request_error",
  "invalid_token",
  "invalid_value",
  "model_not_found",
  "model_not_supported",
  "model_unavailable",
  "quota_exceeded",
  "rate_limit_error",
  "rate_limit_exceeded",
  "request_timeout",
  "resource_unavailable",
  "server_error",
  "server_overloaded",
  "string_above_max_length",
  "unsupported_parameter",
  "usage_limit_reached",
]);

export function vendorErrorCode(value: string | null): string | null {
  return value !== null && vendorCodes.has(value) ? value : null;
}

/** Field paths `buildResponsesRequest` writes, and the reasoning fields it
 * replays from a native continuation (it asks for `reasoning.encrypted_content`). */
const parameters = new Set([
  "model",
  "instructions",
  "input",
  "tools",
  "tool_choice",
  "tool_choice.type",
  "tool_choice.name",
  "parallel_tool_calls",
  "reasoning",
  "reasoning.effort",
  "service_tier",
  "prompt_cache_key",
  "store",
  "stream",
  "include",
  "include[0]",
  "max_output_tokens",
  "temperature",
  "input[0]",
  "input[0].type",
  "input[0].role",
  "input[0].call_id",
  "input[0].name",
  "input[0].arguments",
  "input[0].output",
  "input[0].content",
  "input[0].content[0]",
  "input[0].content[0].type",
  "input[0].content[0].text",
  "input[0].content[0].image_url",
  "input[0].content[0].detail",
  "input[0].content[0].refusal",
  "input[0].output[0]",
  "input[0].output[0].type",
  "input[0].output[0].text",
  "input[0].output[0].image_url",
  "input[0].output[0].detail",
  "input[0].id",
  "input[0].encrypted_content",
  "input[0].summary",
  "input[0].summary[0]",
  "input[0].summary[0].type",
  "input[0].summary[0].text",
  "tools[0]",
  "tools[0].type",
  "tools[0].name",
  "tools[0].description",
  "tools[0].parameters",
  "tools[0].strict",
]);

/** A supplied parameter stays distinguishable from an absent one, so account
 * routing never reads a withheld field diagnostic as evidence against the model. */
export function responseParameter(value: string): string {
  // Compare the field path independently of numeric array positions.
  return value.length <= 256 && parameters.has(value.replace(/\[\d{1,10}\]/g, "[0]"))
    ? value
    : sensitiveResourcePolicy.redactionMarker;
}

export function responseRequestId(headers: Headers | undefined): string | null {
  const id = headers?.get("x-request-id") ?? headers?.get("request-id");
  return id && /^(?:req_[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(id)
    ? id
    : null;
}

/** The Responses stream events this adapter parses or passes over. */
const eventTypes = new Set([
  "error",
  "response.created",
  "response.in_progress",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "response.output_item.added",
  "response.output_item.done",
  "response.content_part.added",
  "response.content_part.done",
  "response.output_text.delta",
  "response.output_text.done",
  "response.refusal.delta",
  "response.refusal.done",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
]);

export function responseEventType(value: unknown): string | null {
  return typeof value === "string" && eventTypes.has(value) ? value : null;
}

const incompleteReasons = new Set(["max_output_tokens", "content_filter", "model_unavailable"]);

export function incompleteReason(value: unknown): string | null {
  return typeof value === "string" && incompleteReasons.has(value) ? value : null;
}

/** A namespace prefix alone identifies neither a Node error nor its source. */
const transportCodes = new Set([
  ...Object.keys(constants.errno),
  ...[...getSystemErrorMap().values()].map(([name]) => name),
  "ENOTFOUND",
  "EAI_AGAIN",
  "CERT_HAS_EXPIRED",
  "ABORT_ERR",
  "ERR_ENCODING_INVALID_ENCODED_DATA",
  "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
]);

export function transportErrorCode(value: unknown): string | null {
  return typeof value === "string" && transportCodes.has(value) ? value : null;
}

const errorNames = new Set([
  "Error", "TypeError", "SyntaxError", "RangeError", "ReferenceError", "EvalError", "URIError",
  "AggregateError", "AbortError", "TimeoutError", "ZodError", "CodexModelError", "SocketError",
]);

export function errorClassName(name: unknown): string | null {
  return typeof name === "string" && errorNames.has(name) ? name : null;
}

/** A provider sentence a classifier recognized, kept as words for its reader. */
export function recognizedProviderSentence(value: string): string {
  return redactSecrets(value)
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .slice(0, 1024);
}
