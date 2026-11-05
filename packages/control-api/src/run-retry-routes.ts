import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  ControlRunAgainDraft,
  RecordedControlRunStartRequest,
  ControlRunRetryResponse,
  ControlRunStartRequest,
  RETIRED_EXTERNAL_SANDBOX_FULL,
  TaskContract,
  restoreRecordedRunReviewRequest,
  decodeAcceptedRunStart,
} from "@claudexor/schema";
import type { EffortHint, ProcessingPreference, PromptCacheTtl } from "@claudexor/schema";
import type {
  DaemonControlApiOptions,
  DaemonFacadeClient,
  DaemonRunRecord,
} from "./daemon-server.js";
import { recordTurnEnqueueFailure, turnEnqueueProblemResponse } from "./thread-turn-problems.js";
import { resolveThreadRecoveryTurn } from "./thread-recovery.js";
import { TERMINAL_STATES } from "./sse-shared.js";
import * as runStart from "./run-start.js";

type RetryServices = Pick<
  NonNullable<DaemonControlApiOptions["services"]>,
  | "createThreadTurn"
  | "findThreadTurnByIdempotency"
  | "setTurnEnqueueError"
  | "threadDetail"
  | "validateResources"
  | "preflightRunRequirements"
>;

export interface RunRetryRouteContext {
  daemon: DaemonFacadeClient;
  storeId?: () => string | undefined;
  wantsStoreId?: boolean;
  services?: RetryServices;
  findRun(id: string): Promise<DaemonRunRecord | null>;
  waitForRunStart(jobId: string): Promise<DaemonRunRecord>;
  serializeThreadMutation<T>(threadId: string, work: () => Promise<T>): Promise<T>;
  json(response: ServerResponse, status: number, body: unknown): void;
  requestError(response: ServerResponse, error: unknown, fallbackStatus?: 400 | 500): void;
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
  const sourceParams = paramsRecord(source);
  if (typeof sourceParams["delegatedFromRunId"] === "string") {
    return ctx.json(res, 409, {
      error:
        "Exact Retry is unavailable for a Delegate child after its parent authority ends; use Run Again to create an ordinary editable run",
      code: "delegated_child_retry_unavailable",
      retryable: false,
    });
  }
  if (source.state === "queued" || source.state === "running") {
    return ctx.json(res, 409, { error: `run is still ${source.state}` });
  }
  let idempotencyKey: string;
  let recordedParams: RecordedControlRunStartRequest;
  let sourceTurnProvenance: SourceTurnProvenance = {};
  try {
    idempotencyKey = runStart.requiredIdempotencyKey(req);
    const replay = await sourceReplayInput(ctx, source);
    sourceTurnProvenance = replay.turn;
    const recorded = restoreRecordedRunReviewRequest(decodeAcceptedRunStart(replay.params).request);
    const { turnId: _turnId, retryOf: _retryOf, ...original } = recorded;
    // QA-035: Exact Retry replays the IMMUTABLE original request. The stored
    // params omit any model/effort the caller left to settings, so re-reading
    // current settings would silently change the route after a settings edit.
    // Replay the values the engine FROZE into the source run's TaskContract
    // (routing_models / routing_efforts) — a value the caller stated explicitly
    // still wins.
    const frozen = readFrozenRouting(source);
    recordedParams = RecordedControlRunStartRequest.parse({
      ...original,
      ...(frozen.models ? { models: { ...frozen.models, ...(original.models ?? {}) } } : {}),
      // QA-035 completeness: replay the FROZEN per-lane efforts map so a
      // non-primary lane keeps its own effort (the old scalar collapse dropped
      // it). Frozen entries merge UNDER anything the caller stated explicitly.
      ...(frozen.efforts ? { efforts: { ...frozen.efforts, ...(original.efforts ?? {}) } } : {}),
      ...(original.processingPreference === undefined && frozen.processingPreference !== undefined
        ? { processingPreference: frozen.processingPreference }
        : {}),
      ...(original.promptCacheTtl === undefined && frozen.promptCacheTtl !== undefined
        ? { promptCacheTtl: frozen.promptCacheTtl }
        : {}),
      parentRunId: source.runId ?? source.id,
      retryOf: source.runId ?? source.id,
    });
  } catch (error) {
    return ctx.requestError(res, error);
  }
  const sourceRunId = source.runId ?? source.id;
  const threadId = typeof recordedParams.threadId === "string" ? recordedParams.threadId : null;
  const idempotencyRequest = { retryOf: sourceRunId };
  let params: ControlRunStartRequest | undefined;
  // A durable daemon command is the canonical replay owner. Probe the
  // historical projection before active parsing, including the retirement
  // check, so an unknown old POST outcome cannot strand a live accepted run.
  // Only an absent lookup (plus the race-closing second miss) may turn the
  // retired body into a definitive refusal.
  let preflightStarted = false;
  try {
    const prior = await runStart.findAcceptedAroundPreflight(
      () =>
        ctx.daemon.findAccepted?.(recordedParams, {
          idempotencyKey,
          clientId: "control-api",
          operation: "run.retry",
          idempotencyRequest,
        }) ?? Promise.resolve(null),
      async () => {
        preflightStarted = true;
        if (recordedParams.access === RETIRED_EXTERNAL_SANDBOX_FULL) {
          throw Object.assign(
            new Error(
              "Exact Retry cannot reproduce the retired external_sandbox_full access guarantee; use Run Again and choose an active access profile",
            ),
            {
              status: 409,
              code: "retired_access_profile",
              retryable: false,
              requiredActions: [
                "Use Run Again and choose workspace_write, or explicitly trust the repository and choose full.",
              ],
            },
          );
        }
        params = runStart.normalizeRunStart(ControlRunStartRequest.parse(recordedParams));
        // A same-key repeat whose recovery turn was recorded before its first enqueue
        // (#249) reads the refs as that turn, which holds them; otherwise this Exact
        // Retry is a new reference. A changed request under the key conflicts here.
        const recorded = threadId
          ? await ctx.services?.findThreadTurnByIdempotency?.(threadId, {
              key: idempotencyKey,
              client: "control-api",
              request: idempotencyRequest,
            })
          : null;
        const heldBy = recorded ? { owner: "turn" as const, id: recorded.id } : undefined;
        await ctx.services?.validateResources?.(params.attachments ?? [], heldBy);
        await ctx.services?.preflightRunRequirements?.(params, heldBy);
      },
    );
    if (prior) {
      const priorParams = paramsRecord(prior);
      const priorTurnId =
        typeof priorParams["turnId"] === "string" ? priorParams["turnId"] : undefined;
      return await respondToExactRetryJob(ctx, res, sourceRunId, prior, threadId, priorTurnId);
    }
  } catch (error) {
    return ctx.requestError(res, error, preflightStarted ? undefined : 500);
  }
  if (!params) {
    return ctx.requestError(
      res,
      Object.assign(new Error("retry admission did not produce an active request"), {
        status: 500,
      }),
      500,
    );
  }
  const activeParams = params;
  const retry = async (): Promise<void> => {
    let retryTurnId: string | undefined;
    if (threadId) {
      const turn = await resolveThreadRecoveryTurn(
        ctx.daemon,
        ctx.services,
        source,
        threadId,
        activeParams.prompt,
        {
          kind: "followup",
          parentRunId: sourceRunId,
          planRunId: activeParams.planRunId ?? null,
          planHash: sourceTurnProvenance.planHash ?? null,
          planOverridden: sourceTurnProvenance.planOverridden === true,
          attachments: activeParams.attachments,
        },
        {
          key: idempotencyKey,
          client: "control-api",
          request: idempotencyRequest,
        },
        (turnId) =>
          ctx.daemon.findAccepted?.(
            { ...activeParams, turnId },
            {
              idempotencyKey,
              clientId: "control-api",
              operation: "run.retry",
              idempotencyRequest,
            },
          ) ?? Promise.resolve(null),
      );
      retryTurnId = turn.id;
    }
    const request = { ...activeParams, ...(retryTurnId ? { turnId: retryTurnId } : {}) };
    let job: { id: string };
    try {
      runStart.requireTaskGroupStoreIdentity(request, ctx.storeId);
      job = await ctx.daemon.enqueue(request, {
        idempotencyKey,
        clientId: "control-api",
        operation: "run.retry",
        idempotencyRequest,
      });
    } catch (error) {
      const problem = recordTurnEnqueueFailure(
        ctx.services?.setTurnEnqueueError,
        retryTurnId,
        error,
      );
      const status =
        error && typeof error === "object" && "status" in error
          ? Number((error as { status: number }).status)
          : 500;
      return ctx.json(
        res,
        status,
        turnEnqueueProblemResponse(problem, {
          ...(threadId ? { threadId } : {}),
          ...(retryTurnId ? { turnId: retryTurnId } : {}),
        }),
      );
    }
    return respondToExactRetryJob(ctx, res, sourceRunId, job, threadId, retryTurnId);
  };
  try {
    return await (threadId ? ctx.serializeThreadMutation(threadId, retry) : retry());
  } catch (error) {
    return ctx.requestError(res, error, 500);
  }
}

