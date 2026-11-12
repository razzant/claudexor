import { randomUUID } from "node:crypto";
import type { ChildStdin, ChildStdinSend, InteractionChannel } from "@claudexor/core";
import { readVerifiedAttachmentBytes } from "@claudexor/core";
import type {
  HarnessEvent,
  HarnessRunSpec,
  InteractionAnswerSet,
  InteractionQuestion,
  InteractionRequest,
} from "@claudexor/schema";
import { interactionAnswerContent, interactionAnswerSetViolation } from "@claudexor/schema";
import { displayPreview, nowIso } from "@claudexor/util";
import {
  questionUnavailableEvent,
  unavailableDenyMessage,
  type NativeQuestionIds,
} from "./question-outcome.js";

type Json = any;

/**
 * Claude Code bidirectional stream-json control protocol (the same channel the
 * Agent SDK's `canUseTool` rides on):
 *
 *   CLI -> client : {"type":"control_request","request_id":X,
 *                    "request":{"subtype":"can_use_tool","tool_name":T,"input":I,...}}
 *   client -> CLI : {"type":"control_response","response":{"subtype":"success",
 *                    "request_id":X,"response":{"behavior":"allow"|"deny",...}}}
 *
 * For AskUserQuestion the answers ride in `updatedInput.answers` as a record of
 * question text -> selected label(s) (docs: "Handle approvals and user input").
 * Frame shapes are LIVE-VERIFIED against Claude Code 2.1.165: the full
 * bidirectional exchange (initialize -> can_use_tool -> allow -> ok
 * tool_result -> result) is recorded in fixtures/protocol/control-handshake.jsonl.
 * The control channel only activates with `--permission-prompt-tool stdio`;
 * without it the headless CLI auto-denies interactive tools itself.
 */

/**
 * Request id of the ONE initialize handshake this adapter sends. Interactive
 * runs write it as the first stdin frame; the prompt-free model probe sends the
 * same frame alone and selects the CLI's answer by this id (hook frames may
 * precede it), so both must share one literal.
 */
export const CLAUDE_INIT_REQUEST_ID = "req_claudexor_init";

export function isControlRequestFrame(obj: Json): boolean {
  return obj?.type === "control_request";
}

export function isResultFrame(obj: Json): boolean {
  return obj?.type === "result";
}

/** A result that ends its turn successfully: subtype `success` (or none) and
 * not `is_error` (a `prompt_too_long` error result is still labelled success). */
export function isSuccessResultFrame(obj: Json): boolean {
  return isResultFrame(obj) && (!obj.subtype || obj.subtype === "success") && obj.is_error !== true;
}

/** A Claude stream-json image content block (base64 source). Claude carries
 *  images ONLY on the stdin stream-json transport — a one-shot `-p` argv run
 *  cannot, so a turn with attachments must use the interactive path. */
export interface ClaudeImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}
export interface ClaudeTextBlock {
  type: "text";
  text: string;
}
export type ClaudeAttachmentBlock = ClaudeImageBlock | ClaudeTextBlock;

/** Bind finalized bytes once, then build Claude stream-json content blocks. */
export function claudeAttachmentBlocks(
  attachments: HarnessRunSpec["attachments"] | undefined,
): ClaudeAttachmentBlock[] {
  return (attachments ?? []).map((attachment) => {
    const bytes = readVerifiedAttachmentBytes(attachment);
    return attachment.kind === "image"
      ? {
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: attachment.mime,
            data: bytes.toString("base64"),
          },
        }
      : {
          type: "text" as const,
          text: `Attached file ${attachment.name || attachment.resource_id} (${attachment.mime}, ${attachment.sha256}):\n${bytes.toString("utf8")}`,
        };
  });
}

/**
 * One stream-json user message frame (`--input-format stream-json`). The
 * `uuid` is the CLI's identity for the message: with `--replay-user-messages`
 * the CLI echoes the frame back as `{type:"user", isReplay:true, uuid}` and
 * lists every consumed uuid in `result.user_message_uuids` — the receipts the
 * live-input owner (live-input.ts) correlates. Shape recorded on 2.1.283.
 */
export function userMessageFrame(
  text: string,
  uuid: string,
  attachments: ClaudeAttachmentBlock[] = [],
): string {
  const content = [{ type: "text", text }, ...attachments];
  return (
    JSON.stringify({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      uuid,
    }) + "\n"
  );
}

/** Initial user message frame; its own uuid keeps its replay echo identifiable
 * (and ignored) beside the live messages' echoes. */
