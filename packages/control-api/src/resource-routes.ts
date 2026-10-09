import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ControlResource,
  ControlUploadCreateRequest,
  ControlUploadFinalizeRequest,
  ControlUploadStatus,
  type ResourceAttachmentRef,
} from "@claudexor/schema";
import { requiredIdempotencyKey } from "./run-start.js";
import { routeValue, serviceResponse } from "./route-stages.js";

export interface ResourceRouteServices {
  createUpload(input: ControlUploadCreateRequest, idempotencyKey: string): Promise<unknown>;
  writeUpload(uploadId: string, chunks: AsyncIterable<Uint8Array>): Promise<unknown>;
  uploadStatus(uploadId: string): Promise<unknown>;
  cancelUpload(uploadId: string): Promise<unknown>;
  finalizeUpload(
    uploadId: string,
    expectedSha256: string | undefined,
    idempotencyKey: string,
  ): Promise<unknown>;
  validateResources(refs: ResourceAttachmentRef[]): Promise<void>;
}

export interface ResourceRouteContext {
  services?: Partial<ResourceRouteServices>;
  readBody(req: IncomingMessage, maxBytes?: number): Promise<unknown>;
  json(res: ServerResponse, status: number, body: unknown): void;
  requestError(res: ServerResponse, error: unknown, fallbackStatus?: 400 | 500): void;
}

export async function handleResourceRoute(
  ctx: ResourceRouteContext,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const services = ctx.services;
  if (method === "POST" && path === "/uploads") {
    const service = services?.createUpload;
    if (!service) return false;
    const input = await routeValue(ctx, res, 400, async () => ({
      idempotencyKey: requiredIdempotencyKey(req),
      request: ControlUploadCreateRequest.parse(await ctx.readBody(req)),
    }));
    if (!input.ok) return true;
    const result = await routeValue(ctx, res, 500, () =>
      service(input.value.request, input.value.idempotencyKey),
    );
    if (!result.ok) return true;
    return serviceResponse(ctx, res, "createUpload", () =>
      ctx.json(res, 201, ControlUploadStatus.parse(result.value)),
    );
  }
  const uploadBytesMatch = /^\/uploads\/([^/]+)\/bytes$/.exec(path);
  const uploadFinalizeMatch = /^\/uploads\/([^/]+)\/finalize$/.exec(path);
  const uploadMatch = /^\/uploads\/([^/]+)$/.exec(path);

  if (method === "PUT" && uploadBytesMatch) {
    const service = services?.writeUpload;
    if (!service) return false;
    const uploadId = await routeValue(ctx, res, 400, () =>
      decodeURIComponent(uploadBytesMatch[1] as string),
    );
    if (!uploadId.ok) return true;
    const result = await routeValue(ctx, res, 500, () => service(uploadId.value, req));
    if (!result.ok) return true;
    return serviceResponse(ctx, res, "writeUpload", () =>
      ctx.json(res, 200, ControlUploadStatus.parse(result.value)),
    );
  }
  if (method === "POST" && uploadFinalizeMatch) {
    const service = services?.finalizeUpload;
    if (!service) return false;
    const input = await routeValue(ctx, res, 400, async () => {
      const uploadId = decodeURIComponent(uploadFinalizeMatch[1] as string);
      const body = ControlUploadFinalizeRequest.parse(await ctx.readBody(req));
      return {
        uploadId,
        expectedSha256: body.expectedSha256,
        idempotencyKey: requiredIdempotencyKey(req),
      };
    });
    if (!input.ok) return true;
    const result = await routeValue(ctx, res, 500, () =>
      service(input.value.uploadId, input.value.expectedSha256, input.value.idempotencyKey),
    );
    if (!result.ok) return true;
    return serviceResponse(ctx, res, "finalizeUpload", () =>
      ctx.json(res, 201, ControlResource.parse(result.value)),
    );
  }
  if (method === "GET" && uploadMatch) {
    const service = services?.uploadStatus;
    if (!service) return false;
    const uploadId = await routeValue(ctx, res, 400, () =>
      decodeURIComponent(uploadMatch[1] as string),
    );
    if (!uploadId.ok) return true;
    const result = await routeValue(ctx, res, 500, () => service(uploadId.value));
    if (!result.ok) return true;
    return serviceResponse(ctx, res, "uploadStatus", () =>
      ctx.json(res, 200, ControlUploadStatus.parse(result.value)),
    );
  }
  if (method === "DELETE" && uploadMatch) {
    const service = services?.cancelUpload;
    if (!service) return false;
    const uploadId = await routeValue(ctx, res, 400, () =>
      decodeURIComponent(uploadMatch[1] as string),
    );
    if (!uploadId.ok) return true;
    const result = await routeValue(ctx, res, 500, () => service(uploadId.value));
    if (!result.ok) return true;
    return serviceResponse(ctx, res, "cancelUpload", () =>
      ctx.json(res, 200, ControlUploadStatus.parse(result.value)),
    );
  }
  return false;
}
