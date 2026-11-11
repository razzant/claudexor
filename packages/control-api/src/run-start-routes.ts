/**
 * The start family over HTTP: the one-shot create and the read-only lookups of an
 * accepted run or thread-turn start. A lookup takes the body and Idempotency-Key its
 * create took and reads the bindings that create wrote. It never applies current
 * admission, preflights, enqueues, records a turn, waits for a run or writes, and a
 * miss never falls back to creating.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ControlStartLookupResponse,
  ControlThreadTurnRequest,
  type ControlStartLookupHandle,
  type RecordedControlRunStartRequest,
} from "@claudexor/schema";
import type { OperationDraft } from "./operation-draft.js";
import { STORE_IDENTITY_HEADER } from "./operation-parameters.js";
import { readContinuationBody } from "./run-continuation-start.js";
import type { DaemonFacadeClient, DaemonRunRecord } from "./run-record.js";
import {
  acceptedLookupFailure,
  acceptedRunQuery,
  handleRunCreate,
  recordedRunStart,
  requiredIdempotencyKey,
  type RunCreateRouteContext,
} from "./run-start.js";
import { servingStore } from "./run-start-receipt.js";
import { projectTurn } from "./thread-projection.js";
import { acceptedTurnCommandQuery, type ThreadTurnIdempotency } from "./thread-recovery.js";
import { threadTurnCreateIdempotency } from "./thread-turn-routes.js";

/** Each create sits beside its lookup: same request schema, same required key. */
export const START_OPERATION_DRAFTS: OperationDraft[] = [
  {
    method: "POST",
    path: "/v2/runs",
    mutability: "mutating",
    requestSchema: "ControlRunStartRequest",
    responseSchema: "ControlRunStartResponse",
    responseKind: "json",
    completion: "durable_handle",
    idempotency: "key_required",
    parameters: [STORE_IDENTITY_HEADER],
  },
  {
    method: "POST",
    path: "/v2/runs/lookup",
    mutability: "read_only",
    requestSchema: "ControlRunStartRequest",
    responseSchema: "ControlStartLookupResponse",
    responseKind: "json",
    idempotency: "key_required",
  },
];

export const TURN_LOOKUP_OPERATION_DRAFTS: OperationDraft[] = [
  {
    method: "POST",
    path: "/v2/threads/:id/turns/lookup",
    mutability: "read_only",
    requestSchema: "ControlThreadTurnRequest",
    responseSchema: "ControlStartLookupResponse",
    responseKind: "json",
    idempotency: "key_required",
  },
];

interface RunStartRouteContext {
  daemon: DaemonFacadeClient;
  services?: Pick<RunCreateRouteContext, "validateResources" | "preflightRunRequirements"> & {
    findThreadTurnByIdempotency?: (
      id: string,
      idempotency: ThreadTurnIdempotency,
    ) => Promise<{ id: string } | null>;
  };
  storeId?: () => string | undefined;
  waitForRunStart(jobId: string): Promise<DaemonRunRecord>;
  readBody(req: IncomingMessage): Promise<unknown>;
  json(res: ServerResponse, status: number, body: unknown): void;
  requestError(res: ServerResponse, error: unknown, fallback?: 400 | 500): void;
}

type LookupAnswer =
  | { status: "found"; handle: ControlStartLookupHandle }
  | {
      status: "turn_only";
      threadId: string;
      turnId: string;
      runId: string | null;
      enqueueError: unknown;
    }
  | { status: "not_found" };

const failure = (code: string, status: number, message: string, retryable = false) =>
  Object.assign(new Error(message), { code, status, retryable });

/** A continuation's request carries what its create inherited from the predecessor. With
 * that predecessor gone, a request rebuilt from defaults is not the one its key bound, so
 * the lookup refuses rather than answer for another request. */
const predecessorNotRetained = (from: string) =>
  Object.assign(
    failure(
      "continuation_predecessor_not_retained",
      410,
      `this store retains no run ${from} for this continuation to inherit from, so the request its create recorded cannot be rebuilt`,
    ),
    {
      requiredActions: [
        "Do not start it again on this answer; read the run by its job or run id (GET /v2/runs/:id) if one was kept.",
      ],
      context: { continueFrom: from },
    },
  );

/** The store this answer speaks for: present before the read and unchanged after it. */
function storeOf(storeId: RunStartRouteContext["storeId"]): string {
  const identity = servingStore(storeId).storeId;
  if (identity === undefined)
    throw failure(
      "store_identity_unavailable",
      503,
      "the durable store identity is unavailable, so no lookup answer can name its store",
      true,
    );
  return identity;
}

/** The failure facts the job already records; absent facts stay null, never defaulted. */
function recordedProblem(record: DaemonRunRecord): Pick<ControlStartLookupHandle, "problem"> {
  if (record.error === undefined && record.errorCode === undefined) return {};
  const { taskGroupId: _group, storeId: _store, ...context } = record.errorContext ?? {};
  const status = record.errorStatus;
  return {
    problem: {
      message: record.error ?? null,
      code: record.errorCode ?? null,
      status:
        typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
          ? status
          : null,
      retryable: record.errorRetryable ?? null,
      requiredActions: record.errorRequiredActions ?? [],
      context,
    },
  };
}

function acceptedHandle(
  record: DaemonRunRecord,
  turn: { threadId: string; turnId: string } | Record<string, never> = {},
): ControlStartLookupHandle {
  return {
    jobId: record.id,
    runId: record.runId ?? null,
    state: record.state as ControlStartLookupHandle["state"],
    runDir: record.runDir ?? null,
    taskId: record.taskId ?? null,
    ...turn,
    ...recordedProblem(record),
  };
}

