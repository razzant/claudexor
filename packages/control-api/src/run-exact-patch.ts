import { EXACT_PATCH_UNAVAILABLE_MESSAGE, type ObjectDelivery } from "@claudexor/delivery";
import { WorkProduct, type GitObjectResult } from "@claudexor/schema";
import { sha256 } from "@claudexor/util";
import {
  PATCH_EXACT_BYTES_UNAVAILABLE,
  resolveExactPatch,
  verifiedGitObjectResult,
} from "@claudexor/workspace";
import {
  artifactReadFault,
  readRawTextArtifact,
  readStructured,
  readTextArtifact,
} from "./run-artifact-read.js";
import { recordedExecutionRoot } from "./run-delivery-state.js";
import type { DaemonRunRecord } from "./run-record.js";
import { projectionRead } from "./projection-context.js";

const WORK_PRODUCT = "final/work_product.yaml";

/**
 * The meta of the run's work-product record: undefined when the record is not there
 * (ENOENT, ENOTDIR, not a regular file) or names nothing (it does not parse). A record
 * that is there but cannot be read (EACCES, EIO) says nothing about the result, and
 * reading it as absent made a mutating route answer "no patch artifact" (404) and a
 * decision "missing patch evidence": it is refused typed instead
 * (`artifact_read_failed`, 503). A bounded read keeps its own typed refusal.
 */
function workProductMeta(rec: DaemonRunRecord, maxBytes?: number) {
  return projectionRead(
    WorkProduct,
    `${rec.runDir ?? rec.id}:${maxBytes ?? "all"}:${WORK_PRODUCT}:strict`,
    () => {
      let text: string | null = null;
      try {
        text = readTextArtifact(rec, WORK_PRODUCT, maxBytes);
      } catch (error) {
        const fault = artifactReadFault(WORK_PRODUCT, error);
        if (fault !== error || (error as { status?: number }).status === 503) throw fault;
      }
      try {
        return readStructured(text, ".yaml", WorkProduct)?.meta;
      } catch {
        return undefined;
      }
    },
  );
}

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
    meta: workProductMeta(rec, maxBytes),
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

/** The run's verified object result (#535): canonical whenever recorded. A
 * descriptor whose digest does not match itself is never trusted; a record that
 * cannot be read is refused typed, never read as "no result" ({@link workProductMeta}). */
export function runGitResult(rec: DaemonRunRecord, maxBytes?: number): GitObjectResult | null {
  return verifiedGitObjectResult(workProductMeta(rec, maxBytes)?.["git_result"]);
}

/** Digest a recorded operator decision must equal: digest v1 of an object
 * result, else the exact patch digest; null when there is nothing to bind to. */
export function runPatchDigest(
  rec: DaemonRunRecord,
  projectRoot: string | null,
  maxBytes?: number,
): string | null {
  return projectionRead(
    rec.runDir ?? rec.id,
    `patch-digest:${maxBytes ?? "all"}:${projectRoot}`,
    () => {
      const result = runGitResult(rec, maxBytes);
      if (result) return result.digest;
      const resolved = resolveRunPatch(rec, projectRoot, maxBytes);
      return resolved.patch !== null && !resolved.unavailable ? sha256(resolved.patch) : null;
    },
  );
}

/**
 * What a mutating route delivers: the object result with its exact rendered
 * view (null when unrendered or its exact bytes are unavailable — `pr` then
 * refuses typed), or the legacy exact patch. `null` = nothing to deliver.
 */
export function runDeliverable(
  rec: DaemonRunRecord,
  projectRoot: string | null,
): { deliverable: string | ObjectDelivery; patch: string; digest: string } | null {
  const result = runGitResult(rec);
  if (result) {
    const view = resolveRunPatch(rec, projectRoot);
    const rendered = view.patch !== null && !view.unavailable ? view.patch : null;
    return {
      deliverable: { result, renderedPatch: rendered },
      patch: rendered ?? "",
      digest: result.digest,
    };
  }
  const patch = readExactRunPatch(rec, projectRoot);
  return patch === null ? null : { deliverable: patch, patch, digest: sha256(patch) };
}
