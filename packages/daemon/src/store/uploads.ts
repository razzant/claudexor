import { createHash, type Hash } from "node:crypto";
import { closeSync, constants, ftruncateSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ControlUploadCreateRequest, ControlUploadStatus } from "@claudexor/schema";
import { hashJson, newId } from "@claudexor/util";
import { ensureDirectory, externalWriteFlags, unlinkExternalFile } from "./external-files.js";
import { mapStoreError } from "./errors.js";
import { deleteUnownedInlineInTx } from "./blob-files.js";
import { bindIdempotencyInTx } from "./idempotency.js";
import { runMutation } from "./mutation.js";
import {
  putUploadInTx,
  readUploadRow,
  resourceError,
  type UploadImportBinding,
  type UploadRow,
} from "./resource-rows.js";
import type { EngineStore } from "./store.js";
import {
  UploadBindings,
  uploadKeyDigest,
  type UploadOperation,
} from "./upload-binding-retention.js";

/** The shared main-thread decision used by cancel, post-publication cleanup and the sweep. */
export async function cleanupUploadPart(
  store: EngineStore,
  uploadId: string,
  path: string,
): Promise<"removed" | "owned"> {
  const observe = (): "owned" | "published" | "unowned" => {
    if (
      store
        .prepare("SELECT 1 FROM effect_obligation WHERE kind='publish_blob' AND key=?")
        .get(uploadId)
    )
      return "owned";
    const row = store.prepare("SELECT state FROM upload WHERE id=?").get(uploadId) as
      { state: string } | undefined;
    if (row?.state === "published") return "published";
    return !row || row.state === "discarded" ? "unowned" : "owned";
  };
  const state = observe();
  if (state === "owned") return "owned";
  if (state === "published") {
    // The removed obligation already certified publication. A crash between
    // its clear and this callback may have left the upload's digest reference.
    runMutation(store, (tx) => {
      const row = tx.prepare("SELECT finalize_sha FROM upload WHERE id=?").get(uploadId) as {
        finalize_sha: string | null;
      };
      if (row.finalize_sha !== null) {
        tx.prepare("UPDATE upload SET finalize_sha=NULL WHERE id=?").run(uploadId);
        deleteUnownedInlineInTx(tx, row.finalize_sha);
        tx.changes.blobChanged(row.finalize_sha);
        tx.changes.uploadChanged(uploadId);
      }
    });
    unlinkExternalFile(store, path);
    return "removed";
  }
  // Discarded metadata keeps its public cancelled receipt but owns no .part.
  return store.owners.unlinkWhenUnowned(`upload:${uploadId}`, {
    path,
    owners: () => observe() !== "unowned",
    afterUnlink: () => {
      store.registerExternal(store.paths.uploads);
    },
  });
}

export class SqlUploads {
  readonly bindings: UploadBindings;
  private readonly writing = new Set<string>();

  constructor(
    private readonly store: EngineStore,
    private readonly defer: (work: Promise<unknown>) => void,
  ) {
    this.bindings = new UploadBindings(store);
    // As in the legacy restart path, an interrupted stream is retryable from byte zero.
    const rows = store.prepare("SELECT id FROM upload WHERE state='open'").all() as Array<{
      id: string;
    }>;
    for (const { id } of rows) {
      const row = readUploadRow(store, id)!;
      if (row.status.state !== "uploading") continue;
      row.status = { ...row.status, state: "open", receivedBytes: 0 };
      this.save(row);
    }
  }

  /** Omitting a caller key mints a new internal upload, with no historical replay to resolve. */
  create(raw: unknown, callerKey?: string): ControlUploadStatus {
    const request = ControlUploadCreateRequest.parse(raw);
    const requestDigest = hashJson(request);
    const key = callerKey ?? newId("model-create");
    const prior =
      callerKey === undefined ? undefined : this.bindings.lookup("create", key, requestDigest);
    if (prior) return ControlUploadStatus.parse(prior.result);
    return this.open(request, "create", uploadKeyDigest("create", key), requestDigest);
  }

  /** The import's key binds this upload in the same transaction that creates it. */
  createImport(
    request: ControlUploadCreateRequest,
    binding: UploadImportBinding,
    requestDigest: string,
  ): ControlUploadStatus {
    return this.open(request, "import", binding.keyDigest, requestDigest, binding);
  }

