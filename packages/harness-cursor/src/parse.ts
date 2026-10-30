import type {
  AuthSourceKind,
  CredentialRoute,
  HarnessEvent,
  HarnessModel,
  ToolKind,
  ToolRef,
} from "@claudexor/schema";
import { commandOutcomeLabel, InputTokenUsage } from "@claudexor/schema";
import { nowIso } from "@claudexor/util";
import { applyCursorVendorLimit } from "./retry-signals.js";
import { classifyCursorToolResult } from "./tool-result.js";

type Json = any;

const FILE_WRITE_VARIANTS = new Set(["write", "edit", "multiEdit", "delete", "create", "apply"]);

function variantToolName(toolCall: Json): string {
  if (!toolCall || typeof toolCall !== "object") return "tool";
  const keys = Object.keys(toolCall);
  const variant = keys.find((k) => k.endsWith("ToolCall")) ?? keys[0];
  if (!variant) return "tool";
  return variant.endsWith("ToolCall") ? variant.slice(0, -"ToolCall".length) : variant;
}

function toolKindFor(name: string): ToolKind {
  const n = name.toLowerCase();
  if (n.includes("websearch") || n.includes("webfetch") || n === "web" || n.includes("browser"))
    return "web";
  if (n.includes("shell") || n.includes("bash") || n.includes("terminal") || n.includes("command"))
    return "command";
  if (n.includes("glob") || n.includes("grep") || n.includes("search")) return "search";
  if (
    n.includes("read") ||
    n.includes("write") ||
    n.includes("edit") ||
    n.includes("delete") ||
    n === "ls" ||
    n.includes("file")
  )
    return "file";
  if (n.includes("mcp")) return "mcp";
  return "other";
}

function argsTarget(args: Json): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const candidates = [args.path, args.file_path, args.command, args.pattern, args.query, args.url];
  const found = candidates.find(
    (v: unknown) => typeof v === "string" && (v as string).trim().length > 0,
  );
  // The agent's own tool input (INV-146): bounded for display, never masked.
  return found ? String(found).slice(0, 500) : undefined;
}

/** Bounded tool result text: the tool output the model saw and the only copy
 * Claudexor keeps, so it is never masked (INV-146). */
function resultSummary(result: Json): string {
  if (typeof result === "string") return result.trim().replace(/\s+/g, " ").slice(0, 1000);
  if (result && typeof result === "object") {
    const rec = result as Record<string, unknown>;
    const text =
      typeof rec["error"] === "string"
        ? rec["error"]
        : typeof rec["output"] === "string"
          ? rec["output"]
          : typeof rec["text"] === "string"
            ? rec["text"]
            : "";
    if (text) return text.trim().replace(/\s+/g, " ").slice(0, 1000);
    return JSON.stringify(result).slice(0, 300);
  }
  return "";
}

export type CursorEventParser = (obj: Json, sessionId: string) => HarnessEvent[] | null;

interface CursorParserState {
  pending: Map<string, ToolRef>;
  lastCompleteAssistant: string | null;
  /** Inline plan recovered from a `createPlan` call whose vendor `planUri`
   * came back empty — provenance-stamped so the final answer never pretends
   * to be a vendor-written plan file. Null when the URI was valid (unchanged
   * path) or no plan content exists anywhere (honest failure). */
  fallbackPlan: { text: string; source: string } | null;
  /** Model identity used to scope a classified vendor-limit signal
   * (applies_to_models): the run's REQUESTED model when the caller passed it,
   * else the init frame's observed model. Null = unknown → account-scoped. */
  scopeModel: string | null;
}

/**
 * Assemble a plan from the inline `createPlan` arguments (protobuf
 * `agent.v1.CreatePlanArgs`: `overview` + `plan` markdown + `todos[].content`).
 * cursor-agent stores the authored plan HERE and, in headless `-p` mode, often
 * returns an EMPTY `planUri` — so this inline content is the only faithful copy
 * of the plan the model actually produced.
 */
function cursorInlinePlanText(args: Json): string {
  if (!args || typeof args !== "object") return "";
  const parts: string[] = [];
  if (typeof args.overview === "string" && args.overview.trim()) parts.push(args.overview.trim());
  if (typeof args.plan === "string" && args.plan.trim()) parts.push(args.plan.trim());
  if (Array.isArray(args.todos)) {
    const items = args.todos
      .map((t: Json) =>
        t && typeof t === "object" && typeof t.content === "string" ? t.content.trim() : "",
      )
      .filter((s: string) => s.length > 0)
      .map((s: string) => `- ${s}`);
    if (items.length > 0) parts.push(items.join("\n"));
  }
  return parts.join("\n\n");
}

