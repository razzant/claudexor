import type {
  ControlProblem,
  ModelCallOptions,
  ModelCallRequest,
  ModelCallResult,
  ModelMessage,
  ModelNativeContinuation,
  ModelRoute,
  ModelUsage,
} from "@claudexor/schema";
import { ModelMessage as ModelMessageSchema } from "@claudexor/schema";
import { ResponseFailureCapture } from "./failure-evidence.js";

export const CODEX_CONTINUATION_FORMAT = "codex.responses.v1";

/** Carries only deliberate public diagnostics, never a provider body or credentials. */
export class CodexModelError extends Error {
  readonly problem: ControlProblem;
  constructor(
    code: string,
    message: string,
    context: Record<string, unknown> = {},
    retryable = false,
  ) {
    super(message);
    this.name = "CodexModelError";
    this.problem = {
      code,
      message,
      context,
      retryable,
      fieldErrors: {},
      requiredActions: [],
      evidenceRefs: [],
    };
  }
}

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function counter(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function responseUsage(value: unknown): ModelUsage {
  const usage = record(value);
  return {
    input_tokens: counter(usage?.input_tokens),
    output_tokens: counter(usage?.output_tokens),
    cached_input_tokens: counter(record(usage?.input_tokens_details)?.cached_tokens),
    cache_write_tokens: counter(record(usage?.input_tokens_details)?.cache_write_tokens),
    reasoning_tokens: counter(record(usage?.output_tokens_details)?.reasoning_tokens),
  };
}

export function emptyModelResult(route: ModelRoute): ModelCallResult {
  return {
    outcome: "failed",
    message: null,
    route,
    usage: responseUsage(null),
    appliedOptions: {},
    problem: null,
    cost: {
      knowledge: "unknown",
      billing: "unknown",
      source: "codex.responses",
      provenance: ["Codex Responses does not report incremental cash or token valuation."],
      estimatedUsd: null,
      cashUsd: null,
      valuationUsd: null,
      valuationKnowledge: "unknown",
    },
  };
}

function invalid(message: string): never {
  throw new CodexModelError("invalid_request", message);
}

/** Blocks are translated structurally; caller text and JSON schemas are never rewritten. */
function content(value: ModelMessage["content"], role: string): unknown[] {
  if (value === null) return [];
  if (typeof value === "string")
    return [{ type: role === "assistant" ? "output_text" : "input_text", text: value }];
  return value.map((block) => {
    if (block.type === "text" || block.type === "input_text" || block.type === "output_text") {
      if (typeof block.text !== "string") invalid("Text content requires a string.");
      return { type: role === "assistant" ? "output_text" : "input_text", text: block.text };
    }
    if (block.type === "image_url" || block.type === "input_image") {
      if (role !== "user" && role !== "tool")
        invalid("Images are supported in user messages and tool results.");
      const image = record(block.image_url);
      const url = typeof block.image_url === "string" ? block.image_url : image?.url;
      const detail = image?.detail ?? block.detail;
      if (typeof url !== "string" || !url)
        invalid("Image content requires an image URL or data URL.");
      if (detail !== undefined && !["auto", "low", "high", "original"].includes(String(detail))) {
        invalid("Image detail is not supported.");
      }
      return { type: "input_image", image_url: url, ...(detail !== undefined ? { detail } : {}) };
    }
    invalid("This content block is not supported by the Codex model transport.");
  });
}

function replay(message: ModelMessage, route: ModelRoute): unknown[] | null {
  const native = message.nativeContinuation;
  if (!native) return null;
  const replayed = replayedNativeItems(message, route);
  if (replayed !== null) return replayed;
  // The same account may answer with another model, or disclose none. That
  // continuation stays bound to the model that produced it and is never
  // replayed here; the message uses its canonical projection instead. A message
  // with nothing but its continuation has no projection and still refuses.
  if (
    native.route.model !== route.model &&
    continuationValid(message, native, route) &&
    (message.content?.length || message.tool_calls?.length)
  )
    return null;
  throw new CodexModelError(
    "invalid_continuation",
    "Native continuation must match the exact account, profile and format, and a turn another model answered must carry its own content or tool calls.",
  );
}

/** Exact account, profile, format, and string-typed payload items. */
function continuationValid(
  message: ModelMessage,
  native: ModelNativeContinuation,
  route: ModelRoute,
): boolean {
  return (
    message.role === "assistant" &&
    native.format === CODEX_CONTINUATION_FORMAT &&
    !!route.accountFingerprint &&
    native.route.accountFingerprint === route.accountFingerprint &&
    native.route.source === route.source &&
    native.route.credentialProfileId === route.credentialProfileId &&
    Array.isArray(native.payload) &&
    native.payload.every((item) => typeof record(item)?.type === "string")
  );
}

/** The payload items a message's continuation pushes verbatim onto the wire for
 * this route, or null when it would not replay: no continuation, a malformed
 * one, or a turn another model answered (which projects structurally instead).
 * These items are the only image bytes that can reach the provider without
 * passing through the content serializer, so the invoke-side capability gate
 * scans exactly them. */
export function replayedNativeItems(message: ModelMessage, route: ModelRoute): unknown[] | null {
  const native = message.nativeContinuation;
  if (native == null) return null;
  if (native.route.model !== route.model || !continuationValid(message, native, route)) return null;
  return native.payload as unknown[];
}

export function validateCodexModelOptions(options: ModelCallOptions): void {
  for (const option of ["maxOutputTokens", "temperature"] as const) {
    if (options[option] !== undefined) {
      throw new CodexModelError(
        "unsupported_parameter",
        `Codex Responses does not support ${option}.`,
        { parameter: option },
      );
    }
  }
}

/** Preserve instruction roles and text parts instead of joining them into one bounded string. */
export function buildResponsesRequest(
  request: ModelCallRequest,
  route: ModelRoute,
): Record<string, unknown> {
  validateCodexModelOptions(request.options);
  const input: unknown[] = [];
  for (const message of request.messages) {
    if (message.tool_calls?.length && message.role !== "assistant")
      invalid("Only assistant messages can contain tool calls.");
    if (message.name !== undefined && message.role !== "tool")
      invalid("Named conversation messages are not supported by Codex Responses.");
    const native = replay(message, route);
    if (native) {
      input.push(...native);
      continue;
    }
    if (message.role === "tool") {
      if (!message.tool_call_id) invalid("Tool results require the original tool_call_id.");
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output:
          typeof message.content === "string" ? message.content : content(message.content, "tool"),
        ...(message.name !== undefined ? { name: message.name } : {}),
      });
      continue;
    }
    const parts = content(message.content, message.role);
    if (parts.length > 0) {
      // The Codex subscription backend rejects `system` roles in `input`.
      // Keep the caller's canonical role untouched and project only this
      // provider-specific wire copy to the equivalent high-priority
      // `developer` role. Existing developer/user/assistant/tool roles remain
      // unchanged and retain their order and content parts. A caller that
      // supplies both system and developer therefore gets one wire priority
      // level for those two source roles on this Codex route.
      const wireRole = message.role === "system" ? "developer" : message.role;
      input.push({ type: "message", role: wireRole, content: parts });
    }
    if (message.tool_calls?.length) {
      for (const call of message.tool_calls)
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
    }
  }
  const options = request.options;
  return {
    model: request.model,
    instructions: "",
    input,
    tools: request.tools.map(({ function: fn }) => ({
      type: "function",
      name: fn.name,
      ...(fn.description !== undefined ? { description: fn.description } : {}),
      parameters: fn.parameters,
      // The native default is strict; ordinary caller schemas must not be silently strictified.
      strict: fn.strict ?? false,
    })),
    tool_choice:
      typeof request.toolChoice === "string"
        ? request.toolChoice
        : { type: "function", name: request.toolChoice.function.name },
    ...(options.parallelToolCalls !== undefined
      ? { parallel_tool_calls: options.parallelToolCalls }
      : {}),
    ...(options.reasoningEffort !== undefined
      ? { reasoning: { effort: options.reasoningEffort } }
      : {}),
    ...(options.serviceTier !== undefined ? { service_tier: options.serviceTier } : {}),
    ...(options.cacheKey !== undefined ? { prompt_cache_key: options.cacheKey } : {}),
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
  };
}

