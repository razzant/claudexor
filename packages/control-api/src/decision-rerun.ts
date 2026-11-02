import type { ServerResponse } from "node:http";
import {
  ControlRunDecisionResponse,
  ControlRunStartRequest,
  restoreRecordedRunReviewRequest,
  decodeAcceptedRunStart,
  type ControlRunDecisionRequest,
} from "@claudexor/schema";
import type {
  DaemonControlApiOptions,
  DaemonFacadeClient,
  DaemonRunRecord,
} from "./daemon-server.js";
import { recordTurnEnqueueFailure, turnEnqueueProblemResponse } from "./thread-turn-problems.js";
import { resolveThreadRecoveryTurn } from "./thread-recovery.js";
import { TERMINAL_STATES } from "./sse-shared.js";
import * as runStart from "./run-start.js";

type RerunServices = Pick<
  NonNullable<DaemonControlApiOptions["services"]>,
  "createThreadTurn" | "findThreadTurnByIdempotency" | "setTurnEnqueueError" | "threadDetail"
>;

export interface DecisionRerunContext {
  daemon: DaemonFacadeClient;
  services?: RerunServices;
  serializeThreadMutation<T>(threadId: string, work: () => Promise<T>): Promise<T>;
  waitForRunStart(id: string): Promise<DaemonRunRecord>;
  storeId?: () => string | undefined;
  wantsStoreId?: boolean;
  appendAudit(record: DaemonRunRecord, payload: Record<string, unknown>): void;
  json(response: ServerResponse, status: number, body: unknown): void;
}

export async function rerunWithFeedback(
  ctx: DecisionRerunContext,
  rec: DaemonRunRecord,
  body: ControlRunDecisionRequest,
  idempotencyKey: string,
  res: ServerResponse,
): Promise<void> {
  if (!body.feedback?.trim()) return ctx.json(res, 400, { error: "feedback is required" });
  const source = paramsRecord(rec);
  if (typeof source["delegatedFromRunId"] === "string") {
    return ctx.json(res, 409, {
      error:
        "Decision rerun is unavailable for a Delegate child after its parent authority ends; use Run Again to create an ordinary editable run",
      code: "delegated_child_rerun_unavailable",
      retryable: false,
    });
  }
  const originalPrompt = typeof source["prompt"] === "string" ? source["prompt"] : "";
  const {
    turnId: _turnId,
    planRunId: _planRunId,
    planRef: _planRef,
    retryOf: _retryOf,
    protectedPathApprovals: _protectedPathApprovals,
    deferredDefaults: _deferredDefaults,
    ...original
  } = source;
  let params: ControlRunStartRequest;
  try {
    decodeAcceptedRunStart(source);
    params = runStart.normalizeRunStart(
      restoreRecordedRunReviewRequest(
        ControlRunStartRequest.parse({
          ...original,
          prompt: `${originalPrompt}\n\n## Reviewer feedback to address (operator decision)\n${body.feedback}`,
          parentRunId: rec.runId ?? rec.id,
        }),
      ),
    );
  } catch (error) {
    return ctx.json(res, 400, {
      error: `cannot rebuild run params for rerun: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const threadId = typeof source["threadId"] === "string" ? source["threadId"] : null;
  const rerun = async (): Promise<void> => {
    let turnId: string | undefined;
    if (threadId) {
      const idempotency = {
        key: idempotencyKey,
        client: "control-api",
        request: { runId: rec.runId ?? rec.id, body },
      };
      const turn = await resolveThreadRecoveryTurn(
        ctx.daemon,
        ctx.services,
        rec,
        threadId,
        params.prompt,
        { kind: "decision", parentRunId: rec.runId ?? rec.id },
        idempotency,
        (existingTurnId) =>
          ctx.daemon.findAccepted?.(
            { ...params, turnId: existingTurnId },
            {
              idempotencyKey,
              clientId: "control-api",
              operation: "run.decision.rerun",
              idempotencyRequest: idempotency.request,
            },
          ) ?? Promise.resolve(null),
      );
      turnId = turn.id;
    }
    let job: { id: string; reused?: boolean };
    try {
      // The inherited group needs the same store identity as a direct launch.
      runStart.requireTaskGroupStoreIdentity(params, ctx.storeId);
      job = await ctx.daemon.enqueue(
        { ...params, ...(turnId ? { turnId } : {}) },
        {
          idempotencyKey,
          clientId: "control-api",
          operation: "run.decision.rerun",
          idempotencyRequest: { runId: rec.runId ?? rec.id, body },
        },
      );
    } catch (error) {
      const problem = recordTurnEnqueueFailure(ctx.services?.setTurnEnqueueError, turnId, error);
      const status =
        error && typeof error === "object" && "status" in error
          ? Number((error as { status: number }).status)
          : 500;
      return ctx.json(
        res,
        status,
        turnEnqueueProblemResponse(problem, {
          ...(threadId ? { threadId } : {}),
          ...(turnId ? { turnId } : {}),
        }),
      );
    }
    let run: DaemonRunRecord;
    try {
      run = await ctx.waitForRunStart(job.id);
    } catch (error) {
      return ctx.json(res, 500, {
        error: `rerun job ${job.id} was accepted but its start could not be observed: ${error instanceof Error ? error.message : String(error)}`,
        jobId: job.id,
        ...(turnId ? { turnId } : {}),
      });
    }
    const metadata = runStart.acceptedRunReceipt(run, ctx.storeId, ctx.wantsStoreId);
    if (!run.runId && TERMINAL_STATES.has(run.state)) {
      const refusal = runStart.unboundRunStartResponse(
        run,
        true,
        {
          ...(threadId ? { threadId } : {}),
          ...(turnId ? { turnId } : {}),
        },
        metadata,
      );
      return ctx.json(res, refusal.status, refusal.body);
    }
    // The daemon command journal is the idempotency authority. Only the
    // request that durably accepted the command owns this audit side effect;
    // same-key replays return the same run without duplicating history.
    if (job.reused === false) {
      ctx.appendAudit(rec, {
        decision: body.action,
        ...(_deferredDefaults ? { omitted_controls: ["deferredDefaults"] } : {}),
        ...(run.runId ? { new_run_id: run.runId } : { new_job_id: run.id }),
      });
    }
    ctx.json(
      res,
      200,
      ControlRunDecisionResponse.parse({
        accepted: true,
        status: "requeued",
        ...(run.runId ? { newRunId: run.runId } : {}),
        newJobId: run.id,
        ...metadata,
        message:
          (run.runId
            ? "follow-up run enqueued with reviewer feedback"
            : "follow-up job enqueued; run start is still pending") +
          (_deferredDefaults ? "; execution preferences resolve from current settings" : ""),
      }),
    );
  };
  return threadId ? ctx.serializeThreadMutation(threadId, rerun) : rerun();
}

function paramsRecord(rec: DaemonRunRecord): Record<string, unknown> {
  return rec.params && typeof rec.params === "object" && !Array.isArray(rec.params)
    ? (rec.params as Record<string, unknown>)
    : {};
}
