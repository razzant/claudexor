import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { daemonDir } from "@claudexor/daemon";
import { newId } from "@claudexor/util";
import type { Attachment, AttachmentInput } from "@claudexor/schema";

/** Filename allowlist (no regex governance): keep only safe chars for the stored name. */
function safeAttachmentName(name: string): string {
  const allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-";
  let s = "";
  for (const ch of name) s += allowed.includes(ch) ? ch : "_";
  return (s || "attachment").slice(0, 120);
}

export function attachmentError(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}

function decodeBase64AttachmentData(data: string, index: number): Buffer {
  const normalized = data.replaceAll("\r", "").replaceAll("\n", "");
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== normalized) {
    throw attachmentError(`attachment ${index} data must be non-empty valid base64`);
  }
  return decoded;
}

/**
 * Resolve inbound attachments (base64 `data`, or an existing `path`) to durable
 * Attachments under a scoped dir OUTSIDE any worktree, so they never enter a git
 * diff. base64 is decoded ONCE here and the command journal never carries the bytes.
 */
export function resolveAttachments(inputs: AttachmentInput[] | undefined): Attachment[] {
  if (!inputs || inputs.length === 0) return [];
  const dir = join(daemonDir(), "attachments", newId("attb"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out: Attachment[] = [];
  for (const [index, a] of inputs.entries()) {
    const hasData = typeof a.data === "string" && a.data.length > 0;
    const attachmentPath = typeof a.path === "string" ? a.path.trim() : "";
    const hasPath = attachmentPath.length > 0;
    if (hasData && hasPath) {
      throw attachmentError(`attachment ${index} must include either data or path, not both`);
    }
    if (hasData) {
      const path = join(dir, `${newId("f")}-${safeAttachmentName(a.name)}`);
      writeFileSync(path, decodeBase64AttachmentData(a.data ?? "", index), { mode: 0o600 });
      out.push({ id: newId("att"), kind: a.kind, mime: a.mime, name: a.name, path });
      continue;
    }
    if (!hasPath) {
      throw attachmentError(`attachment ${index} must include data or an absolute file path`);
    }
    if (!isAbsolute(attachmentPath)) {
      throw attachmentError(`attachment ${index} path must be absolute: ${attachmentPath}`);
    }
    if (!existsSync(attachmentPath) || !lstatSync(attachmentPath).isFile()) {
      throw attachmentError(
        `attachment ${index} path does not exist or is not a file: ${attachmentPath}`,
      );
    }
    out.push({ id: newId("att"), kind: a.kind, mime: a.mime, name: a.name, path: attachmentPath });
  }
  return out;
}
