import type { HarnessEvent } from "@claudex/schema";
import { nowIso } from "@claudex/util";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Map a single Claude `--output-format stream-json` object to zero or more
 * normalized HarnessEvents (one assistant message may carry several blocks).
 */
export function parseClaudeEvent(obj: Json, sessionId: string): HarnessEvent[] {
  const ts = nowIso();
  const type = obj?.type;

  if (type === "system" && obj.subtype === "init") {
    return [
      {
        type: "started",
        session_id: sessionId,
        ts,
        observed_model: typeof obj.model === "string" ? obj.model : undefined,
        payload: { tools: obj.tools, plugins: obj.plugins, mcp_servers: obj.mcp_servers },
      },
    ];
  }

  if (type === "system" && obj.subtype === "api_retry") {
    return [
      {
        type: "thinking",
        session_id: sessionId,
        ts,
        text: `api_retry: ${obj.error ?? ""}`,
        payload: { api_retry: true, error: obj.error, retry_delay_ms: obj.retry_delay_ms },
      },
    ];
  }

  if (type === "assistant") {
    const content: Json[] = obj.message?.content ?? [];
    const out: HarnessEvent[] = [];
    for (const block of content) {
      if (block?.type === "text" && block.text) {
        out.push({ type: "message", session_id: sessionId, ts, text: String(block.text) });
      } else if (block?.type === "tool_use") {
        const name = String(block.name ?? "tool");
        const input = block.input ?? {};
        if (EDIT_TOOLS.has(name)) {
          const path = input.file_path ?? input.path ?? input.notebook_path;
          out.push({ type: "file_change", session_id: sessionId, ts, payload: { path, tool: name } });
        } else {
          out.push({ type: "tool_call", session_id: sessionId, ts, text: name, payload: { input } });
        }
      }
    }
    return out;
  }

  if (type === "result") {
    const out: HarnessEvent[] = [];
    const u = obj.usage ?? {};
    out.push({
      type: "usage",
      session_id: sessionId,
      ts,
      usage: {
        input_tokens: numberOrUndef(u.input_tokens),
        output_tokens: numberOrUndef(u.output_tokens),
        cost_usd: numberOrUndef(obj.total_cost_usd),
      },
    });
    if (obj.subtype && obj.subtype !== "success") {
      out.push({ type: "error", session_id: sessionId, ts, error: `result subtype: ${obj.subtype}` });
    }
    return out;
  }

  return [];
}

function numberOrUndef(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
