import { z } from "zod/v3";
import { Id } from "./primitives.js";

/**
 * How a live message can enter an ALREADY RUNNING harness session (the
 * `POST /v2/runs/:id/messages` capability). `mid_turn`: the harness consumes
 * the message inside the active turn (Codex `turn/steer`). `next_tool_boundary`:
 * queued and consumed at the next tool boundary of the same turn. `none`: no
 * truthful live-input channel; the engine answers `unsupported` without any
 * native write. Declared per adapter; the POST is the run's truth.
 */
export const LiveInputCapability = z
  .enum(["mid_turn", "next_tool_boundary", "none"])
  .describe(
    "How a live message enters a running session: mid_turn (consumed inside the active turn), next_tool_boundary (queued until the same turn's next tool boundary), none (no truthful channel; the engine answers unsupported).",
  );
export type LiveInputCapability = z.infer<typeof LiveInputCapability>;

/**
 * One multiple-choice option of an interactive question (AskUserQuestion-style).
 */
export const InteractionOption = z
  .object({
    label: z.string().describe("Option label shown to the user."),
    description: z
      .string()
      .nullable()
      .default(null)
      .describe("Optional longer explanation of the option."),
  })
  .describe("One multiple-choice option of an interactive question.");
export type InteractionOption = z.infer<typeof InteractionOption>;

export const InteractionQuestion = z
  .object({
    id: Id.describe("Question id."),
    question: z.string().describe("The question text."),
    /** Short chip/header text some harnesses attach to a question. */
    header: z
      .string()
      .nullable()
      .default(null)
      .describe("Short chip/header text some harnesses attach to a question."),
    options: z
      .array(InteractionOption)
      .default([])
      .describe("Selectable options; empty for free-text-only questions."),
    multi_select: z.boolean().default(false).describe("Whether multiple options may be selected."),
  })
  .describe("One question of an interactive user-input request.");
export type InteractionQuestion = z.infer<typeof InteractionQuestion>;

/**
 * A live request for user input raised by an interactive harness session.
 * Carried on `interaction_requested` HarnessEvents and projected into
 * `interaction.requested` RunEvents.
 */
export const InteractionRequest = z
  .object({
    interaction_id: Id.describe("Interaction id used to correlate the answer set."),
    questions: z
      .array(InteractionQuestion)
      .default([])
      .describe("Questions the harness wants answered."),
    /** Native tool that raised the request (e.g. "AskUserQuestion"). */
    source_tool: z
      .string()
      .nullable()
      .default(null)
      .describe('Native tool that raised the request (e.g. "AskUserQuestion").'),
  })
  .describe("A live request for user input raised by an interactive harness session.");
export type InteractionRequest = z.infer<typeof InteractionRequest>;

export const InteractionAnswer = z
  .object({
    question_id: Id.describe("Id of the question being answered."),
    selected_labels: z.array(z.string()).default([]).describe("Labels of the selected options."),
    free_text: z
      .string()
      .nullable()
      .default(null)
      .describe("Free-text answer; null when only options were selected."),
  })
  .describe("The user's answer to one interactive question.");
export type InteractionAnswer = z.infer<typeof InteractionAnswer>;

export const InteractionAnswerSet = z
  .object({
    interaction_id: Id.describe("Interaction this answer set responds to."),
    answers: z.array(InteractionAnswer).default([]).describe("Answers, one per question."),
  })
  .describe("Typed answers delivered back into a live interactive harness session.");
export type InteractionAnswerSet = z.infer<typeof InteractionAnswerSet>;
