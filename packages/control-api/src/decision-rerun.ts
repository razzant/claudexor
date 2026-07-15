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
import { recordTurnEnqueueFailure } from "./thread-turn-routes.js";
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
  if (!body.feedback?.trim()) return ctx.json(res, 400, { error: "feedback is required" });
  const source = paramsRecord(rec);
  const originalPrompt = typeof source["prompt"] === "string" ? source["prompt"] : "";
  const { turnId: _turnId, planRunId: _planRunId, ...original } = source;
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
    return ctx.json(res, 400, {
      error: `cannot rebuild run params for rerun: ${error instanceof Error ? error.message : String(error)}`,
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
    const status =
      error && typeof error === "object" && "status" in error
        ? Number((error as { status: number }).status)
        : 500;
    return ctx.json(res, status, {
      error: error instanceof Error ? error.message : "rerun enqueue failed",
      ...(turnId ? { turnId, retryable: false } : {}),
    });
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

function paramsRecord(rec: DaemonRunRecord): Record<string, unknown> {
  return rec.params && typeof rec.params === "object" && !Array.isArray(rec.params)
    ? (rec.params as Record<string, unknown>)
    : {};
}
