import { readFile } from "node:fs/promises";
import {
  Attachment,
  ControlResource,
  ModelPayloadRef,
  type ResourceAttachmentRef,
} from "@claudexor/schema";
import type { ResourceStorePort } from "../store-contracts.js";
import { BlobFiles, deleteUnownedInlineInTx, sha256Hex } from "./blob-files.js";
import { runMutation } from "./mutation.js";
import { Obligations, type ObligationRow } from "./obligations.js";
import { PublishBlob } from "./publish-blob.js";
import {
  assertModelRef,
  assertResourceId,
  payloadRef,
  putResourceInTx,
  readResourceRow,
  readUploadRow,
  resourceError,
  resourceSha,
  purposeMismatch,
  verifiedResourceBytes,
} from "./resource-rows.js";
import type { EngineStore } from "./store.js";
import { SqlUploadImports } from "./upload-imports.js";
import type { UploadBindingScan } from "./upload-binding-retention.js";
import { SqlUploads } from "./uploads.js";
import { releaseManagedResource } from "./resource-release.js";
import {
  holdsResourceUse,
  isManagedOrdinary,
  releasedResourceError,
  type ResourceUseHolder,
} from "./resource-uses.js";

/** Resource metadata and replay live in the one engine DB; only immutable bytes are files. */
export class SqlResourceStore implements ResourceStorePort {
  private readonly uploads: SqlUploads;
  private readonly publisher: PublishBlob;
  private readonly imports: SqlUploadImports;
  private readonly cleanup = new Set<Promise<void>>();

  constructor(
    private readonly store: EngineStore,
    private readonly blobs: BlobFiles,
    obligations: Obligations,
    private readonly log: (line: string) => void = console.warn,
  ) {
    this.uploads = new SqlUploads(store, (work) => this.defer(work));
    this.publisher = new PublishBlob(store, blobs, obligations, this.uploads, (work) =>
      this.defer(work),
    );
    this.imports = new SqlUploadImports(store, this.uploads, this.publisher);
  }
  create(raw: unknown, key: string) {
    return this.uploads.create(raw, key);
  }
  status(id: string) {
    return this.uploads.status(id);
  }
  write(id: string, chunks: AsyncIterable<Uint8Array>) {
    return this.uploads.write(id, chunks);
  }
  cancel(id: string) {
    return this.uploads.cancel(id);
  }
  finalize(id: string, expectedSha256: string | undefined, key: string) {
    return this.publisher.finalize(id, expectedSha256, key);
  }
  importUpload(raw: unknown, key: string) {
    return this.imports.import(raw, key);
  }

  /** `heldBy`: the accepted owner reading its own refs (a released ID it holds still resolves). */
  resolve(refs: ResourceAttachmentRef[] | undefined, heldBy?: ResourceUseHolder): Attachment[] {
    return (refs ?? []).map(({ resourceId }) => {
      const resource = this.metadata(resourceId, heldBy);
      if (resource.purpose === "model") throw purposeMismatch();
      const path = this.blobs.filePath(resourceSha(resource));
      verifiedResourceBytes(resource, path);
      return Attachment.parse({
        resource_id: resource.resourceId,
        kind: resource.kind,
        mime: resource.mime,
        name: resource.name,
        sha256: resource.sha256,
        size_bytes: resource.sizeBytes,
        path,
      });
    });
  }

  readModel(raw: ModelPayloadRef): Buffer {
    const ref = ModelPayloadRef.parse(raw);
    const resource = this.metadata(ref.resourceId);
    assertModelRef(resource, ref);
    return verifiedResourceBytes(resource, this.blobs.filePath(resourceSha(resource)));
  }
  async readModelAsync(raw: ModelPayloadRef): Promise<Buffer> {
    const ref = ModelPayloadRef.parse(raw);
    const resource = this.metadata(ref.resourceId);
    assertModelRef(resource, ref);
    return readVerifiedResourceFile(resource, this.blobs.filePath(resourceSha(resource)));
  }
  publishModel(bytes: Uint8Array): ModelPayloadRef {
    const status = this.uploads.create({
      purpose: "model",
      kind: "file",
      mime: "application/json",
      name: "model-result.json",
      sizeBytes: bytes.byteLength,
    });
    try {
      this.uploads.writeAll(status.uploadId, bytes);
      return payloadRef(this.publisher.finalize(status.uploadId, `sha256:${sha256Hex(bytes)}`));
    } catch (error) {
      if (!readUploadRow(this.store, status.uploadId)?.finalization)
        this.uploads.discard(status.uploadId);
      throw error;
    }
  }
  releaseModel(raw: ModelPayloadRef): void {
    this.release(raw, "released");
  }
  /** Caller relinquishes future reuse of a managed ordinary ID; accepted holders keep its bytes. */
  releaseResource(id: string, raw: unknown) {
    const { receipt, sha } = releaseManagedResource(this.store, id, raw);
    if (sha) this.defer(this.blobs.gc(sha));
    return receipt;
  }

