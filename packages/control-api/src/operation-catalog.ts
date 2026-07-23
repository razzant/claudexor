import {
  CONTROL_PROTOCOL_MAJOR,
  ControlHandshakeRequest,
  ControlHandshakeResponse,
  ControlOperationCatalog,
  ControlProblem,
  ControlRunState,
  type ControlOperationDescriptor,
} from "@claudexor/schema";
import { engineBuildIdentity } from "@claudexor/util";
import { pathnameDecodes, queryParam, resumeHeader } from "./operation-parameters.js";

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
  // QA-066: a malformed percent triplet (`%ZZ`) or percent-encoded invalid
  // UTF-8 (`%C0%AF`) in the path is a CLIENT syntax error. Validate the whole
  // encoded pathname decodes once, centrally, BEFORE route dispatch — so it is
  // a typed HTTP 400 here instead of a `URIError` thrown from one of ~35
  // per-route `decodeURIComponent` calls into the generic 500 handler. Routes
  // still match on and decode the ENCODED path (no re-routing on decoded text,
  // so `%2F`/`%2e%2e` semantics are unchanged); once the whole path decodes,
  // each `/`-delimited segment decode is guaranteed not to throw.
  if (!pathnameDecodes(input.requestPath)) {
    return {
      kind: "response",
      status: 400,
      contentType: "application/problem+json",
      body: protocolProblem(
        "malformed_request_path",
        "request path contains malformed percent-encoding",
      ),
    };
  }
  return { kind: "route", path: input.requestPath.slice(3) };
}

type Draft = Omit<
  ControlOperationDescriptor,
  | "id"
  | "applicability"
  | "idempotency"
  | "completion"
  | "errorSchema"
  | "summary"
  | "auth"
  | "parameters"
> &
  Partial<
    Pick<
      ControlOperationDescriptor,
      "applicability" | "idempotency" | "completion" | "summary" | "parameters"
    >
  >;

function descriptor(input: Draft): ControlOperationDescriptor {
  // Resource-family classification (QA-054): an operation is grouped under the
  // resource plane it acts on. Collection/create routes inherit their family
  // even without an instance id (GET/POST /v2/projects are project-applicable,
  // matching how /v2/runs and /v2/threads are already run/thread). `/projects`
  // had no branch, so every project route falsely reported `global` and the
  // typed `project` enum value had no live producer.
  const applicability =
    input.path.includes("/threads/") || input.path === "/v2/threads"
      ? "thread"
      : input.path.includes("/runs/") || input.path === "/v2/runs"
        ? "run"
        : input.path.includes("/projects/") || input.path === "/v2/projects"
          ? "project"
          : "global";
  const key = `${input.method} ${input.path}`;
  const summary = input.summary ?? OPERATION_SUMMARIES[key];
  if (!summary) {
    // Fail loudly at construction: a new route without a human summary can
    // never ship a blank descriptor (INV-122 SSOT — no silent gaps).
    throw new Error(`operation catalog: missing summary for '${key}'`);
  }
  return {
    ...input,
    summary,
    // Every product route is loopback + bearer; the loopback-only health probe
    // is unversioned and never enters this catalog.
    auth: "loopback_bearer",
    errorSchema: "ControlProblem",
    id: `${input.method.toLowerCase()}:${input.path.slice(4).replaceAll(/[:/<>]+/g, ".")}`,
    applicability: input.applicability ?? applicability,
    parameters: input.parameters ?? [],
    idempotency: input.idempotency ?? (input.mutability === "read_only" ? "natural" : "none"),
    completion:
      input.completion ?? (input.responseKind === "stream" ? "terminal_stream" : "immediate"),
  };
}

/**
 * Human one-line summaries, keyed by `${method} ${path}`, co-located with the
 * descriptors they annotate. This IS the descriptor summary data (not a shadow
 * of another table) — descriptor() throws if a route has no entry, so the map
 * can never silently drift from the operations array.
 */
