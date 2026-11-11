import { z } from "zod/v3";
import { ControlHandshakeResponse } from "./operation.js";

/** Caller-owned correlation only; every member still needs its own acceptance key. */
export const TaskGroupId = z
  .string()
  .uuid()
  .describe(
    "Caller-generated UUID saved before launching the first member. Each job still needs its own idempotency key; the group grants no execution authority.",
  );
export type TaskGroupId = z.infer<typeof TaskGroupId>;

/** Validate correlation without parsing unrelated run defaults or authorizing lineage. */
export function taskGroupLaunchMetadata(
  value: unknown,
  beltContext = false,
): { taskGroupId?: TaskGroupId } {
  const request = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  if (request["taskGroupId"] === undefined) return {};
  const taskGroupId = TaskGroupId.parse(request["taskGroupId"]);
  if (
    beltContext ||
    request["threadId"] !== undefined ||
    request["delegatedFromRunId"] !== undefined ||
    request["kind"] !== undefined
  ) {
    throw Object.assign(
      new Error(
        "taskGroupId is available only on one-shot launches, not thread turns or Delegate children",
      ),
      {
        code: "task_group_not_supported",
        status: 400,
        retryable: false,
      },
    );
  }
  return { taskGroupId };
}

/** Accepted membership and the durable store that owns it; never caller-supplied identity. */
export const TaskGroupReceipt = z.object({
  taskGroupId: TaskGroupId,
  storeId: ControlHandshakeResponse.shape.storeId
    .unwrap()
    .describe(
      "Identity of the durable engine store that accepted this command, stable across restarts. A group member always carries it; an ordinary receipt carries it only for a request sending `X-Claudexor-Store-Identity: 1`, and it stays absent, meaning unknown, when the store has no identity to give.",
    ),
});
export type TaskGroupReceipt = z.infer<typeof TaskGroupReceipt>;

/** Thin clients copy only a complete, validated pair from an accepted server receipt. */
export function taskGroupReceiptMetadata(value: unknown): Partial<TaskGroupReceipt> {
  const receipt = TaskGroupReceipt.safeParse(value);
  return receipt.success ? receipt.data : {};
}

/** The same copy for an accepted handle, whose ordinary receipt can name its store alone. A group
 * without its store stays dropped, and absent stays unknown. */
export function acceptedReceiptMetadata(value: unknown): Partial<TaskGroupReceipt> {
  const pair = taskGroupReceiptMetadata(value);
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  if (pair.storeId !== undefined || record["taskGroupId"] !== undefined) return pair;
  const store = TaskGroupReceipt.shape.storeId.safeParse(record["storeId"]);
  return store.success ? { storeId: store.data } : {};
}
