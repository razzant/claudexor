import type { HarnessEvent } from "@claudexor/schema";
import { nowIso } from "@claudexor/util";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const EDIT_TOOLS = /edit|write|patch/i;

/** Map an OpenCode `run --format json` event to normalized events (best-effort). */
export function parseOpenCodeEvent(obj: Json, sessionId: string): HarnessEvent[] {
  const ts = nowIso();
  const type = String(obj?.type ?? "");

  if (type === "error") {
    return [{ type: "error", session_id: sessionId, ts, error: String(obj.error ?? obj.message ?? "opencode error") }];
  }
  if (type === "session" || type === "start" || type === "init") {
    return [{ type: "started", session_id: sessionId, ts, observed_model: typeof obj.model === "string" ? obj.model : undefined }];
  }

  // Text parts can arrive under several shapes across versions.
  const text = obj.text ?? obj.part?.text ?? obj.message?.text ?? obj.delta?.text;
  if ((type === "message" || type === "text" || type === "assistant" || type === "part") && typeof text === "string" && text) {
    return [{ type: "message", session_id: sessionId, ts, text }];
  }

  if (type === "tool" || type === "tool_call") {
    const name = String(obj.tool ?? obj.name ?? obj.part?.tool ?? "tool");
    if (EDIT_TOOLS.test(name)) {
      const path = obj.path ?? obj.args?.path ?? obj.part?.path;
      return [{ type: "file_change", session_id: sessionId, ts, payload: { path, tool: name } }];
    }
    return [{ type: "tool_call", session_id: sessionId, ts, text: name }];
  }

  if (type === "usage" || typeof obj.cost === "number") {
    return [{ type: "usage", session_id: sessionId, ts, usage: { cost_usd: typeof obj.cost === "number" ? obj.cost : undefined } }];
  }

  return [];
}
