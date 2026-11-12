import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DeferredMessageMutation,
  DeferredMessageReceipt,
  DeferredMessageDetail,
} from "@claudexor/schema";
import type { DaemonFacadeClient } from "./run-record.js";
import { requiredIdempotencyKey } from "./run-start.js";

export async function handleDeferredMessageRoute(
  ctx: {
    daemon: DaemonFacadeClient;
    readBody(req: IncomingMessage): Promise<unknown>;
    json(res: ServerResponse, status: number, body: unknown): void;
    requestError(res: ServerResponse, error: unknown): void;
  },
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const draftMatch = /^\/runs\/next-message\/([^/]+)$/.exec(path);
  if (!(method === "POST" && path === "/runs/next-message") && !(method === "GET" && draftMatch))
    return false;
  try {
    if (draftMatch) {
      if (!ctx.daemon.deferredMessageRead) throw unavailable();
      const draft = await ctx.daemon.deferredMessageRead(decodeURIComponent(draftMatch[1]!));
      if (!draft) ctx.json(res, 404, { code: "draft_unknown", error: "no such deferred message" });
      else ctx.json(res, 200, DeferredMessageDetail.parse(draft));
    } else {
      if (!ctx.daemon.deferredMessage) throw unavailable();
      const body = (await ctx.readBody(req)) as Record<string, unknown>;
      if (body?.delegatedFromRunId != null || body?.beltContext === true)
        throw Object.assign(new Error("the delegation belt cannot mutate deferred messages"), {
          code: "delegation_forbidden",
          status: 403,
        });
      const request = DeferredMessageMutation.parse(body);
      const result = await ctx.daemon.deferredMessage({
        request,
        idempotencyKey: requiredIdempotencyKey(req),
      });
      ctx.json(res, 200, DeferredMessageReceipt.parse(result));
    }
  } catch (error) {
    ctx.requestError(res, error);
  }
  return true;
}
function unavailable() {
  return Object.assign(new Error("deferred messages are unavailable on this engine"), {
    code: "deferred_messages_unavailable",
    status: 501,
  });
}
