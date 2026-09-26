import type { HarnessEvent, ToolKind, ToolRef } from "@claudexor/schema";
import { InputTokenUsage } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";
import {
  claudeCompactBoundaryEvents,
  claudeRateLimitEvents,
  claudeResultMessageEvents,
  claudeTerminalContextEvent,
} from "./context-signals.js";
import { requiredMcpStartupReceipts } from "./required-mcp.js";
import { claudeApiRetryEvents, claudeEntitlementEvents } from "./retry-signals.js";

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

export interface ClaudeParserOptions {
  deniedTools?: Iterable<string>;
  requiredMcpServers?: Iterable<string>;
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
  const requiredMcpServers = new Set(opts.requiredMcpServers ?? []);
  const turns: ClaudeTurnState = { results: 0, cumulativeCostUsd: null };
  return (obj: Json, sessionId: string): HarnessEvent[] | null =>
    parseClaudeEventStateful(obj, sessionId, pendingTools, deniedTools, requiredMcpServers, turns);
}

/**
 * Native-turn state of one streaming session. A live message that arrives
 * during the final text runs as the NEXT native turn of the same process
 * (live-input.ts): a `result` followed by a second `system/init` and a second
 * `result` in one run. `total_cost_usd` is CUMULATIVE across those turns (SDK
 * streaming-input contract) while `usage` tokens stay per turn.
 */
interface ClaudeTurnState {
  /** Results seen so far; an init after one is the next native turn, not a new start. */
  results: number;
  cumulativeCostUsd: number | null;
}

/** Stateless convenience used by tests; resolves results within a single call only. */
interface SessionTask {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
}
const sessionTasks = new Map<string, SessionTask[]>();
const sessionPlanSnapshots = new Map<string, string>();
const SESSION_TASKS_MAX_SESSIONS = 64;

