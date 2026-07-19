import {
  CONTROL_PROTOCOL_MAJOR,
  ControlHandshakeRequest,
  ControlHandshakeResponse,
  ControlOperationCatalog,
  ControlProblem,
  type ControlOperationDescriptor,
} from "@claudexor/schema";
import { engineBuildIdentity } from "@claudexor/util";

export type ControlProtocolBoundary =
  | { kind: "route"; path: string }
  | { kind: "response"; status: number; body: unknown; contentType: string };

const protocolProblem = (code: string, message: string, requiredActions: string[] = []) =>
  ControlProblem.parse({
    code,
    message,
    retryable: false,
    fieldErrors: {},
    requiredActions,
    evidenceRefs: [],
  });

/** Stateless v2 negotiation boundary; product handlers only see unversioned internal paths. */
export async function resolveControlProtocol(input: {
  method: string;
  requestPath: string;
  requestedMajor: string | string[] | undefined;
  readBody: () => Promise<unknown>;
}): Promise<ControlProtocolBoundary> {
  if (input.method === "POST" && input.requestPath === "/v2/handshake") {
    const request = ControlHandshakeRequest.parse(await input.readBody());
    if (request.protocolMajor !== CONTROL_PROTOCOL_MAJOR) {
      return {
        kind: "response",
        status: 426,
        contentType: "application/problem+json",
        body: protocolProblem(
          "incompatible_protocol_major",
          `control protocol major ${request.protocolMajor} is incompatible; server requires ${CONTROL_PROTOCOL_MAJOR}`,
          [`use control protocol major ${CONTROL_PROTOCOL_MAJOR}`],
        ),
      };
    }
    return {
      kind: "response",
      status: 200,
      contentType: "application/json",
      body: ControlHandshakeResponse.parse({
        protocolMajor: CONTROL_PROTOCOL_MAJOR,
        compatible: true,
        operationsPath: "/v2/operations",
        engine: engineBuildIdentity(),
      }),
    };
  }
  if (!input.requestPath.startsWith("/v2/")) {
    return {
      kind: "response",
      status: 404,
      contentType: "application/problem+json",
      body: protocolProblem("route_not_found", "product routes require the /v2 prefix"),
    };
  }
  if (input.requestedMajor !== String(CONTROL_PROTOCOL_MAJOR)) {
    return {
      kind: "response",
      status: 426,
      contentType: "application/problem+json",
      body: protocolProblem(
        "handshake_required",
        "a successful v2 handshake is required before product calls",
        ["POST /v2/handshake", `send X-Claudexor-Protocol-Major: ${CONTROL_PROTOCOL_MAJOR}`],
      ),
    };
  }
  if (input.method === "GET" && input.requestPath === "/v2/operations") {
    return {
      kind: "response",
      status: 200,
      contentType: "application/json",
      body: OPERATION_CATALOG,
    };
  }
  return { kind: "route", path: input.requestPath.slice(3) };
}

type Draft = Omit<
  ControlOperationDescriptor,
  "id" | "applicability" | "idempotency" | "completion" | "errorSchema"
> &
  Partial<Pick<ControlOperationDescriptor, "applicability" | "idempotency" | "completion">>;

function descriptor(input: Draft): ControlOperationDescriptor {
  const applicability =
    input.path.includes("/threads/") || input.path === "/v2/threads"
      ? "thread"
      : input.path.includes("/runs/") || input.path === "/v2/runs"
        ? "run"
        : "global";
  return {
    ...input,
    errorSchema: "ControlProblem",
    id: `${input.method.toLowerCase()}:${input.path.slice(4).replaceAll(/[:/<>]+/g, ".")}`,
    applicability: input.applicability ?? applicability,
    idempotency: input.idempotency ?? (input.mutability === "read_only" ? "natural" : "none"),
    completion:
      input.completion ?? (input.responseKind === "stream" ? "terminal_stream" : "immediate"),
  };
}

const j = (
  method: Draft["method"],
  path: string,
  mutability: Draft["mutability"],
  requestSchema: string | null = null,
  responseSchema: string | null = null,
  extra: Partial<Draft> = {},
): ControlOperationDescriptor =>
  descriptor({
    method,
    path,
    mutability,
    requestSchema,
    responseSchema,
    responseKind: "json",
    ...extra,
  });

