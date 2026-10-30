import { InputTokenUsage, WorkReport, type HarnessEvent, type ToolRef } from "@claudexor/schema";
import { nowIso } from "@claudexor/util";
import { codexFileChangeEvents } from "./file-change.js";
import { applyCodexRateLimit, applyCodexTransient, codexReconnectStatus } from "./retry-signals.js";
import { mcpToolOutcome, summarizeCodexOutput } from "./tool-output.js";

type Json = any;

/**
 * Per-run finality state: codex's `exec --json` stream has NO typed marker of
 * the final answer (verified against exec_events.rs + official docs, 2026-07)
 * — the vendor's own definition (`--output-last-message`, SDK finalResponse,
 * proto `task_complete.last_agent_message`) is "the last agent message of the
 * turn". The adapter tracks it and FINALIZES it as a typed `final` message on
 * `turn.completed`, so consumers never re-derive finality from prose order.
 */
export interface CodexParseState {
  lastAgentMessage?: string;
  /** Last whole-list plan snapshot; repeated native replays are observable
   * transport noise, not new progress. */
  lastPlanProgressKey?: string;
  /** Engine-injected MCP servers whose startup Codex was told to require. */
  requiredMcpServers?: string[];
  /**
   * `codex exec --json` emits both `thread.started` and `turn.started` for one
   * run. The normalized protocol has one run-level `started` event, so retain
   * the first native lifecycle frame and recognize-but-skip the duplicate.
   * `turn.started` remains a fallback for older/partial streams that omit the
   * thread frame.
   */
  startedEmitted?: boolean;
  /**
   * D-16 / codex #19816: true when THIS run armed a WorkReport output-schema
   * envelope (`--output-schema` present). codex applies the schema to
   * INTERMEDIATE agent messages too, not just the final one, so a mid-run
   * narration arrives as the raw `{work_report, output}` envelope. When set, an
   * intermediate agent message that typed-matches the envelope is unwrapped to
   * its `output` (or suppressed) for the VISIBLE stream — never surfaced raw.
   * The FINAL message keeps the raw envelope so the orchestrator's unwrap runs
   * unchanged.
   */
  envelopeActive?: boolean;
}

/**
 * Typed detection of the D-16 `{work_report, output}` transport envelope in an
 * intermediate codex agent message (codex #19816). Returns:
 * - `undefined`: the text is NOT a WorkReport envelope — display it verbatim.
 * - a string: the envelope's `output` narration — display it UNWRAPPED.
 * - `null`: an envelope whose `output` is not a plain string (structured/partial)
 *   — SUPPRESS it from the visible stream rather than leak raw JSON.
 *
 * The check is TYPED (INV-049), not a prose/regex match: the text must parse to
 * a JSON object with EXACTLY `work_report` + `output`, and `work_report` must
 * satisfy the WorkReport schema. This never mutates the raw `lastAgentMessage`
 * the turn finalizes — the orchestrator still un-nests the FINAL envelope.
 */
function detectEnvelopeOutput(text: string): string | null | undefined {
  const trimmed = text.trim();
  // Fast reject: an envelope is a JSON object literal.
  if (trimmed.length === 0 || trimmed[0] !== "{") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 2 || !("work_report" in obj) || !("output" in obj)) return undefined;
  if (!WorkReport.safeParse(obj["work_report"]).success) return undefined;
  const output = obj["output"];
  // A string `output` is the no-caller-schema narration codex wraps: show it
  // unwrapped. A non-string `output` is a caller-schema partial we cannot safely
  // render as progress text — suppress rather than leak the envelope JSON.
  return typeof output === "string" ? output : null;
}

/**
 * Map a single Codex `exec --json` JSONL object to normalized HarnessEvents.
 * Codex event names: thread.*, turn.*, item.started|updated|completed, error.
 *
 * Returns `null` for unrecognized shapes (counted as dropped by the run loop)
 * and `[]` for recognized-but-intentionally-skipped events (e.g. item.updated
 * progress ticks that would double-register a tool call).
 */
