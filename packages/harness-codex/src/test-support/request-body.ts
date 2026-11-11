import { zstdDecompressSync } from "node:zlib";

/** The JSON text of an inference request as a test's fetch receives it: the
 * body bytes with their content encoding undone. */
export async function requestBodyText(init: RequestInit | undefined): Promise<string> {
  const bytes = Buffer.from(await new Response(init?.body ?? null).arrayBuffer());
  const encoding = new Headers(init?.headers).get("content-encoding");
  if (encoding === null) return bytes.toString("utf8");
  if (encoding !== "zstd") throw new Error(`unexpected request content encoding: ${encoding}`);
  return zstdDecompressSync(bytes).toString("utf8");
}
