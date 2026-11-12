import { z } from "zod/v3";
import {
  ControlSession,
  ControlThread,
  ControlThreadTurn,
  ControlTurnRunCard,
  ControlRunSummary,
  ControlRunState,
} from "./control.js";
import { ControlPrimaryOutput, ControlRunDetail } from "./control-run-detail.js";
import { ControlRunEventPart } from "./control-run-event-part.js";
import { ControlHandshakeResponse } from "./operation.js";

export const THREAD_HISTORY_MAX_TURNS = 20;
export const THREAD_HISTORY_PROMPT_BYTES = 32_768;
export const THREAD_HISTORY_ANSWER_BYTES = 65_536;
export const THREAD_HISTORY_FAILURE_BYTES = 8_192;
export const THREAD_HISTORY_PAGE_BYTES = 2_097_152;
export const THREAD_HISTORY_ROW_BYTES = 851_968;
export const THREAD_HISTORY_HEADER_BYTES = 32_768;
export const THREAD_HISTORY_METADATA_BYTES = 32_768;
export const THREAD_HISTORY_SESSION_LIMIT = 16;
export const THREAD_HISTORY_FACT_BYTES = 1_048_576;
export const THREAD_HISTORY_EVENT_BYTES = 262_144;
const id = ControlThread.shape.id.max(256);
const ordinal = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const cursor = z.string().min(1).max(2048);
const storeId = ControlHandshakeResponse.shape.storeId.unwrap();

export const ThreadHistoryInput = z
  .object({
    threadId: id,
    limit: z.number().int().min(1).max(THREAD_HISTORY_MAX_TURNS).default(THREAD_HISTORY_MAX_TURNS),
    cursor: cursor.optional(),
    beforeTurnId: id.optional(),
    afterTurnId: id.optional(),
    aroundTurnId: id.optional(),
    expectedStoreId: storeId.optional(),
  })
  .strict()
  .refine(
    (v) =>
      [v.cursor, v.beforeTurnId, v.afterTurnId, v.aroundTurnId].filter((v) => v !== undefined)
        .length <= 1,
    "choose at most one cursor, beforeTurnId, afterTurnId or aroundTurnId",
  );
export type ThreadHistoryInput = z.infer<typeof ThreadHistoryInput>;

/** An observation order, not a turn ordinal or a wall-clock timestamp. */
export const ThreadHistoryRevision = z
  .object({
    epoch: z
      .string()
      .uuid()
      .describe("Read-owner incarnation; compare sequence only within this epoch."),
    sequence: ordinal.describe(
      "Allocated before synchronous projection. A later snapshot always has a greater sequence.",
    ),
  })
  .strict();
export type ThreadHistoryRevision = z.infer<typeof ThreadHistoryRevision>;

export const ThreadHistoryTextFacts = z
  .object({
    textBytes: ordinal,
    totalTextBytes: ordinal
      .nullable()
      .describe("Complete UTF-8 length, only when known; never an estimated remainder."),
    truncated: z.boolean(),
  })
  .strict();
export const ThreadHistoryOutput = ControlPrimaryOutput.extend(
  ThreadHistoryTextFacts.shape,
).strict();
const count = z
  .object({
    value: ordinal.nullable(),
    coverage: z.enum(["complete", "partial", "unavailable"]),
  })
  .strict();
const runStatus = z.enum(["available", "unbound", "not_retained"]);
export const ThreadHistoryRun = ControlTurnRunCard.extend({
  ...ControlRunSummary.pick({
    runDir: true,
    authRoute: true,
    harnesses: true,
    primaryHarness: true,
    startedAt: true,
    createdAt: true,
    spendEstimated: true,
    route: true,
  }).shape,
  ...ControlRunDetail.pick({
    budget: true,
    failure: true,
    applyEligibility: true,
    requiredActions: true,
    planReadiness: true,
    planQuestions: true,
    outcomeBanner: true,
    operatorDecision: true,
    runFacts: true,
  }).shape,
  applyEligibilityCoverage: z.enum(["complete", "unavailable"]),
  operatorDecisionCoverage: z.enum(["complete", "unavailable"]),
  unverifiedOperatorDecision: ControlRunDetail.shape.operatorDecision.describe(
    "Recorded decision whose exact evidence exceeds the history read bound. Never grants authority.",
  ),
  failureMessageInfo: ThreadHistoryTextFacts.nullable(),
  toolCount: count,
  fileCount: count.describe(
    "File-kind tool calls, not distinct paths or the WorkProduct diffstat.",
  ),
}).strict();
export type ThreadHistoryRun = z.infer<typeof ThreadHistoryRun>;
export const ThreadHistoryPlanAnswer = ControlThreadTurn.pick({ id: true, prompt: true })
  .extend({
    promptInfo: ThreadHistoryTextFacts,
  })
  .strict();