const operations: ControlOperationDescriptor[] = [
  j("POST", "/v2/uploads", "mutating", "ControlUploadCreateRequest", "ControlUploadStatus", {
    idempotency: "key_required",
  }),
  j("PUT", "/v2/uploads/:id/bytes", "mutating", null, "ControlUploadStatus"),
  j("GET", "/v2/uploads/:id", "read_only", null, "ControlUploadStatus"),
  j("DELETE", "/v2/uploads/:id", "mutating", null, "ControlUploadStatus"),
  j(
    "POST",
    "/v2/uploads/:id/finalize",
    "mutating",
    "ControlUploadFinalizeRequest",
    "ControlResource",
    { idempotency: "key_required" },
  ),
  j("POST", "/v2/handshake", "read_only", "ControlHandshakeRequest", "ControlHandshakeResponse"),
  j("GET", "/v2/operations", "read_only", null, "ControlOperationCatalog"),
  j("POST", "/v2/maintenance/gc", "mutating", "ControlGcRequest", "ControlGcReceipt", {
    idempotency: "natural",
  }),
  j("GET", "/v2/agent-capabilities", "read_only", null, "AgentCapabilityCatalog"),
  j("GET", "/v2/global/events", "read_only", null, null, { responseKind: "stream" }),
  j("GET", "/v2/quota", "read_only", null, "ControlQuotaResponse"),
  j("GET", "/v2/credential-profiles", "read_only", null, "ControlCredentialProfilesResponse"),
  j(
    "POST",
    "/v2/credential-profiles",
    "mutating",
    "ControlCredentialProfileCreateRequest",
    "ControlCredentialProfileCreateResponse",
    { idempotency: "natural" },
  ),
  j(
    "DELETE",
    "/v2/credential-profiles/:harness/:profileId",
    "mutating",
    null,
    "ControlCredentialProfileDeleteResponse",
    { idempotency: "natural" },
  ),
  j("POST", "/v2/quota", "mutating", null, "ControlQuotaResponse", {
    idempotency: "natural",
  }),
  j("GET", "/v2/harnesses", "read_only", null, "ControlHarnessListResponse"),
  j("GET", "/v2/projects", "read_only", null, "ControlProjectListResponse"),
  j("POST", "/v2/projects", "mutating", "ControlProjectRegisterRequest", "ControlProject", {
    idempotency: "key_required",
  }),
  j(
    "POST",
    "/v2/projects/:id/relink",
    "mutating",
    "ControlProjectRelinkRequest",
    "ControlProject",
    { idempotency: "natural" },
  ),
  j("GET", "/v2/projects/:id/events", "read_only", null, null, { responseKind: "stream" }),
  j("GET", "/v2/harnesses/:id/models", "read_only", null, "ControlHarnessModelsResponse"),
  j(
    "POST",
    "/v2/harnesses/:id/auth-readiness",
    "read_only",
    "ControlAuthReadinessRefreshRequest",
    "ControlAuthReadinessRefreshResponse",
  ),
  j("GET", "/v2/runs", "read_only", null, "ControlRunListResponse"),
  j("POST", "/v2/runs", "mutating", "ControlRunStartRequest", "ControlRunStartResponse", {
    completion: "durable_handle",
    idempotency: "key_required",
  }),
  j("GET", "/v2/runs/:id", "read_only", null, "ControlRunDetail"),
  j("POST", "/v2/runs/:id/retry", "mutating", null, "ControlRunRetryResponse", {
    completion: "durable_handle",
    idempotency: "key_required",
  }),
  j("GET", "/v2/runs/:id/run-again", "read_only", null, "ControlRunAgainDraft"),
  j("POST", "/v2/runs/:id/apply", "mutating", "ControlApplyRequest", "ControlDeliveryResponse", {
    idempotency: "key_required",
  }),
  j(
    "POST",
    "/v2/runs/:id/apply/check",
    "read_only",
    "ControlApplyCheckRequest",
    "ControlApplyCheckResponse",
  ),
  j("GET", "/v2/runs/:id/artifacts", "read_only", null, "ControlArtifactListResponse"),
  descriptor({
    method: "GET",
    path: "/v2/runs/:id/artifacts/<path>",
    requestSchema: null,
    responseSchema: null,
    mutability: "read_only",
    responseKind: "binary",
  }),
  j(
    "POST",
    "/v2/runs/:id/control",
    "mutating",
    "ControlRunControlRequest",
    "ControlRunControlResponse",
    {
      idempotency: "natural",
    },
  ),
  j(
    "POST",
    "/v2/runs/:id/decision",
    "mutating",
    "ControlRunDecisionRequest",
    "ControlRunDecisionResponse",
    {
      idempotency: "key_required",
    },
  ),
  j("GET", "/v2/runs/:id/events", "read_only", null, null, { responseKind: "stream" }),
  j(
    "POST",
    "/v2/runs/:id/interactions/:id/answer",
    "mutating",
    "ControlInteractionAnswerRequest",
    "ControlInteractionAnswerResponse",
    { idempotency: "natural" },
  ),
  j("GET", "/v2/runs/:id/produced", "read_only", null, "ControlArtifactListResponse"),
  descriptor({
    method: "GET",
    path: "/v2/runs/:id/produced/<path>",
    requestSchema: null,
    responseSchema: null,
    mutability: "read_only",
    responseKind: "binary",
  }),
  j("GET", "/v2/threads", "read_only", null, "ControlThreadListResponse"),
  j("POST", "/v2/threads", "mutating", "ControlThreadCreateRequest", "ControlThread", {
    idempotency: "key_required",
  }),
  j("GET", "/v2/threads/:id", "read_only", null, "ControlThreadDetail"),
  j("PATCH", "/v2/threads/:id", "mutating", "ControlThreadUpdateRequest", "ControlThread", {
    idempotency: "natural",
  }),
  j("POST", "/v2/threads/:id/trash", "mutating", null, "ControlThread", {
    idempotency: "natural",
  }),
  j("POST", "/v2/threads/:id/restore", "mutating", null, "ControlThread", {
    idempotency: "natural",
  }),
  j("POST", "/v2/threads/:id/purge", "mutating", null, "ControlThread", {
    idempotency: "natural",
  }),
  j(
    "POST",
    "/v2/threads/:id/apply",
    "mutating",
    "ControlThreadApplyRequest",
    "ControlThreadApplyResponse",
    { idempotency: "key_required" },
  ),
  j(
    "POST",
    "/v2/threads/:id/turns",
    "mutating",
    "ControlThreadTurnRequest",
    "ControlThreadTurnResponse",
    {
      idempotency: "key_required",
    },
  ),
  j("POST", "/v2/threads/:id/turns/:id/retry", "mutating", null, "ControlThreadTurnResponse", {
    idempotency: "key_required",
  }),
  j("GET", "/v2/trust", "read_only", null, "ControlTrustListResponse"),
  j("POST", "/v2/trust", "mutating", "ControlTrustUpdateRequest", "ControlTrustState", {
    idempotency: "natural",
  }),
  j("GET", "/v2/settings", "read_only", null, "ControlSettingsSnapshot"),
  j("POST", "/v2/settings", "mutating", "ControlSettingsUpdateRequest", "ControlSettingsSnapshot", {
    idempotency: "natural",
  }),
  j("GET", "/v2/secrets", "read_only", null, "ControlSecretListResponse"),
  j("POST", "/v2/secrets", "mutating", "ControlSecretSetRequest", "ControlSecretMutationResponse", {
    idempotency: "natural",
  }),
  j("DELETE", "/v2/secrets/:id", "mutating", null, "ControlSecretMutationResponse", {
    idempotency: "natural",
  }),
  j("GET", "/v2/spec/sessions", "read_only", null, "ControlSpecSessionListResponse"),
  j("POST", "/v2/spec/sessions", "mutating", "ControlSpecQuestionsRequest", "ControlSpecSession", {
    idempotency: "key_required",
  }),
  j("GET", "/v2/spec/sessions/:id", "read_only", null, "ControlSpecSession"),
  j(
    "POST",
    "/v2/spec/sessions/:id/answers",
    "mutating",
    "ControlSpecAnswersRequest",
    "ControlSpecSession",
    {
      idempotency: "natural",
    },
  ),
  j("POST", "/v2/spec/sessions/:id/freeze", "mutating", null, "ControlSpecSession"),
  j("POST", "/v2/spec/sessions/:id/cancel", "mutating", null, "ControlSpecSession", {
    idempotency: "natural",
  }),
  j("POST", "/v2/spec/sessions/:id/resume", "mutating", null, "ControlSpecSession", {
    idempotency: "natural",
  }),
  j("GET", "/v2/setup/jobs", "read_only", null, "ControlSetupJobListResponse"),
  j("POST", "/v2/setup/jobs", "mutating", "ControlSetupJobCreateRequest", "ControlSetupJob", {
    completion: "durable_handle",
    idempotency: "key_required",
  }),
  j("GET", "/v2/setup/jobs/:id", "read_only", null, "ControlSetupJob"),
  j("GET", "/v2/setup/jobs/:id/snapshot", "read_only", null, "ControlSetupJobSnapshot"),
  j("GET", "/v2/setup/jobs/:id/events", "read_only", null, null, { responseKind: "stream" }),
  j("POST", "/v2/setup/jobs/:id/cancel", "mutating", null, "ControlSetupJob", {
    idempotency: "natural",
  }),
  j("POST", "/v2/setup/jobs/:id/reconcile", "mutating", null, "ControlSetupJob", {
    idempotency: "natural",
  }),
  j("POST", "/v2/setup/jobs/:id/extend", "mutating", null, "ControlSetupJob", {
    idempotency: "natural",
  }),
  j("GET", "/v2/recovery/partitions/:id", "read_only", null, "ControlJournalInspection"),
  j("POST", "/v2/recovery/partitions/:id/validate", "read_only", null, "ControlJournalValidation"),
  j("POST", "/v2/recovery/partitions/:id/export", "read_only", null, "ControlJournalExportReceipt"),
  j(
    "POST",
    "/v2/recovery/partitions/:id/quarantine",
    "mutating",
    "ControlJournalQuarantineRequest",
    "ControlJournalQuarantineReceipt",
    { idempotency: "key_required" },
  ),
];

export const OPERATION_CATALOG = ControlOperationCatalog.parse({
  protocolMajor: CONTROL_PROTOCOL_MAJOR,
  operations,
});