/**
 * Create a stateful per-run parser for Cursor `--output-format stream-json`.
 *
 * Cursor tool_call events are keyed by a variant object (e.g.
 * `tool_call.writeToolCall.args.path`) with `subtype: "started" | "completed"`
 * and a `call_id` — there is no flat `name` field. State maps call_id back to
 * the originating tool so completed events become self-describing
 * `tool_result`s instead of duplicate `tool_call`s.
 */
export function createCursorParser(
  credentialRoute?: CredentialRoute,
  credentialSource?: AuthSourceKind,
  planMode = false,
  nativePlanMode = planMode,
  requestedModel?: string | null,
): CursorEventParser {
  const state: CursorParserState = {
    pending: new Map(),
    lastCompleteAssistant: null,
    fallbackPlan: null,
    scopeModel: requestedModel ?? null,
  };
  return (obj: Json, sessionId: string): HarnessEvent[] | null => {
    const out = parseCursorEventStateful(
      obj,
      sessionId,
      state,
      credentialRoute,
      credentialSource,
      planMode,
      nativePlanMode,
    );
    if (out) {
      for (const ev of out) {
        // The auth route is fixed before spawn (mirrors harness-claude). Carry
        // it on EVERY event — the error/result branches included — so a typed
        // rate_limit can register a cooldown: QuotaRegistry.ingest keys the
        // reactive cooldown on the event's own credential_route, and a
        // route-less limit event would silently never cool anything down.
        if (credentialRoute) ev.credential_route = credentialRoute;
        if (credentialSource) ev.credential_source = credentialSource;
      }
    }
    return out;
  };
}

/** Stateless convenience used by tests; resolves results within one call only. */
export function parseCursorEvent(obj: Json, sessionId: string): HarnessEvent[] | null {
  return parseCursorEventStateful(obj, sessionId, {
    pending: new Map(),
    lastCompleteAssistant: null,
    fallbackPlan: null,
    scopeModel: null,
  });
}

