import type { IncomingMessage, ServerResponse } from "node:http";
import {
  directDelegatedChildrenFromRecords,
  type DeferredMessageProjection,
} from "@claudexor/schema";
import type { DaemonRunRecord } from "./run-record.js";
import { jsonOperation } from "./operation-descriptor.js";
import { queryParam, RUN_DEADLINE_FACTS_HEADER } from "./operation-parameters.js";
import { requestGone } from "./request-liveness.js";
import { optionalBooleanQuery } from "./query.js";
import { servingStore } from "./run-start-receipt.js";

export const RUN_DETAIL_OPERATION = jsonOperation(
  "GET",
  "/v2/runs/:id",
  "read_only",
  null,
  "ControlRunDetail",
  {
    parameters: [
      queryParam({
        name: "includeFinalMessages",
        enum: ["true", "false"],
        description:
          "Include the recorded final-messages outcome. Omission or false keeps the original run detail.",
      }),
      queryParam({
        name: "includeEarlierAssistantOutput",
        enum: ["true", "false"],
        description:
          "Include the earlier assistant text preview and exact artifact path beside an eligible primary answer. Omission or false keeps the original primary output shape.",
      }),
      RUN_DEADLINE_FACTS_HEADER,
    ],
  },
);

export function parseRunDetailQuery(url: URL) {
  return {
    includeFinalMessages: optionalBooleanQuery(url, "includeFinalMessages"),
    includeEarlierAssistantOutput: optionalBooleanQuery(url, "includeEarlierAssistantOutput"),
  };
}

interface RunDetailContext {
  findRun(id: string): Promise<DaemonRunRecord | null>;
  storeId?: () => string | undefined;
  deferred?(id: string): Promise<DeferredMessageProjection | null>;
  children(parent: string): Promise<DaemonRunRecord[]>;
  cursor(record: DaemonRunRecord, signal: AbortSignal): Promise<number>;
  project(
    record: DaemonRunRecord,
    cursor: number,
    children: DaemonRunRecord[],
    deferred: DeferredMessageProjection | null | undefined,
    signal: AbortSignal,
  ): Promise<string>;
  json(res: ServerResponse, status: number, body: unknown): void;
  serialized(res: ServerResponse, body: string): void;
}

export async function serveRunDetail(
  ctx: RunDetailContext,
  id: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (requestGone(req, res)) return;
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once("aborted", abort);
  res.once("close", abort);
  try {
    const rec = await ctx.findRun(id);
    if (requestGone(req, res)) return;
    // `context.storeId` scopes this absence to the store just read: a caller compares it with the
    // store that accepted the run. Even a match is no proof that the run never started.
    if (!rec)
      return ctx.json(res, 404, { error: "no such run", context: servingStore(ctx.storeId) });
    // Fence FIRST, before pending interactions or projection bytes. The worker
    // also owns legacy/oversized-line fallback scans. Later bytes may replay;
    // a later cursor must never be stamped onto earlier pending state.
    const cursor = await ctx.cursor(rec, controller.signal);
    if (requestGone(req, res)) return;
    const parent = rec.runId ?? rec.id;
    const records = await ctx.children(parent);
    if (requestGone(req, res)) return;
    const children = directDelegatedChildrenFromRecords(parent, records);
    const deferred = ctx.deferred ? await ctx.deferred(rec.id) : undefined;
    if (requestGone(req, res)) return;
    const body = await ctx.project(rec, cursor, children, deferred, controller.signal);
    if (!requestGone(req, res)) ctx.serialized(res, body);
  } finally {
    req.off("aborted", abort);
    res.off("close", abort);
  }
}
