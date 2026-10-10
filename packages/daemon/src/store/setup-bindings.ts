import type { StoreEvent } from "../store-contracts.js";
import type { SqlWriteContext } from "./mutation.js";
import { bindIdempotencyInTx } from "./idempotency.js";

/** Legacy setup binding bytes are shared by create and extension events. */
export interface SetupCreateBinding {
  keyDigest: string;
  requestDigest: string;
  jobId: string;
}
type SetupJournalPayload = { job?: unknown; binding?: unknown };

export function parseSetupBinding(value: unknown): SetupCreateBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row["keyDigest"] !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(row["keyDigest"]) ||
    typeof row["requestDigest"] !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(row["requestDigest"]) ||
    typeof row["jobId"] !== "string" ||
    !/^setup-[A-Za-z0-9-]+$/.test(row["jobId"])
  )
    return null;
  return {
    keyDigest: row["keyDigest"],
    requestDigest: row["requestDigest"],
    jobId: row["jobId"],
  };
}

export function setupIdempotencyConflict(): Error {
  return Object.assign(new Error("Idempotency-Key was already used with a different request"), {
    code: "idempotency_conflict",
    status: 409,
  });
}

export function bindSetupInTx(
  sql: SqlWriteContext,
  pid: number,
  binding: SetupCreateBinding,
  operation: string,
  createdAt: string,
): void {
  const stored = bindIdempotencyInTx(sql, {
    owner: "setup",
    pid,
    keyDigest: binding.keyDigest,
    operation,
    requestDigest: binding.requestDigest,
    targetId: binding.jobId,
    createdAt,
  });
  if (stored.targetId !== binding.jobId) throw setupIdempotencyConflict();
}

/** Pure PR-D import seam. Legacy payloads contain no operation discriminator;
 * that absence stays explicit metadata and never affects opaque-digest replay. */
export function importSetupBindingInTx(
  sql: SqlWriteContext,
  pid: number,
  record: Pick<StoreEvent<SetupJournalPayload>, "type" | "time" | "payload">,
): void {
  if (record.type !== "setup.job.saved" && record.type !== "setup.job.create_bound") return;
  if (record.type === "setup.job.saved" && record.payload?.binding === undefined) return;
  const binding = parseSetupBinding(record.payload?.binding);
  if (
    !binding ||
    (record.type === "setup.job.saved" &&
      (record.payload.job as { jobId?: unknown } | undefined)?.jobId !== binding.jobId)
  )
    throw new Error("invalid imported setup binding");
  bindSetupInTx(sql, pid, binding, "setup.legacy_unknown", record.time);
}
