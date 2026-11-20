import type { IncomingMessage, ServerResponse } from "node:http";
import { RunDeadlineSetRequest, RunDeadlineSnapshot } from "@claudexor/schema";
import type { DaemonFacadeClient, DaemonRunRecord } from "./run-record.js";

export interface RunDeadlineRouteContext {
  daemon: Pick<DaemonFacadeClient, "runDeadline" | "list">;
  readBody(req: IncomingMessage): Promise<unknown>;
  json(res: ServerResponse, status: number, body: unknown): void;
  requestError(res: ServerResponse, error: unknown): void;
}

/** GET/PATCH /v2/runs/:id/deadline (run-deadline/1). The daemon owns every verdict:
 * a terminal run, a stale revision or a Delegate child refuse there, typed. */
export async function handleRunDeadlineRoute(
  ctx: RunDeadlineRouteContext,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const deadlineMatch = /^\/runs\/([^/]+)\/deadline$/.exec(path);
  if (!(method === "GET" && deadlineMatch) && !(method === "PATCH" && deadlineMatch)) return false;
  try {
    const id = decodeURIComponent(deadlineMatch![1]!);
    const record: DaemonRunRecord | undefined = (await ctx.daemon.list({ id })).find(
      (run) => run.id === id || run.runId === id,
    );
    if (!record) {
      ctx.json(res, 404, { error: "no such run", code: "run_not_found" });
      return true;
    }
    if (!ctx.daemon.runDeadline) {
      ctx.json(res, 501, { error: "run deadlines are not supported by this daemon" });
      return true;
    }
    const snapshot =
      method === "GET"
        ? await ctx.daemon.runDeadline(record.id, { action: "read" })
        : await ctx.daemon.runDeadline(record.id, {
            action: "set",
            ...RunDeadlineSetRequest.parse(await ctx.readBody(req)),
          });
    ctx.json(res, 200, RunDeadlineSnapshot.parse(snapshot));
  } catch (error) {
    ctx.requestError(res, error);
  }
  return true;
}
