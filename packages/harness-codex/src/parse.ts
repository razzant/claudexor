import type { HarnessEvent, ToolRef } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

// Native codex error phrasing that indicates a rate-limit / quota condition.
// This regex lives in the ADAPTER (native-output translation is its job), not
// in the budget/governance layer.
const CODEX_RATE_LIMIT_RE =
  /rate.?limit|usage.?limit|usagelimitexceeded|too many requests|quota[ _-]?(?:exceeded|exhausted|reached)|(?:http|status|code)[ :/]?429|429 too many/i;

/**
 * Map a single Codex `exec --json` JSONL object to normalized HarnessEvents.
 * Codex event names: thread.*, turn.*, item.started|updated|completed, error.
 *
 * Returns `null` for unrecognized shapes (counted as dropped by the run loop)
 * and `[]` for recognized-but-intentionally-skipped events (e.g. item.updated
 * progress ticks that would double-register a tool call).
 */
export function parseCodexEvent(obj: Json, sessionId: string): HarnessEvent[] | null {
  const ts = nowIso();
  const type = obj?.type;

  if (type === "thread.started") {
    // Expose the native session id uniformly so the engine can record it for resume.
    return [{ type: "started", session_id: sessionId, ts, payload: { thread_id: obj.thread_id, native_session_id: obj.thread_id } }];
  }
  if (type === "turn.completed") {
    const u = obj.usage ?? {};
    return [
      {
        type: "usage",
        session_id: sessionId,
        ts,
        usage: {
          input_tokens: numberOrUndef(u.input_tokens),
          output_tokens: numberOrUndef(u.output_tokens),
          cached_input_tokens: numberOrUndef(u.cached_input_tokens),
        },
      },
    ];
  }
  if (type === "turn.failed") {
    const message = obj.error?.message ?? "turn failed";
    const ev: HarnessEvent = { type: "error", session_id: sessionId, ts, error: message, payload: obj };
    applyCodexRateLimit(ev, message, obj.error?.resets_at ?? obj.resets_at);
    return [ev];
  }
  if (type === "turn.started") {
    return [{ type: "thinking", session_id: sessionId, ts, text: "turn started", payload: { turn_id: obj.turn_id } }];
  }
  if (type === "error") {
    const message = typeof obj.message === "string" ? obj.message : (obj.error?.message ?? "codex error");
    const ev: HarnessEvent = { type: "error", session_id: sessionId, ts, error: message, payload: obj };
    applyCodexRateLimit(ev, message, obj.resets_at ?? obj.error?.resets_at);
    return [ev];
  }
  if (type === "item.started" || type === "item.updated") {
    const item = obj.item ?? {};
    const updated = type === "item.updated";
    switch (item.type) {
      case "reasoning":
        return [
          { type: "thinking", session_id: sessionId, ts, text: String(item.text ?? item.summary ?? "reasoning"), payload: { status: type, item_id: item.id } },
        ];
      case "command_execution":
        if (updated) return [];
        return [
          {
            type: "tool_call",
            session_id: sessionId,
            ts,
            text: String(item.command ?? "command execution"),
            tool: commandToolRef(item),
            payload: { status: item.status ?? type, item_id: item.id },
          },
        ];
      case "mcp_tool_call":
        if (updated) return [];
        return [
          {
            type: "tool_call",
            session_id: sessionId,
            ts,
            text: String(item.tool ?? item.server ?? "mcp tool"),
            tool: mcpToolRef(item),
            payload: { server: item.server, tool: item.tool, status: item.status ?? type, item_id: item.id },
          },
        ];
      case "web_search":
        if (updated) return [];
        return [
          {
            type: "tool_call",
            session_id: sessionId,
            ts,
            text: webSearchQuery(item) ?? "web search",
            tool: webSearchToolRef(item),
            payload: { status: item.status ?? type, item_id: item.id },
          },
        ];
      case "file_change":
        return [{ type: "file_change", session_id: sessionId, ts, tool: fileToolRef(item), payload: { path: item.path, status: item.status ?? type, item_id: item.id } }];
      default:
        return null;
    }
  }
  if (type === "item.completed") {
    const item = obj.item ?? {};
    switch (item.type) {
      case "agent_message":
        return [{ type: "message", session_id: sessionId, ts, text: String(item.text ?? "") }];
      case "reasoning":
        return [{ type: "thinking", session_id: sessionId, ts, text: String(item.text ?? "") }];
      case "file_change": {
        const path = item.path ?? (Array.isArray(item.changes) ? item.changes[0]?.path : undefined);
        return [{ type: "file_change", session_id: sessionId, ts, tool: fileToolRef(item), payload: { path, item } }];
      }
      case "command_execution": {
        const failed = item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0);
        const detail = summarizeCodexOutput(item.aggregated_output ?? item.output);
        return [
          {
            type: "tool_result",
            session_id: sessionId,
            ts,
            text: failed ? `tool_result: error${detail ? `: ${detail}` : ""}` : "tool_result",
            tool: {
              ...commandToolRef(item),
              status: failed ? "error" : "ok",
              exit_code: numberOrUndef(item.exit_code),
              error_summary: failed ? detail || commandFailureSummary(item) : undefined,
              content_summary: detail || undefined,
            },
            payload: { exit_code: item.exit_code, status: item.status, item_id: item.id },
          },
        ];
      }
      case "mcp_tool_call": {
        const failed = item.status === "failed";
        return [
          {
            type: "tool_result",
            session_id: sessionId,
            ts,
            text: failed ? "tool_result: error" : "tool_result",
            tool: {
              ...mcpToolRef(item),
              status: failed ? "error" : "ok",
              error_summary: failed ? summarizeCodexOutput(item.error ?? item.result) || "mcp tool call failed" : undefined,
            },
            payload: { server: item.server, tool: item.tool, status: item.status, item_id: item.id },
          },
        ];
      }
      case "web_search": {
        const failed = item.status === "failed";
        return [
          {
            type: "tool_result",
            session_id: sessionId,
            ts,
            text: failed ? "tool_result: error" : "tool_result",
            tool: {
              ...webSearchToolRef(item),
              status: failed ? "error" : "ok",
              error_summary: failed ? summarizeCodexOutput(item.error) || "web search failed" : undefined,
            },
            payload: { status: item.status, item_id: item.id },
          },
        ];
      }
      case "todo_list": {
        // Codex's structured plan (re-emitted on revision; last wins). Surface it
        // as a message so the plan is visible in the timeline and available to the
        // relay's plan-extraction. Verified shape: item.items[].{text,completed}.
        const items = Array.isArray(item.items) ? item.items : [];
        const lines = items.map((t: { text?: string; completed?: boolean }) => `${t.completed ? "[x]" : "[ ]"} ${String(t.text ?? "")}`);
        return [{ type: "message", session_id: sessionId, ts, text: lines.length ? `Plan:\n${lines.join("\n")}` : "Plan updated" }];
      }
      default:
        return null;
    }
  }
  return null;
}