  /** Expiry has an observed custody timestamp; callers must not infer it from file mtime. */
  expireModel(raw: ModelPayloadRef, expiredAt: string): void {
    this.release(raw, "expired", expiredAt);
  }

  listModelResources(): Array<ModelPayloadRef & { createdAt: string }> {
    return (
      this.store
        .prepare("SELECT body FROM resource WHERE purpose='model' AND state='ready' ORDER BY id")
        .all() as Array<{ body: Uint8Array }>
    ).map((row) => {
      const resource = ControlResource.parse(JSON.parse(Buffer.from(row.body).toString("utf8")));
      return { ...payloadRef(resource), createdAt: resource.createdAt };
    });
  }
  /** One scan of expired upload bindings in bounded steps; `signal` ends it between steps. */
  pruneUploadBindings(signal?: AbortSignal): Promise<UploadBindingScan> {
    return this.uploads.bindings.prune({ signal });
  }
  onObligationsCleared(rows: readonly ObligationRow[]): void {
    this.publisher.onCleared(rows);
  }

  /** Await this before closing the store; failures are logged and the existing sweep retries residue. */
  async drainCleanup(): Promise<void> {
    while (this.cleanup.size) await Promise.all(this.cleanup);
  }

  private release(raw: ModelPayloadRef, state: "released" | "expired", expiredAt?: string): void {
    const ref = ModelPayloadRef.parse(raw);
    assertResourceId(ref.resourceId);
    const row = readResourceRow(this.store, ref.resourceId);
    if (!row || row.state === "released" || row.state === "expired") return;
    assertModelRef(row.resource, ref);
    const sha = resourceSha(row.resource);
    runMutation(this.store, (tx) => {
      putResourceInTx(tx, {
        ...row,
        state,
        releasedAt: expiredAt ?? tx.now().toISOString(),
        expiresAt: expiredAt ?? row.expiresAt,
      });
      deleteUnownedInlineInTx(tx, sha);
      tx.changes.blobChanged(sha);
    });
    this.defer(this.blobs.gc(sha));
  }
  private metadata(id: string, heldBy?: ResourceUseHolder): ControlResource {
    assertResourceId(id);
    const row = readResourceRow(this.store, id);
    // A released managed ID resolves only for an accepted owner that holds it (its bytes are kept).
    if (row?.state === "released" && isManagedOrdinary(row.resource)) {
      if (!heldBy || !holdsResourceUse(this.store, heldBy, id))
        throw releasedResourceError(id, row.releasedAt);
      return row.resource;
    }
    if (!row || row.state === "released" || row.state === "expired")
      throw resourceError(`no such resource: ${id}`, 404, "resource_not_found");
    if (row.state === "publishing")
      throw resourceError("resource blob is unavailable", 409, "resource_unavailable");
    return row.resource;
  }
  private defer(work: Promise<unknown>): void {
    const pending = work
      .then(
        () => undefined,
        (error: unknown) => {
          this.log(
            `Resource cleanup remains pending: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      )
      .finally(() => this.cleanup.delete(pending));
    this.cleanup.add(pending);
  }
}

/** Same checks as `verifiedResourceBytes`, on the libuv pool. */
async function readVerifiedResourceFile(resource: ControlResource, path: string): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    const code =
      error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (code === "ENOENT")
      throw resourceError("resource blob is unavailable", 409, "resource_unavailable");
    throw error;
  }
  if (bytes.length !== resource.sizeBytes || sha256Hex(bytes) !== resourceSha(resource))
    throw resourceError(
      "resource blob no longer matches finalized bytes",
      409,
      "resource_digest_mismatch",
    );
  return bytes;
}
