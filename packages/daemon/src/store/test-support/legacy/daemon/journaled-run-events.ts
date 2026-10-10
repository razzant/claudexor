import { createHash } from "node:crypto";
import { JournaledRunCreatedPayload, type RunEvent, type RunEventType } from "@claudexor/schema";

/**
 * Run events whose copy the owning global/project journal partition keeps
 * durably: the lifecycle-significant subset (run announced, a question asked
 * or resolved, output ready, terminal). Per-token `harness.event` deltas and
 * every other progress event reach only the per-run `events.jsonl` and the
 * in-process bus. Consumers of the journaled copy: the daemon's durable
 * terminal recovery (terminal types only) and the global journal stream, whose
 * macOS client reacts to `run.created`, `interaction.requested` and terminals.
 */
export const JOURNALED_RUN_EVENT_TYPES: ReadonlySet<RunEventType> = new Set<RunEventType>([
  "run.created",
  "interaction.requested",
  "interaction.answered",
  "interaction.timeout",
  "message.accepted",
  "message.delivered",
  "message.refused",
  "output.ready",
  "run.completed",
  "run.failed",
  "run.blocked",
]);

/**
 * Audit rows the control API may append AFTER a run's terminal event without
 * conflicting with terminal authority: the cancel audit (`control.*`) and the
 * live-message receipts (`message.*`). A receipt that lands after terminal
 * commit is file-tail-stamped into events.jsonl (durable; visible on the next
 * timeline read; only the live SSE push is missed). Consumed by the
 * CommandStore's per-run log validator.
 */
export const POST_TERMINAL_AUDIT_EVENT_TYPES: ReadonlySet<string> = new Set<RunEventType>([
  "control.requested",
  "control.applied",
  "control.rejected",
  "message.accepted",
  "message.delivered",
  "message.refused",
]);

export function isJournaledRunEvent(event: Pick<RunEvent, "type">): boolean {
  return JOURNALED_RUN_EVENT_TYPES.has(event.type);
}

/**
 * The journal copy of `run.created` carries the prompt's sha256 and byte
 * length instead of the prompt text (the accepted command already holds the
 * prompt; the per-run `events.jsonl` keeps it too). The copy of a live-message
 * receipt (`message.*`) drops the message `text` the same way: its digest
 * fields (`text_sha256`, `text_bytes`) already ride the row, and the plaintext
 * lives only in the per-run `events.jsonl`. Every other journaled event is
 * stored exactly as emitted.
 */
export function journaledRunEventCopy(event: RunEvent): RunEvent {
  if (
    event.type === "message.accepted" ||
    event.type === "message.delivered" ||
    event.type === "message.refused"
  ) {
    if (typeof event.payload["text"] !== "string") return event;
    const { text: _text, ...digest } = event.payload;
    return { ...event, payload: digest };
  }
  if (event.type !== "run.created") return event;
  const { prompt, ...rest } = event.payload;
  if (typeof prompt !== "string") return event;
  return {
    ...event,
    payload: JournaledRunCreatedPayload.parse({
      ...rest,
      prompt_sha256: createHash("sha256").update(prompt, "utf8").digest("hex"),
      prompt_bytes: Buffer.byteLength(prompt, "utf8"),
    }),
  };
}
