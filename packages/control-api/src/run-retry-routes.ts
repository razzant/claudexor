import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  ControlRunAgainDraft,
  ControlRunRetryResponse,
  ControlRunStartRequest,
  TaskContract,
} from "@claudexor/schema";
import type { EffortHint } from "@claudexor/schema";
import type {
  DaemonControlApiOptions,
  DaemonFacadeClient,
  DaemonRunRecord,
} from "./daemon-server.js";
import { recordTurnEnqueueFailure } from "./thread-turn-routes.js";
import * as runStart from "./run-start.js";

type RetryServices = Pick<
  NonNullable<DaemonControlApiOptions["services"]>,
  | "createThreadTurn"
  | "setTurnEnqueueError"
  | "threadDetail"
  | "validateResources"
  | "preflightRunRequirements"
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
    // QA-035: Exact Retry replays the IMMUTABLE original request. The stored
    // params omit any model/effort the caller left to settings, so re-reading
    // current settings would silently change the route after a settings edit.
    // Replay the values the engine FROZE into the source run's TaskContract
    // (routing_models / routing_efforts) — a value the caller stated explicitly
    // still wins.
    const frozen = readFrozenRouting(source);
    params = runStart.normalizeRunStart({
      ...original,
      ...(frozen.models ? { models: { ...frozen.models, ...(original.models ?? {}) } } : {}),
      // QA-035 completeness: replay the FROZEN per-lane efforts map so a
      // non-primary lane keeps its own effort (the old scalar collapse dropped
      // it). Frozen entries merge UNDER anything the caller stated explicitly.
      ...(frozen.efforts ? { efforts: { ...frozen.efforts, ...(original.efforts ?? {}) } } : {}),
      parentRunId: source.runId ?? source.id,
      retryOf: source.runId ?? source.id,
    });
    await ctx.services?.validateResources?.(params.attachments ?? []);
    await ctx.services?.preflightRunRequirements?.(params);
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

/** QA-035: read the model/effort the engine froze into the source run's
 * TaskContract. Exact Retry injects these as the immutable route so a settings
 * change between runs cannot silently re-resolve the model or drop the effort.
 * The efforts are replayed as the WHOLE per-lane map (not a single primary-lane
 * scalar) so a non-primary lane keeps its own frozen effort. A missing/old/
 * unreadable contract yields nothing — retry then behaves exactly as before. */
function readFrozenRouting(source: DaemonRunRecord): {
  models?: Record<string, string>;
  efforts?: Record<string, EffortHint>;
} {
  if (!source.runDir) return {};
  let contract: TaskContract;
  try {
    contract = TaskContract.parse(
      parseYaml(readFileSync(join(source.runDir, "context", "task.yaml"), "utf8")),
    );
  } catch {
    return {};
  }
  const models =
    Object.keys(contract.routing_models).length > 0 ? contract.routing_models : undefined;
  const efforts =
    Object.keys(contract.routing_efforts).length > 0
      ? (contract.routing_efforts as Record<string, EffortHint>)
      : undefined;
  return { ...(models ? { models } : {}), ...(efforts ? { efforts } : {}) };
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
  if (Array.isArray(turn?.attachments)) {
    params["attachments"] = turn.attachments.map((attachment) => ({
      resourceId:
        attachment && typeof attachment === "object"
          ? (attachment as { resource_id?: unknown }).resource_id
          : undefined,
    }));
  }
  return params;
}
