import { z } from "zod/v3";
import { ControlRunState, ControlThreadTurn } from "./control.js";
import { ControlHandshakeResponse } from "./operation.js";
import { Id } from "./primitives.js";

/** Every lookup answer names the store it read; a read without one is unavailable, not empty. */
const LookupStoreId = ControlHandshakeResponse.shape.storeId
  .unwrap()
  .describe(
    "Identity of the durable engine store this read answered from, stable across restarts. A lookup without a store identity is refused as unavailable instead of answering.",
  );

/** Failure facts an accepted command already records, returned as data. */
export const ControlStartLookupProblem = z
  .object({
    message: z.string().nullable().describe("Recorded failure message; null when none was kept."),
    code: z
      .string()
      .min(1)
      .nullable()
      .describe("Recorded machine code; null for an untyped failure."),
    status: z
      .number()
      .int()
      .min(400)
      .max(599)
      .nullable()
      .describe(
        "HTTP status the start route answers for this failure; null when none is recorded.",
      ),
    retryable: z
      .boolean()
      .nullable()
      .describe("The recorded retryability; null when the producer made no claim."),
    requiredActions: z
      .array(z.string().min(1))
      .describe("Bounded actions recorded with the failure."),
    context: z
      .record(z.string(), z.unknown())
      .describe("Bounded recorded context; store and task-group identity are not repeated here."),
  })
  .strict()
  .describe(
    "The refusal or failure an accepted job records. A lookup returns it with HTTP 200; it is the job's outcome, not a failure of the read.",
  );
export type ControlStartLookupProblem = z.infer<typeof ControlStartLookupProblem>;

export const ControlStartLookupHandle = z
  .object({
    jobId: Id.describe("The accepted daemon job."),
    runId: Id.nullable().describe(
      "Run bound to the job at this read; null while none is bound, or for a job that ended before a run.",
    ),
    state: ControlRunState.describe("The job's lifecycle state at this read."),
    runDir: z.string().nullable().optional().describe("Run artifact directory; null before a run."),
    taskId: z.string().nullable().optional().describe("Task id; null before it is allocated."),
    threadId: Id.optional().describe("Thread of an accepted turn."),
    turnId: Id.optional().describe("The accepted turn."),
    problem: ControlStartLookupProblem.optional(),
  })
  .strict()
  .describe("Durable handle of the job a start request created, read without waiting for it.");
export type ControlStartLookupHandle = z.infer<typeof ControlStartLookupHandle>;

/**
 * The answer of a start lookup: the same body and Idempotency-Key a create route
 * accepted, read from the bindings that create wrote. A lookup never creates,
 * preflights, enqueues or waits.
 */
export const ControlStartLookupResponse = z
  .discriminatedUnion("status", [
    z
      .object({
        status: z.literal("found"),
        storeId: LookupStoreId,
        handle: ControlStartLookupHandle,
      })
      .strict()
      .describe("The store retains the job this exact key and request created."),
    z
      .object({
        status: z.literal("turn_only"),
        storeId: LookupStoreId,
        threadId: Id,
        turnId: Id.describe("The turn this exact key and request recorded."),
        runId: Id.nullable().describe(
          "Run bound to the turn; observe exactly this run. Null when no run is bound.",
        ),
        enqueueError: ControlThreadTurn.shape.enqueueError,
      })
      .strict()
      .describe(
        "The store retains the turn this exact key and request recorded, but no command bound to them: the enqueue failed or never happened, or retention removed the command. Nothing is enqueued for it.",
      ),
    z
      .object({
        status: z.literal("not_found"),
        storeId: LookupStoreId,
      })
      .strict()
      .describe(
        "This store's current partition retains no binding for this key and request. It never proves that the original request was not accepted and never authorizes a new start.",
      ),
  ])
  .describe(
    "Read-only lookup of an accepted run or thread-turn start by its original request and Idempotency-Key.",
  );
export type ControlStartLookupResponse = z.infer<typeof ControlStartLookupResponse>;
