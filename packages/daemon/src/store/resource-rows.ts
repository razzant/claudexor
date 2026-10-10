import { readFileSync, existsSync } from "node:fs";
import {
  ControlResource,
  ControlUploadCreateRequest,
  ControlUploadStatus,
  ModelPayloadRef,
} from "@claudexor/schema";
import { sensitiveResourcePolicy } from "@claudexor/util";
import { sha256Hex } from "./blob-files.js";
import { requireTransaction, type SqlWriteContext } from "./mutation.js";

export type ResourceState = "publishing" | "ready" | "released" | "expired";
export interface ResourceRow {
  resource: ControlResource;
  state: ResourceState;
  expiresAt: string | null;
  releasedAt: string | null;
}
export interface UploadFinalization {
  keyDigest: string;
  requestDigest: string;
  result: ControlResource;
}
export interface UploadRow {
  request: ControlUploadCreateRequest;
  status: ControlUploadStatus;
  state: "open" | "uploaded" | "finalizing" | "published" | "discarded";
  finalizeSha: string | null;
  resourceId?: string;
  finalization?: UploadFinalization;
}

type SqlReader = Pick<SqlWriteContext, "prepare">;
export function readResourceRow(sql: SqlReader, id: string): ResourceRow | undefined {
  const row = sql
    .prepare("SELECT state, expires_at, released_at, body FROM resource WHERE id = ?")
    .get(id) as
    | {
        state: ResourceState;
        expires_at: string | null;
        released_at: string | null;
        body: Uint8Array;
      }
    | undefined;
  if (!row) return undefined;
  const resource = ControlResource.parse(JSON.parse(Buffer.from(row.body).toString("utf8")));
  if (resource.resourceId !== id)
    throw resourceError("resource identity mismatch", 409, "resource_digest_mismatch");
  return { resource, state: row.state, expiresAt: row.expires_at, releasedAt: row.released_at };
}

export function readUploadRow(sql: SqlReader, id: string): UploadRow | undefined {
  const row = sql
    .prepare(
      "SELECT state, finalize_sha, received_bytes, expected_bytes, body FROM upload WHERE id = ?",
    )
    .get(id) as
    | {
        state: UploadRow["state"];
        finalize_sha: string | null;
        received_bytes: number;
        expected_bytes: number;
        body: Uint8Array;
      }
    | undefined;
  if (!row) return undefined;
  const body = JSON.parse(Buffer.from(row.body).toString("utf8")) as UploadRow;
  return {
    ...body,
    request: ControlUploadCreateRequest.parse(body.request),
    status: ControlUploadStatus.parse({
      ...body.status,
      uploadId: id,
      receivedBytes: Number(row.received_bytes),
      expectedBytes: Number(row.expected_bytes),
    }),
    state: row.state,
    finalizeSha: row.finalize_sha,
  };
}

/** Pure row reducer: the caller owns the transaction, files and live notifications. */
export function putResourceInTx(sql: SqlWriteContext, row: ResourceRow): void {
  requireTransaction(sql);
  const r = row.resource;
  sql
    .prepare(
      `INSERT INTO resource(id, purpose, kind, sha256, size_bytes, state, created_at, expires_at, released_at, body)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET purpose=excluded.purpose, kind=excluded.kind, sha256=excluded.sha256,
    size_bytes=excluded.size_bytes, state=excluded.state, created_at=excluded.created_at,
    expires_at=excluded.expires_at, released_at=excluded.released_at, body=excluded.body`,
    )
    .run(
      r.resourceId,
      r.purpose ?? null,
      r.kind,
      resourceSha(r),
      r.sizeBytes,
      row.state,
      r.createdAt,
      row.expiresAt,
      row.releasedAt,
      Buffer.from(JSON.stringify(r)),
    );
}

/** Also used by the importer; no EngineStore, COMMIT, files or workers are involved. */
export function putUploadInTx(sql: SqlWriteContext, row: UploadRow): void {
  requireTransaction(sql);
  const { state, finalizeSha, ...body } = row;
  sql
    .prepare(
      `INSERT INTO upload(id, state, received_bytes, expected_bytes, finalize_sha, body) VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET state=excluded.state, received_bytes=excluded.received_bytes,
    expected_bytes=excluded.expected_bytes, finalize_sha=excluded.finalize_sha, body=excluded.body`,
    )
    .run(
      row.status.uploadId,
      state,
      row.status.receivedBytes,
      row.status.expectedBytes,
      finalizeSha,
      Buffer.from(JSON.stringify(body)),
    );
}

export function resourceError(message: string, status = 400, code = "resource_error"): Error {
  return Object.assign(new Error(message), { status, code });
}
export function assertResourceId(id: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(id))
    throw resourceError("invalid resource id", 400, "invalid_resource_id");
}
export function resourceSha(resource: Pick<ControlResource, "sha256">): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(resource.sha256))
    throw resourceError("invalid resource digest", 409, "resource_digest_mismatch");
  return resource.sha256.slice(7);
}
export function payloadRef(resource: ControlResource): ModelPayloadRef {
  return ModelPayloadRef.parse({
    resourceId: resource.resourceId,
    sha256: resource.sha256,
    sizeBytes: resource.sizeBytes,
  });
}
export function sensitiveResourceError(): Error {
  return resourceError(
    "resource rejected by sensitive-resource policy",
    422,
    "sensitive_resource_rejected",
  );
}
export function assertContentAllowed(
  resource: Pick<ControlResource, "purpose">,
  bytes: Uint8Array,
): void {
  if (
    resource.purpose !== "model" &&
    sensitiveResourcePolicy.containsSensitiveContent(Buffer.from(bytes).toString("utf8"))
  )
    throw sensitiveResourceError();
}
export function assertModelRef(resource: ControlResource, ref: ModelPayloadRef): void {
  if (resource.purpose !== "model") throw purposeMismatch();
  if (resource.sha256 !== ref.sha256 || resource.sizeBytes !== ref.sizeBytes)
    throw resourceError(
      "model resource reference does not match finalized bytes",
      409,
      "resource_digest_mismatch",
    );
}
export function purposeMismatch(): Error {
  return resourceError(
    "resource purpose does not match this operation",
    409,
    "resource_purpose_mismatch",
  );
}
export function verifiedResourceBytes(resource: ControlResource, path: string): Buffer {
  if (!existsSync(path))
    throw resourceError("resource blob is unavailable", 409, "resource_unavailable");
  const bytes = readFileSync(path);
  if (bytes.length !== resource.sizeBytes || sha256Hex(bytes) !== resourceSha(resource))
    throw resourceError(
      "resource blob no longer matches finalized bytes",
      409,
      "resource_digest_mismatch",
    );
  return bytes;
}
