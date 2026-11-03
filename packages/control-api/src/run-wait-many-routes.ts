import type { IncomingMessage, ServerResponse } from "node:http";
import { RUN_WAIT_MANY_REQUEST_BYTES, RunWaitManyInput } from "@claudexor/schema";
import { readLifetime, requestGone, stoppingProblem } from "./request-liveness.js";
import { observeRunAttention, type RunWaitManyHost } from "./run-wait-many.js";

interface RunWaitManyRouteContext {
  runObservations?: RunWaitManyHost["snapshot"];
  runObservationChanges?: RunWaitManyHost["subscribe"];
  pollMs?: number;
  /** Fires when the server starts stopping; ends the wait with a typed 503. */
  stopping?: AbortSignal;
  readBody(req: IncomingMessage, maxBytes?: number): Promise<unknown>;
  json(res: ServerResponse, status: number, body: unknown): void;
  requestError(res: ServerResponse, error: unknown, fallbackStatus?: 400 | 500): void;
}

/** Thin HTTP admission and response-liveness projection of the single observer. */
export async function handleRunWaitManyRoute(
  ctx: RunWaitManyRouteContext,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!(method === "POST" && path === "/runs/wait-many")) return false;
  let input: RunWaitManyInput;
  try {
    input = RunWaitManyInput.parse(await ctx.readBody(req, RUN_WAIT_MANY_REQUEST_BYTES));
  } catch (error) {
    if (!requestGone(req, res)) ctx.requestError(res, error);
    return true;
  }
  if (requestGone(req, res)) return true;
  const snapshot = ctx.runObservations;
  if (!snapshot) {
    ctx.requestError(
      res,
      Object.assign(new Error("compact run observation is unavailable"), {
        code: "run_observation_unavailable",
        status: 503,
        retryable: false,
      }),
      500,
    );
    return true;
  }

  const lifetime = readLifetime(req, res, ctx.stopping);
  try {
    const result = await observeRunAttention(
      input,
      { snapshot, subscribe: ctx.runObservationChanges, pollMs: ctx.pollMs },
      lifetime.signal,
    );
    if (requestGone(req, res)) return true;
    // Only a stopping server aborts a live request's wait. Tokens are
    // level-triggered, so repeating the wait elsewhere loses nothing.
    if (result.wakeReason === "aborted")
      ctx.requestError(
        res,
        stoppingProblem("daemon is stopping; repeat the wait after reconnecting"),
        500,
      );
    else ctx.json(res, 200, result);
  } catch (error) {
    if (!requestGone(req, res)) ctx.requestError(res, error, 500);
  } finally {
    lifetime.dispose();
  }
  return true;
}
