import type { HarnessEvent, ToolKind, ToolRef } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";

type Json = any;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const CLAUDE_TRANSIENT_RE = /overloaded|temporar(?:y|ily) unavailable|network|econnreset|etimedout|enotfound|eai_again|stream/i;

function toolKindFor(name: string): ToolKind {
  if (name === "WebSearch" || name === "WebFetch") return "web";
  if (name === "Bash" || name === "BashOutput" || name === "KillShell") return "command";
  if (name === "Glob" || name === "Grep") return "search";
  if (name === "Read" || name === "LS" || EDIT_TOOLS.has(name)) return "file";
  if (name.startsWith("mcp__")) return "mcp";
  return "other";
}

export type ClaudeEventParser = (obj: Json, sessionId: string) => HarnessEvent[] | null;

export interface ClaudeParserOptions {
  deniedTools?: Iterable<string>;
}

/**
 * Create a stateful per-run parser for Claude `--output-format stream-json`.
 * State is needed to resolve tool_result blocks (which only carry tool_use_id)
 * back to the tool name/kind/target of the originating tool_use block, so the
 * normalized `tool_result` event is self-describing.
 * Returns `null` for unrecognized top-level shapes (counted as dropped by the
 * run loop) and `[]` for recognized events that produce nothing.
 */
export function createClaudeParser(opts: ClaudeParserOptions = {}): ClaudeEventParser {
  const pendingTools = new Map<string, ToolRef>();
  const deniedTools = new Set(opts.deniedTools ?? []);
  return (obj: Json, sessionId: string): HarnessEvent[] | null =>
    parseClaudeEventStateful(obj, sessionId, pendingTools, deniedTools);
}

/** Stateless convenience used by tests; resolves results within a single call only. */
interface SessionTask {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
}
const sessionTasks = new Map<string, SessionTask[]>();
const SESSION_TASKS_MAX_SESSIONS = 64;

function applySessionTask(sessionId: string, tool: string, input: Record<string, unknown>): boolean {
  if (!sessionTasks.has(sessionId) && sessionTasks.size >= SESSION_TASKS_MAX_SESSIONS) {
    const oldest = sessionTasks.keys().next().value;
    if (oldest !== undefined) sessionTasks.delete(oldest);
  }
  const list = sessionTasks.get(sessionId) ?? [];
  if (tool === "TaskCreate") {
    const title = typeof input["subject"] === "string" ? input["subject"] : null;
    if (!title) return false;
    list.push({ id: String(list.length + 1), title, status: "pending" });
    sessionTasks.set(sessionId, list);
    return true;
  }
  // TaskUpdate: {taskId, status?} — ids are 1-based creation order (the CLI's
  // own numbering, observed live).
  const taskId = typeof input["taskId"] === "string" ? input["taskId"] : null;
  if (!taskId) return false;
  let task = list.find((t) => t.id === taskId);
  const status = input["status"];
  if (status !== "completed" && status !== "in_progress" && status !== "pending") return false;
  if (!task) {
    // RESUMED session: the CLI's numbering continues from prior turns while
    // this accumulator started fresh — create-on-miss with the CLI's own id
    // (subject line unknown; the status update is still honest progress).
    const subject = typeof input["subject"] === "string" ? input["subject"] : `Task ${taskId}`;
    task = { id: taskId, title: subject, status };
    list.push(task);
    sessionTasks.set(sessionId, list);
    return true;
  }
  task.status = status;
  sessionTasks.set(sessionId, list);
  return true;
}

/** Session finished: release its accumulated task list (long-lived daemons
 * must not hold every historical session's checklist). */
function releaseSessionTasks(sessionId: string): void {
  sessionTasks.delete(sessionId);
}

function sessionTaskItems(sessionId: string): SessionTask[] {
  return (sessionTasks.get(sessionId) ?? []).map((t) => ({ id: `claude-${t.id}`, title: t.title, status: t.status }));
}

export function parseClaudeEvent(obj: Json, sessionId: string): HarnessEvent[] | null {
  return parseClaudeEventStateful(obj, sessionId, new Map());
}

