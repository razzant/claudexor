import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  Attachment,
  ControlResource,
  ControlUploadCreateRequest,
  ControlUploadStatus,
  ModelPayloadRef,
  type ResourceAttachmentRef,
} from "@claudexor/schema";
import { fsyncDirectory, hashJson, newId, sensitiveResourcePolicy } from "@claudexor/util";

interface UploadRecord {
  request: ReturnType<typeof ControlUploadCreateRequest.parse>;
  status: ReturnType<typeof ControlUploadStatus.parse>;
  partPath: string;
  // This binding precedes the blob rename, so every interrupted finalize
  // resumes the same resource and idempotency key, even without the part file.
  finalization?: IdempotencyRecord<ReturnType<typeof ControlResource.parse>>;
}

interface IdempotencyRecord<T> {
  operation: "create" | "finalize";
  key: string;
  requestDigest: string;
  result: T;
}

function resourceError(message: string, status = 400, code = "resource_error"): Error {
  return Object.assign(new Error(message), { status, code });
}

function atomicJson(path: string, value: unknown): void {
  const temp = `${path}.${newId("tmp")}`;
  try {
    writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    // Windows FlushFileBuffers requires a write-capable file handle. The temp
    // was already written above; r+ only changes handle rights, not contents.
    const fd = openSync(temp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    fsyncDirectory(dirname(path));
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Daemon-owned immutable content store. Uploads are single-shot streams; finalized blobs dedupe. */
export class ResourceStore {
  private readonly uploads = new Map<string, UploadRecord>();
  private readonly createIdempotency = new Map<
    string,
    { requestDigest: string; result: ReturnType<typeof ControlUploadStatus.parse> }
  >();
  private readonly finalizeIdempotency = new Map<
    string,
    { requestDigest: string; result: ReturnType<typeof ControlResource.parse> }
  >();
  private readonly uploadsDir: string;
  private readonly blobsDir: string;
  private readonly resourcesDir: string;
  private readonly idempotencyDir: string;

  constructor(root: string) {
    this.uploadsDir = join(root, "uploads");
    this.blobsDir = join(root, "blobs");
    this.resourcesDir = join(root, "resources");
    this.idempotencyDir = join(root, "idempotency");
    for (const dir of [this.uploadsDir, this.blobsDir, this.resourcesDir, this.idempotencyDir])
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.restoreState();
  }

  create(raw: unknown, idempotencyKey: string): ReturnType<typeof ControlUploadStatus.parse> {
    const request = ControlUploadCreateRequest.parse(raw);
    if (sensitiveResourcePolicy.classifyPath(request.name).sensitive) {
      throw sensitiveResourceError();
    }
    const requestDigest = hashJson(request);
    const prior = this.createIdempotency.get(idempotencyKey);
    if (prior) {
      if (prior.requestDigest !== requestDigest) throw idempotencyConflict();
      return ControlUploadStatus.parse(prior.result);
    }
    const uploadId = newId("upl");
    const partPath = join(this.uploadsDir, `${uploadId}.part`);
    const fd = openSync(partPath, "wx", 0o600);
    closeSync(fd);
    const status = ControlUploadStatus.parse({
      uploadId,
      state: "open",
      receivedBytes: 0,
      expectedBytes: request.sizeBytes,
    });
    this.uploads.set(uploadId, { request, status, partPath });
    this.persistUpload(this.uploads.get(uploadId) as UploadRecord);
    this.persistIdempotency({
      operation: "create",
      key: idempotencyKey,
      requestDigest,
      result: status,
    });
    this.createIdempotency.set(idempotencyKey, { requestDigest, result: status });
    return status;
  }

  status(uploadId: string): ReturnType<typeof ControlUploadStatus.parse> {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw resourceError(`no such upload: ${uploadId}`, 404, "upload_not_found");
    return ControlUploadStatus.parse(upload.status);
  }

  async write(
    uploadId: string,
    chunks: AsyncIterable<Uint8Array>,
  ): Promise<ReturnType<typeof ControlUploadStatus.parse>> {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw resourceError(`no such upload: ${uploadId}`, 404, "upload_not_found");
    if (upload.status.state !== "open")
      throw resourceError(`upload ${uploadId} is ${upload.status.state}`, 409, "upload_not_open");
    upload.status = { ...upload.status, state: "uploading" };
    const fd = openSync(upload.partPath, "r+");
    try {
      ftruncateSync(fd, 0);
      upload.status = { ...upload.status, receivedBytes: 0 };
      this.persistUpload(upload);
      for await (const chunk of chunks) {
        if (upload.status.state === "cancelled")
          throw resourceError(`upload ${uploadId} was cancelled`, 409, "upload_cancelled");
        const bytes = Buffer.from(chunk);
        const next = upload.status.receivedBytes + bytes.length;
        if (next > upload.status.expectedBytes)
          throw resourceError("upload exceeds declared size", 413, "upload_size_exceeded");
        writeFileSync(fd, bytes);
        upload.status = { ...upload.status, receivedBytes: next };
      }
      if (upload.status.state === "cancelled")
        throw resourceError(`upload ${uploadId} was cancelled`, 409, "upload_cancelled");
      if (upload.status.receivedBytes !== upload.status.expectedBytes)
        throw resourceError(
          `upload size mismatch: expected ${upload.status.expectedBytes}, received ${upload.status.receivedBytes}`,
          400,
          "upload_size_mismatch",
        );
      fsyncSync(fd);
      upload.status = { ...upload.status, state: "uploaded" };
      this.persistUpload(upload);
      return ControlUploadStatus.parse(upload.status);
    } catch (error) {
      upload.status = { ...upload.status, state: "cancelled" };
      throw error;
    } finally {
      closeSync(fd);
      if (upload.status.state === "cancelled") {
        rmSync(upload.partPath, { force: true });
        this.persistUpload(upload);
      }
    }
  }

  cancel(uploadId: string): ReturnType<typeof ControlUploadStatus.parse> {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw resourceError(`no such upload: ${uploadId}`, 404, "upload_not_found");
    if (upload.finalization)
      throw resourceError("upload finalization has already started", 409, "upload_finalizing");
    const writing = upload.status.state === "uploading";
    upload.status = { ...upload.status, state: "cancelled" };
    // The writer closes its descriptor before unlinking (also required on Windows).
    if (!writing) rmSync(upload.partPath, { force: true });
    this.persistUpload(upload);
    return ControlUploadStatus.parse(upload.status);
  }

  finalize(
    uploadId: string,
    expectedSha256: string | undefined,
    idempotencyKey: string,
  ): ReturnType<typeof ControlResource.parse> {
    const requestDigest = hashJson({ uploadId, expectedSha256: expectedSha256 ?? null });
    const prior = this.finalizeIdempotency.get(idempotencyKey);
    if (prior) {
      if (prior.requestDigest !== requestDigest) throw idempotencyConflict();
      const pending = this.uploads.get(uploadId);
      if (pending?.finalization) this.discardUpload(pending);
      return ControlResource.parse(prior.result);
    }
    const upload = this.uploads.get(uploadId);
    if (!upload) throw resourceError(`no such upload: ${uploadId}`, 404, "upload_not_found");
    if (upload.finalization) {
      if (
        upload.finalization.key !== idempotencyKey ||
        upload.finalization.requestDigest !== requestDigest
      )
        throw idempotencyConflict();
      return this.completeFinalization(upload);
    }
    if (upload.status.state !== "uploaded")
      throw resourceError(
        `upload ${uploadId} is ${upload.status.state}`,
        409,
        "upload_not_uploaded",
      );
    const bytes = readFileSync(upload.partPath);
    if (bytes.length !== upload.status.expectedBytes)
      throw resourceError(
        "uploaded file no longer matches declared size",
        409,
        "upload_size_mismatch",
      );
    if (
      upload.request.purpose !== "model" &&
      sensitiveResourcePolicy.containsSensitiveContent(bytes.toString("utf8"))
    ) {
      upload.status = { ...upload.status, state: "cancelled" };
      rmSync(upload.partPath, { force: true });
      this.persistUpload(upload);
      throw sensitiveResourceError();
    }
    const sha256 = digestOf(bytes);
    if (expectedSha256 !== undefined && expectedSha256 !== sha256)
      throw resourceError(
        "uploaded byte digest does not match expectedSha256",
        409,
        "digest_mismatch",
      );
    const blobPath = join(this.blobsDir, sha256.slice("sha256:".length));
    const deduplicated = existsSync(blobPath);
    const resourceId = newId("res");
    const resource = ControlResource.parse({
      resourceId,
      ...(upload.request.purpose ? { purpose: upload.request.purpose } : {}),
      kind: upload.request.kind,
      mime: upload.request.mime,
      name: upload.request.name,
      sha256,
      sizeBytes: bytes.length,
      createdAt: new Date().toISOString(),
      deduplicated,
    });
    upload.finalization = {
      operation: "finalize",
      key: idempotencyKey,
      requestDigest,
      result: resource,
    };
    return this.completeFinalization(upload);
  }

  resolve(refs: ResourceAttachmentRef[] | undefined): Attachment[] {
    return (refs ?? []).map(({ resourceId }) => {
      const resource = this.metadata(resourceId);
      if (resource.purpose === "model") throw purposeMismatch();
      const path = this.blobPath(resource.sha256);
      const bytes = this.verifiedBytes(resource, path);
      if (
        sensitiveResourcePolicy.classifyPath(resource.name).sensitive ||
        sensitiveResourcePolicy.containsSensitiveContent(bytes.toString("utf8"))
      ) {
        throw sensitiveResourceError();
      }
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

  /** Exact model bytes only; never a text/artifact projection or secret scanner. */
  readModel(raw: ModelPayloadRef): Buffer {
    const ref = ModelPayloadRef.parse(raw);
    const resource = this.metadata(ref.resourceId);
    this.assertModelRef(resource, ref);
    return this.verifiedBytes(resource, this.blobPath(resource.sha256));
  }

  /** Publish a daemon-produced result through the same durable finalize owner. */
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
    const upload = this.uploads.get(status.uploadId)!;
    try {
      const fd = openSync(upload.partPath, "r+");
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      upload.status = { ...upload.status, state: "uploaded", receivedBytes: bytes.byteLength };
      this.persistUpload(upload);
      return payloadRef(this.finalize(status.uploadId, digestOf(bytes), newId("model-finalize")));
    } catch (error) {
      // An unpublished partial result has no caller-visible ref to release.
      // A begun finalization retains its binding for ordinary restart recovery.
      if (!upload.finalization) this.discardUpload(upload);
      throw error;
    }
  }

  /** Caller owns command-reference checks. This removes only this resource;
   * a blob shared with another resource or pending finalize remains owned. */
  releaseModel(raw: ModelPayloadRef): void {
    const ref = ModelPayloadRef.parse(raw);
    const metaPath = this.resourcePath(ref.resourceId);
    if (!existsSync(metaPath)) return;
    const resource = this.metadata(ref.resourceId);
    this.assertModelRef(resource, ref);
    const referenced =
      readdirSync(this.resourcesDir).some((name) => {
        if (!name.endsWith(".json") || name === `${ref.resourceId}.json`) return false;
        return this.metadata(name.slice(0, -5)).sha256 === ref.sha256;
      }) ||
      [...this.uploads.values()].some(
        (upload) => upload.finalization?.result.sha256 === ref.sha256,
      );
    // Unlink bytes before metadata: a failed cleanup retains its exact retry target.
    if (!referenced) {
      rmSync(this.blobPath(ref.sha256), { force: true });
      fsyncDirectory(this.blobsDir);
    }
    rmSync(metaPath, { force: true });
    fsyncDirectory(this.resourcesDir);
  }

  listModelResources(): Array<ModelPayloadRef & { createdAt: string }> {
    return readdirSync(this.resourcesDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.metadata(name.slice(0, -5)))
      .filter((resource) => resource.purpose === "model")
      .map((resource) => ({ ...payloadRef(resource), createdAt: resource.createdAt }));
  }

  private assertModelRef(resource: ControlResource, ref: ModelPayloadRef): void {
    if (resource.purpose !== "model") throw purposeMismatch();
    if (resource.sha256 !== ref.sha256 || resource.sizeBytes !== ref.sizeBytes)
      throw resourceError(
        "model resource reference does not match finalized bytes",
        409,
        "resource_digest_mismatch",
      );
  }

  private resourcePath(resourceId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(resourceId))
      throw resourceError("invalid resource id", 400, "invalid_resource_id");
    return join(this.resourcesDir, `${resourceId}.json`);
  }

  private blobPath(sha256: string): string {
    if (!/^sha256:[a-f0-9]{64}$/.test(sha256))
      throw resourceError("invalid resource digest", 409, "resource_digest_mismatch");
    return join(this.blobsDir, sha256.slice("sha256:".length));
  }

  private metadata(resourceId: string): ControlResource {
    const path = this.resourcePath(resourceId);
    if (!existsSync(path))
      throw resourceError(`no such resource: ${resourceId}`, 404, "resource_not_found");
    const resource = ControlResource.parse(JSON.parse(readFileSync(path, "utf8")));
    if (resource.resourceId !== resourceId)
      throw resourceError("resource identity mismatch", 409, "resource_digest_mismatch");
    return resource;
  }

  private verifiedBytes(resource: ControlResource, path: string): Buffer {
    if (!existsSync(path))
      throw resourceError("resource blob is unavailable", 409, "resource_unavailable");
    const bytes = readFileSync(path);
    if (bytes.length !== resource.sizeBytes || digestOf(bytes) !== resource.sha256)
      throw resourceError(
        "resource blob no longer matches finalized bytes",
        409,
        "resource_digest_mismatch",
      );
    return bytes;
  }

  private completeFinalization(upload: UploadRecord): ControlResource {
    const binding = upload.finalization!;
    const resource = binding.result;
    const prior = this.finalizeIdempotency.get(binding.key);
    if (prior) {
      if (prior.requestDigest !== binding.requestDigest) throw idempotencyConflict();
      // Publication already committed. Only clean debris; an ACK may since
      // have released this resource and replay must never resurrect its bytes.
      this.discardUpload(upload);
      return ControlResource.parse(prior.result);
    }
    // Re-persist even on same-process retry: the earlier metadata write may have failed.
    this.persistUpload(upload);
    const blobPath = this.blobPath(resource.sha256);
    const bytes = this.verifiedBytes(resource, existsSync(blobPath) ? blobPath : upload.partPath);
    if (
      resource.purpose !== "model" &&
      sensitiveResourcePolicy.containsSensitiveContent(bytes.toString("utf8"))
    )
      throw sensitiveResourceError();
    if (!existsSync(blobPath)) renameSync(upload.partPath, blobPath);
    fsyncDirectory(this.blobsDir);
    fsyncDirectory(this.uploadsDir);
    atomicJson(this.resourcePath(resource.resourceId), resource);
    this.persistIdempotency(binding);
    this.finalizeIdempotency.set(binding.key, {
      requestDigest: binding.requestDigest,
      result: resource,
    });
    this.discardUpload(upload);
    return ControlResource.parse(resource);
  }

  private discardUpload(upload: UploadRecord): void {
    rmSync(upload.partPath, { force: true });
    rmSync(join(this.uploadsDir, `${upload.status.uploadId}.json`), { force: true });
    fsyncDirectory(this.uploadsDir);
    this.uploads.delete(upload.status.uploadId);
  }

  private persistUpload(upload: UploadRecord): void {
    atomicJson(join(this.uploadsDir, `${upload.status.uploadId}.json`), {
      request: upload.request,
      status: upload.status,
      ...(upload.finalization ? { finalization: upload.finalization } : {}),
    });
  }

  private persistIdempotency(record: IdempotencyRecord<unknown>): void {
    const name = createHash("sha256").update(`${record.operation}\0${record.key}`).digest("hex");
    atomicJson(join(this.idempotencyDir, `${name}.json`), record);
  }

  private restoreState(): void {
    for (const name of readdirSync(this.uploadsDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(readFileSync(join(this.uploadsDir, name), "utf8")) as {
          request: unknown;
          status: unknown;
          finalization?: IdempotencyRecord<unknown>;
        };
        const request = ControlUploadCreateRequest.parse(raw.request);
        let status = ControlUploadStatus.parse(raw.status);
        if (!/^[a-zA-Z0-9_-]+$/.test(status.uploadId) || name !== `${status.uploadId}.json`)
          continue;
        const partPath = join(this.uploadsDir, `${status.uploadId}.part`);
        if (status.state === "uploading") {
          status = { ...status, state: "open", receivedBytes: 0 };
        }
        const finalization = raw.finalization
          ? {
              ...raw.finalization,
              result: ControlResource.parse(raw.finalization.result),
            }
          : undefined;
        if (
          finalization &&
          (finalization.operation !== "finalize" ||
            typeof finalization.key !== "string" ||
            typeof finalization.requestDigest !== "string" ||
            finalization.result.purpose !== request.purpose)
        )
          continue;
        if (status.state !== "cancelled" && !existsSync(partPath) && !finalization) continue;
        const upload = { request, status, partPath, finalization };
        this.uploads.set(status.uploadId, upload);
        this.persistUpload(upload);
      } catch {
        // Invalid daemon-owned metadata is ignored; immutable resources remain independently verifiable.
      }
    }
    for (const name of readdirSync(this.idempotencyDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(readFileSync(join(this.idempotencyDir, name), "utf8")) as {
          operation: unknown;
          key: unknown;
          requestDigest: unknown;
          result: unknown;
        };
        if (typeof raw.key !== "string" || typeof raw.requestDigest !== "string") continue;
        if (raw.operation === "create") {
          this.createIdempotency.set(raw.key, {
            requestDigest: raw.requestDigest,
            result: ControlUploadStatus.parse(raw.result),
          });
        } else if (raw.operation === "finalize") {
          this.finalizeIdempotency.set(raw.key, {
            requestDigest: raw.requestDigest,
            result: ControlResource.parse(raw.result),
          });
        }
      } catch {
        // Fail closed on the individual binding: it cannot be used to claim a replay match.
      }
    }
    for (const upload of this.uploads.values()) {
      if (!upload.finalization) continue;
      try {
        this.completeFinalization(upload);
      } catch {
        // Keep the binding for an exact finalize retry to report its failure;
        // one damaged resource must not prevent unrelated resources loading.
      }
    }
  }
}

function digestOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function payloadRef(resource: ControlResource): ModelPayloadRef {
  return ModelPayloadRef.parse({
    resourceId: resource.resourceId,
    sha256: resource.sha256,
    sizeBytes: resource.sizeBytes,
  });
}

function purposeMismatch(): Error {
  return resourceError(
    "resource purpose does not match this operation",
    409,
    "resource_purpose_mismatch",
  );
}

function idempotencyConflict(): Error {
  return resourceError(
    "idempotency key was already used with a different request",
    409,
    "idempotency_conflict",
  );
}

function sensitiveResourceError(): Error {
  return resourceError(
    "resource rejected by sensitive-resource policy",
    422,
    "sensitive_resource_rejected",
  );
}
