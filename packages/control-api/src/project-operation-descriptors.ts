import { ControlProjectRemoveTrashedThreads } from "@claudexor/schema";
import type { OperationDraft } from "./operation-draft.js";
import { queryParam } from "./operation-parameters.js";

/** Registry mutations handled by project-routes.ts, in catalog order. */
export const PROJECT_OPERATION_DRAFTS: OperationDraft[] = [
  {
    method: "POST",
    path: "/v2/projects",
    mutability: "mutating",
    requestSchema: "ControlProjectRegisterRequest",
    responseSchema: "ControlProjectRegisterResponse",
    responseKind: "json",
    idempotency: "key_required",
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
