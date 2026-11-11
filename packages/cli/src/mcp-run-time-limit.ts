import { RunTimeLimitRequest, RunTimeLimitSnapshot } from "@claudexor/schema";
import { connectDaemonIfRunning } from "./daemon-run.js";
import { controlProblemError } from "./cli-error.js";
import { controlApiFetch } from "./live.js";
import { daemonUnavailableError } from "./mcp-daemon-unavailable.js";

/** Read or mutate a run-owned timer through the existing daemon only. */
export async function runTimeLimitQuery(
  input: Record<string, unknown>,
  beltContext = false,
): Promise<Record<string, unknown>> {
  if (beltContext) {
    throw Object.assign(new Error("the delegation belt cannot access run time limits"), {
      code: "delegation_forbidden",
      status: 403,
    });
  }
  const runId = input["runId"];
  if (typeof runId !== "string" || !runId.trim()) {
    throw Object.assign(new Error("runId is required"), { code: "invalid_argument", status: 400 });
  }
  const request = RunTimeLimitRequest.parse(input["request"]);
  const connection = await connectDaemonIfRunning();
  if (!connection) throw daemonUnavailableError(false, "time-limit access does not start one");
  const path = `/runs/${encodeURIComponent(runId)}/time-limit`;
  const response = await controlApiFetch(
    connection.addr,
    path,
    request.action === "read"
      ? { method: "GET" }
      : {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw controlProblemError(
      response.status,
      body,
      `run time limit failed (HTTP ${response.status})`,
    );
  const snapshot = RunTimeLimitSnapshot.parse(body);
  return {
    runId,
    ...snapshot,
    summary: `run ${runId} time limit: ${snapshot.state}${snapshot.deadlineAt ? ` until ${snapshot.deadlineAt}` : ""} (revision ${snapshot.revision})`,
  };
}
