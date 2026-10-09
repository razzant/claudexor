import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ControlImageOperationCreateRequest,
  ControlImageOperationDetail,
  ControlImageOperationAckRequest,
  ControlImageOperationControlRequest,
  IMAGE_REQUEST_LIMIT_BYTES,
  Id,
  type CancelReasonCode,
} from "@claudexor/schema";
import type { ImageCallRequest } from "@claudexor/schema";
import type { OperationDraft } from "./operation-draft.js";
import { requiredIdempotencyKey } from "./run-start.js";
import { routeValue, serviceResponse } from "./route-stages.js";
import { writeBinaryResponse } from "./binary-response.js";
import type { ResourceRouteContext } from "./resource-routes.js";

/** Images are a separate provider operation, never a caller-owned chat turn. */
export interface ImageRouteServices {
  createImageOperation(request: ImageCallRequest, key: string): Promise<unknown>;
  getImageOperation(id: string): Promise<unknown>;
  readImageResult(id: string): Promise<{ bytes: Buffer; sha256: string }>;
  acknowledgeImageResult(id: string, sha256: string): Promise<unknown>;
  cancelImageOperation(id: string, reason?: CancelReasonCode): Promise<unknown>;
}

type Context = Omit<ResourceRouteContext, "services"> & { services?: Partial<ImageRouteServices> };

export async function handleImageRoute(
  ctx: Context,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const services = ctx.services;
  if (method === "POST" && path === "/image-operations") {
    if (!services?.createImageOperation) return false;
    const input = await routeValue(ctx, res, 400, async () => ({
      key: requiredIdempotencyKey(req),
      body: ControlImageOperationCreateRequest.parse(
        await ctx.readBody(req, IMAGE_REQUEST_LIMIT_BYTES),
      ),
    }));
    if (!input.ok) return true;
    const value = await routeValue(ctx, res, 500, () =>
      services.createImageOperation!(input.value.body, input.value.key),
    );
    if (!value.ok) return true;
    return serviceResponse(ctx, res, "createImageOperation", () =>
      ctx.json(res, 202, ControlImageOperationDetail.parse(value.value)),
    );
  }
  const detail = /^\/image-operations\/([^/]+)$/.exec(path);
  const result = /^\/image-operations\/([^/]+)\/result$/.exec(path);
  const ack = /^\/image-operations\/([^/]+)\/ack$/.exec(path);
  const control = /^\/image-operations\/([^/]+)\/control$/.exec(path);
  let action: "get" | "result" | "ack" | "control";
  let encodedId: string;
  if (method === "GET" && detail) {
    if (!services?.getImageOperation) return false;
    action = "get";
    encodedId = detail[1]!;
  } else if (method === "GET" && result) {
    if (!services?.readImageResult) return false;
    action = "result";
    encodedId = result[1]!;
  } else if (method === "POST" && ack) {
    if (!services?.acknowledgeImageResult) return false;
    action = "ack";
    encodedId = ack[1]!;
  } else if (method === "POST" && control) {
    if (!services?.cancelImageOperation) return false;
    action = "control";
    encodedId = control[1]!;
  } else return false;
  const id = await routeValue(ctx, res, 400, () => Id.parse(decodeURIComponent(encodedId)));
  if (!id.ok) return true;
  if (action === "result") {
    const value = await routeValue(ctx, res, 500, () => services!.readImageResult!(id.value));
    if (!value.ok) return true;
    return serviceResponse(ctx, res, "readImageResult", () => {
      res.setHeader("ETag", `"${value.value.sha256}"`);
      // This is the private, complete provider envelope: never expose it through
      // a public job/status projection. GET alone does not acknowledge custody.
      writeBinaryResponse(
        res,
        200,
        value.value.bytes,
        "application/json; charset=utf-8",
        "image-result.json",
      );
    });
  }
  const input = await routeValue(ctx, res, 400, async () =>
    action === "ack"
      ? ControlImageOperationAckRequest.parse(await ctx.readBody(req))
      : action === "control"
        ? ControlImageOperationControlRequest.parse(await ctx.readBody(req))
        : null,
  );
  if (!input.ok) return true;
  const value = await routeValue(ctx, res, 500, () => {
    if (input.value && "sha256" in input.value)
      return services!.acknowledgeImageResult!(id.value, input.value.sha256);
    if (input.value && "action" in input.value)
      return services!.cancelImageOperation!(id.value, input.value.reasonCode);
    return services!.getImageOperation!(id.value);
  });
  if (!value.ok) return true;
  return serviceResponse(ctx, res, "imageOperation", () =>
    ctx.json(res, 200, ControlImageOperationDetail.parse(value.value)),
  );
}

/** Catalog descriptors are the capability: clients discover this family by its POST. */
export const IMAGE_OPERATION_DRAFTS: OperationDraft[] = [
  {
    method: "POST",
    path: "/v2/image-operations",
    mutability: "mutating",
    requestSchema: "ControlImageOperationCreateRequest",
    responseSchema: "ControlImageOperationDetail",
    responseKind: "json",
    summary: "Accept one idempotent subscription image generation, without an Agent Run.",
    idempotency: "key_required",
    completion: "durable_handle",
  },
  {
    method: "GET",
    path: "/v2/image-operations/:id",
    mutability: "read_only",
    requestSchema: null,
    responseSchema: "ControlImageOperationDetail",
    responseKind: "json",
    summary: "Inspect the image operation and its dispatch/result custody.",
  },
  {
    method: "GET",
    path: "/v2/image-operations/:id/result",
    mutability: "read_only",
    requestSchema: null,
    responseSchema: null,
    responseKind: "binary",
    summary: "Read exact private image-result JSON bytes without acknowledging delivery.",
  },
  {
    method: "POST",
    path: "/v2/image-operations/:id/ack",
    mutability: "mutating",
    requestSchema: "ControlImageOperationAckRequest",
    responseSchema: "ControlImageOperationDetail",
    responseKind: "json",
    summary:
      "Acknowledge one retained image by its content digest; release after all images are acknowledged.",
  },
  {
    method: "POST",
    path: "/v2/image-operations/:id/control",
    mutability: "mutating",
    requestSchema: "ControlImageOperationControlRequest",
    responseSchema: "ControlImageOperationDetail",
    responseKind: "json",
    summary: "Request cancellation without claiming an unknown image attempt was free.",
  },
];
