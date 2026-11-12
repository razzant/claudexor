import { ControlResourceRelease, ControlResourceReleaseRequest } from "@claudexor/schema";
import { deleteUnownedInlineInTx } from "./blob-files.js";
import { runMutation } from "./mutation.js";
import {
  assertResourceId,
  purposeMismatch,
  putResourceInTx,
  readResourceRow,
  resourceError,
  resourceSha,
  type ResourceRow,
} from "./resource-rows.js";
import type { EngineStore } from "./store.js";

function receipt(storeId: string, row: ResourceRow): ControlResourceRelease {
  return ControlResourceRelease.parse({
    storeId,
    resourceId: row.resource.resourceId,
    sha256: row.resource.sha256,
    state: "released",
    releasedAt: row.releasedAt,
  });
}

/**
 * Release one MANAGED ordinary resource (#249): its caller relinquishes every
 * future reference to the ID. Only the row's state changes, in one transaction;
 * every accepted holder (`resource_use`) and every other live resource with the
 * same digest keep the bytes, so the blob GC that follows frees nothing they
 * need. Naturally idempotent: a repeat answers the first release unchanged.
 * Refusals precede any effect. `sha` is set when this call released the row.
 */
export function releaseManagedResource(
  store: EngineStore,
  id: string,
  raw: unknown,
): { receipt: ControlResourceRelease; sha: string | null } {
  const request = ControlResourceReleaseRequest.parse(raw);
  const storeId = store.storeId;
  if (!storeId)
    throw Object.assign(
      resourceError("durable store identity is unavailable", 503, "resource_release_unavailable"),
      { retryable: true },
    );
  if (request.expectedStoreId !== storeId)
    throw resourceError("this release names another durable store", 409, "store_mismatch");
  assertResourceId(id);
  const row = readResourceRow(store, id);
  if (!row) throw resourceError(`no such resource: ${id}`, 404, "resource_not_found");
  if (row.resource.purpose !== undefined) throw purposeMismatch();
  if (row.resource.sha256 !== request.sha256)
    throw resourceError(
      "the release names another digest than this resource",
      409,
      "resource_digest_mismatch",
    );
  if (row.resource.lifetime !== "managed")
    throw Object.assign(
      resourceError(
        "this resource keeps indefinite reuse; only a managed import can be released",
        409,
        "resource_lifetime_indefinite",
      ),
      { retryable: false },
    );
  if (row.state === "released") return { receipt: receipt(storeId, row), sha: null };
  if (row.state !== "ready")
    throw Object.assign(
      resourceError("resource publication is still in progress", 409, "resource_unavailable"),
      { retryable: true },
    );
  const sha = resourceSha(row.resource);
  const released = runMutation(store, (tx) => {
    const current = readResourceRow(tx, id)!;
    if (current.state === "released") return current;
    const next: ResourceRow = { ...current, state: "released", releasedAt: tx.now().toISOString() };
    putResourceInTx(tx, next);
    deleteUnownedInlineInTx(tx, sha);
    tx.changes.blobChanged(sha);
    return next;
  });
  return { receipt: receipt(storeId, released), sha };
}
