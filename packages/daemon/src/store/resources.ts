import {
  Attachment,
  ControlResource,
  ModelPayloadRef,
  type ResourceAttachmentRef,
} from "@claudexor/schema";
import { newId, sensitiveResourcePolicy } from "@claudexor/util";
import type { ResourceStorePort } from "../store-contracts.js";
import { BlobFiles, deleteUnownedInlineInTx, sha256Hex } from "./blob-files.js";
import { runMutation } from "./mutation.js";
import { Obligations, type ObligationRow } from "./obligations.js";
import { PublishBlob } from "./publish-blob.js";
import {
  assertContentAllowed,
  assertModelRef,
  assertResourceId,
  payloadRef,
  putResourceInTx,
  readResourceRow,
  readUploadRow,
  resourceError,
  resourceSha,
  purposeMismatch,
  sensitiveResourceError,
  verifiedResourceBytes,
} from "./resource-rows.js";
import type { EngineStore } from "./store.js";
import { SqlUploads } from "./uploads.js";

/** Resource metadata and replay live in the one engine DB; only immutable bytes are files. */
export class SqlResourceStore implements ResourceStorePort {
  private readonly uploads: SqlUploads;
  private readonly publisher: PublishBlob;
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

  resolve(refs: ResourceAttachmentRef[] | undefined): Attachment[] {
    return (refs ?? []).map(({ resourceId }) => {
      const resource = this.metadata(resourceId);
      if (resource.purpose === "model") throw purposeMismatch();
      const path = this.blobs.filePath(resourceSha(resource));
      const bytes = verifiedResourceBytes(resource, path);
      if (sensitiveResourcePolicy.classifyPath(resource.name).sensitive)
        throw sensitiveResourceError();
      assertContentAllowed(resource, bytes);
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
  publishModel(bytes: Uint8Array): ModelPayloadRef {
    const status = this.create(
      {
        purpose: "model",
        kind: "file",
        mime: "application/json",
        name: "model-result.json",
        sizeBytes: bytes.byteLength,
      },
      newId("model-create"),
    );
    try {
      this.uploads.writeAll(status.uploadId, bytes);
      return payloadRef(
        this.finalize(status.uploadId, `sha256:${sha256Hex(bytes)}`, newId("model-finalize")),
      );
    } catch (error) {
      if (!readUploadRow(this.store, status.uploadId)?.finalization)
        this.uploads.discard(status.uploadId);
      throw error;
    }
  }
  releaseModel(raw: ModelPayloadRef): void {
    this.release(raw, "released");
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
  pruneUploadBindings(): number {
    return this.uploads.bindings.prune();
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
  private metadata(id: string): ControlResource {
    assertResourceId(id);
    const row = readResourceRow(this.store, id);
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
