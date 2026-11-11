import { basename, resolve } from "node:path";
import {
  ControlUploadImport,
  type ControlUploadImportContent,
  type ControlUploadImportRequest,
  type McpUploadImportInput,
} from "@claudexor/schema";
import { sensitiveResourcePolicy } from "@claudexor/util";
import { CliError } from "./cli-error.js";
import type { ControlApiAddress } from "./live.js";
import { attachmentTypeFor, resolveLocalAttachment } from "./local-attachment.js";
import { openDocumentSource } from "./local-document-source.js";
import { putDocumentSource, responseValue, uploadJson } from "./upload-http.js";

const SOURCE_CHANGED = new Set(["attachment_source_changed", "attachment_size_mismatch"]);

function importContext(state: ControlUploadImport | undefined): Record<string, unknown> {
  return state ? { uploadId: state.uploadId, state: state.state, content: state.content } : {};
}

function importError(
  code: string,
  message: string,
  state: ControlUploadImport | undefined,
  retryable = false,
): CliError {
  return new CliError("operational", message, { code, retryable, context: importContext(state) });
}

/** Source problems keep the bound import identity so the caller can decide honestly. */
function sourceFailure(error: unknown, state: ControlUploadImport | undefined): unknown {
  if (error instanceof Error && error.name === "AbortError") return error;
  const code = (error as { code?: unknown } | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "sensitive_resource_rejected") return importError(code, message, state);
  if (typeof code === "string" && SOURCE_CHANGED.has(code))
    return importError(
      "upload_import_source_changed",
      `${message}; the import keeps its key, and a new edition needs a new key`,
      state,
    );
  return importError("upload_import_source_unavailable", message, state);
}

/** Daemon refusals keep their typed code plus the import identity; a call without an answer is uncertain. */
function callFailure(error: unknown, state: ControlUploadImport | undefined): unknown {
  if (error instanceof CliError) {
    return Object.assign(error, { context: { ...error.context, ...importContext(state) } });
  }
  if (error instanceof Error && error.name === "AbortError") return error;
  const message = error instanceof Error ? error.message : String(error);
  return importError("upload_import_uncertain", message, state, true);
}

/** A successful one-call import always returns a ready resource. */
function settled(state: ControlUploadImport): ControlUploadImport {
  if (state.state === "ready") return state;
  if (state.state === "cancelled")
    throw importError(
      "upload_import_cancelled",
      "this import ended without a resource; a new attempt needs a new key",
      state,
    );
  if (state.state === "released")
    throw importError(
      "upload_import_released",
      "this import's managed resource was released and admits no new reference; a new attachment needs a new key",
      state,
    );
  throw state.state === "uploading"
    ? importError(
        "upload_import_in_progress",
        "another transfer for this import is in flight; repeat the identical call later",
        state,
        true,
      )
    : importError(
        "upload_import_incomplete",
        "this import has no verified bytes yet; repeat the identical call",
        state,
        true,
      );
}

async function readContent(
  path: string,
  state: ControlUploadImport | undefined,
  signal?: AbortSignal,
): Promise<ControlUploadImportContent> {
  try {
    const { sizeBytes } = resolveLocalAttachment(path, false);
    const source = await openDocumentSource(path, sizeBytes);
    try {
      for await (const _chunk of source.chunks()) signal?.throwIfAborted();
      return { sizeBytes, sha256: source.expectedSha256! };
    } finally {
      await source.close();
    }
  } catch (error) {
    throw sourceFailure(error, state);
  }
}

async function sendBytes(
  addr: ControlApiAddress,
  state: ControlUploadImport,
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  let source: Awaited<ReturnType<typeof openDocumentSource>>;
  try {
    source = await openDocumentSource(path, state.content.sizeBytes);
  } catch (error) {
    throw sourceFailure(error, state);
  }
  try {
    // The daemon verifies these bytes against the digest the import key owns.
    await putDocumentSource(addr, state.uploadId, state.content.sizeBytes, source, signal);
  } catch (error) {
    const code = (error as { code?: unknown } | undefined)?.code;
    const fromSource =
      !(error instanceof CliError) &&
      (typeof code === "string" || (error as NodeJS.ErrnoException)?.syscall !== undefined);
    throw fromSource ? sourceFailure(error, state) : callFailure(error, state);
  } finally {
    await source.close();
  }
}

/**
 * One keyed import of a file on this host. A replay is answered before the
 * source is touched; the source is read only while the import is unfinished.
 */
export async function importLocalDocument(
  addr: ControlApiAddress,
  input: McpUploadImportInput,
  signal?: AbortSignal,
): Promise<ControlUploadImport> {
  const path = resolve(input.path);
  // String-only checks precede every filesystem and network access.
  if (sensitiveResourcePolicy.classifyPath(path).sensitive)
    throw importError(
      "sensitive_resource_rejected",
      "sensitive local attachment path rejected",
      undefined,
    );
  const mime = input.mime ?? attachmentTypeFor(path).mime;
  const request: ControlUploadImportRequest = {
    // The daemon refuses another store first, before this client touches the file.
    expectedStoreId: input.expectedStoreId,
    kind: input.kind ?? (mime.startsWith("image/") ? "image" : "file"),
    mime,
    name: input.name ?? basename(path),
    source: path,
  };
  const post = async (content?: ControlUploadImportContent, known?: ControlUploadImport) => {
    try {
      const body = await uploadJson(addr, "/uploads/imports", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": input.idempotencyKey },
        body: JSON.stringify(content ? { ...request, content } : request),
        signal,
      });
      return responseValue(ControlUploadImport, body);
    } catch (error) {
      throw callFailure(error, known);
    }
  };
  let state = await post().catch((error: unknown) => {
    if ((error as { code?: unknown }).code === "upload_import_not_found") return undefined;
    throw error;
  });
  if (state && state.state !== "open") return settled(state);
  const content = await readContent(path, state, signal);
  if (
    state &&
    (state.content.sizeBytes !== content.sizeBytes || state.content.sha256 !== content.sha256)
  )
    throw importError(
      "upload_import_source_changed",
      "the source no longer matches the content this import key owns; a new edition needs a new key",
      state,
    );
  state ??= await post(content);
  if (state.state === "open") {
    await sendBytes(addr, state, path, signal);
    state = await post(content, state);
  }
  return settled(state);
}
