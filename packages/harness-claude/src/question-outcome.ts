import type { HarnessEvent } from "@claudexor/schema";
import { nowIso } from "@claudexor/util";

type Json = any;

/**
 * What the adapter itself knows about a Claude `AskUserQuestion` (#622).
 *
 * A native error result of the question tool is not evidence that a person
 * declined: the CLI returns one for Claudexor's own benign decline, for a
 * failure of its permission channel (`Stream closed`) and in a run without an
 * answer channel alike. The parser therefore records every such result
 * neutrally with its native detail, adding only the session-input state
 * Claudexor held when it read the question; frames can arrive batched, so that
 * state says nothing about when the CLI asked. A known decline, expiry or
 * answer keeps its typed interaction events. When Claudexor itself cannot
 * obtain or send an answer, a `status` event says so (a no-channel or
 * failed-channel deny that cannot be written adds its own), keyed by the native
 * request and tool-use ids, never by vendor prose (INV-049). None of these is
 * a blocking tool error (INV-048).
 */
export const INTERACTION_ANSWER_UNAVAILABLE = "interaction_answer_unavailable";

export type QuestionUnavailableReason =
  | "no_answer_channel"
  | "answer_channel_failed"
  | "process_closed"
  | "response_write_failed"
  | "input_closed";

const REASONS: Record<QuestionUnavailableReason, string> = {
  no_answer_channel: "this run has no answer channel",
  answer_channel_failed: "the answer channel failed",
  process_closed: "the native process closed before an answer was sent",
  response_write_failed: "writing the response to the native process failed",
  input_closed: "this session's input was already closed when Claudexor read the request",
};

export interface NativeQuestionIds {
  /** The control request id (also the interaction id), when one was observed. */
  interactionId: string | null;
  /** The native tool-use id of the AskUserQuestion call, when the CLI named it. */
  toolUseId: string | null;
}

/** The adapter's own observation that no answer can reach this question. It
 * says why and never claims that nobody saw the question. */
export function questionUnavailableEvent(
  sessionId: string,
  ids: NativeQuestionIds,
  reason: QuestionUnavailableReason,
  extra: { input?: unknown; error?: string } = {},
): HarnessEvent {
  const label = ids.interactionId || ids.toolUseId;
  return {
    type: "status",
    session_id: sessionId,
    ts: nowIso(),
    text: `AskUserQuestion${label ? ` ${label}` : ""} could not be answered: ${REASONS[reason]}`,
    payload: {
      code: INTERACTION_ANSWER_UNAVAILABLE,
      reason,
      ...(ids.interactionId ? { interaction_id: ids.interactionId } : {}),
      ...(ids.toolUseId ? { tool_use_id: ids.toolUseId } : {}),
      ...extra,
    },
  };
}

/** The deny the model receives when Claudexor cannot obtain an answer itself:
 * the question went unanswered for a stated reason, not by the user's choice. */
export function unavailableDenyMessage(
  reason: "no_answer_channel" | "answer_channel_failed",
): string {
  return `Claudexor could not obtain an answer to these questions (${REASONS[reason]}); this is not the user's decision. Continue with your best assumptions and state them explicitly.`;
}

/** Claudexor's session input when it read a question: `open` (a permission
 * request can still be answered), `closed` (Claudexor had already ended the
 * session's stdin) or `none` (a run without an interactive answer channel). */
export type ClaudeQuestionInput = "open" | "closed" | "none";

export interface ClaudeQuestionTracker {
  /** An AskUserQuestion tool_use was read: remember the session input then. */
  asked(toolUseId: string | undefined): void;
  /** Its result, answered or not, ends what is remembered about it; an error
   * result becomes one neutral, benign record (null for any other result). */
  result(
    toolUseId: string | undefined,
    isError: boolean,
    detail: string,
    sessionId: string,
    ts: string,
  ): HarnessEvent | null;
  /** A control_request the session could not route (stdin already closed or
   * never interactive): an AskUserQuestion becomes an explicit observation
   * carrying the exact native input; anything else stays unrecognized (null). */
  unroutedRequest(obj: Json, sessionId: string): HarnessEvent[] | null;
}

/** Per-run parser state. Without `input` (fixture replays, the stateless
 * parser) nothing about the session is claimed. */
export function createClaudeQuestionTracker(
  input?: () => ClaudeQuestionInput,
): ClaudeQuestionTracker {
  const askedUnder = new Map<string, ClaudeQuestionInput>();
  return {
    asked(toolUseId) {
      if (toolUseId && input) askedUnder.set(toolUseId, input());
    },
    result(toolUseId, isError, detail, sessionId, ts) {
      const state = toolUseId ? askedUnder.get(toolUseId) : undefined;
      if (toolUseId) askedUnder.delete(toolUseId);
      if (!isError) return null;
      const observed =
        state === "closed"
          ? "; this session's input was already closed when Claudexor read the question"
          : state === "none"
            ? `; ${REASONS.no_answer_channel}`
            : "";
      return {
        type: "thinking",
        session_id: sessionId,
        ts,
        text: `AskUserQuestion returned an error instead of answers${observed}${detail ? `: ${detail}` : ""}`,
        payload: {
          tool: "AskUserQuestion",
          ...(toolUseId ? { tool_use_id: toolUseId } : {}),
          ...(state ? { session_input: state } : {}),
        },
      };
    },
    unroutedRequest(obj, sessionId) {
      const request: Json = obj?.request;
      const state = input?.();
      if (
        !state ||
        state === "open" ||
        request?.subtype !== "can_use_tool" ||
        request?.tool_name !== "AskUserQuestion"
      )
        return null;
      const ids: NativeQuestionIds = {
        interactionId: typeof obj.request_id === "string" ? obj.request_id : null,
        toolUseId: typeof request.tool_use_id === "string" ? request.tool_use_id : null,
      };
      const reason = state === "closed" ? "input_closed" : "no_answer_channel";
      return [questionUnavailableEvent(sessionId, ids, reason, { input: request.input ?? null })];
    },
  };
}
