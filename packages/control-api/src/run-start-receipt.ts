import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CONTROL_STORE_IDENTITY_HEADER,
  ControlQueuedRunInfo,
  ControlRunStartInfo,
  TaskGroupReceipt,
} from "@claudexor/schema";
import type { DaemonRunRecord } from "./run-record.js";
import { TERMINAL_STATES } from "./sse-shared.js";

/** The request opted in to `storeId`: some shipped same-major clients parse a receipt strictly. */
export function wantsStoreIdentity(req: IncomingMessage): boolean {
  return req.headers[CONTROL_STORE_IDENTITY_HEADER] === "1";
}

/** The store that served the read this answer speaks for, so call this after that read. Absent
 * means unknown, never another store. */
export function servingStore(
  storeId?: () => string | undefined,
): Partial<Pick<TaskGroupReceipt, "storeId">> {
  const identity = TaskGroupReceipt.shape.storeId.safeParse(storeId?.());
  return identity.success ? { storeId: identity.data } : {};
}

/** A tagged launch is admitted only while the durable store identity it will
 * name exists, so a missing identity refuses before anything is accepted. */
export function requireTaskGroupStoreIdentity(
  params: { taskGroupId?: unknown },
  storeId?: () => string | undefined,
): void {
  if (params.taskGroupId === undefined) return;
  if (TaskGroupReceipt.shape.storeId.safeParse(storeId?.()).success) return;
  throw Object.assign(new Error("a task group launch needs the durable store identity"), {
    code: "store_identity_unavailable",
    status: 503,
    retryable: true,
  });
}

/** Membership comes only from the accepted request; embedders without store identity cannot mint
 * it. An ordinary receipt names its store only on request, and only when the store has an identity. */
export function acceptedRunReceipt(
  rec: DaemonRunRecord,
  storeId?: () => string | undefined,
  wantsStoreId = false,
): Partial<TaskGroupReceipt> {
  const params =
    rec.params && typeof rec.params === "object" ? (rec.params as Record<string, unknown>) : {};
  if (params["taskGroupId"] === undefined) return wantsStoreId ? servingStore(storeId) : {};
  const receipt = TaskGroupReceipt.safeParse({
    taskGroupId: params["taskGroupId"],
    storeId: storeId?.(),
  });
  if (receipt.success) return receipt.data;
  throw Object.assign(new Error("accepted task group receipt needs the durable store identity"), {
    code: "store_identity_unavailable",
    status: 503,
    retryable: true,
    context: { jobId: rec.id, state: rec.state },
  });
}

export function unboundRunStartResponse(
  rec: DaemonRunRecord,
  terminal: boolean,
  terminalContext: Record<string, unknown> = {},
  metadata: Partial<TaskGroupReceipt> = {},
): { status: number; body: Record<string, unknown> } {
  // errorStatus is served verbatim only inside the failure range; anything
  // else (absent, or a non-4xx/5xx value from a defective writer) must not
  // turn a terminal failure body into a 2xx/3xx response.
  const errorStatus =
    typeof rec.errorStatus === "number" &&
    Number.isInteger(rec.errorStatus) &&
    rec.errorStatus >= 400 &&
    rec.errorStatus <= 599
      ? rec.errorStatus
      : 500;
  const queued = ControlQueuedRunInfo.parse({
    ...metadata,
    jobId: rec.id,
    state: rec.state,
    error: rec.error,
  });
  if (!terminal) return { status: 202, body: queued };
  const { taskGroupId: _group, storeId: _store, ...errorContext } = rec.errorContext ?? {};
  return {
    status: errorStatus,
    body: {
      ...queued,
      ...(rec.errorCode ? { code: rec.errorCode } : {}),
      // The daemon producer owns retryability when it supplied the fact. A
      // legacy typed refusal without the field keeps the prior conservative
      // non-retryable fallback; an untyped terminal makes no claim.
      ...(rec.errorRetryable !== undefined
        ? { retryable: rec.errorRetryable }
        : rec.errorCode
          ? { retryable: false }
          : {}),
      requiredActions: rec.errorRequiredActions ?? [],
      context: {
        ...errorContext,
        // Server-owned handles override any producer context with the same key.
        jobId: rec.id,
        state: rec.state,
        ...terminalContext,
        ...metadata,
      },
    },
  };
}

/** Answer an accepted one-shot job: its bound handle, its queued handle or its pre-run refusal. */
export async function respondToAcceptedJob(
  ctx: {
    waitForRunStart(jobId: string): Promise<DaemonRunRecord>;
    storeId?: () => string | undefined;
    json(res: ServerResponse, status: number, body: unknown): void;
  },
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
): Promise<void> {
  const rec = await ctx.waitForRunStart(jobId);
  const metadata = acceptedRunReceipt(rec, ctx.storeId, wantsStoreIdentity(req));
  if (rec.runId && rec.runDir) {
    return ctx.json(
      res,
      200,
      ControlRunStartInfo.parse({
        ...metadata,
        jobId: rec.id,
        runId: rec.runId,
        taskId: rec.taskId,
        runDir: rec.runDir,
      }),
    );
  }
  const { status, body } = unboundRunStartResponse(
    rec,
    TERMINAL_STATES.has(rec.state),
    {},
    metadata,
  );
  return ctx.json(res, status, body);
}
