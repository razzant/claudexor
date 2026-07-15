import { z } from "zod";
import { Id } from "./primitives.js";

export function makeControlRunRetrySchemas<T extends z.ZodTypeAny>(runRequest: T) {
  const startInfo = z
    .object({
      jobId: z.string().optional().describe("Daemon job id backing the run."),
      runId: z.string().describe("Run id."),
      taskId: z.string().optional().describe("Task id, when already allocated."),
      runDir: z.string().describe("On-disk run artifact directory."),
    })
    .describe("Response for a successfully enqueued run.");
  const response = z
    .object({
      retryOf: Id,
      jobId: Id,
      runId: Id.nullable().default(null),
      turnId: Id.nullable().default(null),
      state: z.string().min(1),
    })
    .strict()
    .describe("Durable handle returned by Exact Retry for a fresh command attempt.");
  const draft = z
    .object({
      sourceRunId: Id,
      request: runRequest,
      differences: z
        .array(
          z
            .object({
              field: z.string().min(1),
              change: z.literal("omitted"),
              reason: z.string().min(1),
            })
            .strict(),
        )
        .default([]),
    })
    .strict()
    .describe("Editable Run Again draft copied from a prior run with explicit omissions.");
  return { startInfo, response, draft };
}