export function providerProblem(
  status: number | null,
  value: unknown,
  headers?: Headers,
): ControlProblem {
  const error = record(record(value)?.error) ?? record(value);
  const vendorCode = text(error?.code) ?? text(error?.type);
  const quota =
    vendorCode === "usage_limit_reached" ||
    vendorCode === "quota_exceeded" ||
    vendorCode === "insufficient_quota";
  const code = quota
    ? "subscription_window_exhausted"
    : vendorCode === "unsupported_parameter"
      ? "unsupported_parameter"
      : vendorCode === "model_not_found"
        ? "model_unavailable"
        : status === 401
          ? "auth_required"
          : status === 429
            ? "rate_limited"
            : status === 403
              ? "provider_refused"
              : status === null || status >= 500
                ? "provider_failed"
                : "invalid_request";
  const context: Record<string, unknown> = status === null ? {} : { httpStatus: status };
  if (vendorCode) context.vendorCode = vendorCode;
  if (typeof error?.param === "string") context.parameter = error.param;
  const requestId = headers?.get("x-request-id") ?? headers?.get("request-id");
  if (requestId) context.requestId = requestId;
  const retry = headers?.get("retry-after");
  if (retry && /^\d+(?:\.\d+)?$/.test(retry)) context.retryAfterMs = Number(retry) * 1000;
  else if (retry && Number.isFinite(Date.parse(retry)))
    context.resetsAt = new Date(retry).toISOString();
  const reset = counter(error?.resets_at);
  if (reset !== null && Number.isFinite(new Date(reset * 1000).getTime()))
    context.resetsAt = new Date(reset * 1000).toISOString();
  return new CodexModelError(
    code,
    status === null
      ? "Codex reported a failed response."
      : `Codex model request was refused (HTTP ${status}).`,
    context,
    status === 429 || (status !== null && status >= 500),
  ).problem;
}

