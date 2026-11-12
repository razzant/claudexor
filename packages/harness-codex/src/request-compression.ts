import { promisify } from "node:util";
import { constants, zstdCompress } from "node:zlib";

/** `off` (or `0`, `false`, `no`) sends the inference request body as plain
 * JSON. An operator's switch for a provider that stops accepting compressed
 * requests, typed in an outage; anything else, and no value, keeps compression
 * on. */
export const CODEX_REQUEST_COMPRESSION_ENV = "CLAUDEXOR_CODEX_REQUEST_COMPRESSION";
const OFF = new Set(["off", "0", "false", "no"]);

export function codexRequestCompression(env: NodeJS.ProcessEnv = process.env): boolean {
  return !OFF.has(env[CODEX_REQUEST_COMPRESSION_ENV]?.trim().toLowerCase() ?? "");
}

const compress = promisify(zstdCompress);

/** The body as it is sent: zstd at the level the vendor's own client uses for
 * this endpoint, or the plain bytes. Compression runs off the event loop. */
export async function encodeRequestBody(
  plain: Buffer,
  compressed: boolean,
): Promise<{ bytes: Buffer; contentEncoding: "zstd" | null }> {
  if (!compressed) return { bytes: plain, contentEncoding: null };
  const bytes = await compress(plain, { params: { [constants.ZSTD_c_compressionLevel]: 3 } });
  return { bytes, contentEncoding: "zstd" };
}
