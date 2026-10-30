import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ControlRunControlRequest,
  ControlRunControlResponse,
  DeferredMessageStopReport,
} from "@claudexor/schema";
import { errorCode } from "@claudexor/util";
import { cancelDelegationFamily } from "./delegation-control.js";
import { appendRunAuditEvent } from "./run-audit.js";
import type { DaemonFacadeClient, DaemonRunRecord } from "./run-record.js";

export interface RunControlRouteContext {
  daemon: DaemonFacadeClient;
  pollMs?: number;
  findRun(id: string): Promise<DaemonRunRecord | null>;
  delegatedDescendants(parentRunId: string): Promise<DaemonRunRecord[]>;
  readBody(req: IncomingMessage): Promise<unknown>;
  json(res: ServerResponse, status: number, body: unknown): void;
  requestError(res: ServerResponse, error: unknown): void;
}

export async function handleRunControlRoute(
  ctx: RunControlRouteContext,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const controlMatch = /^\/runs\/([^/]+)\/control$/.exec(path);
  if (!(method === "POST" && controlMatch)) return false;
  const rec = await ctx.findRun(decodeURIComponent(controlMatch[1] as string));
  if (!rec) {
    ctx.json(res, 404, { error: "no such run" });
    return true;
  }
  let body: ControlRunControlRequest;
  try {
    const raw = await ctx.readBody(req);
    body = ControlRunControlRequest.parse(raw);
  } catch (err) {
    ctx.requestError(res, err);
    return true;
  }
  appendRunAuditEvent(rec, "control.requested", { control: body.control });
  const kind = body.control.kind;
  // Stop holds a next message that is not accepted yet, whatever the run's
  // lifecycle: for an ended run here, for a live run in the daemon cancel right
  // after its ordinary stop. A successor that was already accepted is named,
  // never cancelled. A hold that cannot be saved is reported, never claimed,
  // and never blocks the ordinary stop.
  let followUp: DeferredMessageStopReport = { held: false, draft: null };
  let unsaved: unknown = null;
  // A terminal run has no process to stop, so claiming "applied" would invent an effect.
  if (rec.state !== "queued" && rec.state !== "running") {
    try {
      if (ctx.daemon.deferredMessageStop)
        followUp = DeferredMessageStopReport.parse(await ctx.daemon.deferredMessageStop(rec.id));
    } catch (error) {
      appendRunAuditEvent(rec, "control.rejected", { control: body.control, reason: text(error) });
      ctx.json(res, 503, stopHoldProblem(error, `run is ${rec.state}`));
      return true;
    }
    const { deferredMessage, successor } = nextMessage(followUp, kind);
    if (followUp.held) {
      appendRunAuditEvent(rec, "control.applied", { control: body.control });
      ctx.json(
        res,
        200,
        ControlRunControlResponse.parse({
          accepted: true,
          status: "applied",
          runId: rec.runId ?? rec.id,
          message: `run is ${rec.state}; ${kind} held its waiting next message`,
          deferredMessage,
        }),
      );
      return true;
    }
    appendRunAuditEvent(rec, "control.rejected", {
      control: body.control,
      reason: `run is terminal (${rec.state})${successor ? `; ${successor}` : ""}`,
    });
    ctx.json(
      res,
      409,
      successor
        ? {
            code: "next_message_dispatched",
            error: `run is ${rec.state}; ${kind} has nothing to stop: ${successor}`,
            requiredActions: [`Stop job ${deferredMessage!.successorJobId} to stop the successor.`],
            deferredMessage,
          }
        : {
            error: `run is ${rec.state}; ${kind} has nothing to stop`,
            ...(deferredMessage ? { deferredMessage } : {}),
          },
    );
    return true;
  }
  let activeDescendants: DaemonRunRecord[];
  try {
    const cancelled = await cancelDelegationFamily({
      daemon: {
        status: (id) => ctx.daemon.status(id),
        fenceDelegationParent: ctx.daemon.fenceDelegationParent?.bind(ctx.daemon),
        // The run's own daemon cancel reports its next message after the
        // ordinary stop, a typed hold failure included: that is this Stop's
        // outcome, not an incomplete cancel.
        cancel: async (id, reasonCode) => {
          try {
            const result = await ctx.daemon.cancel(id, reasonCode);
            if (id === rec.id) followUp = stopReport(result);
            return result;
          } catch (error) {
            if (id !== rec.id || errorCode(error) !== "next_message_hold_failed") throw error;
            unsaved = error;
          }
        },
      },
      parent: rec,
      descendantsAfterFence: () => ctx.delegatedDescendants(rec.runId ?? rec.id),
      pollMs: ctx.pollMs,
      // The typed class rides the abort into the terminal writers; the
      // free-text reason stays audit-only.
      reasonCode: body.control.reason_code,
    });
    activeDescendants = cancelled.descendants;
  } catch (error) {
    appendRunAuditEvent(rec, "control.rejected", {
      control: body.control,
      reason: unsaved ? `${text(error)}; ${text(unsaved)}` : text(error),
    });
    ctx.requestError(res, error);
    return true;
  }
  const requested = `${kind} requested${activeDescendants.length ? ` for parent and ${activeDescendants.length} delegated descendant(s)` : ""}`;
  const cascadeRunIds = activeDescendants.map((child) => child.runId ?? child.id);
  if (unsaved) {
    // The cancel is applied; only the next message's hold is incomplete.
    appendRunAuditEvent(rec, "control.applied", { control: body.control, reason: text(unsaved) });
    ctx.json(res, 503, stopHoldProblem(unsaved, requested, { cascadeRunIds }));
    return true;
  }
  const { deferredMessage, successor } = nextMessage(followUp, kind);
  appendRunAuditEvent(rec, "control.applied", { control: body.control });
  ctx.json(
    res,
    200,
    ControlRunControlResponse.parse({
      accepted: true,
      status: "applied",
      runId: rec.runId ?? rec.id,
      cascadeRunIds,
      message: `${requested}${followUp.held ? "; its waiting next message is held" : ""}${successor ? `; ${successor}` : ""}`,
      ...(deferredMessage ? { deferredMessage } : {}),
    }),
  );
  return true;
}

const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The same report `deferredMessageStop` returns, carried by the daemon cancel. */
function stopReport(result: unknown): DeferredMessageStopReport {
  const report = (result as { deferredMessageStop?: unknown } | null)?.deferredMessageStop;
  return DeferredMessageStopReport.safeParse(report).data ?? { held: false, draft: null };
}

function nextMessage(report: DeferredMessageStopReport, kind: string) {
  const deferredMessage =
    report.draft && report.draft.state !== "cleared" ? report.draft : undefined;
  const successor =
    deferredMessage?.state === "dispatched"
      ? `its next message was already accepted as job ${deferredMessage.successorJobId}${deferredMessage.successorRunId ? ` (run ${deferredMessage.successorRunId})` : ""}, which this ${kind} does not stop`
      : null;
  return { deferredMessage, successor };
}

/** The daemon's typed hold failure, with what this control did before it. */
function stopHoldProblem(error: unknown, done: string, context: Record<string, unknown> = {}) {
  const problem = (error && typeof error === "object" ? error : {}) as Record<string, unknown>;
  return {
    code: typeof problem.code === "string" ? problem.code : "next_message_hold_failed",
    error: `${done}; ${text(error)}`,
    retryable: problem.retryable === true,
    requiredActions: problem.requiredActions,
    context: { ...(problem.context as Record<string, unknown> | undefined), ...context },
  };
}
