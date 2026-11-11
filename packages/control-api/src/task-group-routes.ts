import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ControlHandshakeResponse,
  ControlRunState,
  TaskGroupRunsInput,
  TaskGroupRunsResult,
  TASK_GROUP_CURSOR_CHARS,
  TASK_GROUP_RUNS_RESULT_BYTES,
  decodeTaskGroupCursor,
  encodeTaskGroupCursor,
  type TaskGroupPage,
  type TaskGroupPageQuery,
  type RunWaitManySummary,
} from "@claudexor/schema";
import type { OperationDraft } from "./operation-draft.js";
import { queryParam } from "./operation-parameters.js";
import { readLifetime, requestGone } from "./request-liveness.js";

interface TaskGroupRunsHost {
  storeId(): string | undefined;
  page(input: TaskGroupPageQuery): TaskGroupPage;
  snapshot(ids: readonly string[], signal?: AbortSignal): Promise<RunWaitManySummary[]>;
}
const failure = (code: string, status: number, message: string) =>
  Object.assign(new Error(message), { code, status, retryable: false });
const invalidResponse = () =>
  failure("invalid_service_response", 500, "invalid compact task group page");
const Member = TaskGroupRunsResult.innerType().shape.members.element;

/** One daemon-owned retained traversal page. Byte limits never consume a row
 * that was not returned; shared observations own all lifecycle/pending facts. */
export async function readTaskGroupRuns(
  rawInput: unknown,
  host: TaskGroupRunsHost,
  signal?: AbortSignal,
): Promise<TaskGroupRunsResult> {
  const input = TaskGroupRunsInput.parse(rawInput);
  signal?.throwIfAborted();
  const identity = ControlHandshakeResponse.shape.storeId.unwrap().safeParse(host.storeId());
  if (!identity.success)
    throw failure("task_group_runs_unavailable", 503, "durable store identity is unavailable");
  const storeId = identity.data;
  if (input.expectedStoreId !== undefined && input.expectedStoreId !== storeId)
    throw failure("store_mismatch", 409, "task group belongs to another durable store");
  const cursor = input.cursor === undefined ? null : decodeTaskGroupCursor(input.cursor);
  const state = input.state ?? null;
  if (cursor?.storeId !== undefined && cursor.storeId !== storeId)
    throw failure("store_mismatch", 409, "task group cursor belongs to another durable store");
  // Membership is case-insensitive; the answer echoes the caller's spelling.
  const group = input.taskGroupId.toLowerCase();
  if (cursor && (cursor.taskGroupId.toLowerCase() !== group || cursor.state !== state))
    throw failure("stale_cursor", 409, "task group cursor belongs to another group or filter");
  const page = host.page({
    taskGroupId: input.taskGroupId,
    limit: input.limit,
    state,
    cursor,
    storeId,
  });
  if (page.records.length > input.limit + 1 || page.hasMore !== page.records.length > input.limit)
    throw invalidResponse();
  if (page.records.some((row) => row.taskGroupId?.toLowerCase() !== group)) throw invalidResponse();
  signal?.throwIfAborted();
  const selected = page.records.slice(0, input.limit);
  const observations = await host.snapshot(
    selected.map((row) => row.jobId),
    signal,
  );
  signal?.throwIfAborted();
  if (observations.length !== selected.length) throw invalidResponse();
  const result: TaskGroupRunsResult = {
    taskGroupId: input.taskGroupId,
    storeId,
    visibility: "current_served_generations",
    retention: "retained_only",
    viewToken: page.viewToken,
    members: [],
    hasMore: false,
    nextCursor: null,
  };
  // A running total over each member's own JSON; the cursor is sized at its
  // maximum and encoded once, for the last member the page keeps.
  let bytes =
    Buffer.byteLength(JSON.stringify(result), "utf8") + TASK_GROUP_CURSOR_CHARS + 2 - "null".length;
  for (let index = 0; index < selected.length; index++) {
    signal?.throwIfAborted();
    const row = selected[index]!;
    const member = Member.safeParse({
      jobId: row.jobId,
      runId: row.runId,
      createdAt: row.createdAt,
      observation: observations[index],
    });
    if (!member.success)
      throw failure("invalid_service_response", 500, "malformed retained task group member");
    const added =
      Buffer.byteLength(JSON.stringify(member.data), "utf8") + (result.members.length ? 1 : 0);
    if (bytes + added > TASK_GROUP_RUNS_RESULT_BYTES) {
      if (result.members.length) break;
      throw failure(
        "task_group_member_too_large",
        500,
        "first retained member exceeds the task group page byte limit",
      );
    }
    bytes += added;
    result.members.push(member.data);
  }
  result.hasMore = page.hasMore || result.members.length < selected.length;
  if (result.hasMore) {
    const last = result.members.at(-1)!;
    try {
      result.nextCursor = encodeTaskGroupCursor({
        version: 1,
        taskGroupId: input.taskGroupId,
        state,
        storeId,
        viewToken: page.viewToken,
        last: { createdAt: last.createdAt, id: last.jobId },
      });
    } catch {
      throw failure(
        "invalid_service_response",
        500,
        "retained task group cursor cannot be encoded",
      );
    }
  }
  const parsed = TaskGroupRunsResult.safeParse(result);
  if (!parsed.success) throw invalidResponse();
  return parsed.data;
}