function parseCursorEventStateful(
  obj: Json,
  sessionId: string,
  state: CursorParserState,
  credentialRoute?: CredentialRoute,
  credentialSource?: AuthSourceKind,
  planMode = false,
  nativePlanMode = planMode,
): HarnessEvent[] | null {
  const ts = nowIso();
  const type = obj?.type;

  if (type === "system" && obj.subtype === "init") {
    // Cursor surfaces the chat id under different keys across versions; expose
    // it uniformly so the engine can `--resume` this thread's native chat.
    const nativeId =
      typeof obj.chatId === "string"
        ? obj.chatId
        : typeof obj.chat_id === "string"
          ? obj.chat_id
          : typeof obj.session_id === "string"
            ? obj.session_id
            : undefined;
    // Vendor-limit scope fallback: when the caller passed no requested model,
    // the init frame's own model identity scopes a later classified limit.
    if (!state.scopeModel && typeof obj.model === "string" && obj.model) {
      state.scopeModel = obj.model;
    }
    return [
      {
        type: "started",
        session_id: sessionId,
        ts,
        observed_model: typeof obj.model === "string" ? obj.model : undefined,
        ...(credentialRoute ? { credential_route: credentialRoute } : {}),
        ...(credentialSource ? { credential_source: credentialSource } : {}),
        ...(nativeId ? { payload: { native_session_id: nativeId } } : {}),
      },
    ];
  }

  if (type === "user") {
    const content = obj.message?.content;
    const isPromptEcho =
      obj.message?.role === "user" &&
      Array.isArray(content) &&
      content.length > 0 &&
      content.every((block: Json) => block?.type === "text" && typeof block.text === "string") &&
      content.some((block: Json) => block.text.length > 0);
    if (isPromptEcho) return [];
  }

  if (type === "assistant") {
    // --stream-partial-output taxonomy (official docs, F2.5 W-C4): a new-text
    // DELTA has timestamp_ms and no model_call_id; a buffered duplicate has
    // BOTH (retained evidence only); the final flush has NEITHER
    // (the complete message — the plain no-flag shape).
    const hasTimestamp = obj.timestamp_ms !== undefined && obj.timestamp_ms !== null;
    const hasModelCall = typeof obj.model_call_id === "string" && obj.model_call_id;
    const buffered = Boolean(hasTimestamp && hasModelCall);
    const isDelta = hasTimestamp && !hasModelCall;
    const content: Json[] = obj.message?.content ?? [];
    const out: HarnessEvent[] = [];
    const completeText: string[] = [];
    for (const block of content) {
      if (typeof block?.text === "string" && block.text) {
        if (!isDelta && !buffered) completeText.push(block.text);
        out.push({
          type: "message",
          session_id: sessionId,
          ts,
          text: block.text,
          ...(isDelta ? { payload: { delta: true } } : {}),
          ...(buffered ? { payload: { buffered: true, model_call_id: obj.model_call_id } } : {}),
        });
      }
    }
    if (!isDelta && completeText.length > 0) state.lastCompleteAssistant = completeText.join("");
    return out;
  }

  if (type === "thinking" || type === "reasoning") {
    const text =
      typeof obj.text === "string" ? obj.text : typeof obj.message === "string" ? obj.message : "";
    return text
      ? [
          {
            type: "thinking",
            session_id: sessionId,
            ts,
            text,
            // The recorded native stream declares fragment semantics here;
            // complete/legacy thinking blocks are not deltas merely by type.
            ...(obj.subtype === "delta" ? { payload: { delta: true } } : {}),
          },
        ]
      : [];
  }

  if (type === "tool_call") {
    const toolCall = obj.tool_call ?? {};
    const variant = variantToolName(toolCall);
    const inner =
      toolCall[Object.keys(toolCall).find((k) => k.endsWith("ToolCall")) ?? variant] ?? toolCall;
    const args = inner?.args ?? obj.tool_call?.args ?? {};
    const callId =
      typeof obj.call_id === "string"
        ? obj.call_id
        : typeof obj.id === "string"
          ? obj.id
          : undefined;
    const subtype = String(obj.subtype ?? "started");

    if (subtype === "started" || subtype === "updated") {
      if (subtype === "updated") return [];
      const tool: ToolRef = {
        name: variant,
        kind: toolKindFor(variant),
        use_id: callId,
        target: argsTarget(args),
      };
      if (callId) state.pending.set(callId, tool);
      return [{ type: "tool_call", session_id: sessionId, ts, text: variant, tool }];
    }

    // completed / failed
    const origin = callId ? state.pending.get(callId) : undefined;
    if (callId) state.pending.delete(callId);
    const result = inner?.result ?? obj.result;
    // Denial/failure status plus, for the shell, the command outcome (#450).
    const { status, facts, payload } = classifyCursorToolResult(subtype, variant, result);
    const detail = resultSummary(result);
    const kind = origin?.kind ?? toolKindFor(variant);
    // Plan mode is READ-ONLY exploration: a read/search that misses (a probed
    // path that does not exist) is speculative negative information, never a
    // destructive failure, and the model routinely adapts and still produces a
    // plan. Surface it as a DISCLOSED benign thinking event (detail preserved)
    // instead of an `error` tool_result so the generic unrecovered-tool-error
    // rule cannot fail a read-only planning pass over an exploration miss
    // (mirrors claude's benign turn-control translation, CLAUDEXOR_BIBLE §5).
    // Non-read-only kinds (command/web/mcp) still surface as real errors.
    if (planMode && status === "error" && (kind === "file" || kind === "search")) {
      const target = origin?.target ?? argsTarget(args);
      return [
        {
          type: "thinking",
          session_id: sessionId,
          ts,
          text: `plan-mode read-only probe unresolved (${origin?.name ?? variant}${
            target ? `: ${target}` : ""
          })${detail ? `: ${detail}` : ""}`,
          payload: {
            plan_probe_miss: true,
            tool: origin?.name ?? variant,
            ...(callId ? { tool_use_id: callId } : {}),
          },
        },
      ];
    }
    const tool: ToolRef = {
      name: origin?.name ?? variant,
      kind,
      use_id: callId,
      target: origin?.target ?? argsTarget(args),
      status,
      error_summary: status === "error" ? detail || "tool call failed" : undefined,
      content_summary: detail || undefined,
      ...facts,
    };
    const outcomeLabel = commandOutcomeLabel(tool.command_outcome);
    const events: HarnessEvent[] = [
      {
        type: "tool_result",
        session_id: sessionId,
        ts,
        text:
          status !== "ok"
            ? `tool_result: ${status}${detail ? `: ${detail}` : ""}`
            : `tool_result${outcomeLabel ? `: ${outcomeLabel}` : ""}`,
        tool,
        ...(payload ? { payload } : {}),
      },
    ];
    // cursor's `createPlan` is the plan-mode DELIVERABLE tool. Its authored plan
    // lives in the call ARGS; the `planUri` in the result points at a vendor
    // file cursor-agent frequently leaves EMPTY in headless `-p` mode. When the
    // URI is empty/missing, recover the plan from the inline args (or, last
    // resort, the assembled assistant text) so a completed plan run is not
    // discarded — with stamped provenance so the answer never masquerades as a
    // vendor-written plan file. A valid URI is left unchanged.
    if (nativePlanMode && variant === "createPlan" && status === "ok") {
      const planUri =
        result && typeof result === "object" && typeof result.planUri === "string"
          ? result.planUri.trim()
          : "";
      if (!planUri) {
        const inline = cursorInlinePlanText(args);
        const text = inline || (state.lastCompleteAssistant?.trim() ?? "");
        if (text.trim()) {
          state.fallbackPlan = {
            text,
            source: inline ? "cursor_plan_inline_args" : "cursor_plan_assistant_fallback",
          };
          events.push({
            type: "thinking",
            session_id: sessionId,
            ts,
            text: `cursor returned an empty plan URI; recovering the plan from the inline createPlan ${
              inline ? "content" : "assistant narration"
            }.`,
            payload: { plan_uri_fallback: true, plan_source: state.fallbackPlan.source },
          });
        }
      }
    }
    if (status === "ok" && FILE_WRITE_VARIANTS.has(tool.name)) {
      const path = args?.path ?? args?.file_path;
      events.push({
        type: "file_change",
        session_id: sessionId,
        ts,
        tool: { name: tool.name, kind: "file", use_id: callId },
        payload: { path, tool: tool.name },
      });
    }
    return events;
  }

  if (type === "result") {
    const out: HarnessEvent[] = [];
    const nativeUsage =
      obj.usage && typeof obj.usage === "object" ? (obj.usage as Record<string, unknown>) : {};
    const usage: NonNullable<HarnessEvent["usage"]> = {};
    if (typeof nativeUsage.inputTokens === "number") {
      usage.input_tokens = nativeUsage.inputTokens;
    }
    if (typeof nativeUsage.outputTokens === "number") {
      usage.output_tokens = nativeUsage.outputTokens;
    }
    const cachedTokens = [nativeUsage.cacheReadTokens, nativeUsage.cacheWriteTokens].filter(
      (value): value is number => typeof value === "number",
    );
    if (cachedTokens.length > 0) {
      usage.cached_input_tokens = cachedTokens.reduce((sum, value) => sum + value, 0);
    }
    if (typeof obj.total_cost_usd === "number") {
      usage.cost_usd = obj.total_cost_usd;
    }
    if (Object.keys(usage).length > 0) {
      // The headless result accumulator subtracts cache reads/writes from
      // inputTokens (Cursor 2026.08.11, src/headless.ts turnEnded).
      const input =
        InputTokenUsage.shape.total_tokens.safeParse(nativeUsage.inputTokens).data ?? null;
      const read =
        InputTokenUsage.shape.cache_read_tokens.safeParse(nativeUsage.cacheReadTokens).data ?? null;
      const write =
        InputTokenUsage.shape.cache_write_tokens.safeParse(nativeUsage.cacheWriteTokens).data ??
        null;
      usage.input_token_usage = {
        total_tokens:
          input !== null && read !== null && write !== null ? input + read + write : null,
        cache_read_tokens: read,
        cache_write_tokens: write,
      };
      out.push({
        type: "usage",
        session_id: sessionId,
        ts,
        usage,
      });
    }
    // Finality only for a SUCCESS result (review sol #1): an is_error / non-
    // success result is aborted/partial text, never the authoritative answer.
    const successResult = obj.is_error !== true && (!obj.subtype || obj.subtype === "success");
    // A recovered inline plan (empty vendor planUri) is the faithful deliverable
    // and WINS over the trailing narration cursor emits as its `result`, which
    // is only a preamble ("I'll inspect ...") — never the plan itself.
    const planFallback = successResult ? state.fallbackPlan : null;
    const finalText = planFallback?.text.trim()
      ? planFallback.text
      : successResult && state.lastCompleteAssistant?.trim()
        ? state.lastCompleteAssistant
        : typeof obj.result === "string"
          ? obj.result
          : null;
    if (finalText?.trim()) {
      // A3 deliverable hygiene: a NON-SUCCESS result's prose is failure
      // evidence, not answer material. It rides a `status` event (visible in
      // the timeline, classified onto the terminal error below) and never a
      // `message` the answer assembly could adopt as answer.md.
      out.push(
        successResult
          ? {
              type: "message",
              session_id: sessionId,
              ts,
              text: finalText,
              final: true,
              payload: {
                final_source: planFallback
                  ? planFallback.source
                  : state.lastCompleteAssistant
                    ? "assistant_message"
                    : "result",
                ...(planFallback ? { plan_recovered: true } : {}),
              },
            }
          : {
              type: "status",
              session_id: sessionId,
              ts,
              text: finalText,
              payload: { non_success_result: true },
            },
      );
    }
    if (obj.subtype && obj.subtype !== "success") {
      const failure: HarnessEvent = {
        type: "error",
        session_id: sessionId,
        ts,
        error: `result subtype: ${obj.subtype}`,
      };
      // A failed result's vendor prose rides obj.result (surfaced as a status
      // event above, never a message); classify it onto THIS terminal error so a
      // vendor limit stays a TYPED rate_limit signal. This branch matters
      // because once the stream emitted any error, the run loop skips the
      // stderr-failure callback (core/runloop.ts sawError gate).
      applyCursorVendorLimit(
        failure,
        `${obj.subtype} ${typeof obj.result === "string" ? obj.result : ""}`,
        state.scopeModel,
      );
      out.push(failure);
    }
    return out;
  }

  if (type === "error") {
    const message = String(obj.message ?? obj.error ?? "cursor error");
    const failure: HarnessEvent = { type: "error", session_id: sessionId, ts, error: message };
    // Same typed vendor-limit classification as the stderr path: an `error`
    // frame sets the run loop's sawError gate, so this branch is the only
    // chance to type a limit that arrives as a stream error.
    applyCursorVendorLimit(failure, message, state.scopeModel);
    return [failure];
  }

  return null;
}

