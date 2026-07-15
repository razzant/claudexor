import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Attachment } from "@claudexor/schema";

/** Read once and bind the adapter payload to the finalized daemon resource digest. */
export function readVerifiedAttachmentBytes(attachment: Attachment): Buffer {
  const bytes = readFileSync(attachment.path);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (bytes.length !== attachment.size_bytes || digest !== attachment.sha256) {
    throw Object.assign(
      new Error(`attachment bytes no longer match resource ${attachment.resource_id}`),
      { code: "attachment_digest_mismatch" },
    );
  }
  return bytes;
}