function parseClaudeEventStateful(
  obj: Json,
  sessionId: string,
  pendingTools: Map<string, ToolRef>,
  deniedTools = new Set<string>(),
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
        // The native session id (when present) lets the engine resume this thread.
        payload: {
          tools: obj.tools,
          plugins: obj.plugins,
          mcp_servers: obj.mcp_servers,
          ...(typeof obj.session_id === "string" ? { native_session_id: obj.session_id } : {}),
        },
      },
    ];
  }

  if (type === "system" && obj.subtype === "api_retry") {
    const errText = String(obj.error ?? "");
    const ev: HarnessEvent = {
      type: "thinking",
      session_id: sessionId,
      ts,
      text: `api_retry: ${redactSecrets(errText)}`,
      payload: { api_retry: true, retry_delay_ms: obj.retry_delay_ms },
    };
    // Adapter-layer translation of claude's native retry into a TYPED rate-limit
    // signal (the budget layer reads the typed field, not the prose).
    if (/rate.?limit|overloaded|too many requests|quota/i.test(errText)) {
      ev.rate_limit = {
        resets_at: null,
        retry_delay_ms: typeof obj.retry_delay_ms === "number" ? obj.retry_delay_ms : null,
      };
    }
    if (CLAUDE_TRANSIENT_RE.test(errText)) {
      ev.transient = {
        kind: /overloaded|temporar(?:y|ily) unavailable/i.test(errText) ? "service_unavailable" : "network",
        retry_delay_ms: typeof obj.retry_delay_ms === "number" ? obj.retry_delay_ms : null,
      };
    }
    return [ev];
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
        } else if (name === "TodoWrite" && Array.isArray(input.todos)) {
          // Typed plan progress, legacy surface: older claude CLIs plan
          // via TodoWrite (whole-list updates; statuses map 1:1).
          const items = (input.todos as Array<{ content?: unknown; status?: unknown }>).map((t, i) => ({
            id: `claude-${i}`,
            title: String(t.content ?? ""),
            status:
              t.status === "completed" ? ("completed" as const) : t.status === "in_progress" ? ("in_progress" as const) : ("pending" as const),
          }));
          out.push({ type: "tool_call", session_id: sessionId, ts, text: name, tool, plan_progress: { items } });
        } else if (name === "TaskCreate" || name === "TaskUpdate") {
          // Typed plan progress, current surface (LIVE-VERIFIED 2.1.165):
          // claude plans via TaskCreate/TaskUpdate. The adapter accumulates the
          // session's task list and re-emits the WHOLE list on every change
          // (the run-event contract is last-wins).
          const taskChanged = applySessionTask(sessionId, name, input);
          if (taskChanged) {
            out.push({
              type: "tool_call",
              session_id: sessionId,
              ts,
              text: name,
              tool,
              plan_progress: { items: sessionTaskItems(sessionId) },
            });
          } else {
            out.push({ type: "tool_call", session_id: sessionId, ts, text: name, tool, payload: { input } });
          }
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
        const denied = isError && origin?.name !== undefined && deniedTools.has(origin.name);
        const status: ToolRef["status"] = denied ? "denied" : isError ? "error" : "ok";
        const tool: ToolRef = {
          name: origin?.name ?? "tool",
          kind: origin?.kind ?? "other",
          use_id: useId,
          target: origin?.target,
          status,
          error_summary: status === "error" ? detail || "tool result marked error" : undefined,
          content_summary: detail || undefined,
        };
        out.push({
          type: "tool_result",
          session_id: sessionId,
          ts,
          text: status !== "ok" ? `tool_result: ${status}${detail ? `: ${detail}` : ""}` : "tool_result",
          tool,
        });
      }
    }
    return out;
  }

  if (type === "result") {
    // The session is finishing: release its accumulated task list.
    releaseSessionTasks(sessionId);
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
      // `error_max_turns` is NOT a run failure: the turn ended because it hit the
      // configured --max-turns ceiling, with all partial work already streamed
      // (file_change / message events). Mirror the ExitPlanMode / AskUserQuestion
      // benign-event handling above — surface it as a normal timeline event so
      // the run is NOT marked errored. (CLAUDEXOR_BIBLE §5: benign turn-control
      // outcomes never fail a run.)
      if (obj.subtype === "error_max_turns") {
        out.push({
          type: "thinking",
          session_id: sessionId,
          ts,
          text: "turn ended at the configured max-turns limit (partial work preserved)",
          payload: { max_turns_reached: true, num_turns: numberOrUndef(obj.num_turns) },
        });
      } else {
        out.push({ type: "error", session_id: sessionId, ts, error: `result subtype: ${obj.subtype}` });
      }
    }
    return out;
  }

  if (type === "system") return []; // recognized but uninteresting system subtypes

  // Control-protocol plumbing frames. Incoming control_requests are consumed
  // by the interactive session handler BEFORE this parser; responses to OUR
  // initialize handshake (and cancel acks) are recognized plumbing, never
  // counted as dropped events.
  if (type === "control_response" || type === "control_cancel_request") return [];

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
