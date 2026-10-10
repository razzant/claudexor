import { z } from "zod/v3";

export const ControlTimelineEvent = z
  .object({
    type: z.string().describe("Run event type."),
    ts: z.string().optional().describe("Event timestamp."),
    harnessId: z.string().nullable().default(null).describe("Harness involved, when any."),
    attemptId: z.string().nullable().default(null).describe("Attempt involved, when any."),
    messageId: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "Live-message id on message.* receipt rows and on the adapter's live_input_delivered status row, when any.",
      ),
    outcome: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "Typed live-message outcome on message.* rows (delivered | accepted | rejected | not_active | unsupported | delivery_unknown); `delivered` on the adapter's consumption status row; null elsewhere.",
      ),
    title: z.string().describe("Human-readable event title."),
    detail: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "Human-readable event detail. For typed harness text, the complete redacted text with original whitespace; title may be abbreviated.",
      ),
    textKind: z
      .enum(["thinking", "message"])
      .nullable()
      .default(null)
      .describe(
        "Normalized harness text category; null for non-text or legacy rows. Read text from detail, not the abbreviated title.",
      ),
    textDelta: z
      .boolean()
      .default(false)
      .describe(
        "True only for adapter-declared text fragments. Consecutive deltas of the same textKind and attempt may be concatenated verbatim; complete messages and other events remain separate.",
      ),
    severity: z
      .enum(["info", "warning", "error"])
      .default("info")
      .describe("Display severity of the event."),
    toolName: z.string().nullable().default(null).describe("Tool name for tool events."),
    target: z.string().nullable().default(null).describe("Redacted tool target for tool events."),
    errorSummary: z
      .string()
      .nullable()
      .default(null)
      .describe("Redacted error detail for error events."),
    /** Unsupported per-harness knobs the selected route silently could not honor
     * (INV-105): the engine discloses them on `harness.started`, and this
     * projection carries them so the row can render a visible warning ("max_turns
     * was ignored") instead of an indistinguishable benign start (QA-070). Empty
     * for every event that dropped nothing. */
    ignoredSettings: z
      .array(z.string())
      .default([])
      .describe(
        "Unsupported per-harness knobs the route could not honor (INV-105), disclosed on harness.started; empty when nothing was dropped (QA-070).",
      ),
    rawRef: z
      .string()
      .nullable()
      .default(null)
      .describe("Reference to the raw underlying event/artifact."),
  })
  .describe("One projected timeline row of a run for display.");
export type ControlTimelineEvent = z.infer<typeof ControlTimelineEvent>;
