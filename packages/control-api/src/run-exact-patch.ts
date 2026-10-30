import { EXACT_PATCH_UNAVAILABLE_MESSAGE } from "@claudexor/delivery";
import { WorkProduct } from "@claudexor/schema";
import { sha256 } from "@claudexor/util";
import { PATCH_EXACT_BYTES_UNAVAILABLE, resolveExactPatch } from "@claudexor/workspace";
import { readRawTextArtifact, safeReadStructuredArtifact } from "./run-artifact-read.js";
import { recordedExecutionRoot } from "./run-delivery-state.js";
import type { DaemonRunRecord } from "./run-record.js";
import { projectionRead } from "./projection-context.js";

/**
 * The ONE interpretation point for a run's saved patch.
 *
 * `final/patch.diff` is byte-exact. Only a historical run whose work product
 * says `persisted_patch: redacted` saved a display-only copy with secret-like
 * strings hidden; every consumer that applies, checks, hashes or binds a
 * decision to "the patch" then reads that run's private exact patch object.
 * `unavailable` means that object is missing or corrupt: `patch` then still
 * holds the saved copy for display, and nothing may be applied from it.
 */
export function resolveRunPatch(
  rec: DaemonRunRecord,
  projectRoot: string | null,
  maxBytes?: number,
): { patch: string | null; unavailable: boolean } {
  return projectionRead(
    rec.runDir ?? rec.id,
    `exact-patch:${maxBytes ?? "all"}:${projectRoot}`,
    () => resolveUncached(rec, projectRoot, maxBytes),
  );
}

function resolveUncached(
  rec: DaemonRunRecord,
  projectRoot: string | null,
  maxBytes?: number,
): { patch: string | null; unavailable: boolean } {
  const saved = readRawTextArtifact(rec, "final/patch.diff", maxBytes);
  if (saved === null) return { patch: null, unavailable: false };
  const exact = resolveExactPatch({
    savedCopy: saved,
    meta: safeReadStructuredArtifact(rec, "final/work_product.yaml", WorkProduct, maxBytes)?.meta,
    roots: [projectRoot, recordedExecutionRoot(rec, maxBytes)],
    maxBytes,
  });
  return exact.ok
    ? { patch: exact.patch, unavailable: false }
    : { patch: saved, unavailable: true };
}

/** Exact patch for a mutating or digest-binding route. An unavailable exact
 * object is a typed 409 raised before any tree is touched. */
export function readExactRunPatch(rec: DaemonRunRecord, projectRoot: string | null): string | null {
  const resolved = resolveRunPatch(rec, projectRoot);
  if (resolved.unavailable) {
    throw Object.assign(new Error(EXACT_PATCH_UNAVAILABLE_MESSAGE), {
      status: 409,
      code: PATCH_EXACT_BYTES_UNAVAILABLE,
    });
  }
  return resolved.patch;
}

/** Digest a recorded operator decision must equal; null when there is no exact
 * patch to bind to (no artifact, or its exact bytes are unavailable). */
export function runPatchDigest(
  rec: DaemonRunRecord,
  projectRoot: string | null,
  maxBytes?: number,
): string | null {
  return projectionRead(
    rec.runDir ?? rec.id,
    `patch-digest:${maxBytes ?? "all"}:${projectRoot}`,
    () => {
      const resolved = resolveRunPatch(rec, projectRoot, maxBytes);
      return resolved.patch !== null && !resolved.unavailable ? sha256(resolved.patch) : null;
    },
  );
}
