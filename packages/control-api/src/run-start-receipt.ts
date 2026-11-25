import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CONTROL_CAPABILITIES_HEADER,
  CONTROL_STORE_IDENTITY_HEADER,
  ControlQueuedRunInfo,
  ControlRunStartInfo,
  TaskGroupReceipt,
} from "@claudexor/schema";
import type { RunDeadlineSnapshot } from "@claudexor/schema";
import type { DaemonFacadeClient, DaemonRunRecord } from "./run-record.js";
import { TERMINAL_STATES } from "./sse-shared.js";

/** The request opted in to `storeId`: some shipped same-major clients parse a receipt strictly. */
export function wantsStoreIdentity(req: IncomingMessage): boolean {
  return req.headers[CONTROL_STORE_IDENTITY_HEADER] === "1";
}

/** This answer's reader opted in to run-deadline/1 facts (`X-Claudexor-Capabilities: 1`, the
 * header its handshake takes): the exact `run_deadline_expired` reason and failure code, and a
 * deadline the job inherited. A client built before run-deadline/1 parses those as closed sets
 * or strict objects and drops the whole outcome, failure or handle; it is answered without them. */
export function readsRunDeadline(req: IncomingMessage): boolean {
  return req.headers[CONTROL_CAPABILITIES_HEADER] === "1";
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
  metadata: Partial<TaskGroupReceipt> & { deadline?: RunDeadlineSnapshot } = {},
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

/**
 * The run-deadline/1 snapshot a start receipt, a pre-start refusal and a lookup
 * carry. A reader that opted in (`readsRunDeadline`) gets the deadline the job
 * holds, its own or inherited (`heldDeadline`). Any other reader gets only one its
 * own request set: that request proves it knows the field, and a client built
 * before run-deadline/1, which never sets one, parses a lookup handle and a queued
 * turn strictly.
 */
export async function receiptDeadline(
  daemon: Pick<DaemonFacadeClient, "runDeadline"> | undefined,
  rec: DaemonRunRecord,
  readsDeadline: boolean,
): Promise<{ deadline?: RunDeadlineSnapshot }> {
  const params = rec.params as { deadline?: unknown } | null | undefined;
  const own = !!params && typeof params === "object" && params.deadline !== undefined;
  return readsDeadline || own ? heldDeadline(daemon, rec) : {};
}

/**
 * The deadline a job holds, read for every job that can hold a deadline record —
 * one that set its own, a continuation (`continueFrom`) or a Delegate child
 * (`delegatedFromRunId`) that may inherit one, and a job its deadline ended. A job
 * without a record holds none. Also the engine's own read for a replay refusal and
 * Run Again's differences, whoever asks. The projection is read-only (`peek`): it
 * awaits no pending change and starts no stop, so the receipt agrees with the
 * handle it carries. A record that exists but cannot be read fails the answer
 * (503, retryable).
 */
export async function heldDeadline(
  daemon: Pick<DaemonFacadeClient, "runDeadline"> | undefined,
  rec: DaemonRunRecord,
): Promise<{ deadline?: RunDeadlineSnapshot }> {
  const params = rec.params as
    { deadline?: unknown; continueFrom?: unknown; delegatedFromRunId?: unknown } | null | undefined;
  const mayHold =
    rec.errorCode === "run_deadline_expired" ||
    (!!params &&
      typeof params === "object" &&
      (params.deadline !== undefined ||
        typeof params.continueFrom === "string" ||
        typeof params.delegatedFromRunId === "string"));
  if (!mayHold || !daemon?.runDeadline) return {};
  try {
    return { deadline: await daemon.runDeadline(rec.id, { action: "peek" }) };
  } catch (error) {
    // No record (a job that inherited none): the field is left out, the handle stands.
    if ((error as { code?: unknown })?.code === "run_deadline_absent") return {};
    throw error;
  }
}

/**
 * A replay of a run that held a run-deadline/1 deadline (its own or inherited)
 * would start an ordinary run with no deadline at all: Exact Retry, a decision
 * rerun and a thread turn retry refuse it, typed, and name the start that
 * carries a new deadline. Fail closed: a source whose request set a deadline,
 * or that its deadline ended, is refused even when its record is gone; a
 * record that cannot be read fails the request (503). Null when the source
 * held none.
 */
export async function deadlineReplayRefusal(
  daemon: Pick<DaemonFacadeClient, "runDeadline"> | undefined,
  source: DaemonRunRecord,
  route: string,
  restart: { threadId: string } | null = null,
): Promise<{ error: string; code: string; retryable: false; requiredActions: string[] } | null> {
  const params = source.params as { deadline?: unknown } | null | undefined;
  const explicit = !!params && typeof params === "object" && params.deadline !== undefined;
  const { deadline } = await heldDeadline(daemon, source);
  if (!deadline && !explicit && source.errorCode !== "run_deadline_expired") return null;
  return {
    error: `${route} would start this run again without its deadline; start it again with a new deadline instead`,
    code: "run_deadline_replay_refused",
    retryable: false,
    requiredActions: [
      restart
        ? `Send a new turn with deadline.at (POST /v2/threads/${restart.threadId}/turns) under a new idempotency key.`
        : "Start a new run with deadline.at (POST /v2/runs), or take Run Again and give the draft its own deadline.",
    ],
  };
}

/** Answer an accepted one-shot job: its bound handle, its queued handle or its pre-run refusal. */
export async function respondToAcceptedJob(
  ctx: {
    waitForRunStart(jobId: string): Promise<DaemonRunRecord>;
    storeId?: () => string | undefined;
    json(res: ServerResponse, status: number, body: unknown): void;
    daemon?: Pick<DaemonFacadeClient, "runDeadline">;
  },
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
): Promise<void> {
  const rec = await ctx.waitForRunStart(jobId);
  const metadata = {
    ...acceptedRunReceipt(rec, ctx.storeId, wantsStoreIdentity(req)),
    ...(await receiptDeadline(ctx.daemon, rec, readsRunDeadline(req))),
  };
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
