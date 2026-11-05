import { THREAD_HISTORY_OPERATION_DRAFTS } from "./thread-history-routes.js";
import { THREAD_EXPORT_OPERATION_DRAFTS } from "./thread-export-routes.js";
import { ACCOUNT_RESOURCE_OPERATION_DRAFTS } from "./account-resource-routes.js";
import {
  CONTROL_PROTOCOL_MAJOR,
  ControlOperationCatalog,
  ControlRunState,
  type ControlOperationDescriptor,
  ControlHarnessSetupHarness,
} from "@claudexor/schema";
import { STORE_IDENTITY_HEADER, queryParam, resumeHeader } from "./operation-parameters.js";
import { REMOTE_OPERATION_DRAFTS } from "./remote-operation-descriptors.js";
import { MODEL_OPERATION_DRAFTS } from "./model-routes.js";
import { MAINTENANCE_OPERATION_DRAFTS } from "./maintenance-routes.js";
import { PROJECT_OPERATION_DRAFTS } from "./project-operation-descriptors.js";
import { RUN_EVENT_PART_OPERATION_DRAFTS } from "./run-event-part-routes.js";
import { descriptor, jsonOperation as j } from "./operation-descriptor.js";
import { TASK_GROUP_RUNS_OPERATION_DRAFTS } from "./task-group-routes.js";

const operations: ControlOperationDescriptor[] = [
  j(
    "POST",
    "/v2/runs/next-message",
    "mutating",
    "DeferredMessageMutation",
    "DeferredMessageReceipt",
    {
      idempotency: "key_required",
      summary: "Create, replace or clear one operator-owned deferred next message",
    },
  ),
  j("GET", "/v2/runs/next-message/:id", "read_only", null, "DeferredMessageDetail", {
    summary:
      "Read one exact deferred draft and its existing predecessor result and successor handles",
  }),
  ...TASK_GROUP_RUNS_OPERATION_DRAFTS.map(descriptor),
  ...THREAD_HISTORY_OPERATION_DRAFTS.map(descriptor),
  ...THREAD_EXPORT_OPERATION_DRAFTS.map(descriptor),
  ...MODEL_OPERATION_DRAFTS.map(descriptor),
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
  // Its catalog presence is the keyed-import feature marker clients detect.
  j(
    "POST",
    "/v2/uploads/imports",
    "mutating",
    "ControlUploadImportRequest",
    "ControlUploadImport",
    {
      idempotency: "key_required",
    },
  ),
  // Its presence also marks the managed import lifetime (`lifetime: "managed"`).
  j(
    "POST",
    "/v2/resources/:id/release",
    "mutating",
    "ControlResourceReleaseRequest",
    "ControlResourceRelease",
    { idempotency: "natural" },
  ),
  j("POST", "/v2/handshake", "read_only", "ControlHandshakeRequest", "ControlHandshakeResponse", {
    parameters: [STORE_IDENTITY_HEADER],
  }),
  j("GET", "/v2/daemon/status", "read_only", null, "ControlDaemonStatus"),
  j("GET", "/v2/operations", "read_only", null, "ControlOperationCatalog"),
  ...MAINTENANCE_OPERATION_DRAFTS.map(descriptor),
  j("GET", "/v2/agent-capabilities", "read_only", null, "AgentCapabilityCatalog"),
  j("GET", "/v2/run-applicability", "read_only", null, "ControlRunApplicabilityResponse", {
    applicability: "project",
    parameters: [
      queryParam({
        name: "repoRoot",
        required: true,
        description:
          "Absolute existing project root whose protected-path policy and Git prerequisite should be projected.",
      }),
    ],
  }),
  j("GET", "/v2/global/events", "read_only", null, null, {
    responseKind: "stream",
    parameters: [
      resumeHeader(
        "an opaque, partition- and epoch-scoped global journal cursor; a stale or foreign cursor is refused so the client can resnapshot",
      ),
    ],
  }),
  ...ACCOUNT_RESOURCE_OPERATION_DRAFTS.map(descriptor),
  // Unified account model (INV-135 rewrite): the pool-authority read. Its
  // catalog presence is also the feature marker clients detect (absent from
  // 3.5.0 engines), per INV-138 a generated capability, never hand-declared.
  j("GET", "/v2/account-pools", "read_only", null, "ControlAccountPoolsResponse"),
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
  // The supported downgrade path of the unified-accounts startup migration:
  // run BEFORE installing an engine whose canonicalizers refuse the migrated
  // row's native locator. Naturally idempotent (a second call finds no record).
  j(
    "POST",
    "/v2/accounts-migration/rollback",
    "mutating",
    "ControlAccountsMigrationRollbackRequest",
    "ControlAccountsMigrationRollbackResponse",
    { idempotency: "natural" },
  ),
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
  ...REMOTE_OPERATION_DRAFTS.map(descriptor),
  ...PROJECT_OPERATION_DRAFTS.map(descriptor),
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
  j("GET", "/v2/harnesses/:id/models", "read_only", null, "ControlHarnessModelsQueryResponse", {
    parameters: [
      queryParam({
        name: "view",
        enum: ["accounts"],
        description:
          "Opt in to all enabled account catalogs with separate availability and provenance; omission preserves the legacy response.",
      }),
      queryParam({
        name: "credentialProfileId",
        schemaRef: "Id",
        description: "Restrict the accounts view to this exact enabled credential profile.",
      }),
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
    parameters: [STORE_IDENTITY_HEADER],
  }),
  j("POST", "/v2/runs/wait-many", "read_only", "RunWaitManyInput", "RunWaitManyResult"),
  j("GET", "/v2/runs/:id", "read_only", null, "ControlRunDetail"),
  j("GET", "/v2/runs/:id/time-limit", "read_only", null, "RunTimeLimitSnapshot"),
  j("PATCH", "/v2/runs/:id/time-limit", "mutating", "RunTimeLimitRequest", "RunTimeLimitSnapshot"),
  j("POST", "/v2/runs/:id/retry", "mutating", null, "ControlRunRetryResponse", {
    completion: "durable_handle",
    idempotency: "key_required",
    parameters: [STORE_IDENTITY_HEADER],
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
      parameters: [STORE_IDENTITY_HEADER],
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
  ...RUN_EVENT_PART_OPERATION_DRAFTS.map(descriptor),
  j(
    "POST",
    "/v2/runs/:id/interactions/:id/answer",
    "mutating",
    "ControlInteractionAnswerRequest",
    "ControlInteractionAnswerResponse",
    { idempotency: "natural" },
  ),
  j(
    "POST",
    "/v2/runs/:id/messages",
    "mutating",
    "ControlRunMessageRequest",
    "ControlRunMessageResponse",
    // key_required (not natural): a replayed message would be delivered twice;
    // the Idempotency-Key is the message id and the stored receipt is replayed.
    { idempotency: "key_required" },
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
      parameters: [STORE_IDENTITY_HEADER],
    },
  ),
  j("POST", "/v2/threads/:id/turns/:id/retry", "mutating", null, "ControlThreadTurnResponse", {
    idempotency: "key_required",
    parameters: [STORE_IDENTITY_HEADER],
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
        enum: [...ControlHarnessSetupHarness.options],
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
  // One-shot sign-in input: first submission lands the transient sidecar, a
  // repeat 409s (naturally idempotent); the value is never journaled.
  j(
    "POST",
    "/v2/setup/jobs/:id/input",
    "mutating",
    "ControlSetupJobInputRequest",
    "ControlSetupJob",
    {
      idempotency: "natural",
    },
  ),
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
