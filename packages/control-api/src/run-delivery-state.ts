import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  ControlRunResult,
  RunDeliveryState,
  WorkProduct,
  type WorkspaceFilesManifest,
} from "@claudexor/schema";
import { nowIso } from "@claudexor/util";
import {
  deliverableWorkspaceChanges,
  releaseRetainedEnvelope,
  retainedEnvelopeOfRun,
} from "@claudexor/workspace";
import { safeArtifactRoot } from "./artifact-paths.js";
import { safeReadStructuredArtifact } from "./run-artifact-read.js";
import type { DaemonRunRecord } from "./run-record.js";

/** Revert targets the tree recorded at execution, even if its thread moved later. */
export function recordedExecutionRoot(rec: DaemonRunRecord, maxBytes?: number): string | null {
  const wp = safeReadStructuredArtifact(rec, "final/work_product.yaml", WorkProduct, maxBytes);
  return typeof wp?.meta["execution_root"] === "string" ? wp.meta["execution_root"] : null;
}

export function controlRunResult(rec: DaemonRunRecord, maxBytes?: number): ControlRunResult {
  const wp = safeReadStructuredArtifact(rec, "final/work_product.yaml", WorkProduct, maxBytes);
  const meta = (wp?.meta ?? {}) as Record<string, unknown>;
  const kindRaw = meta["result_kind"];
  const kind =
    kindRaw === "patch" ||
    kindRaw === "files" ||
    kindRaw === "answer" ||
    kindRaw === "plan" ||
    kindRaw === "report"
      ? kindRaw
      : "none";
  const ds = meta["diffstat"] as
    { files?: unknown; additions?: unknown; deletions?: unknown } | undefined;
  // Unknown is not zero: a Git result with no rendered patch has no line counts.
  const diffStat =
    ds &&
    typeof ds.files === "number" &&
    typeof ds.additions === "number" &&
    typeof ds.deletions === "number"
      ? { files: ds.files, additions: ds.additions, deletions: ds.deletions }
      : null;
  // Delivery/apply state is MUTABLE and lives in its own artifact
  // (final/delivery_state.yaml, V8/PLAN addendum 2); work_product.yaml is the
  // immutable run snapshot. Prefer the delivery-state overlay when present,
  // else fall back to the initial snapshot the orchestrator stamped.
  const delivery = readDeliveryState(rec, maxBytes);
  const applyStateRaw = delivery?.applyState ?? meta["apply_state"];
  const applyState =
    applyStateRaw === "applied" ||
    applyStateRaw === "applied_review_blocked" ||
    applyStateRaw === "reverted" ||
    applyStateRaw === "discarded"
      ? applyStateRaw
      : "not_applied";
  const preTurnSha = typeof meta["pre_turn_sha"] === "string" ? meta["pre_turn_sha"] : null;
  const postTurnSha =
    delivery?.postTurnSha ??
    (typeof meta["post_turn_sha"] === "string" ? meta["post_turn_sha"] : null);
  // An explicit null is a delivery that left no anchor: nothing older stands in.
  const revertAnchorId =
    delivery?.revertAnchorId !== undefined
      ? delivery.revertAnchorId
      : typeof meta["revert_anchor_id"] === "string"
        ? meta["revert_anchor_id"]
        : null;
  const revertable =
    (applyState === "applied" || applyState === "applied_review_blocked") &&
    revertAnchorId !== null;
  return ControlRunResult.parse({
    kind,
    diffStat,
    blockers: typeof meta["blockers"] === "number" ? meta["blockers"] : 0,
    adopted: typeof meta["adopted"] === "boolean" ? meta["adopted"] : null,
    applyState,
    preTurnSha,
    postTurnSha,
    revertAnchorId,
    revertable,
  });
}

/** Read the MUTABLE delivery/apply state overlay (final/delivery_state.yaml);
 * null when the run never delivered/reverted (its state is the immutable
 * work_product snapshot). */
