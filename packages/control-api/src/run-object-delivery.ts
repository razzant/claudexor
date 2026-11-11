import { deliveryRefusalCode } from "@claudexor/delivery";
import {
  createPairRevertAnchorOrNull,
  createRevertAnchorFromPatchOrNull,
} from "@claudexor/workspace";
import type { GitDeliveryPair } from "@claudexor/schema";
import { runRepoRoot } from "./run-apply-projection.js";
import { markRunApplyState } from "./run-delivery-state.js";
import { runDeliverable } from "./run-exact-patch.js";
import type { DaemonRunRecord } from "./run-record.js";

/**
 * After an applied object delivery (#535), anchor its actual pair (T, M) so the
 * delivered tree is revertable on that pair, then record the applied state with
 * that anchor. A legacy patch delivery records the state as before.
 */
export async function markRunAppliedWithPair(
  record: DaemonRunRecord,
  delivered?: { deliveryPair?: GitDeliveryPair },
  root?: string,
): Promise<void> {
  // No pair (a legacy patch, a replay that kept none): the anchor on record stands.
  const anchor =
    delivered?.deliveryPair && root
      ? await createPairRevertAnchorOrNull(
          root,
          delivered.deliveryPair,
          runRepoRoot(record) ?? root,
        )
      : undefined;
  markRunApplyState(record, "applied", undefined, false, anchor);
}

/**
 * A delivery that could not take its write back left the target changed, so the
 * run is not `not_applied` (INV-114): its live bytes are recorded review-blocked
 * and revertable, like a failed in-place turn's. A commit that exists (a `pr`
 * whose push and checkout back both failed), or a write taken back with HEAD
 * stranded on its branch, leaves branch state no revert anchor returns, so it is
 * recorded without one. Any other delivery records nothing.
 */
export async function markRunWriteLeft(
  record: DaemonRunRecord,
  delivered: {
    applied: boolean;
    treeMutated?: boolean;
    deliveryPair?: GitDeliveryPair;
    commit?: string;
    headStranded?: boolean;
  },
  root: string,
  patch: string,
): Promise<{ revertable: boolean } | null> {
  if (delivered.applied || delivered.treeMutated !== true) return null;
  const anchor =
    delivered.commit || delivered.headStranded
      ? null
      : delivered.deliveryPair
        ? await createPairRevertAnchorOrNull(
            root,
            delivered.deliveryPair,
            runRepoRoot(record) ?? root,
          )
        : createRevertAnchorFromPatchOrNull(root, patch);
  markRunApplyState(record, "applied_review_blocked", undefined, false, anchor);
  return { revertable: anchor !== null };
}

/**
 * A refused delivery as its wire problem, the way `patch_exact_bytes_unavailable`
 * is one: the delivery owner's typed reason is the problem code (the route's
 * `delivery_refused` only when the owner has none); the paths it concerns and a
 * write that stayed on the target ride as context, and a write that stayed also
 * names its recovery.
 */
export function deliveryRefusedError(
  delivered: Parameters<typeof deliveryRefusalCode>[0] & {
    detail?: string;
    treeMutated?: boolean;
    refusal?: { paths: string[]; pathCount: number };
  },
  fallbackCode: string,
  /** What `markRunWriteLeft` recorded for this delivery. */
  left: { revertable: boolean } | null,
): Error {
  const code = deliveryRefusalCode(delivered) ?? fallbackCode;
  const { refusal, treeMutated } = delivered;
  const recovery = !treeMutated
    ? null
    : left?.revertable
      ? [
          "the run is recorded applied_review_blocked and can be reverted once the cause is fixed",
          "Fix the cause, then revert the run with the revert_run decision",
        ]
      : [
          "the run is recorded applied_review_blocked without a revert anchor for this write",
          "Fix the cause, then restore the target by hand: this write has no revert anchor",
        ];
  const message = [delivered.detail ?? "delivery refused", recovery?.[0]].filter(Boolean);
  return Object.assign(new Error(message.join("; ")), {
    status: 409,
    code,
    ...(recovery ? { requiredActions: [recovery[1]] } : {}),
    context: {
      ...(treeMutated ? { treeMutated: true } : {}),
      ...(refusal?.pathCount
        ? { paths: refusal.paths.slice(0, 32), pathCount: refusal.pathCount }
        : {}),
    },
  });
}

/** The object-aware members of the manual apply route context. */
export const objectApplyRouteCtx = {
  readDeliverable: (record: DaemonRunRecord) => runDeliverable(record, runRepoRoot(record)),
  projectRoot: (record: DaemonRunRecord) => runRepoRoot(record),
  markApplied: markRunAppliedWithPair,
};

export const runDeliverableOf = (record: DaemonRunRecord) =>
  runDeliverable(record, runRepoRoot(record));

/** Store owner and project of a run's deliveries: the run directory keeps their objects. */
export function deliveryCustody(record: DaemonRunRecord, root: string) {
  return { projectRoot: runRepoRoot(record) ?? root, owner: record.runDir };
}
