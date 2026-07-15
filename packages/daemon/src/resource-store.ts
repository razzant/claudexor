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
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  Attachment,
  ControlResource,
  ControlUploadCreateRequest,
  ControlUploadStatus,
  type ResourceAttachmentRef,
} from "@claudexor/schema";
import { hashJson, newId } from "@claudexor/util";

interface UploadRecord {
  request: ReturnType<typeof ControlUploadCreateRequest.parse>;
  status: ReturnType<typeof ControlUploadStatus.parse>;
  partPath: string;
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
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const fd = openSync(temp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
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
    this.createIdempotency.set(idempotencyKey, { requestDigest, result: status });
    this.persistUpload(this.uploads.get(uploadId) as UploadRecord);
    this.persistIdempotency({
      operation: "create",
      key: idempotencyKey,
      requestDigest,
      result: status,
    });
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
        writeSync(fd, bytes);
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
      rmSync(upload.partPath, { force: true });
      this.persistUpload(upload);
      throw error;
    } finally {
      closeSync(fd);
    }
  }

  cancel(uploadId: string): ReturnType<typeof ControlUploadStatus.parse> {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw resourceError(`no such upload: ${uploadId}`, 404, "upload_not_found");
    upload.status = { ...upload.status, state: "cancelled" };
    rmSync(upload.partPath, { force: true });
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
      return ControlResource.parse(prior.result);
    }
    const upload = this.uploads.get(uploadId);
    if (!upload) throw resourceError(`no such upload: ${uploadId}`, 404, "upload_not_found");
    if (upload.status.state !== "uploaded")
      throw resourceError(
        `upload ${uploadId} is ${upload.status.state}`,
        409,
        "upload_not_uploaded",
      );
    const bytes = readFileSync(upload.partPath);
    const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (expectedSha256 !== undefined && expectedSha256 !== sha256)
      throw resourceError(
        "uploaded byte digest does not match expectedSha256",
        409,
        "digest_mismatch",
      );
    const blobPath = join(this.blobsDir, sha256.slice("sha256:".length));
    const deduplicated = existsSync(blobPath);
    if (deduplicated) rmSync(upload.partPath, { force: true });
    else renameSync(upload.partPath, blobPath);
    const resourceId = newId("res");
    const resource = ControlResource.parse({
      resourceId,
      kind: upload.request.kind,
      mime: upload.request.mime,
      name: upload.request.name,
      sha256,
      sizeBytes: bytes.length,
      createdAt: new Date().toISOString(),
      deduplicated,
    });
    atomicJson(join(this.resourcesDir, `${resourceId}.json`), resource);
    this.uploads.delete(uploadId);
    rmSync(join(this.uploadsDir, `${uploadId}.json`), { force: true });
    this.finalizeIdempotency.set(idempotencyKey, { requestDigest, result: resource });
    this.persistIdempotency({
      operation: "finalize",
      key: idempotencyKey,
      requestDigest,
      result: resource,
    });
    return resource;
  }

  resolve(refs: ResourceAttachmentRef[] | undefined): Attachment[] {
    return (refs ?? []).map(({ resourceId }) => {
      const metaPath = join(this.resourcesDir, `${resourceId}.json`);
      if (!existsSync(metaPath))
        throw resourceError(`no such resource: ${resourceId}`, 404, "resource_not_found");
      const resource = ControlResource.parse(JSON.parse(readFileSync(metaPath, "utf8")));
      const path = join(this.blobsDir, resource.sha256.slice("sha256:".length));
      if (!existsSync(path))
        throw resourceError(
          `resource blob is unavailable: ${resourceId}`,
          409,
          "resource_unavailable",
        );
      const bytes = readFileSync(path);
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (bytes.length !== resource.sizeBytes || digest !== resource.sha256)
        throw resourceError(
          `resource blob no longer matches finalized bytes: ${resourceId}`,
          409,
          "resource_digest_mismatch",
        );
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

  private persistUpload(upload: UploadRecord): void {
    atomicJson(join(this.uploadsDir, `${upload.status.uploadId}.json`), {
      request: upload.request,
      status: upload.status,
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
        };
        const request = ControlUploadCreateRequest.parse(raw.request);
        let status = ControlUploadStatus.parse(raw.status);
        const partPath = join(this.uploadsDir, `${status.uploadId}.part`);
        if (status.state === "uploading") {
          status = { ...status, state: "open", receivedBytes: 0 };
        }
        if (status.state !== "cancelled" && !existsSync(partPath)) continue;
        const upload = { request, status, partPath };
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
  }
}

function idempotencyConflict(): Error {
  return resourceError(
    "idempotency key was already used with a different request",
    409,
    "idempotency_conflict",
  );
}