/**
 * Translate cursor-agent's stderr-only vendor-limit fatal (the live incident
 * shape: `ActionRequiredError: You've hit your usage limit …` + exit 1) into
 * the same typed `rate_limit` error event as stream errors. The run loop calls
 * this only when the stream itself emitted no error (sawError gate). Returns
 * null for unclassified stderr so the generic exit-code disclosure stays
 * authoritative.
 */
export function parseCursorStderrFailure(
  message: string,
  sessionId: string,
  requestedModel?: string | null,
  profile?: { profile_id: string } | null,
): HarnessEvent | null {
  const event: HarnessEvent = {
    type: "error",
    session_id: sessionId,
    ts: nowIso(),
    error: message,
  };
  if (!applyCursorVendorLimit(event, message, requestedModel ?? null)) return null;
  if (profile) event.credential_profile_id = profile.profile_id;
  return event;
}

function isCursorModelId(id: string): boolean {
  if (!id) return false;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(id)) return false;
  for (const ch of id) {
    if (
      (ch >= "a" && ch <= "z") ||
      (ch >= "A" && ch <= "Z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "-" ||
      ch === "." ||
      ch === "_" ||
      ch === "/" ||
      ch === ":"
    )
      continue;
    return false;
  }
  return true;
}

export function parseCursorModelList(text: string): HarnessModel[] {
  const out: HarnessModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.replaceAll("\r", "").split("\n")) {
    const line = rawLine.trim();
    if (!line || line === "Available models" || line.startsWith("Tip:")) continue;
    const sep = line.indexOf(" - ");
    if (sep <= 0) continue;
    const id = line.slice(0, sep).trim();
    const label = line.slice(sep + 3).trim() || null;
    if (!isCursorModelId(id) || seen.has(id)) continue;
    seen.add(id);
    // routes: null = unannotated (route scoping is a manifest concept, W11).
    out.push({ id, label, context_window: null, routes: null });
  }
  return out;
}
