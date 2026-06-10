import type { HarnessEvent, ToolRef } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

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
    return [{ type: "started", session_id: sessionId, ts, payload: { thread_id: obj.thread_id } }];
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
    return [{ type: "error", session_id: sessionId, ts, error: obj.error?.message ?? "turn failed" }];
  }
  if (type === "turn.started") {
    return [{ type: "thinking", session_id: sessionId, ts, text: "turn started", payload: { turn_id: obj.turn_id } }];
  }
  if (type === "error") {
    return [
      {
        type: "error",
        session_id: sessionId,
        ts,
        error: typeof obj.message === "string" ? obj.message : (obj.error?.message ?? "codex error"),
        payload: obj,
      },
    ];
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
            text: String(item.query ?? "web search"),
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
      default:
        return null;
    }
  }
  return null;
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
    target: boundedTarget(item.query),
  };
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