const OPERATION_SUMMARIES: Record<string, string> = {
  "POST /v2/uploads":
    "Create a single-request streaming upload session for an attachment of the declared size.",
  "PUT /v2/uploads/:id/bytes":
    "Stream the complete declared byte body in ONE request. The store is single-shot: a short, oversized, or interrupted PUT cancels the upload and discards partial bytes — retry by creating a new upload and resending from byte zero. Not resumable.",
  "GET /v2/uploads/:id":
    "Read an upload session's status and received byte count (diagnostic on a cancelled upload, not a resumable offset).",
  "DELETE /v2/uploads/:id": "Abort and discard an in-progress upload session.",
  "POST /v2/uploads/:id/finalize": "Finalize an upload into a durable attachment resource.",
  "POST /v2/handshake": "Negotiate the control protocol major before product calls.",
  "GET /v2/operations": "List the implemented operations (this catalog).",
  "POST /v2/maintenance/gc": "Run retention garbage collection over expired run trees.",
  "GET /v2/agent-capabilities": "List the agent capability catalog this engine advertises.",
  "GET /v2/global/events": "Subscribe to the global cross-project event stream (SSE).",
  "GET /v2/quota": "Read cached per-profile harness quota snapshots.",
  "POST /v2/quota": "Refresh and read per-profile harness quota snapshots.",
  "GET /v2/credential-profiles": "List credential profiles per harness.",
  "POST /v2/credential-profiles": "Create a credential profile for a harness.",
  "PATCH /v2/credential-profiles/:harness/:profileId":
    "Toggle a credential profile's enabled state (the accounts Enabled row).",
  "DELETE /v2/credential-profiles/:harness/:profileId": "Delete a harness credential profile.",
  "GET /v2/harnesses": "List installed harnesses and their availability.",
  "GET /v2/projects": "List registered projects (durable handles).",
  "POST /v2/projects": "Register a project root as a durable handle.",
  "POST /v2/projects/:id/relink": "Relink a registered project to a new root.",
  "DELETE /v2/projects/:id":
    "Remove a registered project: retire the registry entry and archive its journal partition. Refused (409) while any non-purged thread or live/queued run references it; run artifacts are left to normal GC.",
  "GET /v2/projects/:id/events": "Subscribe to a project's event stream (SSE).",
  "GET /v2/projects/:id/outputs": "List a project's durable outputs (artifacts/).",
  "GET /v2/projects/:id/outputs/<path>": "Fetch one durable output file from a project.",
  "GET /v2/harnesses/:id/models": "List a harness's selectable models.",
  "POST /v2/harnesses/:id/auth-readiness": "Re-check a harness's auth readiness (dry).",
  "GET /v2/runs":
    "List a bounded, newest-first, keyset-paginated page of durable run summaries visible to the daemon.",
  "POST /v2/runs": "Start a run and return its durable handle.",
  "GET /v2/runs/:id": "Read a run's full detail snapshot.",
  "POST /v2/runs/:id/retry": "Retry a run, returning a new durable handle.",
  "GET /v2/runs/:id/run-again": "Draft a run-again request from a prior run.",
  "POST /v2/runs/:id/apply":
    "Apply a run's work product to the live tree; replay of an already-delivered run is a typed idempotent no-op.",
  "POST /v2/runs/:id/apply/check":
    "Dry-check whether a run's patch would apply; an already-delivered run reports the safe already-applied no-op.",
  "GET /v2/runs/:id/artifacts": "List a run tree's technical artifacts.",
  "GET /v2/runs/:id/artifacts/<path>": "Fetch one artifact file from a run tree.",
  "POST /v2/runs/:id/control": "Send a control signal (cancel/pause) to a run.",
  "POST /v2/runs/:id/decision": "Record an operator unblock/rerun decision on a run.",
  "GET /v2/runs/:id/events": "Replay + tail a run's event stream (SSE).",
  "POST /v2/runs/:id/interactions/:id/answer": "Answer a run's pending interactive question.",
  "GET /v2/runs/:id/produced": "List a run's produced project outputs.",
  "GET /v2/runs/:id/produced/<path>": "Fetch one produced project-output file from a run.",
  "GET /v2/threads": "List conversation threads.",
  "POST /v2/threads": "Create a conversation thread.",
  "GET /v2/threads/:id": "Read a thread's detail (turns + head).",
  "PATCH /v2/threads/:id": "Update a thread's sticky settings (harness/profile/access).",
  "POST /v2/threads/:id/trash": "Move a thread to trash.",
  "POST /v2/threads/:id/restore": "Restore a thread from trash.",
  "POST /v2/threads/:id/purge": "Permanently purge a trashed thread.",
  "POST /v2/threads/:id/apply": "Apply the thread's latest run work product.",
  "POST /v2/threads/:id/turns": "Enqueue a new turn on a thread.",
  "POST /v2/threads/:id/turns/:id/retry": "Retry a thread turn.",
  "GET /v2/trust": "List protected-path trust state.",
  "POST /v2/trust": "Update protected-path trust state.",
  "GET /v2/settings": "Read the settings snapshot.",
  "POST /v2/settings": "Update settings.",
  "GET /v2/secrets": "List stored secret handles (values never returned).",
  "POST /v2/secrets": "Set a stored secret value.",
  "DELETE /v2/secrets/:id": "Delete a stored secret.",
  "GET /v2/setup/jobs": "List harness setup/login jobs.",
  "POST /v2/setup/jobs": "Start a harness setup/login job.",
  "GET /v2/setup/jobs/:id": "Read a setup job's status.",
  "GET /v2/setup/jobs/:id/snapshot": "Read a setup job's terminal snapshot.",
  "GET /v2/setup/jobs/:id/events": "Tail a setup job's event stream (SSE).",
  "POST /v2/setup/jobs/:id/cancel": "Cancel a setup job.",
  "POST /v2/setup/jobs/:id/reconcile": "Reconcile a setup job's state.",
  "POST /v2/setup/jobs/:id/extend": "Extend a setup job's deadline.",
  "GET /v2/recovery/partitions/:id": "Inspect a journal partition for recovery.",
  "POST /v2/recovery/partitions/:id/validate": "Validate a journal partition (dry).",
  "POST /v2/recovery/partitions/:id/export": "Export a journal partition (dry).",
  "POST /v2/recovery/partitions/:id/quarantine": "Quarantine a corrupt journal partition.",
};

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
  j("GET", "/v2/global/events", "read_only", null, null, {
    responseKind: "stream",
    parameters: [
      resumeHeader(
        "an opaque, partition- and epoch-scoped global journal cursor; a stale or foreign cursor is refused so the client can resnapshot",
      ),
    ],
  }),
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
    "PATCH",
    "/v2/credential-profiles/:harness/:profileId",
    "mutating",
    "ControlCredentialProfileUpdateRequest",
    "ControlCredentialProfileUpdateResponse",
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
  j("GET", "/v2/harnesses", "read_only", null, "ControlHarnessListResponse", {
    parameters: [
      queryParam({
        name: "fresh",
        enum: ["true", "false"],
        description: "Request a fresh readiness/status projection instead of only cached truth.",
      }),
      queryParam({
        name: "all",
        enum: ["true", "false"],
        description: "Include fake/test harness adapters in the listing.",
      }),
      queryParam({
        name: "harness",
        repeatable: true,
        description:
          "Scope the status calculation to the given harness ids (repeat to select several).",
      }),
    ],
  }),
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
  j("DELETE", "/v2/projects/:id", "mutating", null, "ControlProjectRemoveReceipt", {
    idempotency: "natural",
  }),
  j("GET", "/v2/projects/:id/events", "read_only", null, null, {
    responseKind: "stream",
    parameters: [
      resumeHeader(
        "an opaque, partition- and epoch-scoped project journal cursor; a stale or foreign cursor is refused so the client can resnapshot",
      ),
    ],
  }),
  j("GET", "/v2/projects/:id/outputs", "read_only", null, "ControlProjectOutputsResponse"),
  descriptor({
    method: "GET",
    path: "/v2/projects/:id/outputs/<path>",
    requestSchema: null,
    responseSchema: null,
    mutability: "read_only",
    responseKind: "binary",
  }),
  j("GET", "/v2/harnesses/:id/models", "read_only", null, "ControlHarnessModelsResponse", {
    parameters: [
      queryParam({
        name: "route",
        enum: ["local_session", "api_key"],
        description:
          "Filter enumerated models to the given credential route (models foreign to the route are hidden).",
      }),
    ],
  }),
  j(
    "POST",
    "/v2/harnesses/:id/auth-readiness",
    "read_only",
    "ControlAuthReadinessRefreshRequest",
    "ControlAuthReadinessRefreshResponse",
  ),
  j("GET", "/v2/runs", "read_only", null, "ControlRunListResponse", {
    parameters: [
      queryParam({
        name: "limit",
        description:
          "Maximum run summaries to return (1..1000; default 200). The page is newest-first by (createdAt, id).",
      }),
      queryParam({
        name: "state",
        enum: [...ControlRunState.options],
        description: "Return only runs in this lifecycle state.",
      }),
      queryParam({
        name: "cursor",
        description:
          "Opaque keyset cursor from a prior page's nextCursor; returns the next (older) page. A malformed cursor is a typed 400.",
      }),
    ],
  }),
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
  j("GET", "/v2/runs/:id/events", "read_only", null, null, {
    responseKind: "stream",
    parameters: [
      resumeHeader(
        "the run's nonnegative integer event `seq` (a canonical decimal; malformed/negative/fractional values are refused)",
      ),
      queryParam({
        name: "lastEventId",
        description:
          "Compatibility alias for the Last-Event-ID header (same numeric run `seq`); the header wins when both are present.",
      }),
    ],
  }),
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
  j("GET", "/v2/trust", "read_only", null, "ControlTrustListResponse", {
    parameters: [
      queryParam({
        name: "repoRoot",
        description:
          "Scope the trust-state listing to a single repository root (absolute path); omit to list all.",
      }),
    ],
  }),
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
  j("GET", "/v2/setup/jobs", "read_only", null, "ControlSetupJobListResponse", {
    parameters: [
      queryParam({
        name: "harness",
        enum: ["codex", "claude", "cursor"],
        schemaRef: "ControlSetupJobListFilter#/properties/harness",
        description: "Filter setup jobs to one harness.",
      }),
      queryParam({
        name: "action",
        enum: ["login"],
        schemaRef: "ControlSetupJobListFilter#/properties/action",
        description: "Filter setup jobs to one action.",
      }),
      queryParam({
        name: "active",
        enum: ["true", "false"],
        schemaRef: "ControlSetupJobListFilter#/properties/active",
        description: "Filter to active (in-flight) jobs only, or terminal jobs only.",
      }),
      queryParam({
        name: "limit",
        schemaRef: "ControlSetupJobListFilter#/properties/limit",
        description: "Cap the number of returned jobs (positive integer, maximum 500).",
      }),
    ],
  }),
  j("POST", "/v2/setup/jobs", "mutating", "ControlSetupJobCreateRequest", "ControlSetupJob", {
    completion: "durable_handle",
    idempotency: "key_required",
  }),
  j("GET", "/v2/setup/jobs/:id", "read_only", null, "ControlSetupJob"),
  j("GET", "/v2/setup/jobs/:id/snapshot", "read_only", null, "ControlSetupJobSnapshot"),
  j("GET", "/v2/setup/jobs/:id/events", "read_only", null, null, {
    responseKind: "stream",
    parameters: [
      resumeHeader(
        "an opaque setup-journal cursor; a stale cursor is refused so the client can resnapshot, and query parameters are not accepted on this stream",
      ),
    ],
  }),
  j("POST", "/v2/setup/jobs/:id/cancel", "mutating", null, "ControlSetupJob", {
    idempotency: "natural",
  }),
  j("POST", "/v2/setup/jobs/:id/reconcile", "mutating", null, "ControlSetupJob", {
    idempotency: "natural",
  }),
  // QA-075/Ф2: extension is ADDITIVE (+15 min). Its Idempotency-Key is OPTIONAL
  // (keyless clients like the installed macOS Extend button are supported), so
  // the catalog honestly declares `none`, not `key_required` (a key opts into replay-safety).
  j("POST", "/v2/setup/jobs/:id/extend", "mutating", null, "ControlSetupJob", {
    idempotency: "none",
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
