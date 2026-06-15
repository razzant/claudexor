import type { HarnessEvent, ToolKind, ToolRef } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

function toolKindFor(name: string): ToolKind {
  const n = name.toLowerCase();
  if (n.includes("webfetch") || n.includes("websearch") || n === "fetch") return "web";
  if (n.includes("bash") || n.includes("shell") || n.includes("command")) return "command";
  if (n.includes("glob") || n.includes("grep") || n.includes("search")) return "search";
  if (n.includes("edit") || n.includes("write") || n.includes("patch") || n.includes("read") || n.includes("file") || n === "ls") return "file";
  if (n.includes("mcp")) return "mcp";
  return "other";
}

const EDIT_TOOLS = /edit|write|patch/i;

/**
 * Map an OpenCode `run --format json` ND-JSON event to normalized events
 * (best-effort across versions; validated against recorded fixtures).
 * Returns `null` for unrecognized shapes so the run loop can COUNT drops
 * instead of silently degrading to an empty stream.
 */
export function parseOpenCodeEvent(obj: Json, sessionId: string): HarnessEvent[] | null {
  const ts = nowIso();
  const type = String(obj?.type ?? "");

  if (type === "error") {
    return [{ type: "error", session_id: sessionId, ts, error: String(obj.error ?? obj.message ?? "opencode error") }];
  }
  if (type === "session" || type === "start" || type === "init") {
    // Surface the native session id (ses_...) so the engine can resume this thread.
    const nativeId =
      typeof obj.sessionID === "string" ? obj.sessionID : typeof obj.session_id === "string" ? obj.session_id : typeof obj.session?.id === "string" ? obj.session.id : undefined;
    return [{
      type: "started",
      session_id: sessionId,
      ts,
      observed_model: typeof obj.model === "string" ? obj.model : undefined,
      ...(nativeId ? { payload: { native_session_id: nativeId } } : {}),
    }];
  }

  // Text parts can arrive under several shapes across versions.
  const text = obj.text ?? obj.part?.text ?? obj.message?.text ?? obj.delta?.text;
  if ((type === "message" || type === "text" || type === "assistant" || type === "part" || type.startsWith("message.part")) && typeof text === "string" && text) {
    return [{ type: "message", session_id: sessionId, ts, text }];
  }

  // Tool lifecycle: flat `tool`/`tool_call` events and part-based shapes with a state.
  const partTool = obj.part?.tool ?? obj.part?.name;
  if (type === "tool" || type === "tool_call" || (typeof partTool === "string" && partTool)) {
    const name = String(obj.tool ?? obj.name ?? partTool ?? "tool");
    const status = String(obj.status ?? obj.part?.state?.status ?? obj.state?.status ?? "");
    const target = boundedTarget(obj.path ?? obj.args?.path ?? obj.part?.path ?? obj.args?.command ?? obj.part?.state?.input?.command);
    const useId = stringOrUndef(obj.id ?? obj.call_id ?? obj.part?.id);
    const tool: ToolRef = { name, kind: toolKindFor(name), use_id: useId, target };

    if (status === "error" || status === "failed") {
      const detail = summarize(obj.error ?? obj.part?.state?.error ?? obj.part?.state?.output);
      return [
        {
          type: "tool_result",
          session_id: sessionId,
          ts,
          text: `tool_result: error${detail ? `: ${detail}` : ""}`,
          tool: { ...tool, status: "error", error_summary: detail || "tool call failed" },
        },
      ];
    }
    if (status === "completed" || status === "done" || status === "success") {
      const detail = summarize(obj.part?.state?.output ?? obj.output);
      const events: HarnessEvent[] = [
        {
          type: "tool_result",
          session_id: sessionId,
          ts,
          text: "tool_result",
          tool: { ...tool, status: "ok", content_summary: detail || undefined },
        },
      ];
      if (EDIT_TOOLS.test(name)) {
        const path = obj.path ?? obj.args?.path ?? obj.part?.path ?? obj.part?.state?.input?.filePath;
        events.push({ type: "file_change", session_id: sessionId, ts, tool: { name, kind: "file", use_id: useId }, payload: { path, tool: name } });
      }
      return events;
    }
    // Pending/running (or legacy shape without status): a tool call start.
    if (EDIT_TOOLS.test(name) && !status) {
      const path = obj.path ?? obj.args?.path ?? obj.part?.path;
      return [{ type: "file_change", session_id: sessionId, ts, tool, payload: { path, tool: name } }];
    }
    return [{ type: "tool_call", session_id: sessionId, ts, text: name, tool }];
  }

  if (type === "usage" || type === "finish" || typeof obj.cost === "number") {
    // Token counts arrive under two recorded shapes across opencode versions:
    //  - flat:   { tokens: { input, output, cache } }
    //  - nested: { usage: { input_tokens, output_tokens, cache_read_input_tokens } }
    //    (the `finish` event uses this nested form). Read both so a nested-shape
    //    finish does not silently drop its token counts.
    const tokens = obj.tokens ?? {};
    const nested = obj.usage ?? {};
    const usage: NonNullable<HarnessEvent["usage"]> = {};
    if (typeof obj.cost === "number") usage.cost_usd = obj.cost;
    const input = firstNumber(tokens.input, nested.input_tokens);
    const output = firstNumber(tokens.output, nested.output_tokens);
    const cache = firstNumber(tokens.cache, nested.cache_read_input_tokens, nested.cache);
    if (input !== undefined) usage.input_tokens = input;
    if (output !== undefined) usage.output_tokens = output;
    if (cache !== undefined) usage.cached_input_tokens = cache;
    if (Object.keys(usage).length === 0) return [];
    return [{ type: "usage", session_id: sessionId, ts, usage }];
  }

  return null;
}

function summarize(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  return redactSecrets(value).trim().replace(/\s+/g, " ").slice(0, 1000);
}

function boundedTarget(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return redactSecrets(value).slice(0, 500);
}

function stringOrUndef(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** First numeric value among the candidates (lets one usage branch read multiple recorded shapes). */
function firstNumber(...values: unknown[]): number | undefined {
  for (const v of values) if (typeof v === "number") return v;
  return undefined;
}
