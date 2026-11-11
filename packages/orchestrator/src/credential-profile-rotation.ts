import { quotaConstraintAppliesToRequestKind, type QuotaRequestKind } from "@claudexor/schema";
import type {
  CredentialProfile,
  CredentialUnusableObservation,
  HarnessRunSpec,
  QuotaSnapshot,
} from "@claudexor/schema";
import {
  HarnessRunSpec as HarnessRunSpecSchema,
  RouteCredentialUnusablePayload,
  quotaWindowFreshness,
} from "@claudexor/schema";
import { quotaConstraintAppliesToModel } from "@claudexor/budget";
import { stampCredentialProfileSelection } from "@claudexor/core";
import {
  credentialPoolExhausted,
  poolMemberEvidence,
  profileQuotaBlock,
  type PoolExhaustionCandidate,
  type QuotaBlock,
} from "./credential-cooldown.js";
import type { AttemptOutputMarkers } from "./attemptOutputMarkers.js";
import { noteRefusedBeforeProgress } from "./pre-progress-refusal.js";
import { pinnedTypedLimit } from "./quota-refusal-scope.js";
import { applicableCredentialUnusable } from "./account-evidence.js";
import {
  reactiveRotationEvidence,
  rotationRetryEligible,
  type RotationEvidence,
} from "./rotation-predicate.js";

export { rotationRetryEligible, type RotationEvidence } from "./rotation-predicate.js";

export interface ProfilePolicy {
  limit_action: "auto" | "fail" | "ask" | "rotate";
  rotation_eligible: string[];
  headroom_threshold: number;
}

/** The typed auth route of the subject a limit decision is about: a pinned
 * profile's credential kind, or the default subject's pre-spawn route
 * estimate. `null` = honestly unknown (an unresolved default route). */
export type SubjectRoute = "local_session" | "api_key" | null;

/** The route of a limit decision's subject: a pinned profile decides by its
 * own credential kind; the default subject decides by the caller's route
 * estimate. ONE owner, so every consumer classifies the subject alike. */
export function limitSubjectRoute(
  profile: Pick<CredentialProfile, "credential_kind"> | null,
  defaultRoute: SubjectRoute = null,
): SubjectRoute {
  if (!profile) return defaultRoute;
  return profile.credential_kind === "api_key" ? "api_key" : "local_session";
}

/**
 * THE effective-policy resolver (A6, owner decision 1=A): the stored default
 * `auto` resolves BY CREDENTIAL KIND — `rotate` for subscription
 * (`local_session`) subjects, `fail` for metered API-key or unknown routes —
 * while explicitly persisted `fail`/`ask`/`rotate` pass through untouched
 * (3=A: a stored value is never reinterpreted, only ABSENT changed meaning).
 * Every `limit_action` comparison in the engine and every projection
 * (`next_up`, Accounts) resolves through this one function, so admission and
 * display can never disagree about what `auto` does (INV-135).
 */
export function effectiveLimitAction(
  policy: Pick<ProfilePolicy, "limit_action">,
  route: SubjectRoute,
): "fail" | "ask" | "rotate" {
  if (policy.limit_action !== "auto") return policy.limit_action;
  return route === "local_session" ? "rotate" : "fail";
}

/** Typed quota evidence for a profile over its headroom bound (provenance). */
export interface HeadroomBreach {
  constraint_id: string;
  used_ratio: number;
  threshold: number;
  resets_at: string | null;
}

/**
 * Static rotation candidates, before any credential-backed readiness probe.
 * One owner applies policy order, enabled/harness scope, current identity,
 * already-tried exclusions, and the payment-kind fence. Callers then probe
 * only identities that could actually be selected.
 */
