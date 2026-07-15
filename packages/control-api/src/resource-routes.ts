import type { IncomingMessage, ServerResponse } from "node:http";
import { ControlUploadFinalizeRequest } from "@claudexor/schema";

export interface ResourceRouteServices {
  createUpload(input: unknown, idempotencyKey: string): Promise<unknown>;
  writeUpload(uploadId: string, chunks: AsyncIterable<Uint8Array>): Promise<unknown>;
  uploadStatus(uploadId: string): Promise<unknown>;
  cancelUpload(uploadId: string): Promise<unknown>;
  finalizeUpload(
    uploadId: string,
    expectedSha256: string | undefined,
    idempotencyKey: string,
  ): Promise<unknown>;
  validateResources(refs: import("@claudexor/schema").ResourceAttachmentRef[]): Promise<void>;
}

export interface ResourceRouteContext {
  services?: Partial<ResourceRouteServices>;
  readBody(req: IncomingMessage): Promise<unknown>;
  json(res: ServerResponse, status: number, body: unknown): void;
  requestError(res: ServerResponse, error: unknown): void;
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
    if (!services?.createUpload) return false;
    try {
      ctx.json(
        res,
        201,
        await services.createUpload(await ctx.readBody(req), requiredIdempotencyKey(req)),
      );
    } catch (error) {
      ctx.requestError(res, error);
    }
    return true;
  }
  const uploadBytesMatch = /^\/uploads\/([^/]+)\/bytes$/.exec(path);
  const uploadFinalizeMatch = /^\/uploads\/([^/]+)\/finalize$/.exec(path);
  const uploadMatch = /^\/uploads\/([^/]+)$/.exec(path);
  try {
    if (method === "PUT" && uploadBytesMatch && services?.writeUpload) {
      const uploadId = decodeURIComponent(uploadBytesMatch[1] as string);
      ctx.json(res, 200, await services.writeUpload(uploadId, req));
      return true;
    }
    if (method === "POST" && uploadFinalizeMatch && services?.finalizeUpload) {
      const uploadId = decodeURIComponent(uploadFinalizeMatch[1] as string);
      const body = ControlUploadFinalizeRequest.parse(await ctx.readBody(req));
      ctx.json(
        res,
        201,
        await services.finalizeUpload(uploadId, body.expectedSha256, requiredIdempotencyKey(req)),
      );
      return true;
    }
    if (method === "GET" && uploadMatch && services?.uploadStatus) {
      const uploadId = decodeURIComponent(uploadMatch[1] as string);
      ctx.json(res, 200, await services.uploadStatus(uploadId));
      return true;
    }
    if (method === "DELETE" && uploadMatch && services?.cancelUpload) {
      const uploadId = decodeURIComponent(uploadMatch[1] as string);
      ctx.json(res, 200, await services.cancelUpload(uploadId));
      return true;
    }
  } catch (error) {
    ctx.requestError(res, error);
    return true;
  }
  return false;
}

function requiredIdempotencyKey(req: IncomingMessage): string {
  const raw = req.headers["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || value.length > 256) {
    throw Object.assign(new Error("Idempotency-Key is required for this create operation"), {
      status: 400,
      code: value ? "invalid_idempotency_key" : "idempotency_key_required",
    });
  }
  return value;
}
