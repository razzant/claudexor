import {
  ControlRunStartRequest,
  ControlRunStartResponse,
  ControlRunState,
  validateOptionalNonEmptyString,
  acceptedReceiptMetadata,
  CONTROL_STORE_IDENTITY_HEADER,
} from "@claudexor/schema";
import { connectDaemonIfRunning, type DaemonRunOutcome } from "./daemon-run.js";
import { controlProblemError } from "./cli-error.js";
import { controlApiFetch } from "./live.js";
import { daemonUnavailableError } from "./mcp-daemon-unavailable.js";
import { projectLaunchHandle } from "./mcp-launch-handle.js";
import { acceptedPreRunFailure } from "./run-start-acceptance.js";

/**
 * The successor controls a caller may state explicitly, by their canonical
 * request names. Mode, scope, execution, harness, model and the prompt-cache
 * lifetime are inherited by the daemon; every other omitted control keeps its
 * ordinary new-run default.
 * Only supported fields are projected: parsing the whole request here would
 * materialize defaults before the daemon can inherit the predecessor.
 */
const continuationRequest = ControlRunStartRequest.pick({
  continueFrom: true,
  taskGroupId: true,
  prompt: true,
  attachments: true,
  access: true,
  web: true,
  externalContextPolicy: true,
  credentialProfileId: true,
  paidBudget: true,
  maxSeconds: true,
  timeLimitMode: true,
  review: true,
  reviewerPanel: true,
  reviewerModels: true,
  reviewerEfforts: true,
  continueCarrier: true,
})
  .partial({ prompt: true })
  .required({ continueFrom: true });
const CALLER_FIELDS = Object.keys(continuationRequest.shape).filter(
  (key) => key !== "continueFrom",
);
const TRANSPORT_FIELDS = new Set(["mode", "runId", "idempotencyKey", "delegatedFromRunId"]);

/** Submit once through the existing control transport; never register cwd or wait for terminal. */
export async function runContinueQuery(
  input: Record<string, unknown>,
  beltContext = false,
): Promise<Record<string, unknown>> {
  if (beltContext || input["delegatedFromRunId"] !== undefined) {
    throw Object.assign(new Error("the delegation belt cannot continue runs"), {
      code: "delegation_forbidden",
      status: 403,
    });
  }
  // Inherited groups (mode, scope, execution, harness, model, prompt-cache
  // lifetime) are not caller controls here.
  const unknown = Object.keys(input).filter(
    (key) => !TRANSPORT_FIELDS.has(key) && !CALLER_FIELDS.includes(key),
  );
  if (unknown.length > 0) {
    throw Object.assign(new Error(`unsupported continuation field(s): ${unknown.join(", ")}`), {
      code: "invalid_argument",
      status: 400,
    });
  }
  const body = continuationRequest.parse({
    continueFrom: input["runId"],
    ...Object.fromEntries(
      CALLER_FIELDS.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]),
    ),
  });
  const key = input["idempotencyKey"];
  const keyError = validateOptionalNonEmptyString(key, "idempotencyKey");
  if (keyError || (typeof key === "string" && key.length > 256)) {
    throw Object.assign(new Error(keyError ?? "idempotencyKey must contain 1-256 characters"), {
      code: "invalid_argument",
      status: 400,
    });
  }
  const connection = await connectDaemonIfRunning();
  if (!connection) throw daemonUnavailableError(false, "run continuation does not start one");
  const response = await controlApiFetch(connection.addr, "/runs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [CONTROL_STORE_IDENTITY_HEADER]: "1",
      ...(typeof key === "string" ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  });
  const result: unknown = await response.json().catch(() => ({}));
  let out: DaemonRunOutcome | null = null;
  if (!response.ok) {
    // A successor accepted and then refused before its run started is a handle, not a lost launch.
    out = acceptedPreRunFailure(response.status, result);
    if (!out)
      throw controlProblemError(
        response.status,
        result,
        `run continuation failed (HTTP ${response.status})`,
      );
  } else {
    const parsed = ControlRunStartResponse.safeParse(result);
    if (!parsed.success) {
      throw controlProblemError(
        502,
        {
          code: "invalid_response",
          message: "daemon returned an invalid run continuation handle",
        },
        "daemon returned an invalid run continuation handle",
      );
    }
    const handle = parsed.data;
    if ("runId" in handle) {
      const jobId = handle.jobId ?? "";
      const record = jobId ? await connection.client?.status(jobId).catch(() => null) : null;
      const state = ControlRunState.safeParse(record?.state);
      out = {
        ...acceptedReceiptMetadata(handle),
        jobId,
        runId: handle.runId,
        runDir: handle.runDir,
        status: state.success ? state.data : "",
      };
    } else {
      out = {
        ...acceptedReceiptMetadata(handle),
        jobId: handle.jobId,
        runId: "",
        runDir: "",
        status: handle.state,
        error: handle.error,
      };
    }
  }
  // The successor's mode is the daemon's inherited fact, unknown here.
  return projectLaunchHandle(connection.addr, out, { deferred: true });
}