export function staticRotationCandidates(args: {
  registry: readonly CredentialProfile[];
  harnessId: string;
  policy: ProfilePolicy;
  current: Pick<CredentialProfile, "profile_id" | "credential_kind"> | null;
  excluded?: ReadonlySet<string>;
}): CredentialProfile[] {
  const pool = args.registry.filter(
    (profile) => profile.harness_id === args.harnessId && profile.enabled,
  );
  const ordered =
    args.policy.rotation_eligible.length > 0
      ? args.policy.rotation_eligible
          .map((id) => pool.find((profile) => profile.profile_id === id))
          .filter((profile): profile is CredentialProfile => profile !== undefined)
      : pool;
  const excluded = args.excluded ?? new Set<string>();
  return ordered.filter((candidate) => {
    if (candidate.profile_id === args.current?.profile_id) return false;
    if (excluded.has(candidate.profile_id)) return false;
    if (args.current !== null && candidate.credential_kind !== args.current.credential_kind) {
      return false;
    }
    // The default subject is vendor-native subscription state; it never probes
    // or rotates into a metered API-key identity.
    if (args.current === null && candidate.credential_kind === "api_key") return false;
    return true;
  });
}

/**
 * Proactive headroom check (W5.4 `profile_headroom_preflight`): the SELECTED
 * profile's freshest snapshot windows against the policy threshold. Unknown
 * usage is NOT a breach — rotation never triggers on missing data. The first
 * breaching window is reported unless a provider-spent (100%) window breaches.
 */
export function profileHeadroomBreach(
  snapshots: readonly QuotaSnapshot[],
  harnessId: string,
  profileId: string | null,
  threshold: number,
  model?: string | null,
  requestKind?: QuotaRequestKind,
  now: number = Date.now(),
): HeadroomBreach | null {
  let breach: HeadroomBreach | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.subject.harness !== harnessId) continue;
    if ((snapshot.subject.subject_id ?? null) !== profileId) continue;
    for (const constraint of snapshot.constraints) {
      // FRESH evidence only, judged per window at this decision (tier1 #3, #457).
      if (quotaWindowFreshness(snapshot, constraint, now) !== "fresh") continue;
      if (!quotaConstraintAppliesToRequestKind(constraint, requestKind)) continue;
      if (!quotaConstraintAppliesToModel(constraint, model)) continue;
      if (constraint.used_ratio === null || constraint.used_ratio < threshold) continue;
      // A provider-spent window outranks a softer reserve breach in any order (#318).
      if (breach && constraint.used_ratio < 1) continue;
      breach = {
        constraint_id: constraint.id,
        used_ratio: constraint.used_ratio,
        threshold,
        resets_at: constraint.resets_at,
      };
      if (constraint.used_ratio >= 1) return breach;
    }
  }
  return breach;
}

/**
 * The next rotation target after `currentProfileId` (W5.4): policy order wins
 * (`rotation_eligible`), else every enabled profile of the harness in registry
 * order. The current profile and disabled/unknown ids never come back; a
 * profile already over the headroom bound is skipped (rotating INTO a spent
 * subscription is not a failover). Cross-subscription rotation of one vendor
 * is allowed by owner decision — but rotation NEVER crosses credential kinds
 * (release wave round-16 BLOCK): a subscription→API-key swap silently changes
 * the payment model mid-attempt, and the attempt's first-wins auth-route
 * receipt (decided once before spawn) would misvalue metered usage as
 * subscription entitlement, bypassing a finite cash cap.
 */
export function nextEligibleProfile(
  registry: readonly CredentialProfile[],
  harnessId: string,
  policy: ProfilePolicy,
  current: Pick<CredentialProfile, "profile_id" | "credential_kind"> | null,
  snapshots: readonly QuotaSnapshot[],
  readyProfileIds: ReadonlySet<string>,
  excluded: ReadonlySet<string> = new Set(),
  model?: string | null,
): CredentialProfile | null {
  for (const candidate of staticRotationCandidates({
    registry,
    harnessId,
    policy,
    current,
    excluded,
  })) {
    if (!readyProfileIds.has(candidate.profile_id)) continue;
    if (
      profileHeadroomBreach(
        snapshots,
        harnessId,
        candidate.profile_id,
        policy.headroom_threshold,
        model,
      )
    )
      continue;
    // Rotating INTO a subject whose own observed windows are still cooling or
    // spent (A4) is not a failover — it burns an attempt to rediscover the
    // limit the registry already holds, stale-but-live evidence included.
    if (
      profileQuotaBlock(
        snapshots,
        harnessId,
        candidate.profile_id,
        limitSubjectRoute(candidate),
        model,
      )
    )
      continue;
    return candidate;
  }
  return null;
}