export function initialUserMessageFrame(
  prompt: string,
  attachments: ClaudeAttachmentBlock[] = [],
  uuid: string = randomUUID(),
): string {
  return userMessageFrame(prompt, uuid, attachments);
}

/**
 * Initial stdin block for an interactive session: the initialize handshake
 * (announces a live control-protocol client) followed by the user message.
 * Live-verified against Claude Code 2.1.165: both frames may be written in
 * one block without waiting for the initialize response
 * (fixtures/protocol/control-handshake.jsonl).
 */
export function initialSessionFrames(
  prompt: string,
  attachments: ClaudeAttachmentBlock[] = [],
  promptUuid: string = randomUUID(),
): string {
  const initialize = JSON.stringify({
    type: "control_request",
    request_id: CLAUDE_INIT_REQUEST_ID,
    request: { subtype: "initialize" },
  });
  return initialize + "\n" + initialUserMessageFrame(prompt, attachments, promptUuid);
}

/** Map the native AskUserQuestion input into the typed InteractionRequest.
 * Question, header, option label and description are the native text exactly,
 * whatever their length: every answering surface shows what the model asked
 * and a selected label goes back byte-identical (INV-146). */
export function interactionRequestFromNative(requestId: string, input: Json): InteractionRequest {
  const rawQuestions: Json[] = Array.isArray(input?.questions) ? input.questions : [];
  const questions: InteractionQuestion[] = rawQuestions.map((q, idx) => ({
    id: `q${idx + 1}`,
    question: String(q?.question ?? ""),
    header: typeof q?.header === "string" ? q.header : null,
    options: (Array.isArray(q?.options) ? q.options : []).map((o: Json) => ({
      label: String(o?.label ?? ""),
      description: typeof o?.description === "string" ? o.description : null,
    })),
    multi_select: q?.multiSelect === true,
  }));
  // AskUserQuestion holds its tool call until the control_response arrives.
  return {
    interaction_id: requestId,
    questions,
    source_tool: "AskUserQuestion",
    delivery: "blocking",
  };
}

/**
 * Build the allow control_response carrying the user's answers, or null when
 * the set answers nothing: an explicit decline (no rows) or a set this request
 * cannot accept (`interactionAnswerSetViolation`) is never sent as an allow.
 * Per the documented contract, `answers` maps the QUESTION TEXT to the
 * selected label, multi-select labels joined with ", ", free text passed
 * through verbatim. The key is the native question text, so a long question
 * still matches its answer.
 */
export function allowResponseFrame(
  requestId: string,
  nativeInput: Json,
  request: InteractionRequest,
  answers: InteractionAnswerSet,
): string | null {
  if (answers.answers.length === 0 || interactionAnswerSetViolation(request, answers)) return null;
  const byId = new Map(answers.answers.map((a) => [a.question_id, a]));
  const answerMap: Record<string, string> = {};
  const nativeQuestions: Json[] = Array.isArray(nativeInput?.questions)
    ? nativeInput.questions
    : [];
  for (const [index, q] of request.questions.entries()) {
    const a = byId.get(q.id);
    const content = a ? interactionAnswerContent(a) : null;
    if (!content) continue;
    const native = nativeQuestions[index]?.question;
    answerMap[typeof native === "string" ? native : q.question] =
      content.freeText ?? content.labels.join(", ");
  }
  return (
    JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: {
          behavior: "allow",
          updatedInput: { questions: nativeInput?.questions ?? [], answers: answerMap },
        },
      },
    }) + "\n"
  );
}

/** Deny control_response: the model continues without an answer; `message` tells it why. */
export function denyResponseFrame(requestId: string, message: string): string {
  return (
    JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: { behavior: "deny", message, interrupt: false },
      },
    }) + "\n"
  );
}

/** Error control_response for request subtypes this adapter does not handle. */
export function errorResponseFrame(requestId: string, error: string): string {
  return (
    JSON.stringify({
      type: "control_response",
      response: { subtype: "error", request_id: requestId, error },
    }) + "\n"
  );
}

/** The benign decline for a channel that returned no answer (declined, expired
 * or released); its typed interaction events carry which, when known. */
export const DECLINE_MESSAGE =
  "No user answer is available (declined or timed out). Continue with your best assumptions and state them explicitly.";

type QuestionWait =
  | { kind: "answer"; answers: InteractionAnswerSet | null }
  | { kind: "failed"; error: unknown }
  | { kind: "closed" };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "unknown";
}

/** Write a response and learn whether it could reach the process: `send` where
 * the handle reports it (the run loop's), else a plain write, whose throw is
 * the only failure it can show. The process closing ends the wait. */
