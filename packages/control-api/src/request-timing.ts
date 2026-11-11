import type { IncomingMessage, ServerResponse } from "node:http";
import { processTiming, type ProcessTiming } from "@claudexor/util";
import { requestGone } from "./request-liveness.js";
import { OPERATION_CATALOG } from "./operation-catalog.js";

// Build once from the contract. Only these trusted strings enter status facts.
const routes = [{ method: "GET", path: "/healthz" }, ...OPERATION_CATALOG.operations].map(
  ({ method, path }) => ({
    method,
    path,
    parts: path.split("/"),
  }),
);

export function trackRequest(
  req: IncomingMessage,
  res: ServerResponse,
  timing: ProcessTiming = processTiming,
): void {
  let parts: string[] = [];
  try {
    parts = new URL(req.url ?? "/", "http://localhost").pathname.split("/");
  } catch {
    /* unmatched */
  }
  const route = routes.find(
    (candidate) =>
      candidate.method === req.method &&
      candidate.parts.every((part, i) =>
        part === "<path>"
          ? parts.length > i
          : part.startsWith(":")
            ? Boolean(parts[i])
            : part === parts[i],
      ) &&
      (candidate.parts.at(-1) === "<path>" || candidate.parts.length === parts.length),
  );
  const started = performance.now();
  const disconnectedAtEntry = requestGone(req, res);
  const done = (): void => {
    res.off("finish", done);
    res.off("close", done);
    timing.recordRequest(
      route?.method ?? "OTHER",
      route?.path ?? "<unmatched>",
      performance.now() - started,
      disconnectedAtEntry
        ? "disconnected_at_entry"
        : !res.writableFinished
          ? "disconnected"
          : res.statusCode === 404
            ? "not_found"
            : res.statusCode >= 400
              ? "failed"
              : "served",
    );
  };
  if (disconnectedAtEntry) done();
  else {
    res.once("finish", done);
    res.once("close", done);
  }
}
