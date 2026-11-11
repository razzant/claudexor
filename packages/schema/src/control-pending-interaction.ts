import { z } from "zod/v3";
import { InteractionDelivery, InteractionQuestion } from "./harness.js";
import { Id } from "./primitives.js";

/** A live interaction awaiting the user's answer (snapshot projection). */
export const ControlPendingInteraction = z
  .object({
    interactionId: Id.describe("Interaction id used to answer."),
    runId: Id.describe("Run the interaction belongs to."),
    attemptId: z
      .string()
      .nullable()
      .default(null)
      .describe("Attempt the interaction was raised in, when known."),
    harnessId: z.string().nullable().default(null).describe("Harness that raised the interaction."),
    sourceTool: z
      .string()
      .nullable()
      .default(null)
      .describe("Native tool that raised the request."),
    questions: z.array(InteractionQuestion).default([]).describe("Questions awaiting answers."),
    requestedAt: z.string().describe("When the interaction was requested."),
    timeoutAt: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "When the interaction expires unanswered; null = no automatic expiry. A blocking question then declines benignly; an async one closes and nothing is sent.",
      ),
    delivery: InteractionDelivery.default("blocking"),
  })
  .describe("A live interactive question awaiting the user's answer (snapshot projection).");
export type ControlPendingInteraction = z.infer<typeof ControlPendingInteraction>;

/**
 * The one derivation of a run's question attention from its pending rows:
 * `waitingOnUser` while any question is pending, `asyncQuestionsOnly` while
 * questions are pending and none of them holds the agent. A mixed set is never
 * async-only, so a blocking question cannot hide behind a non-blocking one.
 */
export function pendingQuestionAttention(
  pending: readonly Pick<ControlPendingInteraction, "delivery">[],
): { waitingOnUser: boolean; asyncQuestionsOnly: boolean } {
  return {
    waitingOnUser: pending.length > 0,
    asyncQuestionsOnly:
      pending.length > 0 && pending.every((interaction) => interaction.delivery === "async"),
  };
}