export function parseCodexEvent(
  obj: Json,
  sessionId: string,
  state?: CodexParseState,
): HarnessEvent[] | null {
  const ts = nowIso();
  const type = obj?.type;

  if (type === "thread.started") {
    if (state?.startedEmitted) return [];
    if (state) state.startedEmitted = true;
    // Expose the native session id uniformly so the engine can record it for resume.
    return [
      {
        type: "started",
        session_id: sessionId,
        ts,
        payload: {
          thread_id: obj.thread_id,
          native_session_id: obj.thread_id,
          ...(state?.requiredMcpServers?.length
            ? {
                mcp_servers: state.requiredMcpServers.map((name) => ({
                  name,
                  status: "connected",
                })),
              }
            : {}),
        },
      },
    ];
  }
  if (type === "turn.completed") {
    const u = obj.usage ?? {};
    const out: HarnessEvent[] = [
      {
        type: "usage",
        session_id: sessionId,
        ts,
        usage: {
          input_tokens: numberOrUndef(u.input_tokens),
          output_tokens: numberOrUndef(u.output_tokens),
          cached_input_tokens: numberOrUndef(u.cached_input_tokens),
          input_token_usage: {
            total_tokens: InputTokenUsage.shape.total_tokens.safeParse(u.input_tokens).data ?? null,
            cache_read_tokens:
              InputTokenUsage.shape.cache_read_tokens.safeParse(u.cached_input_tokens).data ?? null,
            cache_write_tokens:
              InputTokenUsage.shape.cache_write_tokens.safeParse(u.cache_write_input_tokens).data ??
              null,
          },
        },
      },
    ];
    // Typed finality: the turn's last agent message IS the final answer
    // (vendor semantics — see CodexParseState). Emitted as a `final` message
    // so the engine takes it verbatim; the narration copy already streamed.
    if (state?.lastAgentMessage) {
      const raw = state.lastAgentMessage;
      const finalEvent: HarnessEvent = {
        type: "message",
        session_id: sessionId,
        ts,
        text: raw,
        final: true,
        payload: { final_source: "last_agent_message" },
      };
      // codex #19816 / QA-009: with an armed WorkReport envelope, the FINAL agent
      // message is itself the raw `{work_report, output}` envelope. When its
      // `output` is a plain string, emit the UNWRAPPED output as the final's
      // DISPLAY text — so the answer bubble and the reducer's twin-removal see the
      // SAME unwrapped text the intermediate visible copy carried (the raw-vs-
      // unwrapped mismatch was the QA-009 twin regression) — and carry the RAW
      // envelope on a TYPED payload field so the orchestrator's downstream unwrap
      // still reads machine truth (display truth + machine truth, both typed, no
      // double-unwrap). A non-string / non-envelope final keeps its raw text: its
      // intermediate copy was suppressed (no visible twin), no envelope field is
      // attached, and `answer.machineText()` falls back to that raw text so the
      // orchestrator un-nests exactly as before.
      if (state.envelopeActive) {
        const display = detectEnvelopeOutput(raw);
        if (typeof display === "string") {
          finalEvent.text = display;
          finalEvent.payload = { final_source: "last_agent_message", work_report_envelope: raw };
        }
      }
      out.push(finalEvent);
      state.lastAgentMessage = undefined;
    }
    return out;
  }
  if (type === "turn.failed") {
    // A failed turn NEVER finalizes its (partial) agent message, and must not
    // let it leak into the NEXT turn's finalization either (review sol #2).
    if (state) state.lastAgentMessage = undefined;
    const message = obj.error?.message ?? "turn failed";
    const ev: HarnessEvent = {
      type: "error",
      session_id: sessionId,
      ts,
      error: message,
      payload: obj,
    };
    applyRequiredMcpFailure(ev, message, state);
    applyCodexRateLimit(ev, message, obj.error?.resets_at ?? obj.resets_at);
    applyCodexTransient(ev, message);
    return [ev];
  }
  if (type === "turn.started") {
    // A new turn starts fresh: never let a PRIOR turn's last agent message
    // finalize as THIS turn's answer (review sol #2 — the leak was cleared
    // only on turn.completed, so a failed/empty turn inherited a stale one).
    if (state) state.lastAgentMessage = undefined;
    // `thread.started` is the canonical run boundary. Keep this as a fallback
    // for a partial/older native stream, but never emit a second normalized
    // start for the ordinary thread.started + turn.started pair.
    if (state?.startedEmitted) return [];
    if (state) state.startedEmitted = true;
    return [
      {
        type: "started",
        session_id: sessionId,
        ts,
        payload: { turn_id: obj.turn_id },
      },
    ];
  }
  if (type === "error") {
    const message =
      typeof obj.message === "string" ? obj.message : (obj.error?.message ?? "codex error");
    const reconnect = codexReconnectStatus(message, sessionId, ts, obj);
    if (reconnect) return [reconnect];
    const ev: HarnessEvent = {
      type: "error",
      session_id: sessionId,
      ts,
      error: message,
      payload: obj,
    };
    applyRequiredMcpFailure(ev, message, state);
    applyCodexRateLimit(ev, message, obj.resets_at ?? obj.error?.resets_at);
    applyCodexTransient(ev, message);
    return [ev];
  }
  if (type === "item.started" || type === "item.updated") {
    const item = obj.item ?? {};
    const updated = type === "item.updated";
    switch (item.type) {
      case "todo_list":
        return planProgressEvent(item, sessionId, ts, state);
      case "reasoning":
        return [
          {
            type: "thinking",
            session_id: sessionId,
            ts,
            text: String(item.text ?? item.summary ?? "reasoning"),
            payload: { status: type, item_id: item.id },
          },
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
            payload: {
              server: item.server,
              tool: item.tool,
              status: item.status ?? type,
              item_id: item.id,
            },
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
        return updated ? [] : codexFileChangeEvents(item, "started", sessionId, ts);
      default:
        return null;
    }
  }
  if (type === "item.completed") {
    const item = obj.item ?? {};
    switch (item.type) {
      case "agent_message": {
        const text = String(item.text ?? "");
        // Keep the RAW text as the turn's finality candidate: the orchestrator
        // un-nests the FINAL `{work_report, output}` envelope downstream, so the
        // final message must stay raw. Only the VISIBLE intermediate copy below
        // is unwrapped/suppressed.
        if (state && text.trim()) state.lastAgentMessage = text;
        // codex #19816: with `--output-schema` armed, an intermediate agent
        // message is itself the envelope. Unwrap it to its `output` for display,
        // or suppress a non-string `output` — never surface raw `{work_report}`.
        if (state?.envelopeActive) {
          const display = detectEnvelopeOutput(text);
          if (display === null) return []; // suppressed: partial/structured envelope
          if (display !== undefined)
            return [{ type: "message", session_id: sessionId, ts, text: display }];
        }
        return [{ type: "message", session_id: sessionId, ts, text }];
      }
      case "reasoning":
        return [{ type: "thinking", session_id: sessionId, ts, text: String(item.text ?? "") }];
      case "file_change":
        return codexFileChangeEvents(item, "completed", sessionId, ts);
      case "command_execution": {
        const failed =
          item.status === "failed" ||
          item.status === "declined" ||
          (typeof item.exit_code === "number" && item.exit_code !== 0);
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
        const outcome = mcpToolOutcome(item);
        return [
          {
            type: "tool_result",
            session_id: sessionId,
            ts,
            text: outcome.status === "error" ? "tool_result: error" : "tool_result",
            tool: { ...mcpToolRef(item), ...outcome },
            payload: {
              server: item.server,
              tool: item.tool,
              status: item.status,
              item_id: item.id,
            },
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
              error_summary: failed
                ? summarizeCodexOutput(item.error) || "web search failed"
                : undefined,
              // QA-042: codex `exec --json` web_search/open_page items carry NO
              // typed fetch outcome — a `completed` item can hide a 502. So a
              // non-failed item is DISPATCH strength only (the call completed),
              // never proof of retrieved content. Only an explicit `failed`
              // status is a typed retrieval failure.
              web_retrieval: failed ? "failed" : "dispatched",
            },
            payload: { status: item.status, item_id: item.id },
          },
        ];
      }
      case "todo_list":
        return planProgressEvent(item, sessionId, ts, state);
      default:
        return null;
    }
  }
  return null;
}