  private open(
    request: ControlUploadCreateRequest,
    operation: UploadOperation,
    keyDigest: string,
    requestDigest: string,
    importBinding?: UploadImportBinding,
  ): ControlUploadStatus {
    const uploadId = newId("upl");
    ensureDirectory(this.store, this.store.paths.uploads);
    try {
      const fd = openSync(
        this.partPath(uploadId),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      closeSync(fd);
    } catch (error) {
      throw mapStoreError(error, "creating upload part");
    }
    this.store.registerExternal(this.store.paths.uploads);
    const status = ControlUploadStatus.parse({
      uploadId,
      state: "open",
      receivedBytes: 0,
      expectedBytes: request.sizeBytes,
    });
    runMutation(this.store, (tx) => {
      putUploadInTx(tx, {
        request,
        status,
        state: "open",
        finalizeSha: null,
        ...(importBinding ? { import: importBinding } : {}),
      });
      bindIdempotencyInTx(tx, {
        owner: "upload",
        pid: 0,
        keyDigest,
        operation,
        requestDigest,
        targetId: uploadId,
        // The import projection is derived from its upload; only create stores a reply.
        ...(operation === "create" ? { result: status } : {}),
        createdAt: tx.now().toISOString(),
      });
      tx.changes.uploadChanged(uploadId);
    });
    return status;
  }

  status(id: string): ControlUploadStatus {
    return ControlUploadStatus.parse(this.get(id).status);
  }
  get(id: string): UploadRow {
    const row = readUploadRow(this.store, id);
    if (!row || row.state === "published")
      throw resourceError(`no such upload: ${id}`, 404, "upload_not_found");
    return row;
  }
  partPath(id: string): string {
    return join(this.store.paths.uploads, `${id}.part`);
  }

  async write(id: string, chunks: AsyncIterable<Uint8Array>): Promise<ControlUploadStatus> {
    const row = this.get(id);
    if (row.status.state !== "open")
      throw resourceError(`upload ${id} is ${row.status.state}`, 409, "upload_not_open");
    const fd = this.beginWrite(row);
    // An import verifies its declared digest while receiving.
    const hash = row.import ? createHash("sha256") : undefined;
    this.writing.add(id);
    try {
      for await (const chunk of chunks) this.writeChunk(row, fd, chunk, hash);
      return this.finishWrite(row, hash);
    } catch (error) {
      // An import keeps its key: an unverified transfer restarts from byte zero.
      if (row.import) this.reopen(id);
      else this.markCancelled(row);
      throw mapStoreError(error, "writing upload part");
    } finally {
      closeSync(fd);
      this.writing.delete(id);
      if (readUploadRow(this.store, id)?.state === "discarded") this.cleanPart(id);
    }
  }

  /** The daemon-produced result is synchronous through its publication commit. */
  writeAll(id: string, bytes: Uint8Array): void {
    const row = this.get(id);
    const fd = this.beginWrite(row);
    try {
      this.writeChunk(row, fd, bytes);
      this.finishWrite(row);
    } catch (error) {
      this.markCancelled(row);
      throw mapStoreError(error, "writing model result part");
    } finally {
      closeSync(fd);
    }
  }

  cancel(id: string): ControlUploadStatus {
    const row = this.get(id);
    if (row.finalization)
      throw resourceError("upload finalization has already started", 409, "upload_finalizing");
    this.markCancelled(row);
    // A streaming descriptor is closed by its writer before unlink (also required on Windows).
    if (!this.writing.has(id)) this.cleanPart(id);
    return ControlUploadStatus.parse(row.status);
  }

  discard(id: string): void {
    const row = readUploadRow(this.store, id);
    if (!row) return;
    runMutation(this.store, (tx) => {
      tx.prepare("DELETE FROM upload WHERE id=?").run(id);
      if (row.finalizeSha) deleteUnownedInlineInTx(tx, row.finalizeSha);
      tx.changes.uploadChanged(id);
      tx.changes.blobChanged(row.finalizeSha);
    });
    this.cleanPart(id);
  }
  cleanPart(id: string): void {
    this.defer(cleanupUploadPart(this.store, id, this.partPath(id)));
  }

  private beginWrite(row: UploadRow): number {
    let fd: number | undefined;
    try {
      fd = openSync(this.partPath(row.status.uploadId), externalWriteFlags(constants.O_RDWR));
      ftruncateSync(fd, 0);
      row.status = { ...row.status, state: "uploading", receivedBytes: 0 };
      this.save(row);
      return fd;
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      throw mapStoreError(error, "opening upload part for writing");
    }
  }
  private writeChunk(row: UploadRow, fd: number, bytes: Uint8Array, hash?: Hash): void {
    this.assertNotCancelled(row.status.uploadId);
    const next = row.status.receivedBytes + bytes.byteLength;
    if (next > row.status.expectedBytes)
      throw resourceError("upload exceeds declared size", 413, "upload_size_exceeded");
    let offset = 0;
    while (offset < bytes.byteLength)
      offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
    hash?.update(bytes);
    row.status = { ...row.status, receivedBytes: next };
    this.save(row);
  }
  private finishWrite(row: UploadRow, hash?: Hash): ControlUploadStatus {
    this.assertNotCancelled(row.status.uploadId);
    if (row.status.receivedBytes !== row.status.expectedBytes)
      throw resourceError(
        `upload size mismatch: expected ${row.status.expectedBytes}, received ${row.status.receivedBytes}`,
        400,
        "upload_size_mismatch",
      );
    if (hash && `sha256:${hash.digest("hex")}` !== row.import?.sha256)
      throw resourceError(
        "uploaded bytes do not match the import's declared sha256",
        409,
        "digest_mismatch",
      );
    // O_DSYNC writes made the bytes durable; this commit is the import's byte receipt.
    row.status = { ...row.status, state: "uploaded" };
    row.state = "uploaded";
    this.save(row);
    return ControlUploadStatus.parse(row.status);
  }
  private assertNotCancelled(id: string): void {
    if (readUploadRow(this.store, id)?.state === "discarded")
      throw resourceError(`upload ${id} was cancelled`, 409, "upload_cancelled");
  }
  /** Unverified import bytes are not a receipt. An explicit cancel stays final. */
  reopen(id: string): void {
    const row = readUploadRow(this.store, id);
    if (!row?.import || row.state === "discarded" || row.finalization) return;
    row.status = { ...row.status, state: "open", receivedBytes: 0 };
    row.state = "open";
    this.save(row);
  }
  private markCancelled(row: UploadRow): void {
    row.status = { ...row.status, state: "cancelled" };
    row.state = "discarded";
    this.save(row);
  }
  private save(row: UploadRow): void {
    runMutation(this.store, (tx) => {
      putUploadInTx(tx, row);
      tx.changes.uploadChanged(row.status.uploadId);
      tx.changes.blobChanged(row.finalizeSha);
    });
  }
}
