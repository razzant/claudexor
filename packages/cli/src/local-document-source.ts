import { createHash } from "node:crypto";
import { constants, lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { sensitiveResourcePolicy } from "@claudexor/util";
import { resolveLocalAttachment } from "./local-attachment.js";
import { usageError } from "./cli-error.js";

function sourceChanged(): Error {
  return Object.assign(
    new Error("local attachment source changed during import; do not finalize these bytes"),
    {
      code: "attachment_source_changed",
      retryable: false,
    },
  );
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return (
    b.isFile() &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

export function requireAbsoluteDocumentPath(path: string): void {
  if (!isAbsolute(path))
    throw usageError("path must be an explicit absolute file on the MCP-server host", {
      code: "invalid_argument",
    });
}

/** Ingress-only descriptor owner; the ordinary CLI uploader is unchanged. */
export async function openDocumentSource(path: string, expectedBytes: number) {
  requireAbsoluteDocumentPath(path);
  const canonical = realpathSync(path);
  for (const candidate of [path, canonical]) {
    if (sensitiveResourcePolicy.classifyPath(candidate).sensitive) {
      throw Object.assign(new Error("sensitive local attachment path rejected"), {
        code: "sensitive_resource_rejected",
        retryable: false,
      });
    }
  }
  // Reuse ordinary attachment selection and its regular-file/no-symlink checks.
  const snapshot = lstatSync(path, { bigint: true });
  const selected = resolveLocalAttachment(path, false);
  if (selected.sizeBytes !== expectedBytes)
    throw usageError("local file size differs from the upload's expectedBytes", {
      code: "attachment_size_mismatch",
    });
  // NONBLOCK also prevents a raced FIFO replacement from hanging before fstat.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (realpathSync(path) !== canonical || !sameFile(before, lstatSync(path, { bigint: true })))
      throw sourceChanged();
    if (!sameFile(snapshot, before) || before.size !== BigInt(expectedBytes)) throw sourceChanged();
    let digest: string | undefined;
    let consumed = false;
    return {
      fd: handle.fd,
      get expectedSha256() {
        return digest;
      },
      async *chunks(): AsyncGenerator<Buffer> {
        if (consumed) throw sourceChanged();
        consumed = true;
        const hash = createHash("sha256");
        let received = 0;
        while (true) {
          // Read at most admitted bytes + one sentinel, with bounded memory.
          const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, expectedBytes - received + 1));
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
          if (bytesRead === 0) break;
          received += bytesRead;
          if (received > expectedBytes) throw sourceChanged();
          const bytes = chunk.subarray(0, bytesRead);
          hash.update(bytes);
          yield bytes;
        }
        const after = await handle.stat({ bigint: true });
        let named: BigIntStats;
        try {
          named = lstatSync(path, { bigint: true });
          if (realpathSync(path) !== canonical) throw sourceChanged();
        } catch {
          throw sourceChanged();
        }
        if (received !== expectedBytes || !sameFile(before, after) || !sameFile(before, named))
          throw sourceChanged();
        digest = `sha256:${hash.digest("hex")}`;
      },
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
