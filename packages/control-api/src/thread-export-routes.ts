import type { IncomingMessage, ServerResponse } from "node:http";
import { endedByStop, readLifetime, requestGone, stoppingProblem } from "./request-liveness.js";
import type { OperationDraft } from "./operation-draft.js";
import { queryParam } from "./operation-parameters.js";
import type { ThreadExportServices } from "./thread-export.js";

export interface ThreadExportRouteServices {
  threadExport: ThreadExportServices;
}

interface Context {
  services?: Partial<ThreadExportRouteServices>;
  stopping?: AbortSignal;
  json(res: ServerResponse, status: number, body: unknown): void;
  requestError(res: ServerResponse, error: unknown, fallback?: 400 | 500): void;
}

const invalid = (message: string) =>
  Object.assign(new Error(message), { code: "invalid_thread_export_query", status: 400 });

function query(req: IncomingMessage, allowed: readonly string[]): URLSearchParams {
  const params = new URL(req.url ?? "/", "http://localhost").searchParams;
  for (const key of new Set(params.keys()))
    if (!allowed.includes(key) || params.getAll(key).length > 1)
      throw invalid("unknown or repeated export query parameter");
  return params;
}

function assertStore(expected: string | null, actual: string): void {
  if (expected !== null && expected !== actual)
    throw Object.assign(new Error("this read belongs to another store"), {
      code: "store_mismatch",
      status: 409,
    });
}

/** Thin reads over the one export producer; retirement's writes are lifecycle routes. */
export async function handleThreadExportRoute(
  ctx: Context,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const manifestMatch = /^\/threads\/([^/]+)\/export$/.exec(path);
  const itemMatch = /^\/threads\/([^/]+)\/export\/([^/]+)\/items\/([^/]+)$/.exec(path);
  const retirementMatch = /^\/threads\/([^/]+)\/retirement$/.exec(path);
  if (!(
    (method === "GET" && manifestMatch) ||
    (method === "GET" && itemMatch) ||
    (method === "GET" && retirementMatch)
  ))
    return false;
  const service = ctx.services?.threadExport;
  if (!service) {
    ctx.json(res, 501, { error: "thread export is not supported by this build" });
    return true;
  }
  const lifetime = readLifetime(req, res, ctx.stopping);
  try {
    if (manifestMatch) {
      const params = query(req, ["expectedStoreId"]);
      const read = await service.threadExportManifest(
        decodeURIComponent(manifestMatch[1]!),
        lifetime.signal,
      );
      assertStore(params.get("expectedStoreId"), read.storeId);
      if (!requestGone(req, res)) ctx.json(res, 200, read);
    } else if (itemMatch) {
      query(req, []);
      await service.transferThreadExportItem(
        decodeURIComponent(itemMatch[1]!),
        decodeURIComponent(itemMatch[2]!),
        decodeURIComponent(itemMatch[3]!),
        res,
        lifetime.signal,
        ctx.stopping,
      );
    } else {
      const params = query(req, ["operationId", "expectedStoreId"]);
      const read = service.threadRetirement(
        decodeURIComponent(retirementMatch![1]!),
        params.get("operationId"),
      );
      assertStore(params.get("expectedStoreId"), read.storeId);
      ctx.json(res, 200, read);
    }
  } catch (error) {
    // Bytes already on the wire cannot become a problem body: the consumer
    // sees a short body and its digest refuses it. A read Stop ended is not a
    // failure of the read: its client repeats it after reconnecting.
    if (res.headersSent) res.destroy();
    else if (!requestGone(req, res))
      ctx.requestError(
        res,
        endedByStop(error, ctx.stopping)
          ? stoppingProblem("daemon is stopping; repeat the export read after reconnecting")
          : error,
        500,
      );
  } finally {
    lifetime.dispose();
  }
  return true;
}

const STORE_PARAMETER = queryParam({
  name: "expectedStoreId",
  description: "Refuse the read when the engine serves another store.",
});
export const THREAD_EXPORT_OPERATION_DRAFTS: OperationDraft[] = [
  {
    method: "GET",
    path: "/v2/threads/:id/export",
    summary:
      "Read the exact closure inventory of a thread: engine records, run trees, native session material and its lane, with every named gap. Never writes.",
    mutability: "read_only",
    requestSchema: null,
    responseSchema: "ThreadExportManifest",
    responseKind: "json",
    parameters: [STORE_PARAMETER],
  },
  {
    method: "GET",
    path: "/v2/threads/:id/export/:id/items/:id",
    summary:
      "Stream one manifest item's exact bytes; ETag carries their sha256. A restart or eviction rebuilds the inventory; a changed item, or an export the current inventory no longer answers, is refused.",
    mutability: "read_only",
    requestSchema: null,
    responseSchema: null,
    responseKind: "binary",
  },
  {
    method: "POST",
    path: "/v2/threads/:id/retire",
    summary:
      "Conditionally accept this exact export's retirement: purge the thread at once if its closure is finished and its bytes still match, binding one outcome to the operation.",
    mutability: "mutating",
    requestSchema: "ThreadRetireRequest",
    responseSchema: "ThreadRetirement",
    responseKind: "json",
    idempotency: "natural",
  },
  {
    method: "POST",
    path: "/v2/threads/:id/retire/abandon",
    summary:
      "Settle an unanswered retirement operation: it can never accept after this answers; an already accepted one reports so.",
    mutability: "mutating",
    requestSchema: "ThreadRetireAbandonRequest",
    responseSchema: "ThreadRetirement",
    responseKind: "json",
    idempotency: "natural",
  },
  {
    method: "GET",
    path: "/v2/threads/:id/retirement",
    summary:
      "Read a thread's retirement state and, when addressed, one operation's bound outcome. Also answers for a purged thread.",
    mutability: "read_only",
    requestSchema: null,
    responseSchema: "ThreadRetirement",
    responseKind: "json",
    parameters: [
      queryParam({ name: "operationId", description: "The operation whose outcome to read." }),
      STORE_PARAMETER,
    ],
  },
];