/**
 * Codex 0.144.1 emits todo-list snapshots throughout the native item
 * lifecycle (started, updated, completed). All three frames are the same
 * semantic producer; translating only the terminal frame hides live progress.
 */
function planProgressEvent(
  item: Json,
  sessionId: string,
  ts: string,
  state?: CodexParseState,
): HarnessEvent[] {
  const items = Array.isArray(item.items) ? item.items : [];
  const planItems = items.map((entry: { text?: string; completed?: boolean }, index: number) => ({
    id: `codex-${index}`,
    title: String(entry.text ?? ""),
    status: entry.completed ? ("completed" as const) : ("pending" as const),
  }));
  const progressKey = JSON.stringify(planItems);
  if (state?.lastPlanProgressKey === progressKey) return [];
  if (state) state.lastPlanProgressKey = progressKey;
  const lines = items.map(
    (entry: { text?: string; completed?: boolean }) =>
      `${entry.completed ? "[x]" : "[ ]"} ${String(entry.text ?? "")}`,
  );
  return [
    {
      type: "message",
      session_id: sessionId,
      ts,
      text: lines.length ? `Plan:\n${lines.join("\n")}` : "Plan updated",
      plan_progress: { items: planItems },
    },
  ];
}

const REQUIRED_MCP_FAILURE_PREFIX = "required MCP servers failed to initialize:";