export const ThreadHistoryTurn = ControlThreadTurn.omit({ run: true })
  .extend({
    ordinal,
    revision: ThreadHistoryRevision,
    promptInfo: ThreadHistoryTextFacts,
    run: ThreadHistoryRun.nullable(),
    runStatus,
    primaryOutput: ThreadHistoryOutput.nullable(),
    primaryOutputStatus: z.enum(["available", "none", "not_retained"]),
    answeredByTurnId: id.nullable(),
    answeredByPrompt: ThreadHistoryPlanAnswer.nullable(),
    planAnswerComplete: z.boolean(),
  })
  .strict();
export type ThreadHistoryTurn = z.infer<typeof ThreadHistoryTurn>;

export const ThreadHistoryHeader = z
  .object({
    thread: ControlThread.omit({ runIds: true }).strict(),
    latestTurnId: id.nullable(),
    latestOrdinal: ordinal
      .nullable()
      .describe(
        "Latest stored turn ordinal, including runless turns; null only for an empty thread.",
      ),
    latestAdmission: ControlThreadTurn.pick({ id: true, runId: true, enqueueError: true })
      .extend({ jobId: id.nullable(), state: ControlRunState.nullable() })
      .strict()
      .nullable(),
    headRun: z.object({ runId: id, run: ControlTurnRunCard }).strict().nullable(),
    headRunStatus: runStatus,
    sessions: z.array(ControlSession).max(THREAD_HISTORY_SESSION_LIMIT),
    sessionsComplete: z.boolean(),
  })
  .strict();
