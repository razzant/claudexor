/**
 * The continuation notice (B1): what a continued vendor process is told.
 *
 * On a NATIVE carrier the original prompt is never resent — the transcript
 * already holds it — so the engine sends one constant notice as the user
 * prompt, followed by the caller's text when any. Every new fact travels in
 * the prompt, never in `instructions`: Claude Code records the system prompt on
 * the first request and resends that record on resume, so instructions are not
 * a continuation channel.
 *
 * On a PACKET carrier the successor is a fresh session: it receives the
 * original prompt (engine constraints included), the notice and the bounded
 * evidence index.
 *
 * Unknown input (R3-Astra): when the predecessor's last input may not be in
 * the vendor history (a crash between recovery and the turn start), the notice
 * carries it as a reference to reconcile against the observed work — never as a
 * blind replay.
 */
import type { ResumableCause } from "@claudexor/schema";

const CAUSE_PHRASE: Record<ResumableCause, string> = {
  vendor_limit: "a usage limit on the previous account",
  pool_exhausted: "every account's usage limit",
  pinned_limit: "the pinned account's usage limit",
  transport: "an error without a typed cause",
  permission_denied: "a native tool permission was refused (no automatic privilege escalation)",
  context_exhausted: "the context window was exhausted",
  turn_limit: "the max-turns limit set for it was reached",
  wall_clock: "the wall-clock deadline",
  cancelled: "a cancel",
  host_restart: "a host restart",
  input_required: "a request for input",
  other: "an interruption",
};

export interface ContinuationNoticeInput {
  cause: ResumableCause;
  /** A succeeded predecessor without unfinished work receives a neutral follow-up. */
  completed?: boolean;
  /** The predecessor's last input when its delivery is uncertain; null when confirmed. */
  uncertainInput: string | null;
  /** The caller's own continuation text (`continueFrom` prompt); null in-run. */
  callerText: string | null;
}

/** The constant notice a continued process receives as its user prompt. */
export function continuationNotice(input: ContinuationNoticeInput): string {
  const parts = [
    input.completed
      ? "Continue from the previous work. Check the current workspace before making further changes. Finish with a self-contained final message: this process's final message alone is the run's answer."
      : `The previous process stopped (${CAUSE_PHRASE[input.cause]}). Continue the task from where it stopped. The workspace is as it was left. A tool call that was cut off may or may not have taken effect: check before repeating it. Finish with a self-contained final message: this process's final message alone is the run's answer.`,
  ];
  if (input.uncertainInput !== null && input.uncertainInput.trim()) {
    parts.push(
      `The last instruction sent to the previous process may not have been delivered. It was:\n\n${input.uncertainInput.trim()}\n\nReconcile it against the work you observe; do not replay it blindly.`,
    );
  }
  if (input.callerText !== null && input.callerText.trim()) parts.push(input.callerText.trim());
  return parts.join("\n\n");
}

/** Pointer to the evidence index of a packet carrier (fresh session). */
export function evidenceIndexPointer(
  path: string,
  inlineMarkdown: string,
  completed = false,
): string {
  const prior = completed
    ? "The previous work is recorded in its evidence index."
    : "Earlier work on this task was done by another process that could not finish.";
  return `${prior} Its evidence index is at: ${path} — read it before continuing. The same index follows:\n\n${inlineMarkdown}`;
}

/** The packet carrier's prompt: original prompt (constraints included) + notice + evidence
 * index; a route that cannot read files also gets the complete work order the index cuts. */
export function packetContinuationPrompt(input: {
  originalPrompt: string;
  notice: string;
  evidencePath: string;
  evidenceMarkdown: string;
  completed?: boolean;
  workOrder?: string | null;
}): string {
  return [
    input.originalPrompt,
    input.notice,
    ...(input.workOrder ? [`The complete work order:\n\n${input.workOrder}`] : []),
    evidenceIndexPointer(input.evidencePath, input.evidenceMarkdown, input.completed),
  ].join("\n\n");
}
