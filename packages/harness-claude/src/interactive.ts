import type { ChildStdin, InteractionChannel } from "@claudexor/core";
import { readVerifiedAttachmentBytes } from "@claudexor/core";
import type {
  HarnessEvent,
  HarnessRunSpec,
  InteractionAnswerSet,
  InteractionQuestion,
  InteractionRequest,
} from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";

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

export function isControlRequestFrame(obj: Json): boolean {
  return obj?.type === "control_request";
}

export function isResultFrame(obj: Json): boolean {
  return obj?.type === "result";
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

/** Initial user message frame for `--input-format stream-json` sessions. */
export function initialUserMessageFrame(
  prompt: string,
  attachments: ClaudeAttachmentBlock[] = [],
): string {
  const content = [{ type: "text", text: prompt }, ...attachments];
  return (
    JSON.stringify({
      type: "user",
      message: { role: "user", content },
    }) + "\n"
  );
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
): string {
  const initialize = JSON.stringify({
    type: "control_request",
    request_id: "req_claudexor_init",
    request: { subtype: "initialize" },
  });
  return initialize + "\n" + initialUserMessageFrame(prompt, attachments);
}

/** Map the native AskUserQuestion input into the typed InteractionRequest. */
export function interactionRequestFromNative(requestId: string, input: Json): InteractionRequest {
  const rawQuestions: Json[] = Array.isArray(input?.questions) ? input.questions : [];
  const questions: InteractionQuestion[] = rawQuestions.map((q, idx) => ({
    id: `q${idx + 1}`,
    question: redactSecrets(String(q?.question ?? "")).slice(0, 2000),
    header: typeof q?.header === "string" ? redactSecrets(q.header).slice(0, 100) : null,
    options: (Array.isArray(q?.options) ? q.options : []).map((o: Json) => ({
      label: redactSecrets(String(o?.label ?? "")).slice(0, 500),
      description:
        typeof o?.description === "string" ? redactSecrets(o.description).slice(0, 1000) : null,
    })),
    multi_select: q?.multiSelect === true,
  }));
  return { interaction_id: requestId, questions, source_tool: "AskUserQuestion" };
}

/**
 * Build the allow control_response carrying the user's answers.
 * Per the documented contract, `answers` maps the QUESTION TEXT to the
 * selected label, multi-select labels joined with ", ", free text passed
 * through verbatim.
 */
export function allowResponseFrame(
  requestId: string,
  nativeInput: Json,
  request: InteractionRequest,
  answers: InteractionAnswerSet,
): string {
  const byId = new Map(answers.answers.map((a) => [a.question_id, a]));
  const answerMap: Record<string, string> = {};
  for (const q of request.questions) {
    const a = byId.get(q.id);
    if (!a) continue;
    const labels = a.selected_labels.filter((l) => l.trim().length > 0);
    const value =
      a.free_text && a.free_text.trim().length > 0 ? a.free_text.trim() : labels.join(", ");
    if (value) answerMap[q.question] = value;
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

/** Deny control_response: benign decline; the model continues with assumptions. */
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

export const DECLINE_MESSAGE =
  "No user answer is available (declined or timed out). Continue with your best assumptions and state them explicitly.";

/**
 * Handle one control_request frame. AskUserQuestion is routed through the
 * orchestrator's InteractionChannel (pausing only this tool); every other
 * permission request is DENIED — flag-based permission modes already encode
 * the run's policy, and headless print-mode behavior (no interactive approver)
 * must not be silently liberalized by the control channel.
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
  if (toolName !== "AskUserQuestion" || !channel) {
    io.write(
      denyResponseFrame(
        requestId,
        toolName === "AskUserQuestion"
          ? DECLINE_MESSAGE
          : "Not permitted by Claudexor policy for this run.",
      ),
    );
    return;
  }

  const interaction = interactionRequestFromNative(requestId, request?.input ?? {});
  yield {
    type: "interaction_requested",
    session_id: sessionId,
    ts: nowIso(),
    text: interaction.questions
      .map((q) => q.question)
      .join(" | ")
      .slice(0, 500),
    interaction,
  };

  let answers: InteractionAnswerSet | null = null;
  try {
    answers = await channel.request(interaction);
  } catch {
    answers = null;
  }

  if (answers && answers.answers.length > 0) {
    io.write(allowResponseFrame(requestId, request?.input ?? {}, interaction, answers));
  } else {
    io.write(denyResponseFrame(requestId, DECLINE_MESSAGE));
  }
}