export type ThreadHistoryHeader = z.infer<typeof ThreadHistoryHeader>;
export const ThreadHistoryPage = z
  .object({
    storeId,
    threadId: id,
    epoch: z.string().min(1).max(256),
    revision: ThreadHistoryRevision,
    header: ThreadHistoryHeader,
    turns: z.array(ThreadHistoryTurn).max(THREAD_HISTORY_MAX_TURNS),
    hasOlder: z.boolean(),
    hasNewer: z.boolean(),
    olderCursor: cursor.nullable(),
    newerCursor: cursor.nullable(),
    replayCursor: cursor.nullable(),
    replayNextCursor: cursor
      .nullable()
      .describe(
        "Continue the original replay membership if current facts no longer fit one page; merge every segment before declaring the refresh complete.",
      ),
    limitedBy: z.enum(["turns", "bytes"]).nullable(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (Buffer.byteLength(JSON.stringify(v)) > THREAD_HISTORY_PAGE_BYTES)
      issue("history page exceeds byte limit");
    if (Buffer.byteLength(JSON.stringify(v.header)) > THREAD_HISTORY_HEADER_BYTES)
      issue("history header exceeds byte limit");
    if (v.hasOlder !== (v.olderCursor !== null) || v.hasNewer !== (v.newerCursor !== null))
      issue("history edge cursor disagrees with coverage");
    const statusFor = (id: string | null, facts: unknown) =>
      !id ? "unbound" : facts ? "available" : "not_retained";
    if (v.header.headRunStatus !== statusFor(v.header.thread.headRunId, v.header.headRun))
      issue("head run status disagrees with retained facts");
    for (const [i, row] of v.turns.entries()) {
      if (
        row.runStatus !== statusFor(row.runId, row.run) ||
        row.primaryOutputStatus !==
          (row.runStatus === "not_retained"
            ? "not_retained"
            : row.primaryOutput
              ? "available"
              : "none")
      )
        issue("row status disagrees with retained facts");
      if (
        row.threadId !== v.threadId ||
        row.revision.epoch !== v.revision.epoch ||
        row.revision.sequence !== v.revision.sequence
      )
        issue("row does not belong to this observation");
      if (i > 0 && row.ordinal <= v.turns[i - 1]!.ordinal) issue("turns must ascend by ordinal");
      if (
        Buffer.byteLength(row.prompt) > THREAD_HISTORY_PROMPT_BYTES ||
        row.promptInfo.textBytes !== Buffer.byteLength(row.prompt)
      )
        issue("invalid prompt byte count");
      if (
        row.primaryOutput &&
        (row.primaryOutput.textBytes !== Buffer.byteLength(row.primaryOutput.text ?? "") ||
          row.primaryOutput.textBytes > THREAD_HISTORY_ANSWER_BYTES)
      )
        issue("invalid answer byte count");
      if (
        row.run?.failure &&
        (!row.run.failureMessageInfo ||
          row.run.failureMessageInfo.textBytes !== Buffer.byteLength(row.run.failure.safeMessage) ||
          row.run.failureMessageInfo.textBytes > THREAD_HISTORY_FAILURE_BYTES)
      )
        issue("invalid failure preview byte count");
      if (
        row.run &&
        ((row.run.applyEligibilityCoverage === "unavailable" &&
          row.run.applyEligibility !== null) ||
          (row.run.operatorDecisionCoverage === "unavailable" &&
            (row.run.operatorDecision !== null || !row.run.unverifiedOperatorDecision)) ||
          (row.run.operatorDecisionCoverage === "complete" &&
            row.run.unverifiedOperatorDecision !== null))
      )
        issue("unavailable apply evidence must not grant authority");
      if (
        row.answeredByPrompt &&
        (row.answeredByPrompt.id !== row.answeredByTurnId ||
          Buffer.byteLength(row.answeredByPrompt.prompt) > THREAD_HISTORY_PROMPT_BYTES ||
          row.answeredByPrompt.promptInfo.textBytes !==
            Buffer.byteLength(row.answeredByPrompt.prompt))
      )
        issue("invalid plan answer preview");
      for (const facts of [
        row.promptInfo,
        row.primaryOutput,
        row.answeredByPrompt?.promptInfo,
        row.run?.failureMessageInfo,
      ]) {
        if (
          facts &&
          facts.totalTextBytes !== null &&
          (facts.totalTextBytes < facts.textBytes ||
            (!facts.truncated && facts.totalTextBytes !== facts.textBytes))
        )
          issue("invalid total text bytes");
      }
      if (Buffer.byteLength(JSON.stringify(row)) > THREAD_HISTORY_ROW_BYTES)
        issue("history row exceeds byte limit");
    }
  });
export type ThreadHistoryPage = z.infer<typeof ThreadHistoryPage>;

export const ThreadPromptPartInput = z
  .object({
    threadId: id,
    turnId: id,
    offset: ordinal.default(0),
    maxBytes: z
      .number()
      .int()
      .min(4)
      .max(THREAD_HISTORY_ANSWER_BYTES)
      .default(THREAD_HISTORY_PROMPT_BYTES),
    expectedStoreId: storeId.optional(),
  })
  .strict();
export type ThreadPromptPartInput = z.infer<typeof ThreadPromptPartInput>;
export const ThreadPromptPart = ControlRunEventPart.omit({ runId: true, seq: true, type: true })
  .extend({
    threadId: id,
    turnId: id,
    totalBytes: ordinal,
  })
  .strict()
  .refine(
    (v) =>
      v.offset <= v.nextOffset &&
      v.nextOffset <= v.totalBytes &&
      v.nextOffset - v.offset === Buffer.byteLength(v.text) &&
      Buffer.byteLength(v.text) <= THREAD_HISTORY_ANSWER_BYTES,
    "invalid prompt byte interval",
  );
export type ThreadPromptPart = z.infer<typeof ThreadPromptPart>;

/** Internal cursor payload; callers treat its wire encoding as opaque. */
export const ThreadHistoryCursor = z
  .object({
    version: z.literal(1),
    storeId,
    epoch: z.string().min(1).max(256),
    threadId: id,
    limit: z.number().int().min(1).max(THREAD_HISTORY_MAX_TURNS),
    direction: z.enum(["older", "newer", "replay"]),
    low: ordinal,
    high: ordinal,
    ceiling: ordinal,
    after: ordinal.optional(),
    inclusive: z
      .literal(true)
      .optional()
      .describe(
        "Reverse navigation from an empty boundary includes the selector edge; no emitted row is skipped.",
      ),
  })
  .strict()
  .refine(
    (v) =>
      v.low <= v.high &&
      v.high <= v.ceiling &&
      (v.inclusive === undefined || (v.direction !== "replay" && v.low === v.high)) &&
      (v.after === undefined || (v.direction === "replay" && v.after >= v.low && v.after < v.high)),
    "invalid cursor interval",
  );
export type ThreadHistoryCursor = z.infer<typeof ThreadHistoryCursor>;
export function threadHistoryProblem(code: string, status: number, message: string): Error {
  return Object.assign(new Error(message), {
    code,
    status,
    retryable: status === 503,
    requiredActions: status === 409 ? ["resnapshot"] : [],
  });
}
export function encodeThreadHistoryCursor(value: ThreadHistoryCursor): string {
  const wire = Buffer.from(JSON.stringify(ThreadHistoryCursor.parse(value))).toString("base64url");
  if (wire.length > 2048)
    throw threadHistoryProblem("invalid_thread_history_cursor", 400, "cursor exceeds limit");
  return wire;
}
export function decodeThreadHistoryCursor(raw: string): ThreadHistoryCursor {
  try {
    if (raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) throw new Error();
    const parsed = ThreadHistoryCursor.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (encodeThreadHistoryCursor(parsed) !== raw) throw new Error();
    return parsed;
  } catch {
    throw threadHistoryProblem(
      "invalid_thread_history_cursor",
      400,
      "malformed thread history cursor",
    );
  }
}
