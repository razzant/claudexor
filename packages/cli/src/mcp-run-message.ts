import { ControlRunMessageRequest, ControlRunMessageResponse } from "@claudexor/schema";
import { connectDaemonIfRunning } from "./daemon-run.js";
import { controlProblemError } from "./cli-error.js";
import { controlApiFetch } from "./live.js";
import { daemonUnavailableError } from "./mcp-daemon-unavailable.js";

/** Submit once to the existing message journal; cancellation affects HTTP only. */
export async function runMessageQuery(
  input: Record<string, unknown>,
  beltContext = false,
  signal?: AbortSignal,
): Promise<ControlRunMessageResponse> {
  if (beltContext) {
    throw Object.assign(new Error("the delegation belt cannot send live run messages"), {
      code: "delegation_forbidden",
      status: 403,
    });
  }
  signal?.throwIfAborted();
  const runId = ControlRunMessageResponse.shape.runId.parse(input["runId"]);
  const key = ControlRunMessageResponse.shape.messageId
    .trim()
    .min(1)
    .parse(input["idempotencyKey"]);
  const request = ControlRunMessageRequest.parse(input["request"]);
  const connection = await connectDaemonIfRunning();
  signal?.throwIfAborted();
  if (!connection) throw daemonUnavailableError(false, "live messages do not start one");
  const response = await controlApiFetch(
    connection.addr,
    `/runs/${encodeURIComponent(runId)}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(request),
      ...(signal ? { signal } : {}),
    },
  );
  const body = await response.json().catch(() => ({}));
  signal?.throwIfAborted();
  if (!response.ok) {
    throw controlProblemError(
      response.status,
      body,
      `run message failed (HTTP ${response.status})`,
    );
  }
  // HTTP 200 includes refusals and uncertainty; never turn it into delivery.
  return ControlRunMessageResponse.parse(body);
}