/**
 * Set the TYPED `rate_limit` signal on an error event when codex's native error
 * text indicates a 429 / quota / overload. Fires for BOTH `error` and
 * `turn.failed` (the two ways codex surfaces a rate limit). The budget layer
 * reads `ev.rate_limit` instead of regex-matching prose; this adapter-local
 * recognition of its OWN CLI's native error phrasing is the allowed knowledge.
 */
function applyCodexRateLimit(ev: HarnessEvent, message: string, resetsAt: unknown): void {
  if (!CODEX_RATE_LIMIT_RE.test(message)) return;
  ev.rate_limit = {
    resets_at: typeof resetsAt === "string" ? resetsAt : null,
    retry_delay_ms: null,
  };
}

function commandToolRef(item: Json): ToolRef {
  return {
    name: "command",
    kind: "command",
    use_id: stringOrUndef(item.id),
    target: boundedTarget(item.command),
  };
}

function mcpToolRef(item: Json): ToolRef {
  return {
    name: String(item.tool ?? item.server ?? "mcp"),
    kind: "mcp",
    use_id: stringOrUndef(item.id),
    target: boundedTarget(item.tool ? `${item.server ?? "mcp"}:${item.tool}` : item.server),
  };
}

function webSearchToolRef(item: Json): ToolRef {
  return {
    name: "web_search",
    kind: "web",
    use_id: stringOrUndef(item.id),
    target: boundedTarget(webSearchQuery(item)),
  };
}

/**
 * Resolve a codex web_search query. On `item.started` the top-level `query` is
 * often EMPTY ("") while the real query lives in `action.query` (or the first
 * of `action.queries[]`) — live-verified on codex 0.137. Prefer a non-empty
 * top-level query, then fall back to the action shape so a started web search is
 * never surfaced as a query-less "web search".
 */
function webSearchQuery(item: Json): string | undefined {
  const direct = stringOrUndef(item.query);
  if (direct) return direct;
  const action = item.action;
  if (action && typeof action === "object") {
    const fromAction = stringOrUndef(action.query);
    if (fromAction) return fromAction;
    if (Array.isArray(action.queries)) {
      const first = action.queries.find((q: unknown) => typeof q === "string" && q.trim());
      if (first) return first as string;
    }
  }
  return undefined;
}

function fileToolRef(item: Json): ToolRef {
  return {
    name: "apply_patch",
    kind: "file",
    use_id: stringOrUndef(item.id),
    target: boundedTarget(item.path),
  };
}

function commandFailureSummary(item: Json): string {
  return typeof item.exit_code === "number" ? `command exited with code ${item.exit_code}` : "command execution failed";
}

function summarizeCodexOutput(value: unknown): string {
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

function numberOrUndef(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