export function readDeliveryState(
  rec: DaemonRunRecord,
  maxBytes?: number,
): RunDeliveryState | null {
  return safeReadStructuredArtifact(rec, "final/delivery_state.yaml", RunDeliveryState, maxBytes);
}

/** Flip the run's MUTABLE delivery/apply state after a successful apply or
 * revert — ONE owner of the durable outcome fact that controlRunResult
 * projects AND retention's hasActionableWorkProduct consumes (round-15 #2: an
 * applied-but-unmarked patch would read as actionable forever and pin the run
 * against GC). Writes final/delivery_state.yaml (V8/PLAN addendum 2), leaving
 * work_product.yaml immutable. Idempotent and best-effort: the delivery/revert
 * already happened; a metadata write failure must not 500 the response. */
export function markRunApplyState(
  rec: DaemonRunRecord,
  state: "applied" | "applied_review_blocked" | "reverted" | "discarded" | "not_applied",
  appliedPaths?: string[],
  required = false,
  /** The anchor of THIS delivery (an object delivery's actual pair). Null: it left
   * none, so no earlier anchor may answer for it. Omitted: it has nothing to say,
   * and the anchor already recorded stands. */
  deliveryAnchorId?: string | null,
): void {
  try {
    if (!rec.runDir) return;
    const root = safeArtifactRoot(rec.runDir);
    if (!root) return;
    const dsPath = join(root, "final", "delivery_state.yaml");
    const prev = existsSync(dsPath)
      ? (RunDeliveryState.safeParse(parseYaml(readFileSync(dsPath, "utf8"))).data ?? null)
      : null;
    // Carry the revert anchor / post-turn sha from the work_product snapshot
    // when this is the first delivery-state write.
    const wp = safeReadStructuredArtifact(rec, "final/work_product.yaml", WorkProduct);
    const meta = (wp?.meta ?? {}) as Record<string, unknown>;
    const next = RunDeliveryState.parse({
      appliedPaths: appliedPaths ?? prev?.appliedPaths,
      discardedAt: state === "discarded" ? nowIso() : prev?.discardedAt,
      applyState: state,
      deliveredAt: state === "applied" ? nowIso() : (prev?.deliveredAt ?? null),
      revertAnchorId:
        deliveryAnchorId !== undefined
          ? deliveryAnchorId
          : prev?.revertAnchorId !== undefined
            ? prev.revertAnchorId
            : typeof meta["revert_anchor_id"] === "string"
              ? meta["revert_anchor_id"]
              : null,
      postTurnSha:
        prev?.postTurnSha ??
        (typeof meta["post_turn_sha"] === "string" ? meta["post_turn_sha"] : null),
    });
    // Atomic tmp+rename: a crash mid-write must never leave the file half-written.
    const tmp = `${dsPath}.tmp-${process.pid}`;
    writeFileSync(tmp, stringifyYaml(next), "utf8");
    renameSync(tmp, dsPath);
    // Applying a kept stopped run's result is its disposition (A9): the
    // envelope retained for continueFrom is released, never kept twice.
    const kept = state === "applied" && rec.runId ? retainedEnvelopeOfRun(root, rec.runId) : null;
    if (kept) void releaseRetainedEnvelope(kept).catch(() => {});
  } catch (error) {
    if (required) throw error;
    /* best-effort: the revert succeeded regardless of this metadata flip */
  }
}

/** A files result is applied once every deliverable change of its manifest is. */
export function markFilesAppliedState(
  record: DaemonRunRecord,
  paths: string[],
  manifest: WorkspaceFilesManifest,
): void {
  const applied = [...new Set([...(readDeliveryState(record)?.appliedPaths ?? []), ...paths])];
  const complete =
    deliverableWorkspaceChanges(manifest).every((entry) => applied.includes(entry.path)) &&
    !manifest.entries.some((entry) => entry.before === "unknown" && entry.after !== null);
  markRunApplyState(record, complete ? "applied" : "not_applied", applied, true);
}
