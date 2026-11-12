import { z } from "zod/v3";
import { RunEventType } from "./events.js";
import { Id } from "./primitives.js";

/** One UTF-8 character always fits, so every part makes progress. */
export const RUN_EVENT_PART_MIN_BYTES = 4;
export const RUN_EVENT_PART_MAX_BYTES = 65_536;
export const RUN_EVENT_PART_DEFAULT_BYTES = 32_768;

const byteOffset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const eventSeq = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Body of `GET /v2/runs/:id/events/:seq`: one bounded part of one addressed event. */
export const ControlRunEventPart = z
  .object({
    runId: Id.describe("Canonical run id."),
    seq: eventSeq.describe("Durable seq of the event (its event-stream id)."),
    type: RunEventType,
    totalBytes: z
      .number()
      .int()
      .positive()
      .describe(
        "UTF-8 byte length of the event's complete stream serialization: the stored JSON line the run event stream delivers.",
      ),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe("SHA-256 of all totalBytes; verify the reassembled text before parsing it."),
    offset: byteOffset.describe("UTF-8 byte offset where this part starts."),
    nextOffset: byteOffset.describe(
      "Where the next part starts; equal to totalBytes when this part ends the event.",
    ),
    text: z
      .string()
      .describe(
        "Bytes [offset, nextOffset) decoded as UTF-8; a boundary never splits a character.",
      ),
  })
  .strict()
  .describe(
    "One bounded part of a single validated run event, read from the run's own event log by run id and seq. Concatenate parts in offset order until nextOffset equals totalBytes; only then is the event consumed.",
  );
export type ControlRunEventPart = z.infer<typeof ControlRunEventPart>;

export const McpRunEventReadInput = z
  .object({
    runId: z.string().trim().min(1).max(256),
    seq: eventSeq.describe("The event to read, e.g. claudexor_run_wait's oversizedEvent.seq."),
    offset: byteOffset.default(0).describe("0, or the previous part's nextOffset."),
    maxBytes: z
      .number()
      .int()
      .min(RUN_EVENT_PART_MIN_BYTES)
      .max(RUN_EVENT_PART_MAX_BYTES)
      .default(RUN_EVENT_PART_DEFAULT_BYTES)
      .describe(
        "Upper bound of this part's UTF-8 bytes; a part may end earlier at a character boundary.",
      ),
  })
  .strict();
export type McpRunEventReadInput = z.infer<typeof McpRunEventReadInput>;
