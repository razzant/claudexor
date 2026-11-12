/**
 * Codex asynchronous questions (`request_user_input_async`) as pure translation.
 *
 * Native contract, read from openai/codex rust-v0.162.1 sources (the
 * request_user_input_async handler, context-fragments answered_question.rs, the
 * TUI pending-question state and the async question scenario with its
 * snapshot); this module was not checked against a live vendor run:
 * - The tool call answers `{"accepted":true}` at once and emits one completed
 *   `agentMessage` item: id = the function call's call_id, phase final_answer,
 *   delivery "async", `questions` [{title, options?}] and prose text repeating
 *   them. It is a question, never the turn's answer.
 * - A question's native identity is JSON.stringify(["request_user_input_async",
 *   <item id>, <question index>]).
 * - The answer is a user message steered into the active turn: the
 *   `<send_user_message_question_reply>` envelope around a JSON array of
 *   {answer, question, questionItemId}.
 *
 * Registration, the steer itself and the release at turn end belong to the
 * app-server run; this module only translates shapes. An empty answer set,
 * expiry, withdrawal and the run's end produce no message: silence is never
 * consent and no approval is invented.
 */
import type { LiveMessageResult } from "@claudexor/core";
import {
  interactionAnswerContent,
  interactionAnswerSetViolation,
  type HarnessEvent,
  type InteractionAnswerSet,
  type InteractionRequest,
} from "@claudexor/schema";
import { nowIso } from "@claudexor/util";
import { CODEX_TURN_INPUT_LIMIT } from "./capability-profile.js";

export const CODEX_ASYNC_QUESTION_TOOL = "request_user_input_async";
const REPLY_OPEN = "<send_user_message_question_reply>";
const REPLY_CLOSE = "</send_user_message_question_reply>";
/** answered_question.rs bounds model-authored framing and identities to 512 bytes. */
const MAX_FRAMING_BYTES = 512;

/** The native identity of one async question (the desktop's JSON.stringify triple). */
export function codexAsyncQuestionId(itemId: string, index: number): string {
  return JSON.stringify([CODEX_ASYNC_QUESTION_TOOL, itemId, index]);
}

function agentMessageItem(item: unknown): Record<string, unknown> | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const value = item as Record<string, unknown>;
  // Raw app-server items say agentMessage; codexAppServerEvents renames them agent_message.
  return value["type"] === "agentMessage" || value["type"] === "agent_message" ? value : null;
}

/**
 * An agent message delivered asynchronously: a question (or a note) sent while
 * the agent keeps working. Its text is never the turn's final answer.
 */
export function isCodexAsyncAgentMessage(item: unknown): boolean {
  return agentMessageItem(item)?.["delivery"] === "async";
}

export type CodexAsyncQuestion =
  /** Not an async question carrier: the item stays an ordinary message. */
  | { kind: "none" }
  | { kind: "question"; request: InteractionRequest }
  /** An async carrier whose questions this adapter cannot read; its text is
   * still the agent's message, but no answerable question exists. */
  | { kind: "unrecognized"; itemId: string | null; reason: string };

/**
 * The interaction an async question item asks for, with the full question text
 * and every option byte-exact. `interactionId` is the caller's correlation id;
 * register each item id once (on item/completed: item/started carries the same
 * questions).
 */
export function codexAsyncQuestion(item: unknown, interactionId: string): CodexAsyncQuestion {
  const message = agentMessageItem(item);
  if (!message || message["delivery"] !== "async" || message["questions"] == null)
    return { kind: "none" };
  const itemId = typeof message["id"] === "string" && message["id"] ? message["id"] : null;
  const unrecognized = (reason: string): CodexAsyncQuestion => ({
    kind: "unrecognized",
    itemId,
    reason,
  });
  if (!itemId) return unrecognized("the async question item has no id");
  const raw = message["questions"];
  if (!Array.isArray(raw) || raw.length === 0)
    return unrecognized("the async question item carries no question list");
  const questions: InteractionRequest["questions"] = [];
  for (const [index, entry] of raw.entries()) {
    const question =
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : null;
    const title = question?.["title"];
    if (typeof title !== "string" || !title.trim())
      return unrecognized(`question ${index} has no title`);
    const options = question?.["options"] ?? null;
    if (
      options !== null &&
      (!Array.isArray(options) ||
        options.some((label) => typeof label !== "string" || !label.trim()))
    )
      return unrecognized(`question ${index} has options that are not non-empty strings`);
    questions.push({
      id: codexAsyncQuestionId(itemId, index),
      question: title,
      header: null,
      options: ((options ?? []) as string[]).map((label) => ({ label, description: null })),
      // The native reply carries one answer string per question.
      multi_select: false,
    });
  }
  return {
    kind: "question",
    request: {
      interaction_id: interactionId,
      questions,
      source_tool: CODEX_ASYNC_QUESTION_TOOL,
      delivery: "async",
    },
  };
}