function applySessionTask(
  sessionId: string,
  tool: string,
  input: Record<string, unknown>,
): boolean {
  if (!sessionTasks.has(sessionId) && sessionTasks.size >= SESSION_TASKS_MAX_SESSIONS) {
    const oldest = sessionTasks.keys().next().value;
    if (oldest !== undefined) {
      sessionTasks.delete(oldest);
      sessionPlanSnapshots.delete(oldest);
    }
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
  if (task.status === status) return false;
  task.status = status;
  sessionTasks.set(sessionId, list);
  return true;
}

/** Session finished: release its accumulated task list (long-lived daemons
 * must not hold every historical session's checklist). */
function releaseSessionTasks(sessionId: string): void {
  sessionTasks.delete(sessionId);
  sessionPlanSnapshots.delete(sessionId);
}

function sessionTaskItems(sessionId: string): SessionTask[] {
  return (sessionTasks.get(sessionId) ?? []).map((t) => ({
    id: `claude-${t.id}`,
    title: t.title,
    status: t.status,
  }));
}

function planSnapshotChanged(sessionId: string, items: readonly SessionTask[]): boolean {
  const key = JSON.stringify(items);
  if (sessionPlanSnapshots.get(sessionId) === key) return false;
  sessionPlanSnapshots.set(sessionId, key);
  return true;
}

export function parseClaudeEvent(obj: Json, sessionId: string): HarnessEvent[] | null {
  return parseClaudeEventStateful(obj, sessionId, new Map());
}

function parseClaudeEventStateful(
  obj: Json,
  sessionId: string,
  pendingTools: Map<string, ToolRef>,
  deniedTools = new Set<string>(),
  requiredMcpServers = new Set<string>(),
  turns: ClaudeTurnState = { results: 0, cumulativeCostUsd: null },
): HarnessEvent[] | null {
  const ts = nowIso();
  const type = obj?.type;

  if (type === "system" && obj.subtype === "init") {
    const mcp = requiredMcpStartupReceipts(obj.mcp_servers, requiredMcpServers);
    const mcpFailure: HarnessEvent[] =
      mcp.failed.length > 0
        ? [
            {
              type: "error",
              session_id: sessionId,
              ts,
              error: `Required injected MCP startup failed: ${mcp.failed.join(", ")}`,
              payload: {
                code: "required_mcp_startup_failed",
                mcp_servers: mcp.failed.map((name) => ({ name, status: "failed" })),
              },
            },
          ]
        : [];
    // An init AFTER a result is the same process starting its next native turn
    // for a queued live message (recorded on 2.1.283): the run started ONCE
    // (attempt trackers restart on `started`), so the turn boundary rides a
    // typed status event; a required-MCP failure still stops the run.
    if (turns.results > 0) {
      return [
        {
          type: "status",
          session_id: sessionId,
          ts,
          text: `native turn ${turns.results + 1} started in the same session`,
          payload: { code: "native_turn_started", turn: turns.results + 1 },
        },
        ...mcpFailure,
      ];
    }
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
          mcp_servers: mcp.servers,
          ...(typeof obj.session_id === "string" ? { native_session_id: obj.session_id } : {}),
        },
      },
      ...mcpFailure,
    ];
  }

  if (type === "system" && obj.subtype === "api_retry") {
    return claudeApiRetryEvents(obj, sessionId, ts);
  }

  // D-16c typed context / rate-limit signal frames (mapping lives in
  // context-signals.ts so each concern stays a small owner).
  if (type === "system" && obj.subtype === "compact_boundary")
    return claudeCompactBoundaryEvents(obj, sessionId, ts);
  if (type === "rate_limit_event") return claudeRateLimitEvents(obj, sessionId, ts);

  if (type === "assistant") {
    // Subagent traffic (parent_tool_use_id set) is NOT the main conversation
    // and must never enter narration / the answer — the guard belongs on the
    // COMPLETE assistant frame too, not only stream_event deltas (review sol
    // #8). Tool_use blocks still process (a subagent's edits are real file
    // changes); only its assistant TEXT/thinking is suppressed.
    const isSubagent = obj.parent_tool_use_id != null;
    const content: Json[] = obj.message?.content ?? [];
    const out: HarnessEvent[] = [];
    for (const block of content) {
      if (block?.type === "text" && block.text) {
        if (isSubagent) continue;
        out.push({ type: "message", session_id: sessionId, ts, text: String(block.text) });
      } else if (
        block?.type === "thinking" &&
        typeof block.thinking === "string" &&
        block.thinking.trim()
      ) {
        if (isSubagent) continue;
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
          out.push({
            type: "file_change",
            session_id: sessionId,
            ts,
            tool,
            payload: { path, tool: name, tool_use_id: block.id },
          });
        } else if (name === "TodoWrite" && Array.isArray(input.todos)) {
          // Typed plan progress, legacy surface: older claude CLIs plan
          // via TodoWrite (whole-list updates; statuses map 1:1).
          const items = (input.todos as Array<{ content?: unknown; status?: unknown }>).map(
            (t, i) => ({
              id: `claude-${i}`,
              title: String(t.content ?? ""),
              status:
                t.status === "completed"
                  ? ("completed" as const)
                  : t.status === "in_progress"
                    ? ("in_progress" as const)
                    : ("pending" as const),
            }),
          );
          out.push({
            type: "tool_call",
            session_id: sessionId,
            ts,
            text: name,
            tool,
            ...(planSnapshotChanged(sessionId, items) ? { plan_progress: { items } } : {}),
          });
        } else if (name === "TaskCreate" || name === "TaskUpdate") {
          // Typed plan progress, current surface (LIVE-VERIFIED 2.1.165):
          // claude plans via TaskCreate/TaskUpdate. The adapter accumulates the
          // session's task list and re-emits the WHOLE list on every change
          // (the run-event contract is last-wins).
          const taskChanged = applySessionTask(sessionId, name, input);
          const taskItems = sessionTaskItems(sessionId);
          if (taskChanged && planSnapshotChanged(sessionId, taskItems)) {
            out.push({
              type: "tool_call",
              session_id: sessionId,
              ts,
              text: name,
              tool,
              plan_progress: { items: taskItems },
            });
          } else {
            out.push({
              type: "tool_call",
              session_id: sessionId,
              ts,
              text: name,
              tool,
              payload: { input },
            });
          }
        } else if (name === "ExitPlanMode" && typeof input.plan === "string" && input.plan.trim()) {
          // The produced plan rides in ExitPlanMode's INPUT; surface it as the
          // message it is so plan-mode runs keep their work product headless.
          out.push({ type: "message", session_id: sessionId, ts, text: String(input.plan) });
          out.push({ type: "tool_call", session_id: sessionId, ts, text: name, tool });
        } else {
          out.push({
            type: "tool_call",
            session_id: sessionId,
            ts,
            text: name,
            tool,
            payload: { input },
          });
        }
      }
    }
    return out;
  }

  if (type === "user") {
    // `--replay-user-messages` echo of a stdin user frame (the initial prompt
    // or a live message): a consumption RECEIPT that live-input.ts correlates
    // by uuid, never a tool_result — the parser emits nothing for it.
    if (obj.isReplay === true) return [];
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
          // QA-042: claude WebSearch/WebFetch return TYPED content with an
          // is_error flag, so a successful web result is a VERIFIED retrieval
          // (content present), not dispatch-only — unlike codex, which cannot
          // expose the fetch outcome. A typed error is a failed retrieval.
          ...(origin?.kind === "web"
            ? { web_retrieval: status === "error" ? ("failed" as const) : ("verified" as const) }
            : {}),
        };
        out.push({
          type: "tool_result",
          session_id: sessionId,
          ts,
          text:
            status !== "ok"
              ? `tool_result: ${status}${detail ? `: ${detail}` : ""}`
              : "tool_result",
          tool,
        });
      }
    }
    return out;
  }

  if (type === "result") {
    // The session is finishing: release its accumulated task list.
    releaseSessionTasks(sessionId);
    turns.results += 1;
    const out: HarnessEvent[] = [];
    const u = obj.usage ?? {};
    const input = InputTokenUsage.shape.total_tokens.safeParse(u.input_tokens).data ?? null;
    const read =
      InputTokenUsage.shape.cache_read_tokens.safeParse(u.cache_read_input_tokens).data ?? null;
    const write =
      InputTokenUsage.shape.cache_write_tokens.safeParse(u.cache_creation_input_tokens).data ??
      null;
    // The orchestrator SUMS every usage event's cost, so a second native turn
    // must carry the DELTA of the cumulative total (first result = full value).
    const total = numberOrUndef(obj.total_cost_usd);
    const previous = turns.cumulativeCostUsd;
    const delta = total === undefined ? undefined : previous === null ? total : total - previous;
    if (total !== undefined) turns.cumulativeCostUsd = total;
    out.push({
      type: "usage",
      session_id: sessionId,
      ts,
      usage: {
        input_tokens: numberOrUndef(u.input_tokens),
        output_tokens: numberOrUndef(u.output_tokens),
        cached_input_tokens: sumOrUndef(u.cache_read_input_tokens, u.cache_creation_input_tokens),
        input_token_usage: {
          total_tokens:
            input !== null && read !== null && write !== null ? input + read + write : null,
          cache_read_tokens: read,
          cache_write_tokens: write,
        },
        cost_usd: delta !== undefined && delta < 0 ? 0 : delta,
      },
    });
    if (delta !== undefined && delta < 0) {
      out.push({
        type: "status",
        session_id: sessionId,
        ts,
        text: `cumulative total_cost_usd fell from ${previous} to ${total}; this turn's cost is clamped to 0`,
        payload: { code: "usage_cost_delta_negative", total_cost_usd: total, previous },
      });
    }
    // Finality is claimed ONLY for a SUCCESS result (review sol #1); an
    // `is_error:true` result (e.g. terminal_reason:"prompt_too_long", still
    // labeled subtype:"success") carries error prose, not a deliverable — it
    // rides as a `status` event (A3 deliverable hygiene) and the context event
    // below marks it. The final-message emission (structured_output / result /
    // side_tool) lives in context-signals.ts.
    const successResult = (!obj.subtype || obj.subtype === "success") && obj.is_error !== true;
    for (const ev of claudeResultMessageEvents(obj, successResult, sessionId, ts)) out.push(ev);
    // A1: type the org-disabled entitlement prose of a non-success result
    // (oauth_org_not_allowed) alongside the status event carrying the prose.
    for (const ev of claudeEntitlementEvents(obj.result, successResult, sessionId, ts))
      out.push(ev);
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
      } else if (obj.subtype === "error_max_structured_output_retries") {
        // The model exhausted its structured-output retries: a CONFORMANCE
        // failure, not a run failure — the engine validator reports it as
        // outputConformance failed and the run stays success-with-warnings.
        out.push({
          type: "thinking",
          session_id: sessionId,
          ts,
          text: "structured-output retries exhausted; the final answer may not conform to the requested schema",
          payload: { structured_output_retries_exhausted: true },
        });
      } else {
        out.push({
          type: "error",
          session_id: sessionId,
          ts,
          error: `result subtype: ${obj.subtype}`,
        });
      }
    }
    // D-16c: map the FIXTURE-PROVEN terminal_reason onto a typed context event
    // (null for completed/unrecognized — no prose matching).
    const contextEvent = claudeTerminalContextEvent(obj.terminal_reason, sessionId, ts);
    if (contextEvent) out.push(contextEvent);
    return out;
  }

  if (type === "stream_event") {
    // --include-partial-messages (F2.5 W-C4): raw API stream frames. Only
    // MAIN-conversation text deltas become delta messages (subagent frames
    // carry parent_tool_use_id); every other frame (message_start, thinking
    // deltas, block boundaries) is recognized plumbing — the complete
    // assistant/result events still deliver the authoritative text.
    const delta = obj.event?.delta;
    if (
      obj.parent_tool_use_id == null &&
      obj.event?.type === "content_block_delta" &&
      delta?.type === "text_delta" &&
      typeof delta.text === "string" &&
      delta.text
    ) {
      return [
        {
          type: "message",
          session_id: sessionId,
          ts,
          text: delta.text,
          payload: { delta: true },
        },
      ];
    }
    return [];
  }

  // recognized but uninteresting system subtypes (incl. 2.1.165's
  // `post_turn_summary` review-status frame): known plumbing, never counted as
  // a dropped event. The SIGNAL-bearing system subtype (`compact_boundary`) is
  // handled above.
  if (type === "system") return [];

  // Control-protocol plumbing frames. Incoming control_requests are consumed
  // by the interactive session handler BEFORE this parser; responses to OUR
  // initialize handshake (and cancel acks) are recognized plumbing, never
  // counted as dropped events.
  if (type === "control_response" || type === "control_cancel_request") return [];

  // Stdin-message lifecycle frames (`command_lifecycle`: queued / started /
  // completed / cancelled …, keyed by the frame's uuid). Receipts for OUR live
  // messages are correlated by live-input.ts; the frames themselves are
  // recognized plumbing, never dropped events.
  if (type === "command_lifecycle") return [];

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
  if (typeof content === "string")
    return redactSecrets(content).trim().replace(/\s+/g, " ").slice(0, 1000);
  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object" || Array.isArray(item)) return "";
        const rec = item as Record<string, unknown>;
        return typeof rec["text"] === "string"
          ? rec["text"]
          : typeof rec["content"] === "string"
            ? rec["content"]
            : "";
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
