import {
  ControlUploadImport,
  ControlUploadImportRequest,
  type ControlUploadImportContent,
} from "@claudexor/schema";
import { hashJson } from "@claudexor/util";
import type { PublishBlob } from "./publish-blob.js";
import { readResourceRow, readUploadRow, resourceError, type UploadRow } from "./resource-rows.js";
import type { EngineStore } from "./store.js";
import { uploadKeyDigest } from "./upload-binding-retention.js";
import type { SqlUploads } from "./uploads.js";

/** A failed check of already received bytes means they were never a usable receipt. */
const UNVERIFIABLE = new Set(["digest_mismatch", "upload_size_mismatch"]);

/**
 * Keyed import over the existing upload owner. The key binds the semantic request,
 * its first declaration binds the content, and every replay is answered from the
 * store before a client needs its source again.
 */
export class SqlUploadImports {
  constructor(
    private readonly store: EngineStore,
    private readonly uploads: SqlUploads,
    private readonly publisher: PublishBlob,
  ) {}

  import(raw: unknown, key: string): ControlUploadImport {
    const { expectedStoreId, content, ...request } = ControlUploadImportRequest.parse(raw);
    // The store check precedes every lookup and effect; replay never adopts another store.
    const storeId = this.store.storeId;
    if (!storeId)
      throw resourceError(
        "durable store identity is unavailable",
        503,
        "upload_import_unavailable",
      );
    if (expectedStoreId !== storeId)
      throw resourceError("this import names another durable store", 409, "store_mismatch");
    const requestDigest = hashJson({ ...request, source: request.source ?? null });
    const bound = this.uploads.bindings.lookup("import", key, requestDigest);
    if (!bound) {
      if (!content)
        throw resourceError(
          "this store retains no import for this key; declare content to begin one",
          404,
          "upload_import_not_found",
        );
      const { uploadId } = this.uploads.createImport(
        {
          kind: request.kind,
          mime: request.mime,
          name: request.name,
          sizeBytes: content.sizeBytes,
        },
        { keyDigest: uploadKeyDigest("import", key), sha256: content.sha256 },
        requestDigest,
      );
      return this.project(storeId, this.row(uploadId));
    }
    const row = this.row(bound.targetId);
    const owned = boundContent(row);
    if (content && (content.sizeBytes !== owned.sizeBytes || content.sha256 !== owned.sha256))
      throw Object.assign(
        resourceError(
          "this import key already owns other content; a new edition needs a new key",
          409,
          "upload_import_content_conflict",
        ),
        { context: { uploadId: row.status.uploadId, content: owned } },
      );
    return this.project(storeId, this.complete(row));
  }

  /** Publish verified bytes now, so a replay needs neither the source nor a client digest. */
  private complete(row: UploadRow): UploadRow {
    if (row.state !== "uploaded" && row.state !== "finalizing") return row;
    try {
      this.publisher.publishImport(row);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (row.state === "uploaded" && typeof code === "string" && UNVERIFIABLE.has(code))
        this.uploads.reopen(row.status.uploadId);
      throw error;
    }
    return this.row(row.status.uploadId);
  }

  private project(storeId: string, row: UploadRow): ControlUploadImport {
    const base = {
      storeId,
      uploadId: row.status.uploadId,
      content: boundContent(row),
      receivedBytes: row.status.receivedBytes,
    };
    if (row.state === "discarded")
      return ControlUploadImport.parse({ ...base, state: "cancelled" });
    if (row.state !== "published")
      return ControlUploadImport.parse({
        ...base,
        state: row.status.state === "uploading" ? "uploading" : "open",
      });
    const resource = row.finalization!.result;
    // Ordinary attachment resources are never released today; an absent row is not "ready".
    if (readResourceRow(this.store, resource.resourceId)?.state !== "ready")
      throw resourceError(`no such resource: ${resource.resourceId}`, 404, "resource_not_found");
    return ControlUploadImport.parse({ ...base, state: "ready", resource });
  }

  private row(uploadId: string): UploadRow {
    const row = readUploadRow(this.store, uploadId);
    // A retained import binding always keeps its upload row; anything else is store damage.
    if (!row?.import)
      throw resourceError(
        `import upload ${uploadId} is missing for a retained binding`,
        500,
        "upload_import_binding_invalid",
      );
    return row;
  }
}

function boundContent(row: UploadRow): ControlUploadImportContent {
  return { sizeBytes: row.request.sizeBytes, sha256: row.import!.sha256 };
}