export const TASK_GROUP_RUNS_OPERATION_DRAFTS: OperationDraft[] = [
  {
    method: "GET",
    path: "/v2/task-groups/:id/runs",
    mutability: "read_only",
    applicability: "run",
    requestSchema: null,
    responseSchema: "TaskGroupRunsResult",
    responseKind: "json",
    parameters: [
      queryParam({
        name: "limit",
        schemaRef: "TaskGroupRunsInput#/properties/limit",
        description: "Page size 1..200, default 50; byte limits may return fewer members.",
      }),
      queryParam({
        name: "state",
        schemaRef: "TaskGroupRunsInput#/properties/state",
        enum: [...ControlRunState.options],
        description: "Optional lifecycle filter bound to the cursor.",
      }),
      queryParam({
        name: "cursor",
        schemaRef: "TaskGroupRunsInput#/properties/cursor",
        description:
          "Opaque cursor (at most 2048 characters) from this group, filter, store and served view.",
      }),
      queryParam({
        name: "expectedStoreId",
        schemaRef: "TaskGroupRunsInput#/properties/expectedStoreId",
        description:
          "Refuse a different durable store identity instead of recovering another store's handles.",
      }),
    ],
  },
];

interface TaskGroupRouteContext {
  taskGroupRuns?: (input: TaskGroupRunsInput, signal?: AbortSignal) => Promise<TaskGroupRunsResult>;
  json(res: ServerResponse, status: number, body: unknown): void;
  requestError(res: ServerResponse, error: unknown, fallback?: 400 | 500): void;
}
/** Strict HTTP admission only; connection loss closes the read, never a worker. */
export async function handleTaskGroupRunsRoute(
  ctx: TaskGroupRouteContext,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const taskGroupRunsMatch = /^\/task-groups\/([^/]+)\/runs$/.exec(path);
  if (!(method === "GET" && taskGroupRunsMatch)) return false;
  let input: TaskGroupRunsInput;
  try {
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const query: Record<string, unknown> = {
      taskGroupId: decodeURIComponent(taskGroupRunsMatch[1]!),
    };
    for (const [key, value] of params) {
      if (
        !["limit", "state", "cursor", "expectedStoreId"].includes(key) ||
        Object.hasOwn(query, key)
      )
        throw failure("invalid_argument", 400, "unknown or repeated task group query field");
      if (key === "limit" && !/^[1-9][0-9]*$/.test(value))
        throw failure("invalid_argument", 400, "limit must be an integer from 1 to 200");
      query[key] = key === "limit" ? Number(value) : value;
    }
    input = TaskGroupRunsInput.parse(query);
  } catch (error) {
    if (!requestGone(req, res)) ctx.requestError(res, error);
    return true;
  }
  if (!ctx.taskGroupRuns) {
    ctx.requestError(
      res,
      failure("task_group_runs_unavailable", 503, "retained task group observation is unavailable"),
      500,
    );
    return true;
  }
  const lifetime = readLifetime(req, res);
  try {
    if (!lifetime.signal.aborted) {
      const result = await ctx.taskGroupRuns(input, lifetime.signal);
      const parsed = TaskGroupRunsResult.safeParse(result);
      if (
        !parsed.success ||
        parsed.data.taskGroupId !== input.taskGroupId ||
        parsed.data.members.length > input.limit ||
        (input.expectedStoreId !== undefined && parsed.data.storeId !== input.expectedStoreId)
      )
        throw invalidResponse();
      if (!requestGone(req, res)) ctx.json(res, 200, parsed.data);
    }
  } catch (error) {
    if (!requestGone(req, res)) ctx.requestError(res, error, 500);
  } finally {
    lifetime.dispose();
  }
  return true;
}
