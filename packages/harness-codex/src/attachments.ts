import { readVerifiedAttachmentBytes } from "@claudexor/core";
import type { HarnessRunSpec } from "@claudexor/schema";

/** Convert verified image resources to Codex's repeatable file-path arguments. */
export function codexImageArgs(attachments: HarnessRunSpec["attachments"] | undefined): string[] {
  return (attachments ?? []).flatMap((attachment) => {
    if (attachment.kind !== "image") return [];
    readVerifiedAttachmentBytes(attachment);
    return ["-i", attachment.path];
  });
}