function applyRequiredMcpFailure(
  event: HarnessEvent,
  message: string,
  state: CodexParseState | undefined,
): void {
  if (!state?.requiredMcpServers?.length) return;
  const failureLine = message
    .split(/\r?\n/)
    .find((line) => line.startsWith(REQUIRED_MCP_FAILURE_PREFIX));
  if (!failureLine) return;
  const failedNames = failureLine.slice(REQUIRED_MCP_FAILURE_PREFIX.length);
  const failed = state.requiredMcpServers.filter((name) =>
    new RegExp(`(^|[^a-zA-Z0-9_-])${escapeRegex(name)}([^a-zA-Z0-9_-]|$)`).test(failedNames),
  );
  if (failed.length === 0) return;
  event.payload = {
    ...(event.payload ?? {}),
    code: "required_mcp_startup_failed",
    mcp_servers: failed.map((name) => ({ name, status: "failed" })),
  };
}

/**
 * Translate Codex's stderr-only fatals into the same typed receipts as JSON
 * errors: the required-MCP startup fatal, and (A1 cursor-parity) a vendor
 * rate/usage-limit that reaches stderr instead of a typed `error` frame —
 * without the typed `rate_limit` signal a stderr-shaped limit is a generic
 * harness_error and reactive credential rotation can never fire on it.
 */
export function parseCodexStderrFailure(
  message: string,
  sessionId: string,
  state: CodexParseState | undefined,
): HarnessEvent | null {
  const event: HarnessEvent = {
    type: "error",
    session_id: sessionId,
    ts: nowIso(),
    error: message,
  };
  applyRequiredMcpFailure(event, message, state);
  // Stderr carries no typed resets_at field; the signal stays reset-less.
  applyCodexRateLimit(event, message, null);
  return event.payload?.["mcp_servers"] || event.rate_limit ? event : null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function commandFailureSummary(item: Json): string {
  return typeof item.exit_code === "number"
    ? `command exited with code ${item.exit_code}`
    : "command execution failed";
}

function boundedTarget(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  // The agent's own tool input (INV-146): bounded for display, never masked.
  return value.slice(0, 500);
}

function stringOrUndef(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function numberOrUndef(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
