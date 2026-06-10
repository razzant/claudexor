import type { HarnessEvent, ToolKind, ToolRef } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function toolKindFor(name: string): ToolKind {
  if (name === "WebSearch" || name === "WebFetch") return "web";
  if (name === "Bash" || name === "BashOutput" || name === "KillShell") return "command";
  if (name === "Glob" || name === "Grep") return "search";
  if (name === "Read" || name === "LS" || EDIT_TOOLS.has(name)) return "file";
  if (name.startsWith("mcp__")) return "mcp";
  return "other";
}

export type ClaudeEventParser = (obj: Json, sessionId: string) => HarnessEvent[] | null;

/**
 * Create a stateful per-run parser for Claude `--output-format stream-json`.
 * State is needed to resolve tool_result blocks (which only carry tool_use_id)
 * back to the tool name/kind/target of the originating tool_use block, so the
 * normalized `tool_result` event is self-describing.
 * Returns `null` for unrecognized top-level shapes (counted as dropped by the
 * run loop) and `[]` for recognized events that produce nothing.
 */
export function createClaudeParser(): ClaudeEventParser {
  const pendingTools = new Map<string, ToolRef>();
  return (obj: Json, sessionId: string): HarnessEvent[] | null =>
    parseClaudeEventStateful(obj, sessionId, pendingTools);
}

/** Stateless convenience used by tests; resolves results within a single call only. */
export function parseClaudeEvent(obj: Json, sessionId: string): HarnessEvent[] | null {
  return parseClaudeEventStateful(obj, sessionId, new Map());
}

function parseClaudeEventStateful(
  obj: Json,
  sessionId: string,
  pendingTools: Map<string, ToolRef>,
): HarnessEvent[] | null {
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
        text: `api_retry: ${redactSecrets(String(obj.error ?? ""))}`,
        payload: { api_retry: true, retry_delay_ms: obj.retry_delay_ms },
      },
    ];
  }

  if (type === "assistant") {
    const content: Json[] = obj.message?.content ?? [];
    const out: HarnessEvent[] = [];
    for (const block of content) {
      if (block?.type === "text" && block.text) {
        out.push({ type: "message", session_id: sessionId, ts, text: String(block.text) });
      } else if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
        out.push({ type: "thinking", session_id: sessionId, ts, text: String(block.thinking) });
      } else if (block?.type === "tool_use") {
        const name = String(block.name ?? "tool");
        const input = block.input ?? {};
        const tool: ToolRef = {
          name,
          kind: toolKindFor(name),
          use_id: typeof block.id === "string" ? block.id : undefined,
          target: toolTarget(name, input),
        };
        if (tool.use_id) pendingTools.set(tool.use_id, tool);
        if (EDIT_TOOLS.has(name)) {
          const path = input.file_path ?? input.path ?? input.notebook_path;
          out.push({ type: "file_change", session_id: sessionId, ts, tool, payload: { path, tool: name, tool_use_id: block.id } });
        } else if (name === "ExitPlanMode" && typeof input.plan === "string" && input.plan.trim()) {
          // The produced plan rides in ExitPlanMode's INPUT; surface it as the
          // message it is so plan-mode runs keep their work product headless.
          out.push({ type: "message", session_id: sessionId, ts, text: String(input.plan) });
          out.push({ type: "tool_call", session_id: sessionId, ts, text: name, tool });
        } else {
          out.push({ type: "tool_call", session_id: sessionId, ts, text: name, tool, payload: { input } });
        }
      }
    }
    return out;
  }

  if (type === "user") {
    const content: Json[] = obj.message?.content ?? [];
    const out: HarnessEvent[] = [];
    for (const block of content) {
      if (block?.type === "tool_result") {
        const detail = summarizeToolResultContent(block.content);
        const isError = block.is_error === true;
        const useId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
        const origin = useId ? pendingTools.get(useId) : undefined;
        if (useId) pendingTools.delete(useId);
        // ExitPlanMode and AskUserQuestion are Claude's interactive FLOW
        // CONTROL tools, not work tools. A headless (or declined / timed-out)
        // is_error result is their documented way of ending the interaction —
        // translate it to a benign thinking event (detail preserved, the
        // question text stays in the timeline) instead of a blocking error
        // tool_result. Recovery-by-same-tool is impossible by construction for
        // these tools, so the generic unrecovered-tool-error rule must never
        // fail a run over them (CLAUDEXOR_BIBLE §5).
        if (origin?.name === "ExitPlanMode" && isError) {
          out.push({
            type: "thinking",
            session_id: sessionId,
            ts,
            text: `plan mode ended (ExitPlanMode has no headless approver${detail ? `: ${detail}` : ""})`,
            payload: { tool: "ExitPlanMode", tool_use_id: useId },
          });
          continue;
        }
        if (origin?.name === "AskUserQuestion" && isError) {
          out.push({
            type: "thinking",
            session_id: sessionId,
            ts,
            text: `clarifying questions declined (no user answer); the model continues with assumptions${detail ? `: ${detail}` : ""}`,
            payload: { tool: "AskUserQuestion", tool_use_id: useId },
          });
          continue;
        }
        const tool: ToolRef = {
          name: origin?.name ?? "tool",
          kind: origin?.kind ?? "other",
          use_id: useId,
          target: origin?.target,
          status: isError ? "error" : "ok",
          error_summary: isError ? detail || "tool result marked error" : undefined,
          content_summary: detail || undefined,
        };
        out.push({
          type: "tool_result",
          session_id: sessionId,
          ts,
          text: isError ? `tool_result: error${detail ? `: ${detail}` : ""}` : "tool_result",
          tool,
        });
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
        cached_input_tokens: sumOrUndef(u.cache_read_input_tokens, u.cache_creation_input_tokens),
        cost_usd: numberOrUndef(obj.total_cost_usd),
      },
    });
    if (typeof obj.result === "string" && obj.result.trim()) {
      out.push({ type: "message", session_id: sessionId, ts, text: obj.result });
    }
    if (obj.subtype && obj.subtype !== "success") {
      out.push({ type: "error", session_id: sessionId, ts, error: `result subtype: ${obj.subtype}` });
    }
    return out;
  }

  if (type === "system") return []; // recognized but uninteresting system subtypes

  return null;
}

function toolTarget(name: string, input: Record<string, unknown>): string | undefined {
  const candidates = [
    input["query"],
    input["url"],
    input["file_path"],
    input["path"],
    input["command"],
  ];
  const found = candidates.find((v) => typeof v === "string" && v.trim().length > 0);
  return found ? redactSecrets(`${name}: ${String(found)}`).slice(0, 500) : undefined;
}

function summarizeToolResultContent(content: unknown): string {
  if (typeof content === "string") return redactSecrets(content).trim().replace(/\s+/g, " ").slice(0, 1000);
  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object" || Array.isArray(item)) return "";
        const rec = item as Record<string, unknown>;
        return typeof rec["text"] === "string" ? rec["text"] : typeof rec["content"] === "string" ? rec["content"] : "";
      })
      .filter(Boolean);
    return redactSecrets(parts.join(" ")).trim().replace(/\s+/g, " ").slice(0, 1000);
  }
  if (content && typeof content === "object") {
    return redactSecrets(JSON.stringify(content)).slice(0, 1000);
  }
  return "";
}

function numberOrUndef(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function sumOrUndef(...values: unknown[]): number | undefined {
  const nums = values.filter((v): v is number => typeof v === "number");
  if (nums.length === 0) return undefined;
  return nums.reduce((a, b) => a + b, 0);
}
