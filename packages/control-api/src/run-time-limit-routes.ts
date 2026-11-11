import type { IncomingMessage, ServerResponse } from "node:http";
import { RunTimeLimitRequest, RunTimeLimitSnapshot } from "@claudexor/schema";
import type { DaemonFacadeClient, DaemonRunRecord } from "./run-record.js";
import { TERMINAL_STATES } from "./sse-shared.js";

export interface RunTimeLimitRouteContext {
  daemon: Pick<DaemonFacadeClient, "runTimeLimit">;
  findRun(id: string): Promise<DaemonRunRecord | null>;
  readBody(req: IncomingMessage): Promise<unknown>;
  json(res: ServerResponse, status: number, body: unknown): void;
  requestError(res: ServerResponse, error: unknown): void;
}

export async function handleRunTimeLimitRoute(
  ctx: RunTimeLimitRouteContext,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const timeLimitMatch = /^\/runs\/([^/]+)\/time-limit$/.exec(path);
  if (!(method === "GET" && timeLimitMatch) && !(method === "PATCH" && timeLimitMatch))
    return false;
  const record = await ctx.findRun(decodeURIComponent(timeLimitMatch![1]!));
  if (!record) {
    ctx.json(res, 404, { error: "no such run" });
    return true;
  }
  if (!ctx.daemon.runTimeLimit) {
    ctx.json(res, 501, { error: "run time limits are not supported by this daemon" });
    return true;
  }
  if (method === "PATCH" && TERMINAL_STATES.has(record.state)) {
    ctx.json(res, 409, { error: "run is terminal", code: "run_terminal" });
    return true;
  }
  try {
    const request =
      method === "GET"
        ? RunTimeLimitRequest.parse({ action: "read" })
        : RunTimeLimitRequest.parse(await ctx.readBody(req));
    if (method === "PATCH" && request.action === "read") {
      throw Object.assign(new Error("PATCH requires a time-limit mutation"), {
        status: 400,
        code: "invalid_request",
      });
    }
    const snapshot = await ctx.daemon.runTimeLimit(record.id, request);
    ctx.json(res, 200, RunTimeLimitSnapshot.parse(snapshot));
  } catch (error) {
    ctx.requestError(res, error);
  }
  return true;
}
