import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as yieldToAdmission } from "node:timers/promises";
import { ControlResource, ControlUploadStatus } from "@claudexor/schema";
import { StoreError } from "./errors.js";
import {
  bindIdempotencyInTx,
  deleteTargetIdempotencyInTx,
  lookupIdempotency,
  type IdempotencyBinding,
} from "./idempotency.js";
import { runMutation } from "./mutation.js";
import {
  putUploadInTx,
  readResourceRow,
  readUploadRow,
  type ResourceRow,
} from "./resource-rows.js";
import { RETENTION_AGE_REVISIT_MS, RETENTION_ROW_WINDOW } from "./retention-pages.js";
import type { EngineStore } from "./store.js";

/** The accepted upload-binding lifetime starts at release/expiry, never at upload creation. */
export const UPLOAD_BINDING_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
/** The most expired targets one prune transaction confirms and deletes. */
export const UPLOAD_BINDING_PRUNE_BATCH = 100;
/** Key of the last of the next `?2` upload bindings after `?1`; null when none follow. */
export const UPLOAD_BINDING_WINDOW_END_SQL = `SELECT max(k) AS k FROM (SELECT key_digest AS k FROM idempotency
  WHERE owner='upload' AND pid=0 AND key_digest>?1 ORDER BY key_digest LIMIT ?2)`;
/** Targets of one window (`?1`, `?2`] whose binding and resource are both past
 * the cutoff `?3`. The binding's own age is tested first, so a binding inside
 * the lifetime costs no upload or resource read. Both tests only narrow:
 * `expired()` decides. */
export const UPLOAD_BINDING_WINDOW_SQL = `SELECT DISTINCT i.target_id FROM idempotency i
  JOIN upload u ON u.id=i.target_id
  JOIN resource r ON r.id=json_extract(CAST(u.body AS TEXT), '$.resourceId')
  WHERE i.owner='upload' AND i.pid=0 AND i.key_digest>?1 AND i.key_digest<=?2
    AND i.created_at<=?3 AND r.state IN ('released','expired')
    AND coalesce(r.released_at, CASE WHEN r.state='expired' THEN r.expires_at END)<=?3`;
export interface UploadBindingPrune {
  /** Stop, restart and storage recovery: the scan ends after its current step. */
  signal?: AbortSignal;
  /** Binding rows one synchronous read examines. */
  window?: number;
  /** The most targets one transaction confirms and deletes. */
  batch?: number;
}
export interface UploadBindingScan {
  /** Bindings this call deleted. */
  removed: number;
  /** The signal ended the scan before the last key: expired bindings may remain. */
  interrupted: boolean;
}
export type UploadOperation = "create" | "finalize" | "import";
export interface LegacyUploadBinding {
  operation: Exclude<UploadOperation, "import">;
  key: string;
  requestDigest: string;
  result: ControlUploadStatus | ControlResource;
}
export function uploadKeyDigest(operation: UploadOperation, key: string): string {
  return createHash("sha256").update(`${operation}\0${key}`).digest("hex");
}

/** Pure parser for the importer; serving lookup refuses a present invalid record. */
export function parseLegacyUploadBinding(
  raw: unknown,
  operation: LegacyUploadBinding["operation"],
  key: string,
): LegacyUploadBinding | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (value.operation !== operation || value.key !== key || typeof value.requestDigest !== "string")
    return undefined;
  const result =
    operation === "create"
      ? ControlUploadStatus.safeParse(value.result)
      : ControlResource.safeParse(value.result);
  if (!result.success) return undefined;
  return { operation, key, requestDigest: value.requestDigest, result: result.data };
}

/**
 * A present addressed record that cannot prove absence. Its message and problem
 * context carry the operation, key digest and root-relative file (CLI clients
 * keep only the message), never the raw key, record bytes, absolute path or
 * native error text. Retrying means resubmitting the same key after repair.
 */
