import type { IncomingMessage, ServerResponse } from "node:http";
export { IMAGE_OPERATION_DRAFTS } from "./image-routes.js";
import {
  ControlModelSourcesResponse,
  ControlModelSourcesAccountsResponse,
  ControlModelCatalogResponse,
  ControlModelAccountCatalogResponse,
  ModelCallRequest,
  ControlModelOperationCreateRequest,
  ControlModelOperationDetail,
  ControlModelOperationAckRequest,
  ControlModelOperationControlRequest,
  Id,
  type ModelPayloadRef,
  type CancelReasonCode,
} from "@claudexor/schema";
import type { OperationDraft } from "./operation-draft.js";
import { queryParam } from "./operation-parameters.js";
import { assertOnlyQueryParams, optionalBooleanQuery, singleQuery } from "./query.js";
import { requiredIdempotencyKey } from "./run-start.js";
import { routeValue, serviceResponse } from "./route-stages.js";
import { writeBinaryResponse } from "./binary-response.js";
import type { ResourceRouteContext } from "./resource-routes.js";

/** Model operations are commands, not Agent Runs. No tool execution or conversation state. */
export interface ModelRouteServices {
  modelSources(view?: "accounts"): Promise<unknown>;
  modelCatalog(
    source: string,
    credentialProfileId?: string,
    requestedModel?: string,
  ): Promise<unknown>;
  modelAccountCatalog(source: string, credentialProfileId?: string): Promise<unknown>;
  createModelOperation(
    request: ModelPayloadRef,
    idempotencyKey: string,
    captureFailureEvidence?: boolean,
    captureEffortEvidence?: boolean,
  ): Promise<unknown>;
  getModelOperation(id: string): Promise<unknown>;
  readModelResult(id: string): Promise<{ bytes: Buffer; sha256: string }>;
  acknowledgeModelResult(id: string, sha256: string): Promise<unknown>;
  cancelModelOperation(id: string, reason?: CancelReasonCode): Promise<unknown>;
}

type Context = Omit<ResourceRouteContext, "services"> & { services?: Partial<ModelRouteServices> };

