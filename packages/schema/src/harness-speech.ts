import { z } from "zod/v3";

/** What a keyed text event does to its speech (one owner for every projection of it). */
export const HarnessSpeechOp = z
  .enum(["fragment", "complete", "abandoned"])
  .describe(
    "fragment: a verbatim streamed piece of the keyed text block; complete: the harness's complete text of that block (at most once per key); abandoned: the harness stated the block will never be completed (partial fragments stay as emitted).",
  );
export type HarnessSpeechOp = z.infer<typeof HarnessSpeechOp>;

/**
 * Adapter-issued identity of ONE natively observed text block lifecycle: one
 * block of one observed response incarnation in one parser instance. The key
 * is opaque (compare by equality only) and is never derived from text,
 * timing, adjacency, frame counts or native-id equality alone. Absent on every
 * text event whose block lifecycle or completion was not exactly observed;
 * such text stays a separate legacy segment.
 */
export const HarnessSpeech = z
  .object({
    key: z
      .string()
      .min(1)
      .describe("Opaque adapter-issued key of one observed text block; equality only."),
    op: HarnessSpeechOp,
  })
  .strict()
  .describe("Adapter-issued identity and operation of one keyed text event.");
export type HarnessSpeech = z.infer<typeof HarnessSpeech>;

export const HarnessSpeechEventFields = {
  speech: HarnessSpeech.optional().describe(
    "Adapter-issued speech identity of a text event (fragment/complete on messages, abandoned on a status event); absent when no block lifecycle was exactly observed. A typed final never carries it unless the adapter proves the link.",
  ),
};
