import { z } from "zod";
import { Id } from "./primitives.js";

/**
 * A user- or agent-provided file/image attached to a turn. `path` is the
 * resolved on-disk location in the scoped attachment store (kept OUTSIDE any
 * worktree so `git add -A` cannot capture it); an adapter reads bytes from
 * there to forward to its harness in that harness's native shape.
 */
export const AttachmentKind = z.enum(["image", "file"]);
export type AttachmentKind = z.infer<typeof AttachmentKind>;

export const Attachment = z.object({
  id: Id,
  kind: AttachmentKind.default("file"),
  mime: z.string().default("application/octet-stream"),
  name: z.string().default(""),
  /** Resolved local path in the scoped attachment store. */
  path: z.string(),
});
export type Attachment = z.infer<typeof Attachment>;

/**
 * Inbound attachment on a control request. Thread/composer uploads may arrive
 * base64-inline (`data`) for a fresh upload; direct non-thread run enqueue
 * accepts only non-empty absolute existing file paths so bytes cannot persist in
 * the daemon job registry. The daemon/turn store resolves inbound bytes to a
 * durable {@link Attachment}. Exactly one of `data` / `path` is expected; both
 * null is rejected by the resolver (fail loud, never a silent empty attachment).
 */
export const AttachmentInput = z.object({
  kind: AttachmentKind.default("file"),
  mime: z.string().default("application/octet-stream"),
  name: z.string().default(""),
  data: z.string().nullable().default(null),
  path: z.string().nullable().default(null),
});
export type AttachmentInput = z.infer<typeof AttachmentInput>;

/**
 * How a harness accepts image input, declared by its adapter manifest and used
 * for honest UI gating + per-adapter serialization (never a normalized wire
 * format): `file_path` (codex `-i`), `base64_stream` (claude stream-json image
 * block), `base64_inline` (raw-api `image_url` data URL), or `none` (cursor /
 * opencode — image attachments are disabled/routed to a vision-capable harness
 * rather than silently dropped; generic file attachments still use Attachment).
 */
export const ImageInputMode = z.enum(["file_path", "base64_stream", "base64_inline", "none"]);
export type ImageInputMode = z.infer<typeof ImageInputMode>;
