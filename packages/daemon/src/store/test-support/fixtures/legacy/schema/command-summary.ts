import type { RecordedControlRunStartRequest } from "./control.js";

/** The complete request-derived whitelist consumed by run summaries, thread
 * activity/delivery and continuation admission. Prompts, instructions and
 * arbitrary request extensions never travel with collection answers.
 * Historical malformed values remain readable by the consumer's safe parsers. */
export const COMMAND_SUMMARY_PARAM_KEYS = [
  "mode",
  "routingGoal",
  "access",
  "reviewerPanel",
  "protectedPathApprovals",
  "tests",
  "untilClean",
  "attempts",
  "create",
  "deepScan",
  "n",
  "council",
  "delegate",
  "harnesses",
  "primaryHarness",
  "model",
  "models",
  "review",
  "paidBudget",
  "parentRunId",
  "delegatedFromRunId",
  "continueFrom",
  "threadId",
  "turnId",
  "scope",
  "execution",
] as const satisfies readonly (keyof RecordedControlRunStartRequest)[];
export type CommandSummaryParams = Partial<
  Pick<RecordedControlRunStartRequest, (typeof COMMAND_SUMMARY_PARAM_KEYS)[number]>
>;