function legacyBindingUnavailable(
  operation: UploadOperation,
  keyDigest: string,
  reason: "read_failed" | "invalid",
  cause?: unknown,
): StoreError {
  const file = `resource-store/idempotency/${keyDigest}.json`;
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  const errno =
    reason === "read_failed" && typeof code === "string" && /^E[A-Z0-9]+$/.test(code)
      ? code
      : undefined;
  const state =
    reason === "invalid" ? "is invalid" : `could not be read${errno ? ` (${errno})` : ""}`;
  return Object.assign(
    new StoreError(
      "legacy_upload_binding_unavailable",
      503,
      true,
      `historical upload ${operation} binding ${keyDigest} ${state}; restore ${file} under the daemon data root, then retry the same request with the same Idempotency-Key`,
      cause === undefined ? undefined : { cause },
    ),
    {
      requiredActions: [
        `Restore ${file} under the daemon data root (its original record and read access); deleting it does not repair the binding.`,
        "Retry the same request with the same Idempotency-Key.",
      ],
      context: { operation, keyDigest, reason, ...(errno ? { errno } : {}) },
    },
  );
}

function expired(row: ResourceRow | undefined, now: number): boolean {
  if (!row || (row.state !== "released" && row.state !== "expired")) return false;
  const releasedAt = row.releasedAt ?? (row.state === "expired" ? row.expiresAt : null);
  if (releasedAt === null) return false;
  const stamp = Date.parse(releasedAt);
  return Number.isFinite(stamp) && now - stamp >= UPLOAD_BINDING_RETENTION_MS;
}

/** SQL is authoritative once adopted. Historical files are point-read only on an enabled miss. */
export class UploadBindings {
  /** Store time at which the last scan reached the end of the keys. */
  private scannedAt: number | null = null;

  constructor(private readonly store: EngineStore) {}

  lookup(
    operation: UploadOperation,
    key: string,
    requestDigest: string,
    uploadId?: string,
  ): IdempotencyBinding | undefined {
    const address = {
      owner: "upload" as const,
      pid: 0,
      keyDigest: uploadKeyDigest(operation, key),
    };
    // Expired bindings are free even for a different request. Check their target before conflict.
    const target = this.store
      .prepare("SELECT target_id FROM idempotency WHERE owner='upload' AND pid=0 AND key_digest=?")
      .get(address.keyDigest) as { target_id: string } | undefined;
    if (target && this.targetExpired(target.target_id)) {
      runMutation(this.store, (tx) =>
        deleteTargetIdempotencyInTx(tx, "upload", 0, target.target_id),
      );
    }
    const saved = lookupIdempotency(this.store, address, requestDigest);
    // Keyed imports postdate the legacy file store; SQL is their only authority.
    if (saved || operation === "import") return saved;
    const enabled = this.store
      .prepare("SELECT value FROM meta WHERE key='legacy_idempotency_dir'")
      .get() as { value: string } | undefined;
    if (enabled?.value !== "present") return undefined;
    const legacy = this.readLegacy(operation, key, address.keyDigest);
    if (!legacy) return undefined;
    const targetId =
      operation === "create" ? (legacy.result as ControlUploadStatus).uploadId : uploadId!;
    const resource = operation === "finalize" ? (legacy.result as ControlResource) : undefined;
    // Metadata survives SQL cleanup, so a legacy JSON file cannot resurrect a retired binding.
    if (
      this.targetExpired(targetId) ||
      (resource &&
        expired(readResourceRow(this.store, resource.resourceId), this.store.now().getTime()))
    )
      return undefined;
    const binding: IdempotencyBinding = {
      ...address,
      operation,
      requestDigest: legacy.requestDigest,
      targetId,
      result: legacy.result,
      createdAt: this.store.now().toISOString(),
    };
    if (binding.requestDigest !== requestDigest)
      throw Object.assign(new Error("idempotency key was already used with a different request"), {
        code: "idempotency_conflict",
        status: 409,
      });
    runMutation(this.store, (tx) => {
      // Legacy finalize files have no upload id, but this exact request supplies it.
      // Keep a published target for lifetime accounting; never recreate resource bytes/metadata.
      if (resource && !readUploadRow(tx, targetId)) {
        putUploadInTx(tx, {
          request: {
            kind: resource.kind,
            mime: resource.mime,
            name: resource.name,
            sizeBytes: resource.sizeBytes,
            ...(resource.purpose ? { purpose: resource.purpose } : {}),
          },
          status: {
            uploadId: targetId,
            state: "uploaded",
            receivedBytes: resource.sizeBytes,
            expectedBytes: resource.sizeBytes,
          },
          state: "published",
          finalizeSha: null,
          resourceId: resource.resourceId,
        });
        tx.changes.uploadChanged(targetId);
      }
      bindIdempotencyInTx(tx, binding);
    });
    return binding;
  }

