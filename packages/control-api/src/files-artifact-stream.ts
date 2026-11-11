import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { safeArtifactPath } from "./artifact-paths.js";
import { readFilesWorkProduct } from "./files-work-product.js";

/** A plain immutable-manifest address, safe to return from the bulk executor.
 * The open handle and stream remain owned by the serving request. */
export interface FilesArtifactTransfer {
  path: string;
  expectedHash: string;
  expectedSize: number;
  contentType: string;
}

/** Manifest parsing and its digest can grow with the result. Resolve them in a
 * finite bulk job; never hold the worker for a client-bound transfer. */
export function locateFilesArtifact(
  runDir: string,
  relative: string,
): FilesArtifactTransfer | null {
  const product = readFilesWorkProduct({ runDir });
  if (!product) return null;
  const state = product.manifest.entries
    .flatMap((entry) => [entry.before, entry.after])
    .find((item) => item !== "unknown" && item?.kind === "file" && item.artifactPath === relative);
  const manifest = relative === product.manifestPath;
  if (!manifest && (!state || state === "unknown" || state.kind !== "file")) return null;
  const path = safeArtifactPath(product.artifactRoot, relative);
  if (!path) throw new Error("Files artifact is unavailable");
  const file = state && state !== "unknown" && state.kind === "file" ? state : null;
  const expectedHash = manifest ? product.manifestSha256 : file?.sha256;
  if (!expectedHash) throw new Error("Files artifact has no immutable digest");
  return {
    path,
    expectedHash,
    expectedSize: manifest ? Buffer.byteLength(product.text) : (file?.sizeBytes ?? -1),
    contentType: manifest ? "application/json" : "application/octet-stream",
  };
}

/** Full output transfer uses the existing artifact endpoint and immutable result
 * manifest; bounded text previews remain a separate representation. */
export async function streamFilesArtifact(
  transfer: FilesArtifactTransfer,
  res: ServerResponse,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const handle = await open(transfer.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Files artifact is not a regular file");
    const { expectedHash, expectedSize } = transfer;
    if (stat.size !== expectedSize) throw new Error("Files artifact size mismatch");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      signal?.throwIfAborted();
      hash.update(chunk);
    }
    if (`sha256:${hash.digest("hex")}` !== expectedHash)
      throw new Error("Files artifact digest mismatch");
    signal?.throwIfAborted();
    res.writeHead(200, {
      "Content-Type": transfer.contentType,
      "Content-Length": expectedSize,
      ETag: `"${expectedHash}"`,
    });
    await pipeline(handle.createReadStream({ start: 0, autoClose: false }), res, { signal });
  } finally {
    await handle.close();
  }
}
