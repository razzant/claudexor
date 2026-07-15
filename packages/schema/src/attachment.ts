import { z } from "zod";
import { ContentHash, Id, IsoTimestamp } from "./primitives.js";

export const AttachmentKind = z
  .enum(["image", "file"])
  .describe("Kind of attached resource: image input or generic file bytes.");
export type AttachmentKind = z.infer<typeof AttachmentKind>;

/** The only attachment authority accepted by run/turn requests. */
export const ResourceAttachmentRef = z
  .object({ resourceId: Id.describe("Immutable daemon resource id returned by upload finalize.") })
  .strict()
  .describe("Reference to an immutable daemon-owned uploaded resource.");
export type ResourceAttachmentRef = z.infer<typeof ResourceAttachmentRef>;

/** Internal resolved shape passed to adapters; never accepted from a client. */
export const Attachment = z
  .object({
    resource_id: Id.describe("Immutable daemon resource id."),
    kind: AttachmentKind,
    mime: z.string().min(1).describe("Declared MIME type validated against adapter limits."),
    name: z.string().describe("Original display name."),
    sha256: ContentHash.describe("Exact sha256 digest of the immutable bytes."),
    size_bytes: z.number().int().nonnegative().describe("Exact byte length."),
    path: z.string().describe("Daemon-owned immutable blob path; internal adapter input only."),
  })
  .strict()
  .describe("Daemon-resolved immutable resource supplied to a harness adapter.");
export type Attachment = z.infer<typeof Attachment>;

export const AttachmentTransport = z
  .enum(["file_path", "base64_stream", "base64_inline", "text_inline"])
  .describe("Native adapter transport used for one supported attachment class.");
export type AttachmentTransport = z.infer<typeof AttachmentTransport>;

/** Finite declaration: absent/unknown MIME is unsupported, never assumed. */
export const AttachmentInputClass = z
  .object({
    kind: AttachmentKind,
    mime_types: z.array(z.string().min(1)).min(1),
    max_bytes: z.number().int().positive().finite(),
    max_count: z.number().int().positive().finite(),
    transport: AttachmentTransport,
  })
  .strict()
  .describe("Finite MIME, size, count and transport limits declared by one adapter.");
export type AttachmentInputClass = z.infer<typeof AttachmentInputClass>;

export const ControlUploadCreateRequest = z
  .object({
    kind: AttachmentKind,
    mime: z.string().min(1),
    name: z.string().default(""),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();
export type ControlUploadCreateRequest = z.infer<typeof ControlUploadCreateRequest>;

export const ControlUploadStatus = z
  .object({
    uploadId: Id,
    state: z.enum(["open", "uploading", "uploaded", "cancelled"]),
    receivedBytes: z.number().int().nonnegative(),
    expectedBytes: z.number().int().nonnegative(),
  })
  .strict();
export type ControlUploadStatus = z.infer<typeof ControlUploadStatus>;

export const ControlResource = z
  .object({
    resourceId: Id,
    kind: AttachmentKind,
    mime: z.string().min(1),
    name: z.string(),
    sha256: ContentHash,
    sizeBytes: z.number().int().nonnegative(),
    createdAt: IsoTimestamp,
    deduplicated: z.boolean(),
  })
  .strict();
export type ControlResource = z.infer<typeof ControlResource>;

export const ControlUploadFinalizeRequest = z
  .object({ expectedSha256: ContentHash.optional() })
  .strict();
export type ControlUploadFinalizeRequest = z.infer<typeof ControlUploadFinalizeRequest>;