  /**
   * Delete the bindings of expired targets. Metadata rows remain so the point
   * fallback applies this same lifetime forever.
   *
   * One scan walks every upload binding in key order. A synchronous step reads
   * one window of rows or settles one batch of targets, then yields to
   * admission, so the scan's longest hold of the event loop is one such step
   * whatever the store holds. A target is confirmed by the test `lookup()`
   * applies, in the same step that deletes it. The signal ends the scan after
   * its current step; what it had not settled is found again by the next scan,
   * which starts from the first key. A scan that reached the last key is not
   * repeated before the regular age revisit: expiry depends on age alone, so
   * the pass that follows a truncated one a second later has nothing new to
   * find. `lookup()` applies the exact lifetime on every read; the scan only
   * reclaims rows, and a binding created inside the lifetime (a legacy receipt
   * adopted after its resource's release) waits for a later scan.
   */
  async prune(input: UploadBindingPrune = {}): Promise<UploadBindingScan> {
    const interrupted = () => input.signal?.aborted === true;
    if (interrupted()) return { removed: 0, interrupted: true };
    const now = this.store.now().getTime();
    const sinceScan = this.scannedAt === null ? null : now - this.scannedAt;
    // A clock that moved back proves nothing about elapsed time: scan.
    if (sinceScan !== null && sinceScan >= 0 && sinceScan < RETENTION_AGE_REVISIT_MS)
      return { removed: 0, interrupted: false };
    const window = input.window ?? RETENTION_ROW_WINDOW;
    const batch = input.batch ?? UPLOAD_BINDING_PRUNE_BATCH;
    const cutoff = new Date(now - UPLOAD_BINDING_RETENTION_MS).toISOString();
    const windowEnd = this.store.prepare(UPLOAD_BINDING_WINDOW_END_SQL);
    const candidates = this.store.prepare(UPLOAD_BINDING_WINDOW_SQL);
    // Targets SQL selected that no transaction has settled yet.
    const pending = new Set<string>();
    let removed = 0;
    const settle = () => {
      const targets = [...pending].slice(0, batch);
      const expired = targets.filter((id) => this.targetExpired(id));
      if (expired.length)
        removed += runMutation(this.store, (tx) =>
          expired.reduce((n, id) => n + deleteTargetIdempotencyInTx(tx, "upload", 0, id), 0),
        );
      for (const id of targets) pending.delete(id);
    };
    let cursor = "";
    while (!interrupted()) {
      const end = (windowEnd.get(cursor, window) as { k: string | null }).k;
      if (end !== null) {
        for (const row of candidates.all(cursor, end, cutoff) as Array<{ target_id: string }>)
          pending.add(row.target_id);
        cursor = end;
      }
      // A full batch settles before the next read; the rest settles after the last key.
      while (pending.size >= batch || (end === null && pending.size > 0)) {
        await yieldToAdmission();
        if (interrupted()) return { removed, interrupted: true };
        settle();
      }
      if (end === null) {
        this.scannedAt = this.store.now().getTime();
        return { removed, interrupted: false };
      }
      await yieldToAdmission();
    }
    return { removed, interrupted: true };
  }

  private targetExpired(id: string): boolean {
    const upload = readUploadRow(this.store, id);
    return (
      !!upload?.resourceId &&
      expired(readResourceRow(this.store, upload.resourceId), this.store.now().getTime())
    );
  }
  private readLegacy(
    operation: LegacyUploadBinding["operation"],
    key: string,
    digest: string,
  ): LegacyUploadBinding | undefined {
    let text: string;
    try {
      text = readFileSync(
        join(this.store.paths.resourceStore, "idempotency", `${digest}.json`),
        "utf8",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
      throw legacyBindingUnavailable(operation, digest, "read_failed", error);
    }
    let legacy: LegacyUploadBinding | undefined;
    try {
      legacy = parseLegacyUploadBinding(JSON.parse(text), operation, key);
    } catch (error) {
      throw legacyBindingUnavailable(operation, digest, "invalid", error);
    }
    if (!legacy) throw legacyBindingUnavailable(operation, digest, "invalid");
    return legacy;
  }
}
