import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { ControlUploadStatus } from "@claudexor/schema";
import { CliError, controlProblemError } from "./cli-error.js";
import { controlApiFetch, type ControlApiAddress } from "./live.js";
import type { openDocumentSource } from "./local-document-source.js";

type DocumentSource = Awaited<ReturnType<typeof openDocumentSource>>;

export function responseValue<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch {
    throw controlProblemError(
      502,
      { code: "invalid_response", error: "daemon returned an invalid upload response" },
      "daemon returned an invalid upload response",
    );
  }
}

export async function uploadJson(
  addr: ControlApiAddress,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await controlApiFetch(addr, path, init);
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok)
    throw controlProblemError(
      response.status,
      body,
      `upload request failed (HTTP ${response.status})`,
    );
  return body;
}

/** One PUT of an opened source; a source failure wins over the transport error it caused. */
export async function putDocumentSource(
  addr: ControlApiAddress,
  uploadId: string,
  expectedBytes: number,
  source: DocumentSource,
  signal?: AbortSignal,
): Promise<ControlUploadStatus> {
  let sourceFailure: unknown;
  const body = Readable.from(
    (async function* () {
      try {
        yield* source.chunks();
      } catch (error) {
        sourceFailure = error;
        throw error;
      }
    })(),
  );
  // Observe source failures even when a peer rejects before reading the body.
  const settled = finished(body).catch((error: unknown) => error);
  try {
    const result = await uploadJson(addr, `/uploads/${encodeURIComponent(uploadId)}/bytes`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: Readable.toWeb(body) as unknown as RequestInit["body"],
      duplex: "half",
      signal,
    } as RequestInit & { duplex: "half" });
    if (!source.expectedSha256) {
      body.destroy();
      const error = await settled;
      throw error instanceof Error
        ? error
        : new Error("upload response arrived before the local source was verified");
    }
    const uploaded = responseValue(ControlUploadStatus, result);
    if (
      uploaded.uploadId !== uploadId ||
      uploaded.state !== "uploaded" ||
      uploaded.receivedBytes !== expectedBytes ||
      uploaded.expectedBytes !== expectedBytes
    ) {
      throw controlProblemError(
        502,
        { code: "invalid_response", error: "daemon returned inconsistent upload status" },
        "daemon returned inconsistent upload status",
      );
    }
    return uploaded;
  } catch (error) {
    if (!(error instanceof CliError) && sourceFailure) throw sourceFailure;
    throw error;
  } finally {
    body.destroy();
    await finished(body).catch(() => undefined);
  }
}
