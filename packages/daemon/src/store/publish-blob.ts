import { existsSync, readFileSync } from "node:fs";
import { ControlResource } from "@claudexor/schema";
import { hashJson, newId } from "@claudexor/util";
import { BlobFiles, sha256Hex } from "./blob-files.js";
import { bindIdempotencyInTx } from "./idempotency.js";
import { runMutation } from "./mutation.js";
import { Obligations, type ObligationEffects, type ObligationRow } from "./obligations.js";
import {
  assertContentAllowed,
  putResourceInTx,
  putUploadInTx,
  readResourceRow,
  readUploadRow,
  resourceError,
  resourceSha,
  verifiedResourceBytes,
  type UploadRow,
} from "./resource-rows.js";
import type { EngineStore } from "./store.js";
import { uploadKeyDigest } from "./upload-binding-retention.js";
import { SqlUploads } from "./uploads.js";

/** One publication identity across tx1, link, tx2, restart and exact replay. */
export class PublishBlob {
  constructor(
    private readonly store: EngineStore,
    private readonly blobs: BlobFiles,
    private readonly obligations: Obligations,
    private readonly uploads: SqlUploads,
    private readonly defer: (work: Promise<unknown>) => void,
  ) {
    obligations.registerHandler("publish_blob", (row, effects) => this.recover(row, effects));
  }

  finalize(id: string, expectedSha256: string | undefined, key: string): ControlResource {
    const requestDigest = hashJson({ uploadId: id, expectedSha256: expectedSha256 ?? null });
    const prior = this.uploads.bindings.lookup("finalize", key, requestDigest, id);
    if (prior) {
      const row = readUploadRow(this.store, id);
      if (row?.state === "finalizing") this.complete(row);
      return ControlResource.parse(prior.result);
    }
    const upload = this.uploads.get(id);
    const keyDigest = uploadKeyDigest("finalize", key);
    if (upload.finalization) {
      if (
        upload.finalization.keyDigest !== keyDigest ||
        upload.finalization.requestDigest !== requestDigest
      )
        throw resourceError(
          "idempotency key was already used with a different request",
          409,
          "idempotency_conflict",
        );
      return this.complete(upload);
    }
    if (upload.status.state !== "uploaded")
      throw resourceError(`upload ${id} is ${upload.status.state}`, 409, "upload_not_uploaded");
    const bytes = readFileSync(this.uploads.partPath(id));
    if (bytes.length !== upload.status.expectedBytes)
      throw resourceError(
        "uploaded file no longer matches declared size",
        409,
        "upload_size_mismatch",
      );
    try {
      assertContentAllowed(upload.request, bytes);
    } catch (error) {
      this.uploads.cancel(id);
      throw error;
    }
    const sha = sha256Hex(bytes);
    if (expectedSha256 !== undefined && expectedSha256 !== `sha256:${sha}`)
      throw resourceError(
        "uploaded byte digest does not match expectedSha256",
        409,
        "digest_mismatch",
      );
    const resource = ControlResource.parse({
      resourceId: newId("res"),
      ...(upload.request.purpose ? { purpose: upload.request.purpose } : {}),
      kind: upload.request.kind,
      mime: upload.request.mime,
      name: upload.request.name,
      sha256: `sha256:${sha}`,
      sizeBytes: bytes.length,
      createdAt: this.store.now().toISOString(),
      deduplicated: existsSync(this.blobs.filePath(sha)),
    });
    upload.state = "finalizing";
    upload.finalizeSha = sha;
    upload.resourceId = resource.resourceId;
    upload.finalization = { keyDigest, requestDigest, result: resource };
    runMutation(this.store, (tx) => {
      putUploadInTx(tx, upload);
      putResourceInTx(tx, { resource, state: "publishing", expiresAt: null, releasedAt: null });
      bindIdempotencyInTx(tx, {
        owner: "upload",
        pid: 0,
        keyDigest,
        operation: "finalize",
        requestDigest,
        targetId: id,
        result: resource,
        createdAt: tx.now().toISOString(),
      });
      this.obligations.create("publish_blob", id, 0, { sha, resource_id: resource.resourceId });
      tx.changes.blobChanged(sha);
      tx.changes.uploadChanged(id);
    });
    return this.complete(upload);
  }

  /** Called by the composition's single Obligations.onCleared hook, after its owner notification. */
  onCleared(rows: readonly ObligationRow[]): void {
    for (const row of rows) {
      if (row.kind !== "publish_blob") continue;
      this.uploads.cleanPart(row.key);
      const { sha } = row.payload as { sha: string };
      // Release may have happened while publication still owned this digest.
      if (!this.blobs.owned(sha)) this.defer(this.blobs.gc(sha));
    }
  }

  private complete(upload: UploadRow, effects?: ObligationEffects): ControlResource {
    const resource = upload.finalization!.result;
    const row = readResourceRow(this.store, resource.resourceId);
    if (!row)
      throw resourceError(`no such resource: ${resource.resourceId}`, 404, "resource_not_found");
    // Receipts survive byte release. Never link a released or expired resource again.
    if (row.state === "released" || row.state === "expired") return resource;
    const sha = resourceSha(resource);
    const path = this.blobs.filePath(sha);
    const bytes = verifiedResourceBytes(
      resource,
      existsSync(path) ? path : this.uploads.partPath(upload.status.uploadId),
    );
    assertContentAllowed(resource, bytes);
    const linked = this.blobs.publishLink(this.uploads.partPath(upload.status.uploadId), sha);
    const generation = effects ? effects.register(this.blobs.dir) : linked.generation;
    // The part stays through the durability barrier. Only the post-clear hook removes it.
    upload.state = "published";
    runMutation(this.store, (tx) => {
      this.blobs.insertRow({
        sha256: sha,
        size: resource.sizeBytes,
        inline: null,
        file: path,
        generation,
      });
      putResourceInTx(tx, { ...row, state: "ready" });
      putUploadInTx(tx, upload);
      if (!effects)
        this.obligations.materializeInTx(tx, "publish_blob", upload.status.uploadId, generation);
      tx.changes.blobChanged(sha);
      tx.changes.uploadChanged(upload.status.uploadId);
    });
    return ControlResource.parse(resource);
  }

  private recover(obligation: ObligationRow, effects: ObligationEffects): void {
    const upload = readUploadRow(this.store, obligation.key);
    if (!upload?.finalization)
      throw new Error(`publication upload ${obligation.key} is unavailable`);
    const { sha, resource_id } = obligation.payload as { sha: string; resource_id: string };
    if (resourceSha(upload.finalization.result) !== sha || upload.resourceId !== resource_id)
      throw new Error(`publication binding mismatch for ${obligation.key}`);
    // completeOpen owns rematerialization with this process's new registration.
    this.complete(upload, effects);
  }
}
