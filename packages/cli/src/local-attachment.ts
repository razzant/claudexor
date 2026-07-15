import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

export interface LocalAttachment {
  kind: "image" | "file";
  mime: string;
  name: string;
  path: string;
  sizeBytes: number;
  device: number;
  inode: number;
}

function mimeFor(path: string): { mime: string; image: boolean } {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return { mime: "image/png", image: true };
    case ".jpg":
    case ".jpeg":
      return { mime: "image/jpeg", image: true };
    case ".gif":
      return { mime: "image/gif", image: true };
    case ".webp":
      return { mime: "image/webp", image: true };
    case ".txt":
      return { mime: "text/plain", image: false };
    case ".md":
    case ".markdown":
      return { mime: "text/markdown", image: false };
    case ".json":
      return { mime: "application/json", image: false };
    default:
      return { mime: "application/octet-stream", image: false };
  }
}

/** Snapshot source metadata; the caller immediately streams bytes to the daemon. */
export function resolveLocalAttachment(path: string, forceImage: boolean): LocalAttachment {
  const resolved = resolve(path);
  let stat;
  try {
    stat = lstatSync(resolved);
  } catch {
    throw new Error(`attachment must be an existing file: ${path}`);
  }
  if (!stat.isFile()) throw new Error(`attachment must be a regular non-symlink file: ${path}`);
  const detected = mimeFor(resolved);
  return {
    kind: forceImage || detected.image ? "image" : "file",
    mime: detected.mime,
    name: basename(resolved),
    path: resolved,
    sizeBytes: stat.size,
    device: stat.dev,
    inode: stat.ino,
  };
}

/** Open the exact file identity that was selected, without following a swapped symlink. */
export function openLocalAttachment(attachment: LocalAttachment): number {
  let fd: number;
  try {
    fd = openSync(attachment.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error(`attachment changed before upload: ${attachment.path}`);
  }
  const stat = fstatSync(fd);
  if (
    !stat.isFile() ||
    stat.dev !== attachment.device ||
    stat.ino !== attachment.inode ||
    stat.size !== attachment.sizeBytes
  ) {
    closeSync(fd);
    throw new Error(`attachment changed before upload: ${attachment.path}`);
  }
  return fd;
}