async function respondToExactRetryJob(
  ctx: RunRetryRouteContext,
  res: ServerResponse,
  sourceRunId: string,
  job: { id: string },
  threadId: string | null,
  retryTurnId?: string,
): Promise<void> {
  let accepted: DaemonRunRecord;
  try {
    accepted = await ctx.waitForRunStart(job.id);
  } catch (error) {
    return ctx.json(res, 500, {
      error: `retry job ${job.id} was accepted but its start could not be observed: ${error instanceof Error ? error.message : String(error)}`,
      jobId: job.id,
      retryOf: sourceRunId,
      ...(threadId ? { threadId } : {}),
      ...(retryTurnId ? { turnId: retryTurnId } : {}),
    });
  }
  const metadata = runStart.acceptedRunReceipt(accepted, ctx.storeId, ctx.wantsStoreId);
  if (!accepted.runId && TERMINAL_STATES.has(accepted.state)) {
    // The replayed job died BEFORE it bound a run (e.g. the trust gate's typed
    // 403). A 202 here would hand the caller a durable handle for a run that
    // will never exist, and `claudexor retry` would exit 0 on it.
    const { status, body } = runStart.unboundRunStartResponse(
      accepted,
      true,
      {
        retryOf: sourceRunId,
        ...(threadId ? { threadId } : {}),
        ...(retryTurnId ? { turnId: retryTurnId } : {}),
      },
      metadata,
    );
    return ctx.json(res, status, body);
  }
  ctx.json(
    res,
    accepted.runId ? 200 : 202,
    ControlRunRetryResponse.parse({
      ...metadata,
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
    const accepted = decodeAcceptedRunStart((await sourceReplayInput(ctx, source)).params);
    const recorded = restoreRecordedRunReviewRequest(accepted.request);
    const retiredAccess = recorded.access === RETIRED_EXTERNAL_SANDBOX_FULL;
    const { access: recordedAccess, ...withoutRecordedAccess } = recorded;
    const parsed = ControlRunStartRequest.parse(
      retiredAccess ? withoutRecordedAccess : { ...withoutRecordedAccess, access: recordedAccess },
    );
    // Strip EVERY server-owned binding, with disclosure: the draft is an
    // editable POST /runs request, and POST /runs 400s threadId/planRef (they
    // belong to the turn pipeline) — surviving here would make the draft
    // unpostable, and a replayed planRef would smuggle the frozen-plan
    // reference past the boundary (INV-081). Same set as decision-rerun.
    const {
      turnId,
      retryOf,
      planRunId,
      planRef,
      threadId,
      parentRunId,
      delegatedFromRunId,
      continueModelInherited,
      ...request
    } = parsed;
    const differences = [
      ...(accepted.deferredDefaults
        ? [
            {
              field: "deferredDefaults",
              change: "omitted" as const,
              reason: "new editable run resolves execution preferences from current settings",
            },
          ]
        : []),
      ...(continueModelInherited !== undefined
        ? [
            {
              field: "continueModelInherited",
              change: "omitted" as const,
              reason: "model intent is resolved from the edited request",
            },
          ]
        : []),
      ...(turnId
        ? [{ field: "turnId", change: "omitted" as const, reason: "server-owned turn binding" }]
        : []),
      ...(retryOf
        ? [{ field: "retryOf", change: "omitted" as const, reason: "new editable run" }]
        : []),
      ...(planRunId
        ? [{ field: "planRunId", change: "omitted" as const, reason: "server-owned plan binding" }]
        : []),
      ...(planRef
        ? [
            {
              field: "planRef",
              change: "omitted" as const,
              reason: "server-owned frozen-plan reference",
            },
          ]
        : []),
      ...(threadId
        ? [{ field: "threadId", change: "omitted" as const, reason: "server-owned thread binding" }]
        : []),
      ...(parentRunId
        ? [{ field: "parentRunId", change: "omitted" as const, reason: "new ordinary run" }]
        : []),
      ...(delegatedFromRunId
        ? [
            {
              field: "delegatedFromRunId",
              change: "omitted" as const,
              reason: "Delegate parent authority is not replayable",
            },
          ]
        : []),
      ...(retiredAccess
        ? [
            {
              field: "access",
              change: "omitted" as const,
              reason:
                "external_sandbox_full is retired; choose workspace_write or explicitly trusted full",
            },
          ]
        : []),
    ];
    ctx.json(
      res,
      200,
      ControlRunAgainDraft.parse({
        sourceRunId: source.runId ?? source.id,
        request,
        accessChoice: { required: retiredAccess },
        differences,
      }),
    );
  } catch (error) {
    ctx.requestError(res, error);
  }
}

function paramsRecord(rec: DaemonRunRecord): Record<string, unknown> {
  return rec.params && typeof rec.params === "object" && !Array.isArray(rec.params)
    ? (rec.params as Record<string, unknown>)
    : {};
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
  processingPreference?: ProcessingPreference;
  promptCacheTtl?: PromptCacheTtl;
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
  return {
    ...(models ? { models } : {}),
    ...(efforts ? { efforts } : {}),
    ...(contract.processing_preference !== undefined
      ? { processingPreference: contract.processing_preference }
      : {}),
    ...(contract.prompt_cache_ttl !== undefined
      ? { promptCacheTtl: contract.prompt_cache_ttl }
      : {}),
  };
}

interface SourceTurnProvenance {
  planHash?: string | null;
  planOverridden?: boolean;
}

async function sourceReplayInput(
  ctx: RunRetryRouteContext,
  source: DaemonRunRecord,
): Promise<{ params: Record<string, unknown>; turn: SourceTurnProvenance }> {
  const params =
    source.params && typeof source.params === "object" && !Array.isArray(source.params)
      ? ({ ...source.params } as Record<string, unknown>)
      : {};
  const threadId = typeof params["threadId"] === "string" ? params["threadId"] : null;
  const turnId = typeof params["turnId"] === "string" ? params["turnId"] : null;
  if (!threadId || !turnId || !ctx.services?.threadDetail) return { params, turn: {} };
  const detail = await ctx.services.threadDetail(threadId);
  const turn = detail.turns.find(
    (candidate) =>
      candidate &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      (candidate as { id?: unknown }).id === turnId,
  ) as
    | {
        attachments?: unknown;
        plan_hash?: unknown;
        plan_readiness_overridden?: unknown;
      }
    | undefined;
  if (params["attachments"] === undefined && Array.isArray(turn?.attachments)) {
    params["attachments"] = turn.attachments.map((attachment) => ({
      resourceId:
        attachment && typeof attachment === "object"
          ? (attachment as { resource_id?: unknown }).resource_id
          : undefined,
    }));
  }
  return {
    params,
    turn: {
      planHash: typeof turn?.plan_hash === "string" ? turn.plan_hash : null,
      planOverridden: turn?.plan_readiness_overridden === true,
    },
  };
}