function appliedOptions(response: Record<string, unknown>): ModelCallOptions {
  const effort = text(record(response.reasoning)?.effort);
  const tier = text(response.service_tier);
  const cacheKey = text(response.prompt_cache_key);
  return {
    ...(effort?.trim() ? { reasoningEffort: effort } : {}),
    ...(tier?.trim() ? { serviceTier: tier } : {}),
    ...(cacheKey?.trim() ? { cacheKey } : {}),
    ...(typeof response.parallel_tool_calls === "boolean"
      ? { parallelToolCalls: response.parallel_tool_calls }
      : {}),
  };
}

function responseMessage(items: Record<string, unknown>[], route: ModelRoute): ModelMessage {
  const texts: string[] = [];
  const calls: NonNullable<ModelMessage["tool_calls"]> = [];
  for (const item of items) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const block of item.content) {
        const part = record(block);
        if (part?.type === "output_text" && typeof part.text === "string") texts.push(part.text);
        if (part?.type === "refusal" && typeof part.refusal === "string") texts.push(part.refusal);
      }
    }
    if (item.type === "function_call") {
      if (!text(item.call_id) || !text(item.name) || typeof item.arguments !== "string") {
        throw new CodexModelError(
          "response_rejected",
          "Codex returned a malformed completed tool call.",
        );
      }
      calls.push({
        id: item.call_id as string,
        type: "function",
        function: { name: item.name as string, arguments: item.arguments },
      });
    }
  }
  return ModelMessageSchema.parse({
    role: "assistant",
    content: texts.length ? texts.join("") : null,
    ...(calls.length ? { tool_calls: calls } : {}),
    nativeContinuation: { route, format: CODEX_CONTINUATION_FORMAT, payload: items },
  });
}

