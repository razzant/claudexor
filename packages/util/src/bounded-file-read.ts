import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/** A synchronous, allocation-bounded read of a regular immutable artifact.
 * Refuse oversized evidence before decoding; never turn a limit into absence. */
export function readFileUtf8BoundedSync(path: string, maxBytes: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("artifact is not a regular file");
    if (stat.size > maxBytes)
      throw Object.assign(new Error("artifact exceeds its bounded read allowance"), {
        code: "artifact_read_limit",
        status: 503,
        retryable: false,
      });
    const bytes = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length !== stat.size)
      throw Object.assign(new Error("artifact changed during bounded read"), {
        code: "artifact_read_changed",
        status: 503,
        retryable: true,
      });
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, length),
    );
  } finally {
    closeSync(fd);
  }
}
