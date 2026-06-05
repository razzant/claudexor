import type { HarnessEvent } from "@claudex/schema";
import { nowIso } from "@claudex/util";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const EDIT_TOOLS = /edit|write|apply|create/i;

/** Map a Cursor `--output-format stream-json` object to normalized events. */
export function parseCursorEvent(obj: Json, sessionId: string): HarnessEvent[] {
  const ts = nowIso();
  const type = obj?.type;

  if (type === "system" && obj.subtype === "init") {
    return [
      { type: "started", session_id: sessionId, ts, observed_model: typeof obj.model === "string" ? obj.model : undefined },
    ];
  }

  if (type === "assistant") {
    const content: Json[] = obj.message?.content ?? [];
    const out: HarnessEvent[] = [];
    for (const block of content) {
      if (typeof block?.text === "string" && block.text) {
        out.push({ type: "message", session_id: sessionId, ts, text: block.text });
      }
    }
    return out;
  }

  if (type === "tool_call") {
    const name = String(obj.tool_call?.name ?? obj.subtype ?? "tool");
    if (EDIT_TOOLS.test(name)) {
      const path = obj.tool_call?.args?.path ?? obj.tool_call?.args?.file_path;
      return [{ type: "file_change", session_id: sessionId, ts, payload: { path, tool: name } }];
    }
    return [{ type: "tool_call", session_id: sessionId, ts, text: name }];
  }

  if (type === "result") {
    const out: HarnessEvent[] = [];
    if (typeof obj.total_cost_usd === "number") {
      out.push({ type: "usage", session_id: sessionId, ts, usage: { cost_usd: obj.total_cost_usd } });
    }
    if (obj.subtype && obj.subtype !== "success") {
      out.push({ type: "error", session_id: sessionId, ts, error: `result subtype: ${obj.subtype}` });
    }
    return out;
  }

  if (type === "error") {
    return [{ type: "error", session_id: sessionId, ts, error: String(obj.message ?? obj.error ?? "cursor error") }];
  }

  return [];
}