export async function handleModelRoute(
  ctx: Context,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const services = ctx.services;
  if (method === "GET" && path === "/model-sources") {
    if (!services?.modelSources) return false;
    const input = await routeValue(ctx, res, 400, () => {
      const query = new URL(req.url ?? "/", "http://localhost");
      assertOnlyQueryParams(query, ["view"]);
      return catalogView(query);
    });
    if (!input.ok) return true;
    const value = await routeValue(ctx, res, 500, () =>
      input.value === "accounts" ? services.modelSources!("accounts") : services.modelSources!(),
    );
    if (!value.ok) return true;
    return serviceResponse(ctx, res, "modelSources", () =>
      ctx.json(
        res,
        200,
        (input.value === "accounts"
          ? ControlModelSourcesAccountsResponse
          : ControlModelSourcesResponse
        ).parse(value.value),
      ),
    );
  }
  const catalogMatch = /^\/model-sources\/([^/]+)\/models$/.exec(path);
  if (method === "GET" && catalogMatch) {
    const input = await routeValue(ctx, res, 400, () => {
      const query = new URL(req.url ?? "/", "http://localhost");
      assertOnlyQueryParams(query, ["credentialProfileId", "requestedModel", "view"]);
      const profile = singleQuery(query, "credentialProfileId");
      const model = singleQuery(query, "requestedModel");
      const view = catalogView(query);
      if (view === "accounts" && model !== undefined)
        throw new Error("requestedModel is only valid for selected-account discovery");
      return {
        source: Id.parse(decodeURIComponent(catalogMatch[1]!)),
        profile: profile === undefined ? undefined : Id.parse(profile),
        model: model === undefined ? undefined : ModelCallRequest.shape.model.parse(model),
        view,
      };
    });
    if (!input.ok) return true;
    if (input.value.view === "accounts" ? !services?.modelAccountCatalog : !services?.modelCatalog)
      return false;
    const value = await routeValue(ctx, res, 500, () =>
      input.value.view === "accounts"
        ? services!.modelAccountCatalog!(input.value.source, input.value.profile)
        : services!.modelCatalog!(input.value.source, input.value.profile, input.value.model),
    );
    if (!value.ok) return true;
    return serviceResponse(ctx, res, "modelCatalog", () =>
      ctx.json(
        res,
        200,
        input.value.view === "accounts"
          ? publicModelAccountCatalog(value.value)
          : legacyModelCatalog(value.value),
      ),
    );
  }
  if (method === "POST" && path === "/model-operations") {
    if (!services?.createModelOperation) return false;
    const input = await routeValue(ctx, res, 400, async () => ({
      key: requiredIdempotencyKey(req),
      body: ControlModelOperationCreateRequest.parse(await ctx.readBody(req)),
      effort: optionalBooleanQuery(
        new URL(req.url ?? "/", "http://localhost"),
        "captureEffortEvidence",
      ),
      capture: optionalBooleanQuery(
        new URL(req.url ?? "/", "http://localhost"),
        "captureFailureEvidence",
      ),
    }));
    if (!input.ok) return true;
    const value = await routeValue(ctx, res, 500, () =>
      input.value.effort === true
        ? services.createModelOperation!(
            input.value.body.request,
            input.value.key,
            input.value.capture === true ? true : undefined,
            true,
          )
        : input.value.capture === true
          ? services.createModelOperation!(input.value.body.request, input.value.key, true)
          : services.createModelOperation!(input.value.body.request, input.value.key),
    );
    if (!value.ok) return true;
    return serviceResponse(ctx, res, "createModelOperation", () =>
      ctx.json(res, 202, ControlModelOperationDetail.parse(value.value)),
    );
  }
  const detailMatch = /^\/model-operations\/([^/]+)$/.exec(path);
  const resultMatch = /^\/model-operations\/([^/]+)\/result$/.exec(path);
  const ackMatch = /^\/model-operations\/([^/]+)\/ack$/.exec(path);
  const controlMatch = /^\/model-operations\/([^/]+)\/control$/.exec(path);
  let action: "get" | "result" | "ack" | "control";
  let encodedId: string;
  if (method === "GET" && detailMatch) {
    if (!services?.getModelOperation) return false;
    action = "get";
    encodedId = detailMatch[1]!;
  } else if (method === "GET" && resultMatch) {
    if (!services?.readModelResult) return false;
    action = "result";
    encodedId = resultMatch[1]!;
  } else if (method === "POST" && ackMatch) {
    if (!services?.acknowledgeModelResult) return false;
    action = "ack";
    encodedId = ackMatch[1]!;
  } else if (method === "POST" && controlMatch) {
    if (!services?.cancelModelOperation) return false;
    action = "control";
    encodedId = controlMatch[1]!;
  } else return false;
  const id = await routeValue(ctx, res, 400, () => Id.parse(decodeURIComponent(encodedId)));
  if (!id.ok) return true;
  if (action === "result") {
    const value = await routeValue(ctx, res, 500, () => services!.readModelResult!(id.value));
    if (!value.ok) return true;
    // Exact model bytes, not the redacted/bounded Agent artifact projection.
    // Reading never acknowledges delivery: only the caller can accept custody.
    return serviceResponse(ctx, res, "readModelResult", () => {
      const digest = ControlModelOperationAckRequest.parse({ sha256: value.value.sha256 }).sha256;
      res.setHeader("ETag", `"${digest}"`);
      writeBinaryResponse(
        res,
        200,
        value.value.bytes,
        "application/json; charset=utf-8",
        "model-result.json",
      );
    });
  }
  const input = await routeValue(ctx, res, 400, async () =>
    action === "ack"
      ? ControlModelOperationAckRequest.parse(await ctx.readBody(req))
      : action === "control"
        ? ControlModelOperationControlRequest.parse(await ctx.readBody(req))
        : null,
  );
  if (!input.ok) return true;
  const value = await routeValue(ctx, res, 500, () => {
    if (input.value && "sha256" in input.value)
      return services!.acknowledgeModelResult!(id.value, input.value.sha256);
    if (input.value && "action" in input.value)
      return services!.cancelModelOperation!(id.value, input.value.reasonCode);
    return services!.getModelOperation!(id.value);
  });
  if (!value.ok) return true;
  return serviceResponse(ctx, res, "modelOperation", () =>
    ctx.json(res, 200, ControlModelOperationDetail.parse(value.value)),
  );
}

function catalogView(query: URL): "accounts" | undefined {
  const view = singleQuery(query, "view");
  if (view !== undefined && view !== "accounts") throw new Error("view must be accounts");
  return view;
}

/** The pre-negotiation shape of `GET /model-sources/:id/models`: a legacy client
 * keeps its strict schema, so everything the account view carries beyond it —
 * `processing` and effort verification per row, declared client version per catalog — are stripped
 * here and only here. */