/** Exactly the daemon's accepted-command read; an engine without one cannot answer. */
async function readAccepted(
  daemon: DaemonFacadeClient,
  query: readonly [unknown, Parameters<NonNullable<DaemonFacadeClient["findAccepted"]>>[1]],
): Promise<DaemonRunRecord | null> {
  if (!daemon.findAccepted) throw new Error("the daemon offers no accepted-command read");
  return daemon.findAccepted(...query);
}

async function lookupRun(
  ctx: RunStartRouteContext,
  recorded: RecordedControlRunStartRequest,
  idempotencyKey: string,
): Promise<LookupAnswer> {
  let record: DaemonRunRecord | null;
  try {
    record = await readAccepted(ctx.daemon, acceptedRunQuery(recorded, idempotencyKey));
  } catch (error) {
    throw acceptedLookupFailure(error, "lookup");
  }
  return record ? { status: "found", handle: acceptedHandle(record) } : { status: "not_found" };
}

/** The turn binding first, then the command bound to the same key, if still retained. */
async function lookupTurn(
  ctx: RunStartRouteContext,
  threadId: string,
  idempotency: ThreadTurnIdempotency,
): Promise<LookupAnswer> {
  const findTurn = ctx.services?.findThreadTurnByIdempotency;
  if (!findTurn)
    throw failure(
      "thread_recovery_unavailable",
      501,
      "this engine build cannot read durable thread-turn bindings",
    );
  let turn: unknown;
  let record: DaemonRunRecord | null = null;
  try {
    turn = await findTurn(threadId, idempotency);
    if (turn)
      record = await readAccepted(ctx.daemon, acceptedTurnCommandQuery(threadId, idempotency));
  } catch (error) {
    const typed = error as { status?: unknown; code?: unknown } | null;
    if (typed?.status === 404 && typed.code === undefined)
      throw failure("thread_not_found", 404, `no such thread: ${threadId}`);
    throw acceptedLookupFailure(error, "lookup");
  }
  if (!turn) return { status: "not_found" };
  const projected = projectTurn(turn, new Map());
  if (record)
    return {
      status: "found",
      handle: acceptedHandle(record, { threadId, turnId: projected.id }),
    };
  return {
    status: "turn_only",
    threadId,
    turnId: projected.id,
    runId: projected.runId,
    enqueueError: projected.enqueueError,
  };
}

/** Answer one lookup whose reads all happened after `before` named the store. */
async function answer(
  ctx: RunStartRouteContext,
  res: ServerResponse,
  before: string,
  read: () => Promise<LookupAnswer>,
): Promise<void> {
  try {
    const result = await read();
    if (storeOf(ctx.storeId) !== before)
      throw failure(
        "store_identity_unavailable",
        503,
        "the durable store changed during this lookup; repeat it",
        true,
      );
    const parsed = ControlStartLookupResponse.safeParse({ ...result, storeId: before });
    if (!parsed.success)
      throw failure("invalid_service_response", 500, "malformed accepted start record");
    ctx.json(res, 200, parsed.data);
  } catch (error) {
    ctx.requestError(res, error, 500);
  }
}

async function serveRunLookup(
  ctx: RunStartRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let idempotencyKey: string;
  let raw: unknown;
  let before: string;
  try {
    idempotencyKey = requiredIdempotencyKey(req);
    raw = await ctx.readBody(req);
    before = storeOf(ctx.storeId);
  } catch (error) {
    return ctx.requestError(res, error);
  }
  let resolved: Awaited<ReturnType<typeof readContinuationBody>>;
  try {
    // Continuation inheritance reads the predecessor exactly as create does.
    resolved = await readContinuationBody(ctx.daemon, raw);
  } catch (error) {
    // A typed refusal answers as the create route does; an untyped one is a failed daemon read.
    if (typeof (error as { status?: unknown } | null)?.status === "number")
      return ctx.requestError(res, error);
    return ctx.requestError(res, acceptedLookupFailure(error, "continuation"), 500);
  }
  if (resolved.unrecovered !== null)
    return ctx.requestError(res, predecessorNotRetained(resolved.unrecovered));
  let recorded: RecordedControlRunStartRequest;
  try {
    recorded = recordedRunStart(resolved.body);
  } catch (error) {
    return ctx.requestError(res, error);
  }
  return answer(ctx, res, before, () => lookupRun(ctx, recorded, idempotencyKey));
}

async function serveTurnLookup(
  ctx: RunStartRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  threadId: string,
): Promise<void> {
  let idempotency: ThreadTurnIdempotency;
  let before: string;
  try {
    const key = requiredIdempotencyKey(req);
    const body = ControlThreadTurnRequest.parse((await ctx.readBody(req)) ?? {});
    idempotency = threadTurnCreateIdempotency(threadId, body, key);
    before = storeOf(ctx.storeId);
  } catch (error) {
    return ctx.requestError(res, error);
  }
  return answer(ctx, res, before, () => lookupTurn(ctx, threadId, idempotency));
}

export async function handleRunStartRoute(
  ctx: RunStartRouteContext,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (method === "POST" && path === "/runs") {
    await handleRunCreate(
      {
        ...ctx,
        validateResources: ctx.services?.validateResources,
        preflightRunRequirements: ctx.services?.preflightRunRequirements,
      },
      req,
      res,
    );
    return true;
  }
  if (method === "POST" && path === "/runs/lookup") {
    await serveRunLookup(ctx, req, res);
    return true;
  }
  const turnLookupMatch = /^\/threads\/([^/]+)\/turns\/lookup$/.exec(path);
  if (method === "POST" && turnLookupMatch) {
    await serveTurnLookup(ctx, req, res, decodeURIComponent(turnLookupMatch[1]!));
    return true;
  }
  return false;
}
