import { z } from "zod";
import { InterviewAnswer, InterviewQuestion } from "./spec.js";
import { ExternalContextPolicy, NonBlankString, ProviderFamily } from "./primitives.js";
import { EffortHint } from "./harness.js";
import { ControlReviewerPanelEntry } from "./control.js";
import { RunScopeContext } from "./control-run-scope.js";

export const ControlSpecPriorDecision = z
  .object({
    question: z.string().describe("Question asked in a prior tier."),
    answer: z.string().describe("The user's answer."),
  })
  .strict();

export const ControlSpecQuestionsRequest = z
  .object({
    prompt: z.string().min(1).describe("The user's request the interview is clarifying."),
    scope: z
      .object({
        kind: z.literal("project"),
        root: z.string().describe("Absolute path of the project root."),
        context: RunScopeContext.default("auto"),
      })
      .strict()
      .describe("Project the spec is about."),
    harnesses: z
      .array(NonBlankString)
      .optional()
      .describe("Harnesses eligible to generate the questions."),
    n: z.number().int().positive().optional(),
    effort: EffortHint.optional(),
    maxUsd: z.number().nonnegative().optional(),
    web: ExternalContextPolicy.optional(),
    reviewerModels: z.record(ProviderFamily, NonBlankString).optional(),
    reviewerEfforts: z.record(ProviderFamily, EffortHint).optional(),
    reviewerPanel: z.array(ControlReviewerPanelEntry).min(1).optional(),
    priorDecisions: z
      .array(ControlSpecPriorDecision)
      .optional()
      .describe("Prior-tier decisions carried into the next interview tier."),
  })
  .strict()
  .describe("Request to create a durable spec interview session.");
export type ControlSpecQuestionsRequest = z.infer<typeof ControlSpecQuestionsRequest>;

export const ControlSpecAnswersRequest = z
  .object({
    answers: z.array(InterviewAnswer).describe("Answers for the current interview tier."),
    priorDecisions: z.array(ControlSpecPriorDecision).optional(),
  })
  .strict()
  .describe("Answers recorded against a durable spec session.");
export type ControlSpecAnswersRequest = z.infer<typeof ControlSpecAnswersRequest>;

export const ControlSpecSessionState = z.enum([
  "grounding",
  "questions",
  "answered",
  "freezing",
  "frozen",
  "cancelled",
  "failed",
  "interrupted_unknown",
]);
export type ControlSpecSessionState = z.infer<typeof ControlSpecSessionState>;

export const ControlSpecSession = z
  .object({
    sessionId: NonBlankString,
    prompt: z.string(),
    scope: z
      .object({ kind: z.literal("project"), root: z.string(), context: RunScopeContext })
      .strict(),
    state: ControlSpecSessionState,
    planRunId: z.string().nullable(),
    questions: z.array(InterviewQuestion),
    answers: z.array(InterviewAnswer),
    priorDecisions: z.array(ControlSpecPriorDecision),
    specId: z.string().nullable(),
    specDir: z.string().nullable(),
    specPath: z.string().nullable(),
    specHash: z.string().nullable(),
    error: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict()
  .describe("Durable public projection of a spec interview session.");
export type ControlSpecSession = z.infer<typeof ControlSpecSession>;

export const ControlSpecSessionListResponse = z
  .object({ sessions: z.array(ControlSpecSession) })
  .strict();
export type ControlSpecSessionListResponse = z.infer<typeof ControlSpecSessionListResponse>;