function legacyModelCatalog(value: unknown) {
  const {
    clientVersion: _clientVersion,
    clientVersionSource: _clientVersionSource,
    ...catalog
  } = ControlModelCatalogResponse.parse(value);
  return {
    ...catalog,
    models: catalog.models.map(
      ({
        processing: _processing,
        reasoningEffortsVerified: _effortVerified,
        reasoningEffortPreferenceOrder: _preferenceOrder,
        ...model
      }) => model,
    ),
  };
}

/** Preference order is operation-local adaptation evidence, not a new public
 * catalog field. Preserve the negotiated account shape as well as the legacy one. */
function publicModelAccountCatalog(value: unknown) {
  const view = ControlModelAccountCatalogResponse.parse(value);
  return {
    ...view,
    accounts: view.accounts.map((account) => ({
      ...account,
      catalog: account.catalog && {
        ...account.catalog,
        models: account.catalog.models.map(
          ({ reasoningEffortPreferenceOrder: _preferenceOrder, ...model }) => model,
        ),
      },
    })),
  };
}

/** Kept alongside the actual route contract; the common catalog projects IDs and auth. */
export const MODEL_OPERATION_DRAFTS: OperationDraft[] = [
  {
    method: "GET",
    path: "/v2/model-sources",
    mutability: "read_only",
    requestSchema: null,
    responseSchema: "ControlModelSourcesQueryResponse",
    responseKind: "json",
    summary: "List raw model transports, independent of agent harnesses.",
    parameters: [
      queryParam({
        name: "view",
        enum: ["accounts"],
        description:
          "Opt in to account catalog and processing transport capabilities; omitted preserves the legacy source shape.",
      }),
    ],
  },
  {
    method: "GET",
    path: "/v2/model-sources/:id/models",
    mutability: "read_only",
    requestSchema: null,
    responseSchema: "ControlModelCatalogQueryResponse",
    responseKind: "json",
    summary: "Read a selected account's raw model catalog and context evidence.",
    parameters: [
      queryParam({
        name: "view",
        enum: ["accounts"],
        description:
          "Enumerate every enabled account's separate inventory and availability; omitted selects one account using the inference pool criteria. Account view cannot be combined with requestedModel.",
      }),
      queryParam({
        name: "credentialProfileId",
        description: "Pin a managed profile; omitted selects the engine's Auto account.",
      }),
      queryParam({
        name: "requestedModel",
        schemaRef: "ModelCallRequest#/properties/model",
        description:
          "Select one account able to serve this model using the inference pool criteria; omitted discovers one account without a model constraint.",
      }),
    ],
  },
  {
    method: "POST",
    path: "/v2/model-operations",
    mutability: "mutating",
    requestSchema: "ControlModelOperationCreateRequest",
    responseSchema: "ControlModelOperationDetail",
    responseKind: "json",
    summary: "Accept one idempotent model generation without an agent run.",
    parameters: [
      queryParam({
        name: "captureEffortEvidence",
        enum: ["true", "false"],
        description:
          "Retain typed effort preparation and observation evidence in the private result. Omitted or false preserves the legacy result shape; the choice is bound to idempotency.",
      }),
      queryParam({
        name: "captureFailureEvidence",
        enum: ["true", "false"],
        description:
          "Retain exact failed-response bytes and exception details in the private result. Omitted or false preserves the legacy result shape.",
      }),
    ],
    idempotency: "key_required",
    completion: "durable_handle",
  },
  {
    method: "GET",
    path: "/v2/model-operations/:id",
    mutability: "read_only",
    requestSchema: null,
    responseSchema: "ControlModelOperationDetail",
    responseKind: "json",
    summary: "Inspect dispatch, outcome and response custody for the same operation.",
  },
  {
    method: "GET",
    path: "/v2/model-operations/:id/result",
    mutability: "read_only",
    requestSchema: null,
    responseSchema: null,
    responseKind: "binary",
    summary: "Read exact model response bytes without acknowledging delivery.",
  },
  {
    method: "POST",
    path: "/v2/model-operations/:id/ack",
    mutability: "mutating",
    requestSchema: "ControlModelOperationAckRequest",
    responseSchema: "ControlModelOperationDetail",
    responseKind: "json",
    summary: "Acknowledge the exact result digest and release temporary model bytes.",
    idempotency: "natural",
  },
  {
    method: "POST",
    path: "/v2/model-operations/:id/control",
    mutability: "mutating",
    requestSchema: "ControlModelOperationControlRequest",
    responseSchema: "ControlModelOperationDetail",
    responseKind: "json",
    summary: "Cancel an existing model operation; settled results remain settled.",
    idempotency: "natural",
  },
];