export type EmitFn = (
  type:
    | "route.profile.headroom_exceeded"
    | "route.profile.rotated"
    | "route.profile.rotation_exhausted"
    | "route.profile.credential_unusable",
  payload: Record<string, unknown>,
) => void;

/** The per-candidate rejection evidence of one exhausted rotation decision:
 * why each registered identity of the harness could not take over, with its
 * own quota evidence (headroom breach / observed block) when it has any. ONE
 * builder feeds both the `route.profile.rotation_exhausted` event and the
 * typed pool-exhausted terminal, so they can never disagree. */
function rotationExhaustionCandidates(args: {
  current: Pick<CredentialProfile, "profile_id" | "credential_kind"> | null;
  harnessId: string;
  policy: ProfilePolicy;
  registry: readonly CredentialProfile[];
  snapshots: readonly QuotaSnapshot[];
  readyProfileIds: ReadonlySet<string>;
  excluded?: ReadonlySet<string>;
  unusable?: readonly CredentialUnusableObservation[];
  model?: string | null;
}) {
  const excluded = args.excluded ?? new Set<string>();
  return args.registry
    .filter((profile) => profile.harness_id === args.harnessId && profile.enabled)
    .map((profile) => {
      const breach = profileHeadroomBreach(
        args.snapshots,
        args.harnessId,
        profile.profile_id,
        args.policy.headroom_threshold,
        args.model,
      );
      // Observed-limit evidence (A4): a candidate skipped because its own
      // windows are cooling/spent says so machine-readably, with the earliest
      // known release instant, instead of hiding behind "not_selected".
      const block: QuotaBlock | null = profileQuotaBlock(
        args.snapshots,
        args.harnessId,
        profile.profile_id,
        limitSubjectRoute(profile),
        args.model,
      );
      // A7: a candidate refused because ITS CREDENTIAL was observed dead says
      // so typed, instead of hiding behind "not_ready" — a dead credential is
      // not a readiness hiccup, and its quota evidence never carries a
      // reopen promise.
      const dead = applicableCredentialUnusable(
        { harness_id: args.harnessId, profile_id: profile.profile_id },
        {
          unusable: args.unusable,
          quota: { snapshots: args.snapshots, absences: [] },
          model: args.model,
          route: profile.credential_kind === "api_key" ? "managed_api_key" : "vendor_native",
        },
      );
      const rejected =
        profile.profile_id === args.current?.profile_id
          ? "current"
          : args.policy.rotation_eligible.length > 0 &&
              !args.policy.rotation_eligible.includes(profile.profile_id)
            ? "not_in_rotation_policy"
            : excluded.has(profile.profile_id)
              ? "already_tried"
              : args.current && profile.credential_kind !== args.current.credential_kind
                ? "credential_kind_mismatch"
                : args.current === null && profile.credential_kind === "api_key"
                  ? "credential_kind_mismatch"
                  : dead
                    ? "credential_unusable"
                    : !args.readyProfileIds.has(profile.profile_id)
                      ? "not_ready"
                      : breach
                        ? "headroom_exceeded"
                        : block
                          ? "cooldown"
                          : "not_selected";
      return {
        profile_id: profile.profile_id,
        credential_kind: profile.credential_kind,
        rejected,
        headroom: breach,
        cooldown: block,
        unusable: dead ? { code: dead.code, source: dead.source } : null,
        resets_at: block?.reopening ? null : (breach?.resets_at ?? block?.resets_at ?? null),
      };
    });
}

