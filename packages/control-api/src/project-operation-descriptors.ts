import { ControlProjectRemoveTrashedThreads } from "@claudexor/schema";
import type { OperationDraft } from "./operation-draft.js";
import { queryParam, STORE_IDENTITY_HEADER } from "./operation-parameters.js";

/** Registry operations handled by project-routes.ts, in catalog order. */
export const PROJECT_OPERATION_DRAFTS: OperationDraft[] = [
  {
    method: "POST",
    path: "/v2/projects",
    mutability: "mutating",
    requestSchema: "ControlProjectRegisterRequest",
    responseSchema: "ControlProjectRegisterResponse",
    responseKind: "json",
    idempotency: "key_required",
    parameters: [STORE_IDENTITY_HEADER],
  },
  {
    method: "GET",
    path: "/v2/projects/:id/registration",
    mutability: "read_only",
    requestSchema: null,
    responseSchema: "ControlProjectRegistrationState",
    responseKind: "json",
    summary: "Read the addressed registration in the expected store at its recorded root.",
    parameters: [
      queryParam({
        name: "expectedStoreId",
        required: true,
        description: "Registration receipt's store ID.",
      }),
      queryParam({
        name: "expectedRoot",
        required: true,
        description: "Registration receipt's canonical root.",
      }),
      queryParam({
        name: "candidate",
        description:
          "The caller's already-admitted workspace choice, as an absolute path; the answer then adds candidateMatch — same (the registered folder), different (proven another directory), or unknown (undecidable now, never a case-normalization promise).",
      }),
    ],
  },
  {
    method: "POST",
    path: "/v2/projects/:id/release",
    mutability: "mutating",
    requestSchema: "ControlProjectBinding",
    responseSchema: "ControlProjectReleaseReceipt",
    responseKind: "json",
    idempotency: "natural",
    summary: "Release the matching registration when idle, retaining threads, files and artifacts.",
  },
  {
    method: "POST",
    path: "/v2/projects/:id/relink",
    mutability: "mutating",
    requestSchema: "ControlProjectRelinkRequest",
    responseSchema: "ControlProject",
    responseKind: "json",
    idempotency: "natural",
  },
  {
    method: "DELETE",
    path: "/v2/projects/:id",
    mutability: "mutating",
    requestSchema: null,
    responseSchema: "ControlProjectRemoveReceipt",
    responseKind: "json",
    idempotency: "natural",
    parameters: [
      queryParam({
        name: "trashedThreads",
        enum: [...ControlProjectRemoveTrashedThreads.options],
        description:
          "Opt in to purging the threads already in the project's trash in the same removal; any other thread or a queued/running command still refuses it. Omission keeps the default refusal while any non-purged thread remains.",
      }),
    ],
  },
];
