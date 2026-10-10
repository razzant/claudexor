import { requireTransaction, type SqlWriteContext } from "./mutation.js";

export type IdempotencyOwner =
  "command" | "thread" | "turn" | "decision" | "project" | "setup" | "upload" | "quarantine";

export interface IdempotencyKey {
  owner: IdempotencyOwner;
  pid: number;
  /** The caller's original digest formula, including any prefix, is preserved. */
  keyDigest: string;
}

export interface IdempotencyBinding extends IdempotencyKey {
  operation: string;
  requestDigest: string;
  targetId: string;
  createdAt: string;
  /** Only uploads store an original reply. Other owners resolve their target. */
  result?: unknown;
}

interface BindingRow {
  operation: string;
  request_digest: string;
  target_id: string;
  created_at: string;
  result: Uint8Array | null;
}

function conflict(): never {
  throw Object.assign(new Error("idempotency key was already used with a different request"), {
    code: "idempotency_conflict",
    status: 409,
  });
}

/** Addressed replay; request/body hashes are never recomputed or interchanged. */
export function lookupIdempotency(
  sql: Pick<SqlWriteContext, "prepare">,
  key: IdempotencyKey,
  requestDigest: string,
): IdempotencyBinding | undefined {
  const row = sql
    .prepare(
      "SELECT operation, request_digest, target_id, result, created_at FROM idempotency WHERE owner = ? AND pid = ? AND key_digest = ?",
    )
    .get(key.owner, key.pid, key.keyDigest) as BindingRow | undefined;
  if (!row) return undefined;
  if (row.request_digest !== requestDigest) conflict();
  return {
    owner: key.owner,
    pid: key.pid,
    keyDigest: key.keyDigest,
    operation: row.operation,
    requestDigest: row.request_digest,
    targetId: row.target_id,
    createdAt: row.created_at,
    ...(row.result === null
      ? {}
      : { result: JSON.parse(Buffer.from(row.result).toString("utf8")) as unknown }),
  };
}

/** Bind once, in the same transaction as the target. Same-request replay keeps
 * the first target/result/time; a different request never overwrites a row. */
export function bindIdempotencyInTx(
  sql: SqlWriteContext,
  binding: IdempotencyBinding,
): IdempotencyBinding {
  requireTransaction(sql);
  const existing = lookupIdempotency(sql, binding, binding.requestDigest);
  if (existing) return existing;
  if (binding.owner !== "upload" && binding.result !== undefined) {
    throw new Error("only upload idempotency bindings carry a result");
  }
  sql
    .prepare(
      "INSERT INTO idempotency(owner, pid, key_digest, operation, request_digest, target_id, result, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      binding.owner,
      binding.pid,
      binding.keyDigest,
      binding.operation,
      binding.requestDigest,
      binding.targetId,
      binding.result === undefined ? null : Buffer.from(JSON.stringify(binding.result)),
      binding.createdAt,
    );
  return binding;
}

/** Delete only the removed target's bindings. A retained turn must not lose its
 * key merely because its command was pruned, even when the ids happen to match. */
export function deleteTargetIdempotencyInTx(
  sql: SqlWriteContext,
  owner: IdempotencyOwner,
  pid: number,
  targetId: string,
): number {
  requireTransaction(sql);
  return Number(
    sql
      .prepare("DELETE FROM idempotency WHERE target_id = ? AND owner = ? AND pid = ?")
      .run(targetId, owner, pid).changes,
  );
}