export function emitRotationExhausted(args: {
  current: Pick<CredentialProfile, "profile_id" | "credential_kind"> | null;
  harnessId: string;
  policy: ProfilePolicy;
  registry: readonly CredentialProfile[];
  snapshots: readonly QuotaSnapshot[];
  readyProfileIds: ReadonlySet<string>;
  excluded?: ReadonlySet<string>;
  unusable?: readonly CredentialUnusableObservation[];
  attemptId?: string;
  model?: string | null;
  reason:
    "profile_headroom_preflight" | "vendor_limit_rejected" | "structural_pre_progress_failure";
  emit: EmitFn;
}): PoolExhaustionCandidate[] {
  const candidates = rotationExhaustionCandidates(args);
  args.emit("route.profile.rotation_exhausted", {
    harness_id: args.harnessId,
    attempt_id: args.attemptId,
    from_profile_id: args.current?.profile_id ?? null,
    reason: args.reason,
    threshold: args.policy.headroom_threshold,
    candidates,
  });
  // The same rows feed the typed pool-exhausted terminal (A5): the event and
  // the failure must never disagree about why each candidate was rejected.
  return candidates;
}

/**
 * Reactive failover plan (`vendor_limit_rejected` / structural, W5.4 + A2):
 * rotation fires ONLY on the typed evidence predicate under a `rotate`
 * policy, marks the current profile tried (at most once per attempt each),
 * and returns the next target with provenance already emitted — or null when
 * the attempt must fail as-is.
 * `currentProfile: null` is the DEFAULT subject: allowed ONLY when the caller
 * proves the attempt's pre-spawn route was vendor_native (a metered default
 * hitting a limit is a budget fact, not a subscription to fail over from).
 */
export function planReactiveRotation(args: {
  currentProfile: CredentialProfile | null;
  defaultRouteWasVendorNative?: boolean;
  harnessId: string;
  attemptId: string;
  policy: ProfilePolicy;
  registry: readonly CredentialProfile[];
  snapshots: readonly QuotaSnapshot[];
  readyProfileIds: ReadonlySet<string>;
  triedProfiles: Set<string>;
  evidence: RotationEvidence;
  lastLimit: { retryDelayMs: number | null; resetsAt: string | null } | null;
  unusable?: readonly CredentialUnusableObservation[];
  model?: string | null;
  emit: EmitFn;
}): CredentialProfile | null {
  if (!rotationRetryEligible(args.evidence)) return null;
  const route = limitSubjectRoute(
    args.currentProfile,
    args.defaultRouteWasVendorNative === true ? "local_session" : null,
  );
  if (effectiveLimitAction(args.policy, route) !== "rotate") return null;
  if (args.currentProfile === null && args.defaultRouteWasVendorNative !== true) return null;
  if (args.currentProfile) args.triedProfiles.add(args.currentProfile.profile_id);
  // Honest provenance: a structural rotation names its own reason — no typed
  // vendor limit was observed, so `vendor_limit_rejected` would be fabricated.
  const reason = args.evidence.sawTypedLimit
    ? ("vendor_limit_rejected" as const)
    : ("structural_pre_progress_failure" as const);
  const next = nextEligibleProfile(
    args.registry,
    args.harnessId,
    args.policy,
    args.currentProfile,
    args.snapshots,
    args.readyProfileIds,
    args.triedProfiles,
    args.model,
  );
  if (!next) {
    emitRotationExhausted({
      current: args.currentProfile,
      harnessId: args.harnessId,
      policy: args.policy,
      registry: args.registry,
      snapshots: args.snapshots,
      readyProfileIds: args.readyProfileIds,
      excluded: args.triedProfiles,
      unusable: args.unusable,
      attemptId: args.attemptId,
      model: args.model,
      reason,
      emit: args.emit,
    });
    return null;
  }
  args.emit("route.profile.rotated", {
    harness_id: args.harnessId,
    attempt_id: args.attemptId,
    from_profile_id: args.currentProfile?.profile_id ?? null,
    to_profile_id: next.profile_id,
    reason,
    retry_delay_ms: args.lastLimit?.retryDelayMs ?? null,
    resets_at: args.lastLimit?.resetsAt ?? null,
  });
  return next;
}

