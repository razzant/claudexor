import { z } from "zod/v3";
import { ContentHash, Id, NonBlankString } from "./primitives.js";
import {
  AttachmentKind,
  ControlUploadCreateRequest,
  ControlUploadFinalizeRequest,
  ControlUploadImportRequest,
  ControlUploadStatus,
} from "./attachment.js";

const uploadKey = NonBlankString.max(256).describe(
  "Caller-owned key for this exact stage. Save key and body before calling; replay both after an unknown response.",
);

/** Thin attachment-only controls over the existing HTTP upload lifecycle. */
export const McpUploadCreateInput = z
  .object({
    request: ControlUploadCreateRequest.omit({ purpose: true }),
    idempotencyKey: uploadKey,
  })
  .strict();
export type McpUploadCreateInput = z.infer<typeof McpUploadCreateInput>;

export const McpUploadTargetInput = z.object({ uploadId: Id }).strict();
export type McpUploadTargetInput = z.infer<typeof McpUploadTargetInput>;

export const McpUploadImportLocalInput = McpUploadTargetInput.extend({
  path: NonBlankString.describe(
    "Explicit absolute regular file on the MCP-server host, never the remote client's filesystem.",
  ),
}).strict();
export type McpUploadImportLocalInput = z.infer<typeof McpUploadImportLocalInput>;

export const McpUploadFinalizeInput = McpUploadTargetInput.extend({
  request: ControlUploadFinalizeRequest,
  idempotencyKey: uploadKey,
}).strict();
export type McpUploadFinalizeInput = z.infer<typeof McpUploadFinalizeInput>;

/** The store identity read takes no input; its output is the opt-in ControlHandshakeResponse. */
export const McpStoreIdentityInput = z.object({}).strict();
export type McpStoreIdentityInput = z.infer<typeof McpStoreIdentityInput>;

/** One-call keyed import of a file on the MCP-server host; output is ControlUploadImport. */
export const McpUploadImportInput = z
  .object({
    expectedStoreId: ControlUploadImportRequest.shape.expectedStoreId,
    path: NonBlankString.describe(
      "Explicit absolute regular file on the MCP-server host, never the remote client's filesystem.",
    ),
    idempotencyKey: NonBlankString.max(256).describe(
      "Caller-owned key for this one import. Save it with the exact arguments before calling and repeat both after any uncertainty; a completed import returns its original resource without reading the file again. A new edition of the file needs a new key.",
    ),
    kind: AttachmentKind.optional().describe(
      "Default: image when the effective MIME type starts with image/, otherwise file.",
    ),
    mime: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Default from the file extension (unknown extensions are application/octet-stream).",
      ),
    name: z.string().optional().describe("Display name. Default: the file's base name."),
  })
  .strict();
export type McpUploadImportInput = z.infer<typeof McpUploadImportInput>;

export const McpUploadImportLocalResult = ControlUploadStatus.extend({
  expectedSha256: ContentHash.optional().describe(
    "Digest of the verified local bytes. Save it for finalize; absent while uploading or cancelled.",
  ),
}).strict();
export type McpUploadImportLocalResult = z.infer<typeof McpUploadImportLocalResult>;
