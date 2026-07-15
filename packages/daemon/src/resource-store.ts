import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
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
import { newId } from "@claudexor/util";

interface UploadRecord {
  request: ReturnType<typeof ControlUploadCreateRequest.parse>;
  status: ReturnType<typeof ControlUploadStatus.parse>;
  partPath: string;
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
  private readonly uploadsDir: string;
  private readonly blobsDir: string;
  private readonly resourcesDir: string;

  constructor(root: string) {
    this.uploadsDir = join(root, "uploads");
    this.blobsDir = join(root, "blobs");
    this.resourcesDir = join(root, "resources");
    for (const dir of [this.uploadsDir, this.blobsDir, this.resourcesDir])
      mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  create(raw: unknown): ReturnType<typeof ControlUploadStatus.parse> {
    const request = ControlUploadCreateRequest.parse(raw);
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
      return ControlUploadStatus.parse(upload.status);
    } catch (error) {
      upload.status = { ...upload.status, state: "cancelled" };
      rmSync(upload.partPath, { force: true });
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
    return ControlUploadStatus.parse(upload.status);
  }

  finalize(uploadId: string, expectedSha256?: string): ReturnType<typeof ControlResource.parse> {
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
}
