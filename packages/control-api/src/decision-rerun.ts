import type { ServerResponse } from "node:http";
import {
  ControlRunDecisionResponse,
  ControlRunStartRequest,
  type ControlRunDecisionRequest,
} from "@claudexor/schema";
import type {
  DaemonControlApiOptions,
  DaemonFacadeClient,
  DaemonRunRecord,
} from "./daemon-server.js";
import { projectControlProblem } from "./problem-response.js";
import { recordTurnEnqueueFailure } from "./thread-turn-routes.js";
import { TERMINAL_STATES } from "./sse-shared.js";
import * as runStart from "./run-start.js";

type RerunServices = Pick<
  NonNullable<DaemonControlApiOptions["services"]>,
  "createThreadTurn" | "setTurnEnqueueError"
>;

export interface DecisionRerunContext {
  daemon: DaemonFacadeClient;
  services?: RerunServices;
  waitForRunStart(id: string): Promise<DaemonRunRecord>;
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
  if (!body.feedback?.trim())
    return respondProblem(ctx, res, new Error("feedback is required"), {
      status: 400,
      code: "feedback_required",
    });
  const source = paramsRecord(rec);
  const originalPrompt = typeof source["prompt"] === "string" ? source["prompt"] : "";
  const { turnId: _turnId, planRunId: _planRunId, planRef: _planRef, ...original } = source;
  let params: ControlRunStartRequest;
  try {
    params = runStart.normalizeRunStart(
      ControlRunStartRequest.parse({
        ...original,
        prompt: `${originalPrompt}\n\n## Reviewer feedback to address (operator decision)\n${body.feedback}`,
        parentRunId: rec.runId ?? rec.id,
      }),
    );
  } catch (error) {
    return respondProblem(ctx, res, error, {
      status: 400,
      code: "invalid_rerun_request",
      message: "cannot rebuild run params for rerun",
    });
  }
  const threadId = typeof source["threadId"] === "string" ? source["threadId"] : null;
  let turnId: string | undefined;
  if (threadId && ctx.services?.createThreadTurn) {
    const turn = (await ctx.services.createThreadTurn(threadId, params.prompt, {
      kind: "decision",
      parentRunId: rec.runId ?? rec.id,
      idempotency: {
        key: idempotencyKey,
        client: "control-api",
        request: { runId: rec.runId ?? rec.id, body },
      },
    })) as { id: string };
    turnId = turn.id;
  }
  let job: { id: string };
  try {
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
    recordTurnEnqueueFailure(ctx.services?.setTurnEnqueueError, turnId, error);
    return respondProblem(ctx, res, error, {
      status: 500,
      code: "rerun_enqueue_failed",
      message: "rerun enqueue failed",
      context: { ...(turnId ? { turnId } : {}) },
    });
  }
  let run: DaemonRunRecord;
  try {
    run = await ctx.waitForRunStart(job.id);
  } catch (error) {
    return respondProblem(ctx, res, error, {
      status: 500,
      code: "rerun_start_unobserved",
      message: `rerun job ${job.id} was accepted but its start could not be observed`,
      context: { jobId: job.id, ...(turnId ? { turnId } : {}) },
    });
  }
  if (!run.runId && TERMINAL_STATES.has(run.state)) {
    const terminal = runStart.unboundRunStartResponse(run, true);
    return ctx.json(res, terminal.status, {
      ...terminal.body,
      context: {
        ...((terminal.body["context"] as Record<string, unknown> | undefined) ?? {}),
        ...(turnId ? { turnId } : {}),
      },
    });
  }
  ctx.appendAudit(rec, { decision: body.action, new_run_id: run.runId ?? run.id });
  ctx.json(
    res,
    200,
    ControlRunDecisionResponse.parse({
      accepted: true,
      status: "requeued",
      newRunId: run.runId ?? run.id,
      message: "follow-up run enqueued with reviewer feedback",
    }),
  );
}

function respondProblem(
  ctx: DecisionRerunContext,
  res: ServerResponse,
  error: unknown,
  defaults: {
    status: number;
    code: string;
    message?: string;
    context?: Record<string, unknown>;
  },
): void {
  const projected = projectControlProblem(error, {
    status: defaults.status,
    code: defaults.code,
    retryable: false,
    message: defaults.message,
  });
  ctx.json(res, projected.status, {
    ...projected.body,
    context: { ...projected.body.context, ...defaults.context },
  });
}

function paramsRecord(rec: DaemonRunRecord): Record<string, unknown> {
  return rec.params && typeof rec.params === "object" && !Array.isArray(rec.params)
    ? (rec.params as Record<string, unknown>)
    : {};
}
