import {
  CONTROL_PROTOCOL_MAJOR,
  CONTROL_STORE_IDENTITY_HEADER,
  ControlHandshakeResponse,
  ControlResource,
  ControlUploadStatus,
  McpUploadCreateInput,
  McpUploadFinalizeInput,
  McpUploadImportInput,
  McpUploadImportLocalInput,
  McpUploadImportLocalResult,
  McpUploadTargetInput,
  McpStoreIdentityInput,
} from "@claudexor/schema";
import { connectDaemonIfRunning } from "./daemon-run.js";
import { CliError, controlProblemError, usageError } from "./cli-error.js";
import type { ControlApiAddress } from "./live.js";
import { daemonUnavailableError } from "./mcp-daemon-unavailable.js";
import { openDocumentSource, requireAbsoluteDocumentPath } from "./local-document-source.js";
import { putDocumentSource, responseValue, uploadJson } from "./upload-http.js";
import { importLocalDocument } from "./upload-import.js";

function importFailure(error: unknown, uploadId: string, expectedSha256?: string): CliError {
  const failure =
    error instanceof CliError
      ? error
      : new CliError("operational", error instanceof Error ? error.message : String(error), {
          code:
            typeof (error as { code?: unknown })?.code === "string"
              ? (error as { code: string }).code
              : "upload_import_uncertain",
          retryable: false,
        });
  Object.assign(failure, {
    context: { ...failure.context, uploadId, ...(expectedSha256 ? { expectedSha256 } : {}) },
  });
  return failure;
}

async function importLocal(
  addr: ControlApiAddress,
  input: McpUploadImportLocalInput,
  signal?: AbortSignal,
) {
  const path = `/uploads/${encodeURIComponent(input.uploadId)}`;
  const status = responseValue(ControlUploadStatus, await uploadJson(addr, path, { signal }));
  if (status.uploadId !== input.uploadId) {
    throw controlProblemError(
      502,
      { code: "invalid_response", error: "daemon returned another upload identity" },
      "daemon returned another upload identity",
    );
  }
  // A second call never races or overwrites an uploaded/in-flight part.
  if (status.state === "uploading" || status.state === "cancelled") return status;
  const source = await openDocumentSource(input.path, status.expectedBytes).catch(
    (error: unknown) => {
      throw importFailure(error, input.uploadId);
    },
  );
  try {
    if (status.state === "uploaded") {
      // Recover a lost digest from the explicit source, without a second PUT.
      for await (const _chunk of source.chunks()) {
        signal?.throwIfAborted();
      }
      return McpUploadImportLocalResult.parse({ ...status, expectedSha256: source.expectedSha256 });
    }
    const uploaded = await putDocumentSource(
      addr,
      input.uploadId,
      status.expectedBytes,
      source,
      signal,
    );
    return McpUploadImportLocalResult.parse({ ...uploaded, expectedSha256: source.expectedSha256 });
  } catch (error) {
    // Unknown outcomes stay caller-owned: no cancellation, retry or finalize.
    throw importFailure(error, input.uploadId, source.expectedSha256);
  } finally {
    await source.close();
  }
}

async function runningDaemon(): Promise<ControlApiAddress> {
  const connection = await connectDaemonIfRunning();
  if (!connection) throw daemonUnavailableError(false, "upload controls do not start one");
  return connection.addr;
}

/** The existing opt-in handshake is the only owner of the store UUID. */
async function storeIdentity(_input: McpStoreIdentityInput, signal?: AbortSignal) {
  const identity = await uploadJson(await runningDaemon(), "/handshake", {
    method: "POST",
    headers: { "content-type": "application/json", [CONTROL_STORE_IDENTITY_HEADER]: "1" },
    body: JSON.stringify({ protocolMajor: CONTROL_PROTOCOL_MAJOR, client: "claudexor-cli" }),
    signal,
  });
  return responseValue(ControlHandshakeResponse, identity);
}

/** One requested operation; no second state owner, journal or lifecycle retries. */
export async function uploadQuery(
  action: string,
  raw: Record<string, unknown>,
  beltContext = false,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (beltContext)
    throw Object.assign(new Error("the delegation belt cannot access upload controls"), {
      code: "delegation_forbidden",
      status: 403,
    });
  const input =
    action === "create"
      ? McpUploadCreateInput.parse(raw)
      : action === "finalize"
        ? McpUploadFinalizeInput.parse(raw)
        : action === "import_local"
          ? McpUploadImportLocalInput.parse(raw)
          : action === "import"
            ? McpUploadImportInput.parse(raw)
            : action === "status" || action === "cancel"
              ? McpUploadTargetInput.parse(raw)
              : undefined;
  if (action === "store_identity") return storeIdentity(McpStoreIdentityInput.parse(raw), signal);
  if (!input) throw usageError("unknown upload action", { code: "invalid_argument" });
  if (action === "import_local" || action === "import")
    requireAbsoluteDocumentPath((input as { path: string }).path);
  const addr = await runningDaemon();
  if (action === "import_local")
    return importLocal(addr, input as McpUploadImportLocalInput, signal);
  if (action === "import") return importLocalDocument(addr, input as McpUploadImportInput, signal);
  const path = "uploadId" in input ? `/uploads/${encodeURIComponent(input.uploadId)}` : "/uploads";
  const mutation = action === "create" || action === "finalize";
  const result = await uploadJson(addr, `${path}${action === "finalize" ? "/finalize" : ""}`, {
    method: mutation ? "POST" : action === "cancel" ? "DELETE" : "GET",
    ...(mutation && "request" in input
      ? {
          headers: { "content-type": "application/json", "Idempotency-Key": input.idempotencyKey },
          body: JSON.stringify(input.request),
        }
      : {}),
    signal,
  });
  return action === "finalize"
    ? responseValue(ControlResource, result)
    : responseValue(ControlUploadStatus, result);
}
