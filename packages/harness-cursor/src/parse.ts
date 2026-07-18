import type {
  AuthSourceKind,
  CredentialRoute,
  HarnessEvent,
  HarnessModel,
  ToolKind,
  ToolRef,
} from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";

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
  return found ? redactSecrets(String(found)).slice(0, 500) : undefined;
}

function resultSummary(result: Json): string {
  if (typeof result === "string")
    return redactSecrets(result).trim().replace(/\s+/g, " ").slice(0, 1000);
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
    if (text) return redactSecrets(text).trim().replace(/\s+/g, " ").slice(0, 1000);
    return redactSecrets(JSON.stringify(result)).slice(0, 300);
  }
  return "";
}

export type CursorEventParser = (obj: Json, sessionId: string) => HarnessEvent[] | null;

interface CursorParserState {
  pending: Map<string, ToolRef>;
  lastCompleteAssistant: string | null;
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
): CursorEventParser {
  const state: CursorParserState = { pending: new Map(), lastCompleteAssistant: null };
  return (obj: Json, sessionId: string): HarnessEvent[] | null =>
    parseCursorEventStateful(obj, sessionId, state, credentialRoute, credentialSource);
}

/** Stateless convenience used by tests; resolves results within one call only. */
export function parseCursorEvent(obj: Json, sessionId: string): HarnessEvent[] | null {
  return parseCursorEventStateful(obj, sessionId, {
    pending: new Map(),
    lastCompleteAssistant: null,
  });
}

function parseCursorEventStateful(
  obj: Json,
  sessionId: string,
  state: CursorParserState,
  credentialRoute?: CredentialRoute,
  credentialSource?: AuthSourceKind,
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

  if (type === "assistant") {
    // --stream-partial-output taxonomy (official docs, F2.5 W-C4): a new-text
    // DELTA has timestamp_ms and no model_call_id; a buffered duplicate has
    // BOTH (skip — its text already streamed); the final flush has NEITHER
    // (the complete message — the plain no-flag shape).
    const hasTimestamp = obj.timestamp_ms !== undefined && obj.timestamp_ms !== null;
    const hasModelCall = typeof obj.model_call_id === "string" && obj.model_call_id;
    if (hasTimestamp && hasModelCall) return [];
    const isDelta = hasTimestamp && !hasModelCall;
    const content: Json[] = obj.message?.content ?? [];
    const out: HarnessEvent[] = [];
    const completeText: string[] = [];
    for (const block of content) {
      if (typeof block?.text === "string" && block.text) {
        if (!isDelta) completeText.push(block.text);
        out.push({
          type: "message",
          session_id: sessionId,
          ts,
          text: block.text,
          ...(isDelta ? { payload: { delta: true } } : {}),
        });
      }
    }
    if (!isDelta && completeText.length > 0) state.lastCompleteAssistant = completeText.join("");
    return out;
  }

  if (type === "thinking" || type === "reasoning") {
    const text =
      typeof obj.text === "string" ? obj.text : typeof obj.message === "string" ? obj.message : "";
    return text ? [{ type: "thinking", session_id: sessionId, ts, text }] : [];
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
    const rejected = Boolean(
      result && typeof result === "object" && "rejected" in result && result.rejected,
    );
    const nativeFailure =
      result &&
      typeof result === "object" &&
      "failure" in result &&
      result.failure &&
      typeof result.failure === "object" &&
      ("exitCode" in result.failure || "error" in result.failure);
    const failed =
      subtype === "failed" ||
      nativeFailure ||
      (result && typeof result === "object" && "error" in result && result.error);
    const detail = resultSummary(result);
    const status: ToolRef["status"] = rejected ? "denied" : failed ? "error" : "ok";
    const tool: ToolRef = {
      name: origin?.name ?? variant,
      kind: origin?.kind ?? toolKindFor(variant),
      use_id: callId,
      target: origin?.target ?? argsTarget(args),
      status,
      error_summary: status === "error" ? detail || "tool call failed" : undefined,
      content_summary: detail || undefined,
    };
    const events: HarnessEvent[] = [
      {
        type: "tool_result",
        session_id: sessionId,
        ts,
        text:
          status !== "ok" ? `tool_result: ${status}${detail ? `: ${detail}` : ""}` : "tool_result",
        tool,
      },
    ];
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
    if (typeof obj.total_cost_usd === "number") {
      out.push({
        type: "usage",
        session_id: sessionId,
        ts,
        usage: { cost_usd: obj.total_cost_usd },
      });
    }
    // Finality only for a SUCCESS result (review sol #1): an is_error / non-
    // success result is aborted/partial text, never the authoritative answer.
    const successResult = obj.is_error !== true && (!obj.subtype || obj.subtype === "success");
    const finalText =
      successResult && state.lastCompleteAssistant?.trim()
        ? state.lastCompleteAssistant
        : typeof obj.result === "string"
          ? obj.result
          : null;
    if (finalText?.trim()) {
      out.push({
        type: "message",
        session_id: sessionId,
        ts,
        text: finalText,
        ...(successResult
          ? {
              final: true,
              payload: {
                final_source: state.lastCompleteAssistant ? "assistant_message" : "result",
              },
            }
          : {}),
      });
    }
    if (obj.subtype && obj.subtype !== "success") {
      out.push({
        type: "error",
        session_id: sessionId,
        ts,
        error: `result subtype: ${obj.subtype}`,
      });
    }
    return out;
  }

  if (type === "error") {
    return [
      {
        type: "error",
        session_id: sessionId,
        ts,
        error: String(obj.message ?? obj.error ?? "cursor error"),
      },
    ];
  }

  return null;
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