export type CodexAsyncAnswer =
  /** Steer this text into the active turn as the agent's next user message. */
  | { kind: "steer"; text: string; questionIds: string[] }
  /** Nothing answers the question (an empty set): nothing is sent. */
  | { kind: "none" }
  /** The set cannot be sent as given; nothing is sent. */
  | { kind: "refused"; reason: string };

/**
 * The native reply for the answered questions of one async interaction, in the
 * request's question order. Free text wins over selected labels, which join
 * with ", " (the convention every adapter shares).
 */
export function codexAsyncAnswer(
  request: InteractionRequest,
  answers: InteractionAnswerSet | null,
): CodexAsyncAnswer {
  if (!answers || answers.answers.length === 0) return { kind: "none" };
  const violation = interactionAnswerSetViolation(request, answers);
  if (violation) return { kind: "refused", reason: violation };
  const byId = new Map(answers.answers.map((answer) => [answer.question_id, answer]));
  const replies: Array<{ answer: string; question: string; questionItemId: string }> = [];
  for (const question of request.questions) {
    const row = byId.get(question.id);
    const content = row ? interactionAnswerContent(row) : null;
    if (!content) continue;
    replies.push({
      // serde_json renders keys sorted; keep the same order.
      answer: wellFormed(content.freeText ?? content.labels.join(", ")),
      question: framedQuestion(question.question),
      questionItemId: question.id,
    });
  }
  if (replies.length === 0) return { kind: "none" };
  // answered_question.rs falls back to plain text when an identity exceeds its bound.
  const text = replies.every(
    (reply) => Buffer.byteLength(reply.questionItemId) <= MAX_FRAMING_BYTES,
  )
    ? `${REPLY_OPEN}\n${JSON.stringify(replies)}\n${REPLY_CLOSE}`
    : replies.map((reply) => `> ${reply.question}\n\n${reply.answer}`).join("\n\n");
  const scalars = [...text].length;
  if (scalars > CODEX_TURN_INPUT_LIMIT.limit)
    return {
      kind: "refused",
      reason: `the reply is ${scalars} Unicode scalars; Codex accepts at most ${CODEX_TURN_INPUT_LIMIT.limit}`,
    };
  return { kind: "steer", text, questionIds: replies.map((reply) => reply.questionItemId) };
}

/** The question as the native reply frames it: at most 512 bytes on a character
 * boundary, line breaks as spaces. The full question stays in the interaction. */
function framedQuestion(question: string): string {
  const characters: string[] = [];
  let bytes = 0;
  for (const character of wellFormed(question)) {
    bytes += Buffer.byteLength(character);
    if (bytes > MAX_FRAMING_BYTES) break;
    characters.push(character);
  }
  return characters.join("").replace(/[\n\r]/g, " ");
}

/** A lone UTF-16 surrogate becomes U+FFFD: serde_json refuses one inside the envelope. */
function wellFormed(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD",
  );
}

/** The steer's client message id, so its userMessage echo correlates to this answer. */
export function codexAsyncAnswerMessageId(interactionId: string): string {
  return `interaction-answer:${interactionId}`;
}

/**
 * One durable status row for the native send of an async answer. `accepted`
 * proves only that Codex took the steer, `delivered` that its userMessage echo
 * was observed (the later live_input_delivered row reports a late echo); none
 * of them proves the model followed the answer.
 */
export function codexAsyncAnswerReceipt(input: {
  sessionId: string;
  interactionId: string;
  messageId: string;
  result: LiveMessageResult | { outcome: "not_sent"; reason: string };
}): HarnessEvent {
  const { result } = input;
  const detail =
    result.outcome === "not_sent"
      ? `not sent: ${result.reason}`
      : `${result.outcome}${result.reason ? ` (${result.reason})` : ""}`;
  return {
    type: "status",
    session_id: input.sessionId,
    ts: nowIso(),
    text: `answer to async question ${input.interactionId} as the agent's next message: ${detail}`,
    payload: {
      code: "interaction_answer_steer",
      interaction_id: input.interactionId,
      message_id: input.messageId,
      outcome: result.outcome,
      ...(result.reason ? { reason: result.reason } : {}),
      ...("nativeTurnId" in result && result.nativeTurnId
        ? { native_turn_id: result.nativeTurnId }
        : {}),
    },
  };
}
