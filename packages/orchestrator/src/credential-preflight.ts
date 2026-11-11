/**
 * PRE-SPAWN credential preflight of the LEGACY default subject (W5.4
 * `profile_headroom_preflight` + A4 live blocks + A5 pool-exhausted split),
 * split from `credential-profile-rotation` so each file stays under the
 * complexity cap. Under the unified account model (INV-135) this module
 * serves ONLY harnesses with no registered subscription rows (unmigrated
 * stores): pinned runs refuse strictly in the account-resolution owner
 * (D-U6 — a pin never rotates), and unpinned runs of migrated harnesses
 * route through the quota-aware account pool. Re-exported through
 * `credential-profiles` like its siblings.
 */
import type {
  CredentialProfile,
  CredentialUnusableObservation,
  QuotaSnapshot,
} from "@claudexor/schema";
import { credentialPoolExhausted, profileQuotaBlock } from "./credential-cooldown.js";
import {
  effectiveLimitAction,
  emitRotationExhausted,
  nextEligibleProfile,
  profileHeadroomBreach,
  type EmitFn,
  type ProfilePolicy,
} from "./credential-profile-rotation.js";
import { quotaRefusalBasis, quotaRefusalResetsAt } from "./quota-refusal-scope.js";

/**
 * Default-subject start selection (INV-135, owner scope "auto-balance"): when
 * NO profile is pinned, the EFFECTIVE action is `rotate` (explicit, or `auto`
 * on a subscription route — A6), and the DEFAULT store's own fresh quota
 * window is at/over the headroom bound, pick the first eligible SUBSCRIPTION
 * profile instead of spawning into a near-certain vendor limit. Explicit
 * `fail`/`ask` keep the pre-A6 default-user behavior untouched (strict
 * refusal is the PINNED lane's business, owned by account-resolution —
 * throwing here on a bare breach would brick every default user at 90%
 * quota). Unknown or stale usage never rotates.
 */
export function preflightDefaultSubject(args: {
  harnessId: string;
  policy: ProfilePolicy;
  registry: readonly CredentialProfile[];
  snapshots: readonly QuotaSnapshot[];
  readyProfileIds: ReadonlySet<string>;
  defaultRoute: "local_session" | "api_key" | null;
  unusable?: readonly CredentialUnusableObservation[];
  model?: string | null;
  emit: EmitFn;
}): CredentialProfile | null {
  const { harnessId, policy, registry, snapshots, readyProfileIds, defaultRoute, model, emit } =
    args;
  // A6: `auto` resolves by the DEFAULT subject's route — a subscription
  // default rotates, a metered or unknown default keeps today's behavior.
  const action = effectiveLimitAction(policy, defaultRoute);
  if (action !== "rotate" || defaultRoute !== "local_session") return null;
  const breach = profileHeadroomBreach(
    snapshots,
    harnessId,
    null,
    policy.headroom_threshold,
    model,
  );
  // Same A4 cooldown reader as the pinned lane: the default subject's own
  // observed live block (reactive cooldown / spent window) rotates too. The
  // guard above pins `defaultRoute === "local_session"`, so the block is read
  // for the SUBSCRIPTION default subject only.
  const block = profileQuotaBlock(snapshots, harnessId, null, defaultRoute, model);
  if (!breach && !block) return null;
  // One controlling evidence: a provider block outranks the reserve (#318).
  const refusal = quotaRefusalBasis(breach, block);
  emit("route.profile.headroom_exceeded", {
    harness_id: harnessId,
    profile_id: null,
    action,
    constraint_id: refusal?.constraintId ?? null,
    used_ratio: refusal?.usedRatio ?? null,
    threshold: policy.headroom_threshold,
    resets_at: quotaRefusalResetsAt(breach, block),
    basis: refusal?.basis ?? null,
  });
  const next = nextEligibleProfile(
    registry,
    harnessId,
    policy,
    null,
    snapshots,
    readyProfileIds,
    new Set(),
    model,
  );
  if (!next) {
    const candidates = emitRotationExhausted({
      current: null,
      harnessId,
      policy,
      registry,
      snapshots,
      readyProfileIds,
      unusable: args.unusable,
      model,
      reason: "profile_headroom_preflight",
      emit,
    });
    // Same A5 preflight split as the pinned lane: the DEFAULT subject's own
    // observed live block with no eligible alternative refuses typed before
    // spawn; a bare headroom breach proceeds (not proven spent).
    if (block) {
      throw credentialPoolExhausted({
        harnessId,
        model,
        profileId: null,
        reason: "profile_headroom_preflight",
        candidates,
        subjectLimit: { resets_at: block.resets_at },
      });
    }
    return null;
  }
  emit("route.profile.rotated", {
    harness_id: harnessId,
    from_profile_id: null,
    to_profile_id: next.profile_id,
    reason: "profile_headroom_preflight",
    constraint_id: breach?.constraint_id ?? block?.constraint_id ?? null,
    used_ratio: breach?.used_ratio ?? null,
    resets_at: block?.reopening ? null : (breach?.resets_at ?? block?.resets_at ?? null),
  });
  return next;
}
