import { WorkReport, type HarnessEvent, type ToolRef } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";

type Json = any;

// Native codex error phrasing that indicates a rate-limit / quota condition.
// This regex lives in the ADAPTER (native-output translation is its job), not
// in the budget/governance layer.
const CODEX_RATE_LIMIT_RE =
  /rate.?limit|usage.?limit|usagelimitexceeded|too many requests|quota[ _-]?(?:exceeded|exhausted|reached)|(?:http|status|code)[ :/]?429|429 too many/i;
const CODEX_TRANSIENT_RE =
  /stream disconnected|failed to lookup address information|nodename nor servname|eai_again|enotfound|econnreset|etimedout|temporar(?:y|ily) unavailable|network/i;

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
    // Expose the native session id uniformly so the engine can record it for resume.
    return [
      {
        type: "started",
        session_id: sessionId,
        ts,
        payload: { thread_id: obj.thread_id, native_session_id: obj.thread_id },
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
    applyCodexRateLimit(ev, message, obj.error?.resets_at ?? obj.resets_at);
    applyCodexTransient(ev, message);
    return [ev];
  }
  if (type === "turn.started") {
    // A new turn starts fresh: never let a PRIOR turn's last agent message
    // finalize as THIS turn's answer (review sol #2 — the leak was cleared
    // only on turn.completed, so a failed/empty turn inherited a stale one).
    if (state) state.lastAgentMessage = undefined;
    // A lifecycle marker, NOT reasoning: mapping it to `thinking` used to
    // plant a junk "turn started" block at the top of every chat transcript
    // (the reducer renders thinking verbatim). `started` keeps the boundary
    // in the activity feed without polluting the reasoning disclosure.
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
    const ev: HarnessEvent = {
      type: "error",
      session_id: sessionId,
      ts,
      error: message,
      payload: obj,
    };
    applyCodexRateLimit(ev, message, obj.resets_at ?? obj.error?.resets_at);
    applyCodexTransient(ev, message);
    return [ev];
  }
  if (type === "item.started" || type === "item.updated") {
    const item = obj.item ?? {};
    const updated = type === "item.updated";
    switch (item.type) {
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
        return [
          {
            type: "file_change",
            session_id: sessionId,
            ts,
            tool: fileToolRef(item),
            payload: { path: item.path, status: item.status ?? type, item_id: item.id },
          },
        ];
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
      case "file_change": {
        const path = item.path ?? (Array.isArray(item.changes) ? item.changes[0]?.path : undefined);
        return [
          {
            type: "file_change",
            session_id: sessionId,
            ts,
            tool: fileToolRef(item),
            payload: { path, item },
          },
        ];
      }
      case "command_execution": {
        const failed =
          item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0);
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
              error_summary: failed
                ? summarizeCodexOutput(item.error ?? item.result) || "mcp tool call failed"
                : undefined,
            },
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
      case "todo_list": {
        // Codex's structured plan (re-emitted on revision; last wins). The
        // TYPED plan_progress rides a message event: the UI renders the
        // live checklist from the typed field while the prose stays available
        // to plan-extraction. Verified shape: item.items[].{text,completed}.
        const items = Array.isArray(item.items) ? item.items : [];
        const lines = items.map(
          (t: { text?: string; completed?: boolean }) =>
            `${t.completed ? "[x]" : "[ ]"} ${String(t.text ?? "")}`,
        );
        return [
          {
            type: "message",
            session_id: sessionId,
            ts,
            text: lines.length ? `Plan:\n${lines.join("\n")}` : "Plan updated",
            plan_progress: {
              items: items.map((t: { text?: string; completed?: boolean }, i: number) => ({
                id: `codex-${i}`,
                title: String(t.text ?? ""),
                status: t.completed ? ("completed" as const) : ("pending" as const),
              })),
            },
          },
        ];
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

function applyCodexTransient(ev: HarnessEvent, message: string): void {
  if (!CODEX_TRANSIENT_RE.test(message)) return;
  ev.transient = {
    kind: /stream disconnected/i.test(message) ? "stream_disconnect" : "network",
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
  return typeof item.exit_code === "number"
    ? `command exited with code ${item.exit_code}`
    : "command execution failed";
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
