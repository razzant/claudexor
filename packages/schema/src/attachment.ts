import { z } from "zod";
import { Id } from "./primitives.js";

/**
 * A user- or agent-provided file/image attached to a turn. `path` is the
 * resolved on-disk location in the scoped attachment store (kept OUTSIDE any
 * worktree so `git add -A` cannot capture it); an adapter reads bytes from
 * there to forward to its harness in that harness's native shape.
 */
export const AttachmentKind = z
  .enum(["image", "file"])
  .describe("Kind of attachment: image (vision input) or file (generic bytes).");
export type AttachmentKind = z.infer<typeof AttachmentKind>;

export const Attachment = z
  .object({
    id: Id.describe("Attachment id."),
    kind: AttachmentKind.default("file"),
    mime: z
      .string()
      .default("application/octet-stream")
      .describe("MIME type of the attachment content."),
    name: z.string().default("").describe("Original file name as provided by the user or agent."),
    /** Resolved local path in the scoped attachment store. */
    path: z
      .string()
      .describe("Resolved local path in the scoped attachment store (kept outside any worktree)."),
  })
  .describe(
    "A user- or agent-provided file/image attached to a turn, stored in the scoped attachment store and forwarded to harnesses in their native shape.",
  );
export type Attachment = z.infer<typeof Attachment>;

/**
 * Inbound attachment on a control request. Thread/composer uploads may arrive
 * base64-inline (`data`) for a fresh upload; direct non-thread run enqueue
 * accepts only non-empty absolute existing file paths so bytes cannot persist in
 * the daemon command journal. The daemon/turn store resolves inbound bytes to a
 * durable {@link Attachment}. Exactly one of `data` / `path` is expected; both
 * null is rejected by the resolver (fail loud, never a silent empty attachment).
 */
export const AttachmentInput = z
  .object({
    kind: AttachmentKind.default("file"),
    mime: z
      .string()
      .default("application/octet-stream")
      .describe("MIME type of the attachment content."),
    name: z.string().default("").describe("Original file name for the attachment."),
    data: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "Base64-inline attachment bytes for a fresh upload; null when path is used instead.",
      ),
    path: z
      .string()
      .nullable()
      .default(null)
      .describe("Absolute existing file path to read bytes from; null when data is used instead."),
  })
  .describe(
    "Inbound attachment on a control request; exactly one of data (base64-inline) or path (absolute existing file) is expected, resolved by the daemon into a durable Attachment.",
  );
export type AttachmentInput = z.infer<typeof AttachmentInput>;

/**
 * How a harness accepts image input, declared by its adapter manifest and used
 * for honest UI gating + per-adapter serialization (never a normalized wire
 * format): `file_path` (codex `-i`), `base64_stream` (claude stream-json image
 * block), `base64_inline` (raw-api `image_url` data URL), or `none` (cursor /
 * opencode — image attachments are disabled/routed to a vision-capable harness
 * rather than silently dropped; generic file attachments still use Attachment).
 */
export const ImageInputMode = z
  .enum(["file_path", "base64_stream", "base64_inline", "none"])
  .describe(
    "How a harness accepts image input: file_path (CLI file argument), base64_stream (base64 image block on the stream), base64_inline (data-URL in the request), or none (no vision input on this route).",
  );
export type ImageInputMode = z.infer<typeof ImageInputMode>;
