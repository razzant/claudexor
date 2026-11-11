import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ControlAccountResourcesResponse,
  ControlAccountRoutingEvidenceResponse,
  ControlQuotaFreshnessResponse,
  ControlAccountResourcesFreshnessResponse,
  ControlQuotaResponse,
  ControlQuotaReadRequest,
  ControlQuotaRefreshRequest,
  ControlAccountResetRequest,
  ControlAccountResetResponse,
} from "@claudexor/schema";
import type { DaemonControlApiOptions } from "./daemon-server.js";
import type { OperationDraft } from "./operation-draft.js";
import { quotaReadViewQuery, resourceViewQuery } from "./catalog-query.js";
import { assertOnlyQueryParams, optionalBooleanQuery, singleQuery } from "./query.js";
import { requiredIdempotencyKey } from "./run-start.js";
import { queryParam, QUOTA_READ_PARAMETERS } from "./operation-parameters.js";

/** Selectors a resources route hands its service beside the request body. */
export interface ResourceRead {
  view?: "resources";
  includeApiKeys?: boolean;
}
/** Negotiated API-key rows: strict clients that omit it keep the account-only resources. */
const INCLUDE_API_KEYS_PARAMETER = queryParam({
  name: "includeApiKeys",
  enum: ["true", "false"],
  description:
    "With a resources view, add API-key rows: each harness's default API-key route (target.profile_id null) and its enabled registered API-key accounts, bound to the key a request would send now. A row read with another key is never shown. Omitted or false preserves account-only resources for strict clients.",
});
const parameters = [
  queryParam({
    name: "view",
    enum: ["resources"],
    description: "Opt in to typed account resources alongside quota.",
  }),
  INCLUDE_API_KEYS_PARAMETER,
];
const readParameters = [
  ...QUOTA_READ_PARAMETERS,
  queryParam({
    name: "view",
    enum: ["resources", "constraint_freshness", "resources_freshness"],
    description:
      "Opt in to typed resources, per-constraint freshness, or resources_freshness combining both with an explicit availability_scope echo. Omitted preserves the legacy shape. Does not refresh quota.",
  }),
  INCLUDE_API_KEYS_PARAMETER,
];
export const ACCOUNT_RESOURCE_OPERATION_DRAFTS: OperationDraft[] = [
  {
    method: "GET",
    path: "/v2/accounts/routing-evidence",
    mutability: "read_only",
    requestSchema: null,
    responseSchema: "ControlAccountRoutingEvidenceResponse",
    responseKind: "json",
    summary:
      "Read live model-scoped refusal marks, temporary capability marks, model-scoped credential refusals, and the durable last-served order; no probe or quota refresh.",
    parameters: [
      queryParam({
        name: "includeCapabilities",
        enum: ["true", "false"],
        description:
          "Add the temporary account x model capability marks (capabilities[]). Omitted or false preserves the legacy response shape for strict clients.",
      }),
      queryParam({
        name: "includeCredentialUnusable",
        enum: ["true", "false"],
        description:
          "Add the registered rows' live model-scoped credential refusals (credentialUnusable[]): dated evidence for one model that never changes the account's status. Omitted or false preserves the earlier response shape for strict clients.",
      }),
    ],
  },
  {
    method: "GET",
    path: "/v2/credential-profiles",
    mutability: "read_only",
    requestSchema: null,
    responseSchema: "ControlCredentialProfilesQueryResponse",
    responseKind: "json",
    parameters: [
      queryParam({
        name: "view",
        enum: ["resources"],
        description: "Include typed resources in quota; requires snapshot=true.",
      }),
      queryParam({
        name: "snapshot",
        enum: ["true", "false"],
        description: "Return one fresh server-authored Accounts snapshot epoch.",
      }),
      INCLUDE_API_KEYS_PARAMETER,
    ],
  },
  {
    method: "GET",
    path: "/v2/quota",
    mutability: "read_only",
    requestSchema: null,
    responseSchema: "ControlQuotaQueryResponse",
    responseKind: "json",
    parameters: readParameters,
  },
  {
    method: "POST",
    path: "/v2/quota",
    mutability: "mutating",
    idempotency: "natural",
    requestSchema: "ControlQuotaRefreshRequest",
    responseSchema: "ControlQuotaQueryResponse",
    responseKind: "json",
    parameters,
  },
  {
    method: "POST",
    path: "/v2/account-resets",
    mutability: "mutating",
    requestSchema: "ControlAccountResetRequest",
    responseSchema: "ControlAccountResetResponse",
    responseKind: "json",
    idempotency: "key_required",
    summary: "Explicitly consume a native account reset and read back its resources.",
  },
  {
    method: "GET",
    path: "/v2/account-resets/:id",
    mutability: "read_only",
    requestSchema: null,
    responseSchema: "ControlAccountResetResponse",
    responseKind: "json",
    summary: "Read a durable account reset receipt.",
  },
];
interface Context {
  services?: Pick<
    NonNullable<DaemonControlApiOptions["services"]>,
    "accountRoutingEvidence" | "quota" | "refreshQuota" | "createAccountReset" | "accountReset"
  >;
  readBody: (req: IncomingMessage) => Promise<unknown>;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  requestError: (res: ServerResponse, error: unknown) => void;
}
function required<T>(service: T | undefined): T {
  if (service) return service;
  throw Object.assign(new Error("Account resource service is unavailable"), {
    status: 501,
    code: "not_implemented",
  });
}
export async function handleAccountResourceRoute(
  ctx: Context,
  method: string,
  path: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  try {
    if (method === "GET" && path === "/accounts/routing-evidence") {
      assertOnlyQueryParams(url, ["includeCapabilities", "includeCredentialUnusable"]);
      const payload = await required(ctx.services?.accountRoutingEvidence)({
        capabilities: optionalBooleanQuery(url, "includeCapabilities") === true,
        credentialUnusable: optionalBooleanQuery(url, "includeCredentialUnusable") === true,
      });
      ctx.json(res, 200, ControlAccountRoutingEvidenceResponse.parse(payload));
      return true;
    }
    if ((method === "GET" && path === "/quota") || (method === "POST" && path === "/quota")) {
      assertOnlyQueryParams(
        url,
        method === "GET"
          ? ["view", "requestKind", "model", "includeApiKeys"]
          : ["view", "includeApiKeys"],
      );
      const view = method === "GET" ? quotaReadViewQuery(url) : resourceViewQuery(url);
      const includeApiKeys = optionalBooleanQuery(url, "includeApiKeys") === true;
      const input =
        method === "GET"
          ? ControlQuotaReadRequest.parse({
              ...(view ? { view } : {}),
              ...(includeApiKeys ? { includeApiKeys } : {}),
              ...(singleQuery(url, "requestKind") !== undefined
                ? { requestKind: singleQuery(url, "requestKind") }
                : {}),
              ...(singleQuery(url, "model") !== undefined
                ? { model: singleQuery(url, "model") }
                : {}),
            })
          : undefined;
      const schema =
        view === "resources_freshness"
          ? ControlAccountResourcesFreshnessResponse
          : view === "resources"
            ? ControlAccountResourcesResponse
            : view === "constraint_freshness"
              ? ControlQuotaFreshnessResponse
              : ControlQuotaResponse;
      const payload =
        method === "GET"
          ? await required(ctx.services?.quota)(
              input && Object.keys(input).length ? input : undefined,
            )
          : await required(ctx.services?.refreshQuota)({
              ...ControlQuotaRefreshRequest.parse(await ctx.readBody(req)),
              ...(view === "resources" ? { view } : {}),
              ...(includeApiKeys ? { includeApiKeys } : {}),
            });
      ctx.json(res, 200, schema.parse(payload));
      return true;
    }
    if (method === "POST" && path === "/account-resets") {
      const request = ControlAccountResetRequest.parse(await ctx.readBody(req));
      const idempotencyKey = requiredIdempotencyKey(req);
      const payload = await required(ctx.services?.createAccountReset)({
        request,
        idempotencyKey,
        clientId: "control-api",
      });
      ctx.json(res, 200, ControlAccountResetResponse.parse(payload));
      return true;
    }
    const accountResetMatch = /^\/account-resets\/([^/]+)$/.exec(path);
    if (method === "GET" && accountResetMatch) {
      const payload = await required(ctx.services?.accountReset)(
        decodeURIComponent(accountResetMatch[1]!),
      );
      ctx.json(res, 200, ControlAccountResetResponse.parse(payload));
      return true;
    }
    return false;
  } catch (error) {
    ctx.requestError(res, error);
    return true;
  }
}
