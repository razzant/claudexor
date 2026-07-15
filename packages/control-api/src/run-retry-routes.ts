import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ControlRunAgainDraft,
  ControlRunRetryResponse,
  ControlRunStartRequest,
} from "@claudexor/schema";
import type {
  DaemonControlApiOptions,
  DaemonFacadeClient,
  DaemonRunRecord,
} from "./daemon-server.js";
import { recordTurnEnqueueFailure } from "./thread-turn-routes.js";
import * as runStart from "./run-start.js";

type RetryServices = Pick<
  NonNullable<DaemonControlApiOptions["services"]>,
  "createThreadTurn" | "setTurnEnqueueError" | "threadDetail"
>;

export interface RunRetryRouteContext {
  daemon: DaemonFacadeClient;
  services?: RetryServices;
  findRun(id: string): Promise<DaemonRunRecord | null>;
  waitForRunStart(jobId: string): Promise<DaemonRunRecord>;
  json(response: ServerResponse, status: number, body: unknown): void;
  requestError(response: ServerResponse, error: unknown): void;
}

export async function handleRunRetryRoute(
  ctx: RunRetryRouteContext,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const retryMatch = /^\/runs\/([^/]+)\/retry$/.exec(path);
  if (method === "POST" && retryMatch) {
    await exactRetry(ctx, decodeURIComponent(retryMatch[1] as string), req, res);
    return true;
  }
  const runAgainMatch = /^\/runs\/([^/]+)\/run-again$/.exec(path);
  if (method === "GET" && runAgainMatch) {
    await runAgain(ctx, decodeURIComponent(runAgainMatch[1] as string), res);
    return true;
  }
  return false;
}

async function exactRetry(
  ctx: RunRetryRouteContext,
  id: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const source = await ctx.findRun(id);
  if (!source) return ctx.json(res, 404, { error: "no such run" });
  if (source.state === "queued" || source.state === "running") {
    return ctx.json(res, 409, { error: `run is still ${source.state}` });
  }
  let idempotencyKey: string;
  let params: ControlRunStartRequest;
  try {
    idempotencyKey = runStart.requiredIdempotencyKey(req);
    const parsed = ControlRunStartRequest.parse(
      await sourceParamsWithThreadAttachments(ctx, source),
    );
    const { turnId: _turnId, retryOf: _retryOf, ...original } = parsed;
    params = runStart.validateDirectRunAttachments(
      runStart.normalizeRunStart({
        ...original,
        parentRunId: source.runId ?? source.id,
        retryOf: source.runId ?? source.id,
      }),
    );
  } catch (error) {
    return ctx.requestError(res, error);
  }
  const sourceRunId = source.runId ?? source.id;
  const threadId = typeof params.threadId === "string" ? params.threadId : null;
  let retryTurnId: string | undefined;
  if (threadId && ctx.services?.createThreadTurn) {
    const turn = (await ctx.services.createThreadTurn(threadId, params.prompt, {
      kind: "followup",
      parentRunId: sourceRunId,
      planRunId: params.planRunId ?? null,
      attachments: params.attachments,
      idempotency: {
        key: idempotencyKey,
        client: "control-api",
        request: { retryOf: sourceRunId },
      },
    })) as { id: string };
    retryTurnId = turn.id;
  }
  const request = { ...params, ...(retryTurnId ? { turnId: retryTurnId } : {}) };
  let job: { id: string };
  try {
    job = await ctx.daemon.enqueue(request, {
      idempotencyKey,
      clientId: "control-api",
      operation: "run.retry",
      idempotencyRequest: { retryOf: sourceRunId },
    });
  } catch (error) {
    recordTurnEnqueueFailure(ctx.services?.setTurnEnqueueError, retryTurnId, error);
    return ctx.requestError(res, error);
  }
  const accepted = await ctx.waitForRunStart(job.id);
  ctx.json(
    res,
    accepted.runId ? 200 : 202,
    ControlRunRetryResponse.parse({
      retryOf: sourceRunId,
      jobId: accepted.id,
      runId: accepted.runId ?? null,
      turnId: retryTurnId ?? null,
      state: accepted.state,
    }),
  );
}

async function runAgain(ctx: RunRetryRouteContext, id: string, res: ServerResponse): Promise<void> {
  const source = await ctx.findRun(id);
  if (!source) return ctx.json(res, 404, { error: "no such run" });
  try {
    const parsed = ControlRunStartRequest.parse(
      await sourceParamsWithThreadAttachments(ctx, source),
    );
    const { turnId, retryOf, planRunId, ...request } = parsed;
    const differences = [
      ...(turnId
        ? [{ field: "turnId", change: "omitted" as const, reason: "server-owned turn binding" }]
        : []),
      ...(retryOf
        ? [{ field: "retryOf", change: "omitted" as const, reason: "new editable run" }]
        : []),
      ...(planRunId
        ? [{ field: "planRunId", change: "omitted" as const, reason: "server-owned plan binding" }]
        : []),
    ];
    ctx.json(
      res,
      200,
      ControlRunAgainDraft.parse({ sourceRunId: source.runId ?? source.id, request, differences }),
    );
  } catch (error) {
    ctx.requestError(res, error);
  }
}

async function sourceParamsWithThreadAttachments(
  ctx: RunRetryRouteContext,
  source: DaemonRunRecord,
): Promise<unknown> {
  const params =
    source.params && typeof source.params === "object" && !Array.isArray(source.params)
      ? ({ ...source.params } as Record<string, unknown>)
      : {};
  if (params["attachments"] !== undefined) return params;
  const threadId = typeof params["threadId"] === "string" ? params["threadId"] : null;
  const turnId = typeof params["turnId"] === "string" ? params["turnId"] : null;
  if (!threadId || !turnId || !ctx.services?.threadDetail) return params;
  const detail = await ctx.services.threadDetail(threadId);
  const turn = detail.turns.find(
    (candidate) =>
      candidate &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      (candidate as { id?: unknown }).id === turnId,
  ) as { attachments?: unknown } | undefined;
  if (Array.isArray(turn?.attachments)) params["attachments"] = structuredClone(turn.attachments);
  return params;
}
