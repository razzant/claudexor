import type { HarnessEvent } from "@claudex/schema";
import { nowIso } from "@claudex/util";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/**
 * Map a single Codex `exec --json` JSONL object to a normalized HarnessEvent.
 * Returns null for events we intentionally ignore (e.g. item.started/updated).
 * Codex event names: thread.*, turn.*, item.started|updated|completed, error.
 */
export function parseCodexEvent(obj: Json, sessionId: string): HarnessEvent | null {
  const ts = nowIso();
  const type = obj?.type;

  if (type === "thread.started") {
    return { type: "started", session_id: sessionId, ts, payload: { thread_id: obj.thread_id } };
  }
  if (type === "turn.completed") {
    const u = obj.usage ?? {};
    return {
      type: "usage",
      session_id: sessionId,
      ts,
      usage: {
        input_tokens: numberOrUndef(u.input_tokens),
        output_tokens: numberOrUndef(u.output_tokens),
        cached_input_tokens: numberOrUndef(u.cached_input_tokens),
      },
    };
  }
  if (type === "turn.failed") {
    return { type: "error", session_id: sessionId, ts, error: obj.error?.message ?? "turn failed" };
  }
  if (type === "error") {
    return {
      type: "error",
      session_id: sessionId,
      ts,
      error: typeof obj.message === "string" ? obj.message : (obj.error?.message ?? "codex error"),
      payload: obj,
    };
  }
  if (type === "item.completed") {
    const item = obj.item ?? {};
    switch (item.type) {
      case "agent_message":
        return { type: "message", session_id: sessionId, ts, text: String(item.text ?? "") };
      case "reasoning":
        return { type: "thinking", session_id: sessionId, ts, text: String(item.text ?? "") };
      case "file_change": {
        const path =
          item.path ?? (Array.isArray(item.changes) ? item.changes[0]?.path : undefined);
        return { type: "file_change", session_id: sessionId, ts, payload: { path, item } };
      }
      case "command_execution":
        return {
          type: "tool_call",
          session_id: sessionId,
          ts,
          text: String(item.command ?? ""),
          payload: { exit_code: item.exit_code, status: item.status },
        };
      case "mcp_tool_call":
        return {
          type: "tool_call",
          session_id: sessionId,
          ts,
          payload: { server: item.server, tool: item.tool, status: item.status },
        };
      default:
        return null;
    }
  }
  return null;
}

function numberOrUndef(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
