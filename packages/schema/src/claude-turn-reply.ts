import { z } from "zod/v3";

/** Older same-major clients strictly decode both history and raw event parts. */
export const CLAUDE_TURN_REPLIES_HEADER = "x-claudexor-claude-turn-replies";

export const ClaudeTurnReplySource = z
  .object({
    attemptId: z.string().nullable(),
    sessionId: z.string().nullable(),
    afterStop: z.boolean().nullable(),
  })
  .strict();
export type ClaudeTurnReplySource = z.infer<typeof ClaudeTurnReplySource>;

/** The engine owns after_stop. Older journals cannot establish Stop timing. */
export function claudeTurnReply(payload: Record<string, unknown>) {
  if (
    payload.harness_id !== "claude" ||
    payload.type !== "message" ||
    payload.final !== true ||
    payload.buffered === true ||
    (payload.payload as Record<string, unknown> | null)?.buffered === true ||
    typeof payload.text !== "string" ||
    !payload.text.length
  )
    return null;
  return {
    text: payload.text,
    source: {
      attemptId:
        typeof payload.attempt_id === "string" && payload.attempt_id ? payload.attempt_id : null,
      sessionId:
        typeof payload.session_id === "string" && payload.session_id ? payload.session_id : null,
      afterStop: typeof payload.after_stop === "boolean" ? payload.after_stop : null,
    } satisfies ClaudeTurnReplySource,
  };
}
