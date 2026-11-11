import { z } from "zod/v3";
import { ControlRunState } from "./control.js";
import { ControlHandshakeResponse } from "./operation.js";
import { RunObservationRecord, RunWaitManySummary } from "./run-observation.js";
import { TaskGroupId } from "./task-group.js";

export const TASK_GROUP_RUNS_RESULT_BYTES = 131_072;
export const TASK_GROUP_CURSOR_CHARS = 2048;
const storeId = ControlHandshakeResponse.shape.storeId.unwrap();
const viewToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const cursorString = z.string().max(TASK_GROUP_CURSOR_CHARS);

export const TaskGroupRunsInput = z
  .object({
    taskGroupId: TaskGroupId,
    limit: z.number().int().min(1).max(200).default(50),
    state: ControlRunState.optional(),
    cursor: cursorString.optional(),
    expectedStoreId: storeId.optional(),
  })
  .strict();
export type TaskGroupRunsInput = z.infer<typeof TaskGroupRunsInput>;

/** Opaque traversal correlation, never authorization or a permanent roster. */
export const TaskGroupCursor = z
  .object({
    version: z.literal(1),
    taskGroupId: TaskGroupId,
    state: ControlRunState.nullable(),
    storeId,
    viewToken,
    last: z.object({ createdAt: z.string().min(1), id: z.string().min(1) }).strict(),
  })
  .strict();
export type TaskGroupCursor = z.infer<typeof TaskGroupCursor>;

/** Internal scalar selection contract shared by storage and daemon composition. */
export interface TaskGroupPageQuery {
  taskGroupId: TaskGroupId;
  limit: number;
  state: ControlRunState | null;
  cursor: TaskGroupCursor | null;
  storeId: string;
}
export interface TaskGroupPage {
  records: RunObservationRecord[];
  hasMore: boolean;
  viewToken: string;
}

const member = RunObservationRecord.pick({ jobId: true, runId: true, createdAt: true })
  .extend({ observation: RunWaitManySummary })
  .strict();
export const TaskGroupRunsResult = z
  .object({
    taskGroupId: TaskGroupId,
    storeId,
    visibility: z.literal("current_served_generations"),
    retention: z.literal("retained_only"),
    viewToken,
    members: z.array(member).max(200),
    hasMore: z.boolean(),
    nextCursor: cursorString.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.hasMore !== (value.nextCursor !== null))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "hasMore requires a next cursor, and an ended page has none",
      });
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > TASK_GROUP_RUNS_RESULT_BYTES)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "task group result exceeds 131072 bytes",
      });
  })
  .describe(
    "One retained-only page in current served generations, at most 131072 UTF-8 bytes of logical JSON; absence is not historical completeness or launch authority.",
  );
export type TaskGroupRunsResult = z.infer<typeof TaskGroupRunsResult>;

function invalidCursor(): Error {
  return Object.assign(new Error("task group cursor is malformed; read a fresh page"), {
    code: "invalid_task_group_cursor",
    status: 400,
    retryable: false,
  });
}
export function encodeTaskGroupCursor(value: TaskGroupCursor): string {
  const parsed = TaskGroupCursor.safeParse(value);
  if (!parsed.success) throw invalidCursor();
  const encoded = Buffer.from(JSON.stringify(parsed.data), "utf8").toString("base64url");
  if (encoded.length > TASK_GROUP_CURSOR_CHARS) throw invalidCursor();
  return encoded;
}
export function decodeTaskGroupCursor(raw: string): TaskGroupCursor {
  if (
    typeof raw !== "string" ||
    raw.length > TASK_GROUP_CURSOR_CHARS ||
    !/^[A-Za-z0-9_-]+$/.test(raw)
  )
    throw invalidCursor();
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) throw invalidCursor();
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = TaskGroupCursor.safeParse(JSON.parse(decoded));
    if (parsed.success) return parsed.data;
  } catch {
    /* Invalid encoding, JSON and payloads share the typed cursor boundary. */
  }
  throw invalidCursor();
}