/** SSE frames use a streaming UTF-8 decoder. Only a provider terminal makes a response final. */
export async function readResponsesStream(
  response: Response,
  selected: ModelRoute,
  captureFailureEvidence = false,
): Promise<ModelCallResult> {
  const result = emptyModelResult({ ...selected, model: null });
  const capture = new ResponseFailureCapture(captureFailureEvidence);
  capture.response(response);
  capture.stage = "read";
  result.outcome = "unknown";
  if (!response.body) {
    result.problem = new CodexModelError(
      "transport_unknown",
      "Codex returned no response stream.",
    ).problem;
    return capture.finish(result);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let data: string[] = [];
  let terminal = false;
  const done = new Map<number, Record<string, unknown>>();
  const consume = () => {
    if (!data.length || terminal) {
      data = [];
      return;
    }
    const raw = data.join("\n");
    data = [];
    if (raw === "[DONE]") return;
    capture.stage = "json";
    const event = record(JSON.parse(raw));
    capture.stage = "event";
    if (!event) throw new Error("invalid SSE object");
    capture.event(event.type);
    if (event.type === "response.output_item.done") {
      const item = record(event.item),
        index = counter(event.output_index);
      if (!item || index === null) throw new Error("invalid output item");
      done.set(index, item);
    }
    if (event.type === "error") {
      result.problem = providerProblem(null, event);
      result.outcome = "failed";
      capture.terminalStatus = "failed";
      terminal = true;
      return;
    }
    if (
      !["response.completed", "response.incomplete", "response.failed"].includes(String(event.type))
    )
      return;
    capture.stage = "terminal";
    const final = record(event.response);
    if (!final) throw new Error("missing terminal response");
    const expectedStatus = String(event.type).slice("response.".length);
    if (final.status !== undefined && final.status !== expectedStatus)
      throw new Error("contradictory terminal response");
    result.route = { ...selected, model: text(final.model) };
    result.usage = responseUsage(final.usage);
    result.appliedOptions = appliedOptions(final);
    result.outcome =
      event.type === "response.completed"
        ? "completed"
        : event.type === "response.incomplete"
          ? "incomplete"
          : "failed";
    // Provider finality precedes host message conversion. A local rejection
    // cannot undo this fact or turn its reported usage into unknown work.
    terminal = true;
    capture.terminalStatus = result.outcome;
    if (result.outcome === "failed") {
      result.problem = providerProblem(null, final);
      return;
    }
    capture.stage = "message";
    if (Array.isArray(final.output))
      final.output.forEach((item, index) => {
        const object = record(item);
        if (!object) throw new Error("invalid terminal item");
        done.set(index, object);
      });
    else if (event.type === "response.completed" && done.size === 0)
      throw new Error("missing completed output");
    result.message = responseMessage(
      [...done].sort(([a], [b]) => a - b).map(([, item]) => item),
      result.route,
    );
    if (result.outcome === "incomplete")
      result.problem = new CodexModelError(
        "provider_incomplete",
        "Codex returned an incomplete response.",
        { reason: text(record(final.incomplete_details)?.reason) },
      ).problem;
  };
  const lines = (flush = false) => {
    for (;;) {
      const match = /\r\n|\r|\n/.exec(buffer);
      if (!match) break;
      // A CR at the chunk edge might be the first half of CRLF.
      if (!flush && match[0] === "\r" && match.index === buffer.length - 1) break;
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (line === "") consume();
      else if (line === "data") data.push("");
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
  };
  try {
    while (!terminal) {
      capture.stage = "read";
      const chunk = await reader.read();
      if (chunk.done) {
        capture.bodyComplete = true;
        capture.stage = "decode";
        buffer += decoder.decode();
        lines(true);
        break;
      }
      capture.receive(chunk.value);
      capture.stage = "decode";
      buffer += decoder.decode(chunk.value, { stream: true });
      lines();
    }
    if (!terminal) {
      capture.stage = "read";
      result.problem = new CodexModelError(
        "transport_unknown",
        "Codex stream ended without a terminal response.",
      ).problem;
    }
  } catch (error) {
    capture.caught(error);
    result.message = null;
    result.problem = new CodexModelError(
      terminal ? "response_rejected" : "transport_unknown",
      terminal
        ? "Codex returned a terminal response whose message could not be used."
        : "Codex response stream was interrupted or malformed.",
    ).problem;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return capture.finish(result);
}