async function sendResponse(io: ChildStdin, frame: string): Promise<ChildStdinSend> {
  if (!io.send) {
    try {
      io.write(frame);
      return { outcome: "written" };
    } catch (error) {
      return { outcome: "not_written", reason: "failed", error: errorText(error) };
    }
  }
  return Promise.race([
    io.send(frame),
    io.closed.then((): ChildStdinSend => ({ outcome: "not_written", reason: "exited" })),
  ]);
}

/**
 * Handle one control_request frame. AskUserQuestion is routed through the
 * orchestrator's InteractionChannel (pausing only this tool); every other
 * permission request is DENIED — flag-based permission modes already encode
 * the run's policy, and headless print-mode behavior (no interactive approver)
 * must not be silently liberalized by the control channel. When Claudexor
 * itself cannot obtain or send an answer (no channel, a failed channel, a
 * closed process, a failed write) it records that as a status event and never
 * presents it to the model or the run as the user's decline (#622).
 */
export async function* handleControlRequestFrame(
  obj: Json,
  io: ChildStdin,
  sessionId: string,
  channel: InteractionChannel | undefined,
): AsyncGenerator<HarnessEvent> {
  const requestId = String(obj?.request_id ?? "");
  const request: Json = obj?.request ?? {};
  const subtype = String(request?.subtype ?? "");

  if (subtype !== "can_use_tool") {
    io.write(
      errorResponseFrame(requestId, `unsupported control request subtype: ${subtype || "(none)"}`),
    );
    return;
  }

  const toolName = String(request?.tool_name ?? "");
  if (toolName !== "AskUserQuestion") {
    io.write(denyResponseFrame(requestId, "Not permitted by Claudexor policy for this run."));
    return;
  }

  const ids: NativeQuestionIds = {
    interactionId: requestId,
    toolUseId: typeof request?.tool_use_id === "string" ? request.tool_use_id : null,
  };
  // A response that cannot reach the process is recorded as its own status; an
  // optional question never fails the run loop.
  const respond = async function* (frame: string): AsyncGenerator<HarnessEvent> {
    const sent = await sendResponse(io, frame);
    if (sent.outcome === "written") return;
    yield sent.reason === "exited"
      ? questionUnavailableEvent(sessionId, ids, "process_closed")
      : questionUnavailableEvent(sessionId, ids, "response_write_failed", {
          error: sent.error ?? "stdin was already ended",
        });
  };
  if (!channel) {
    yield questionUnavailableEvent(sessionId, ids, "no_answer_channel");
    yield* respond(denyResponseFrame(requestId, unavailableDenyMessage("no_answer_channel")));
    return;
  }

  const interaction = interactionRequestFromNative(requestId, request?.input ?? {});
  yield {
    type: "interaction_requested",
    session_id: sessionId,
    ts: nowIso(),
    // A marked display label; answers are keyed from the native input below.
    text: displayPreview(interaction.questions.map((q) => q.question).join(" | "), 500),
    interaction,
    // Joins this interaction to the tool call and its result (#622).
    ...(ids.toolUseId ? { payload: { tool_use_id: ids.toolUseId } } : {}),
  };

  let answer: Promise<QuestionWait>;
  try {
    answer = Promise.resolve(channel.request(interaction)).then(
      (answers): QuestionWait => ({ kind: "answer", answers }),
      (error: unknown): QuestionWait => ({ kind: "failed", error }),
    );
  } catch (error) {
    // A channel that throws synchronously failed like one that rejects.
    answer = Promise.resolve({ kind: "failed", error });
  }
  const result = await Promise.race([
    answer,
    io.closed.then((): QuestionWait => ({ kind: "closed" })),
  ]);
  // The process owns this protocol channel. Once it is gone there is nowhere
  // to deliver even a benign deny frame; runloop consumes the already-queued
  // exit and terminal cleanup releases the durable question.
  if (result.kind === "closed") {
    yield questionUnavailableEvent(sessionId, ids, "process_closed");
    return;
  }
  if (result.kind === "failed") {
    yield questionUnavailableEvent(sessionId, ids, "answer_channel_failed", {
      error: errorText(result.error),
    });
    yield* respond(denyResponseFrame(requestId, unavailableDenyMessage("answer_channel_failed")));
    return;
  }
  const answers = result.answers;
  const allow = answers
    ? allowResponseFrame(requestId, request?.input ?? {}, interaction, answers)
    : null;
  yield* respond(allow ?? denyResponseFrame(requestId, DECLINE_MESSAGE));
}
