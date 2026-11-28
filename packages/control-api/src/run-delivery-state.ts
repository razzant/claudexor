import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  ControlRunResult,
  RunDeliveryState,
  type RunTakenReason,
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

/** What a result reads of the run's own automatic directory delivery receipt: its
 * producer's statement that the whole manifest it delivered is on the target. A
 * receipt without it (a partial or unknown coverage, an older receipt) is no
 * evidence of an applied result. */
const AutomaticDelivery = {
  parse(value: unknown): { complete: boolean } {
    const coverage = (
      value as { manifestCoverage?: { complete?: unknown; manifestSha256?: unknown } }
    )?.manifestCoverage;
    if (typeof coverage?.complete !== "boolean" || typeof coverage.manifestSha256 !== "string")
      throw new Error("not a manifest-bound delivery receipt");
    return { complete: coverage.complete };
  },
};

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
  // A run whose automatic delivery reached the target but whose result could not be
  // published has no work product: its own receipt's manifest coverage states
  // whether the target holds the whole result.
  const automatic = wp
    ? null
    : safeReadStructuredArtifact(rec, "final/delivery_receipt.yaml", AutomaticDelivery, maxBytes);
  const applyStateRaw =
    delivery?.applyState ?? meta["apply_state"] ?? (automatic?.complete ? "applied" : undefined);
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
    adopted: typeof meta["adopted"] === "boolean" ? meta["adopted"] : (automatic?.complete ?? null),
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
      takenAt: prev?.takenAt,
      takenReason: prev?.takenReason,
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

/** Record that the caller has captured a terminal patch result. This is a
 * delivery-state overlay, not a second retention disposition: the immutable
 * work product and exact patch remain available until ordinary retention. */
export function markRunTaken(rec: DaemonRunRecord, reason: RunTakenReason): void {
  if (!rec.runDir) throw new Error("cannot record taken result without a run directory");
  const root = safeArtifactRoot(rec.runDir);
  if (!root) throw new Error("cannot record taken result outside the run artifact root");
  const dsPath = join(root, "final", "delivery_state.yaml");
  const prev = existsSync(dsPath)
    ? (RunDeliveryState.safeParse(parseYaml(readFileSync(dsPath, "utf8"))).data ?? null)
    : null;
  const wp = safeReadStructuredArtifact(rec, "final/work_product.yaml", WorkProduct);
  const meta = (wp?.meta ?? {}) as Record<string, unknown>;
  const next = RunDeliveryState.parse({
    applyState: prev?.applyState ?? controlRunResult(rec).applyState,
    appliedPaths: prev?.appliedPaths,
    discardedAt: prev?.discardedAt,
    deliveredAt: prev?.deliveredAt ?? null,
    revertAnchorId:
      prev?.revertAnchorId !== undefined
        ? prev.revertAnchorId
        : typeof meta["revert_anchor_id"] === "string"
          ? meta["revert_anchor_id"]
          : null,
    postTurnSha:
      prev?.postTurnSha ??
      (typeof meta["post_turn_sha"] === "string" ? meta["post_turn_sha"] : null),
    takenAt: prev?.takenAt ?? nowIso(),
    takenReason: prev?.takenReason ?? reason,
  });
  const tmp = `${dsPath}.tmp-${process.pid}`;
  writeFileSync(tmp, stringifyYaml(next), "utf8");
  renameSync(tmp, dsPath);
}

/** A files result is applied once every deliverable change of its manifest is.
 * Before any overlay, the run's own automatic delivery of this exact manifest
 * (the work product's `applied_paths`, bound by its `manifest_sha256`) counts. */
export function markFilesAppliedState(
  record: DaemonRunRecord,
  paths: string[],
  manifest: WorkspaceFilesManifest,
  manifestSha256?: string,
): void {
  const wp = safeReadStructuredArtifact(record, "final/work_product.yaml", WorkProduct);
  const automatic =
    manifestSha256 !== undefined &&
    wp?.meta["manifest_sha256"] === manifestSha256 &&
    Array.isArray(wp.meta["applied_paths"])
      ? (wp.meta["applied_paths"] as unknown[]).filter((path) => typeof path === "string")
      : [];
  const prev = readDeliveryState(record);
  const earlier = prev?.appliedPaths ?? (automatic as string[]);
  const deliverable = new Set(deliverableWorkspaceChanges(manifest).map((entry) => entry.path));
  // Only this manifest's deliverable changes count: unknown or unlisted paths never do.
  const applied = [...new Set([...earlier, ...paths])].filter((path) => deliverable.has(path));
  const complete =
    deliverableWorkspaceChanges(manifest).every((entry) => applied.includes(entry.path)) &&
    !manifest.entries.some((entry) => entry.before === "unknown" && entry.after !== null);
  const state = complete ? "applied" : "not_applied";
  // An overlay that already says this is not rewritten: its delivery time stays.
  if (
    prev?.applyState === state &&
    prev.appliedPaths?.length === applied.length &&
    applied.every((path) => prev.appliedPaths?.includes(path))
  )
    return;
  markRunApplyState(record, state, applied, true);
}