/**
 * Shared reactive-failover step for BOTH lanes: fold the try's lane-local
 * facts + output markers into the typed rotation evidence, probe candidate
 * readiness ONLY when the predicate could actually fire (the probe spends
 * seconds), then plan a rotation and rebuild the spec on a NEW vendor session
 * under the next profile. `null` = the failure was never rotation's business
 * (fail as-is: transient machinery, plain errors), or the pool ran out with
 * NO credential evidence anywhere (the evidence gate below) so the attempt
 * keeps its true failure. `{ poolExhausted }` = the
 * failure WAS rotation-eligible under a `rotate` policy, the pool has
 * nowhere left to go, and the decision carries credential evidence — the
 * attempt must terminalize on this typed refusal
 * BEFORE the transient gate can burn same-profile retries on the
 * already-refused subject (A5 ordering: a typed vendor limit classifies as
 * retryable-transient, so falling through would retry the spent credential).
 * Callers invoke this only after the try ended in a terminal error.
 */
export async function rotateSpecOnTypedLimit(args: {
  requestRefused?: boolean;
  spec: HarnessRunSpec;
  harnessId: string;
  attemptId: string;
  policy: ProfilePolicy;
  registry: readonly CredentialProfile[];
  /** The quota authority's current projection (#457). Read once per eligible
   * decision, after both probes, so a reset or replacement recorded while the
   * try ran or readiness was probed is seen; selection, the
   * `rotation_exhausted` event and the typed terminal share that one value. */
  quotaSnapshots: () => readonly QuotaSnapshot[];
  /** Fresh candidate-readiness probe (readyProfileIdsForRotation); called at
   * most once, and only for an eligible try under a `rotate` policy. */
  probeReadyProfiles: () => Promise<ReadonlySet<string>>;
  /** A7 SIBLING probe of the CURRENT/triggering subject (never a candidate —
   * `staticRotationCandidates` excludes the current identity structurally):
   * existing poller/stream/doctor evidence only, never a spawned mini-run.
   * Fires exactly when the candidate probe fires; a typed verdict is emitted,
   * recorded, and carried into the pool terminal's provenance. */
  probeCurrentSubject?: () => Promise<CredentialUnusableObservation | null>;
  /** Live typed `credential_unusable` observations for this decision epoch —
   * candidates they condemn are refused with a typed reason. */
  liveUnusable?: readonly CredentialUnusableObservation[];
  /** #363: remember THIS row's started-then-refused try for later unpinned
   * runs (ordering evidence only; never consulted by this decision). */
  notePreProgressRefusal?: () => void;
  triedProfiles: Set<string>;
  markers: AttemptOutputMarkers;
  sawTypedLimit: boolean;
  sawRetryable: boolean;
  attemptErrored: boolean;
  deliverableEmpty: boolean;
  /** Candidate lane only: the workspace diff is non-empty. The read-only lane
   * omits it — file_change markers are its only mutation truth. */
  workspaceDiffNonEmpty?: boolean;
  /** The try's last typed limit; `constraintId` when the vendor named its window. */
  lastLimit: {
    retryDelayMs: number | null;
    resetsAt: string | null;
    constraintId?: string | null;
    reopening?: "unknown" | null;
  } | null;
  emit: EmitFn;
  newSessionId: () => string;
  /** Pre-spawn route estimate for a profile-less spec: default-subject
   * rotation is allowed ONLY off a vendor_native attempt. */
  defaultRouteWasVendorNative?: boolean;
  /** D-U6 (unified account model): an EXPLICIT pin is strict — a typed vendor
   * limit fails the attempt with its evidence, never a silent rotation onto a
   * sibling account. Pool-selected rows (unpinned runs) still rotate. */
  pinned?: boolean;
}): Promise<HarnessRunSpec | { poolExhausted: Error } | null> {
  const current = args.spec.credential_profile ?? null;
  const evidence = reactiveRotationEvidence(args);
  if (args.pinned) {
    // Strict pin (D-U6): never rotate. A TYPED vendor limit on the pinned
    // subject still terminalizes TYPED — `subscription_window_exhausted` with
    // the limit's own reset — BEFORE the transient gate burns same-profile
    // retries on the already-refused subject (the A5 ordering, preserved for
    // pins). Anything else (structural/untyped deaths) fails as-is.
    if (current && evidence.sawTypedLimit && rotationRetryEligible(evidence)) {
      return {
        poolExhausted: pinnedTypedLimit(current.profile_id, args.harnessId, args.lastLimit),
      };
    }
    return null;
  }
  noteRefusedBeforeProgress(args);
  const route = limitSubjectRoute(
    current,
    args.defaultRouteWasVendorNative === true ? "local_session" : null,
  );
  const eligible =
    effectiveLimitAction(args.policy, route) === "rotate" &&
    rotationRetryEligible(evidence) &&
    (current !== null || args.defaultRouteWasVendorNative === true);
  if (!eligible) return null;
  const readyProfileIds = await args.probeReadyProfiles();
  // A7: the differential probe of the CURRENT subject rides the same eligible
  // decision as the candidate probe — quota-spent stays A4's cooldown story,
  // while a dead credential becomes a typed, emitted, recorded observation.
  const subjectUnusable = (await args.probeCurrentSubject?.()) ?? null;
  if (subjectUnusable) {
    args.emit(
      "route.profile.credential_unusable",
      RouteCredentialUnusablePayload.parse({ ...subjectUnusable, attempt_id: args.attemptId }),
    );
  }
  const snapshots = args.quotaSnapshots();
  const rotation = planReactiveRotation({
    currentProfile: current,
    defaultRouteWasVendorNative: args.defaultRouteWasVendorNative,
    harnessId: args.harnessId,
    attemptId: args.attemptId,
    policy: args.policy,
    registry: args.registry,
    snapshots,
    readyProfileIds,
    triedProfiles: args.triedProfiles,
    evidence,
    lastLimit: args.lastLimit,
    unusable: args.liveUnusable,
    model: args.spec.model_hint,
    emit: args.emit,
  });
  if (!rotation) {
    // planReactiveRotation already emitted `route.profile.rotation_exhausted`;
    // rebuild the same rows (same pure inputs, no second event) for the typed
    // terminal. The subject's own limit joins the fold from the freshest
    // source available: its registry block (default subject has no row), else
    // the typed limit just observed on the stream — the registry may not have
    // ingested it yet, and its unknown reset then honestly nulls the fold.
    const candidates = rotationExhaustionCandidates({
      current,
      harnessId: args.harnessId,
      policy: args.policy,
      registry: args.registry,
      snapshots,
      readyProfileIds,
      excluded: args.triedProfiles,
      unusable: args.liveUnusable,
      model: args.spec.model_hint,
    });
    // The default subject reached here only via the vendor-native eligibility
    // gate above, so its registry row is the SUBSCRIPTION default — never the
    // managed-api-key default that shares subject_id=null.
    const subjectBlock =
      current === null
        ? profileQuotaBlock(snapshots, args.harnessId, null, "local_session", args.spec.model_hint)
        : null;
    const subjectLimit =
      subjectBlock ??
      (evidence.sawTypedLimit ? { resets_at: args.lastLimit?.resetsAt ?? null } : null);
    // A pool terminal must explain the CURRENT failure. Earlier or untried
    // accounts' quota stays diagnostic; it cannot erase this subject's
    // structural failure or invent a reset that would repair its request.
    const subjectEvidence = subjectLimit !== null || subjectUnusable !== null;
    const poolEvidence = candidates.some(
      (candidate) => candidate.profile_id === current?.profile_id && poolMemberEvidence(candidate),
    );
    if (!subjectEvidence && !poolEvidence) return null;
    return {
      poolExhausted: credentialPoolExhausted({
        harnessId: args.harnessId,
        model: args.spec.model_hint,
        requestKind: "text", // Agent/Ask completion, not an image-generation operation.
        profileId: current?.profile_id ?? null,
        reason: evidence.sawTypedLimit
          ? "vendor_limit_rejected"
          : "structural_pre_progress_failure",
        candidates,
        subjectLimit,
        subjectUnusable,
      }),
    };
  }
  const rotated = HarnessRunSpecSchema.parse({
    ...args.spec,
    session_id: args.newSessionId(),
    credential_profile: rotation,
    resume_session_id: null,
  });
  // A rotation is an unpinned choice by construction: a pin returned above.
  stampCredentialProfileSelection(rotated, { pinned: false });
  return rotated;
}
