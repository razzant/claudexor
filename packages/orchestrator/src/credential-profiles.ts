import type {
  CredentialProfile,
  HarnessEvent,
  HarnessRunSpec,
  QuotaSnapshot,
} from "@claudexor/schema";
import { HarnessRunSpec as HarnessRunSpecSchema } from "@claudexor/schema";

/**
 * The ONE resolve owner for credential profiles (INV-135): explicit id →
 * durable registry entry for exactly this harness. Unknown, disabled, or
 * harness-mismatched ids throw a typed refusal — an explicit profile must
 * never silently become the default credential ladder.
 */
export function resolveCredentialProfile(
  registry: readonly CredentialProfile[],
  wanted: string,
  harnessId: string,
): CredentialProfile {
  const match = registry.find((p) => p.profile_id === wanted && p.harness_id === harnessId);
  if (!match) {
    throw new Error(`credential profile "${wanted}" is not registered for harness "${harnessId}"`);
  }
  if (!match.enabled) {
    throw new Error(`credential profile "${wanted}" (${harnessId}) is disabled`);
  }
  return match;
}

export interface ProfilePolicy {
  limit_action: "fail" | "ask" | "rotate";
  rotation_eligible: string[];
  headroom_threshold: number;
}

/** Typed quota evidence for a profile over its headroom bound (provenance). */
export interface HeadroomBreach {
  constraint_id: string;
  used_ratio: number;
  threshold: number;
  resets_at: string | null;
}

/**
 * Proactive headroom check (W5.4 `profile_headroom_preflight`): the SELECTED
 * profile's freshest snapshot windows against the policy threshold. Unknown
 * usage is NOT a breach — rotation never triggers on missing data.
 */
export function profileHeadroomBreach(
  snapshots: readonly QuotaSnapshot[],
  harnessId: string,
  profileId: string | null,
  threshold: number,
): HeadroomBreach | null {
  for (const snapshot of snapshots) {
    // FRESH evidence only (release wave tier1 #3): a stale or unknown reading
    // must never breach headroom, rotate a profile away, or fail selection.
    if (snapshot.freshness !== "fresh") continue;
    if (snapshot.subject.harness !== harnessId) continue;
    if ((snapshot.subject.subject_id ?? null) !== profileId) continue;
    for (const constraint of snapshot.constraints) {
      if (constraint.used_ratio !== null && constraint.used_ratio >= threshold) {
        return {
          constraint_id: constraint.id,
          used_ratio: constraint.used_ratio,
          threshold,
          resets_at: constraint.resets_at,
        };
      }
    }
  }
  return null;
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
  excluded: ReadonlySet<string> = new Set(),
): CredentialProfile | null {
  const pool = registry.filter((p) => p.harness_id === harnessId && p.enabled);
  const ordered =
    policy.rotation_eligible.length > 0
      ? policy.rotation_eligible
          .map((id) => pool.find((p) => p.profile_id === id))
          .filter((p): p is CredentialProfile => p !== undefined)
      : pool;
  for (const candidate of ordered) {
    if (candidate.profile_id === current?.profile_id) continue;
    if (excluded.has(candidate.profile_id)) continue;
    // Fail-CLOSED kind guard (round-17 hardening of the round-16 BLOCK): the
    // kind comes from the TYPED current profile in hand — never re-found in
    // a freshly reloaded pool, where a mid-flight disable/remove of the
    // current profile would have silently dropped the cross-kind prohibition.
    if (current !== null && candidate.credential_kind !== current.credential_kind) continue;
    if (
      profileHeadroomBreach(snapshots, harnessId, candidate.profile_id, policy.headroom_threshold)
    )
      continue;
    return candidate;
  }
  return null;
}

/**
 * `rotation_retry_eligible` (sol #30): a failover retry is allowed ONLY when
 * the attempt saw a TYPED vendor limit AND produced no deliverable and no
 * workspace mutation — a partially-acted attempt never silently reruns.
 */
export function rotationRetryEligible(input: {
  sawTypedLimit: boolean;
  deliverableEmpty: boolean;
}): boolean {
  return input.sawTypedLimit && input.deliverableEmpty;
}

type EmitFn = (
  type: "route.profile.headroom_exceeded" | "route.profile.rotated",
  payload: Record<string, unknown>,
) => void;

/**
 * `profile_headroom_preflight` (W5.4): BEFORE spawn, the selected profile's
 * freshest quota windows are checked against the policy threshold. A breach
 * is always a typed event; `rotate` swaps to the next eligible profile with
 * provenance, `ask`/`fail` proceed on the selected profile — the runtime
 * `vendor_limit_rejected` evidence stays the terminating truth.
 */
export function preflightCredentialProfile(args: {
  profile: CredentialProfile;
  harnessId: string;
  policy: ProfilePolicy;
  registry: readonly CredentialProfile[];
  snapshots: readonly QuotaSnapshot[];
  emit: EmitFn;
}): CredentialProfile {
  const { profile, harnessId, policy, registry, snapshots, emit } = args;
  const breach = profileHeadroomBreach(
    snapshots,
    harnessId,
    profile.profile_id,
    policy.headroom_threshold,
  );
  if (!breach) return profile;
  emit("route.profile.headroom_exceeded", {
    harness_id: harnessId,
    profile_id: profile.profile_id,
    action: policy.limit_action,
    constraint_id: breach.constraint_id,
    used_ratio: breach.used_ratio,
    threshold: breach.threshold,
    resets_at: breach.resets_at,
  });
  if (policy.limit_action === "fail") {
    // The documented FAIL action fails (release wave tier1 #4): a FRESH breach
    // under fail refuses before spawn with the evidence, instead of silently
    // proceeding into a vendor rejection.
    throw new Error(
      `credential profile "${profile.profile_id}" (${harnessId}) is over its headroom threshold ` +
        `(${breach.constraint_id} at ${Math.round(breach.used_ratio * 100)}% >= ${Math.round(breach.threshold * 100)}%; ` +
        `limit_action=fail${breach.resets_at ? `; resets ${breach.resets_at}` : ""})`,
    );
  }
  if (policy.limit_action !== "rotate") return profile;
  const next = nextEligibleProfile(registry, harnessId, policy, profile, snapshots);
  if (!next) return profile;
  emit("route.profile.rotated", {
    harness_id: harnessId,
    from_profile_id: profile.profile_id,
    to_profile_id: next.profile_id,
    reason: "profile_headroom_preflight",
    constraint_id: breach.constraint_id,
    used_ratio: breach.used_ratio,
    resets_at: breach.resets_at,
  });
  return next;
}

/**
 * Reactive failover plan (`vendor_limit_rejected`, W5.4): rotation fires ONLY
 * on the typed predicate under a `rotate` policy, marks the current profile
 * tried (at most once per attempt each), and returns the next target with
 * provenance already emitted — or null when the attempt must fail as-is.
 */
export function planReactiveRotation(args: {
  currentProfile: CredentialProfile;
  harnessId: string;
  attemptId: string;
  policy: ProfilePolicy;
  registry: readonly CredentialProfile[];
  snapshots: readonly QuotaSnapshot[];
  triedProfiles: Set<string>;
  sawTypedLimit: boolean;
  deliverableEmpty: boolean;
  lastLimit: { retryDelayMs: number | null; resetsAt: string | null } | null;
  emit: EmitFn;
}): CredentialProfile | null {
  if (!rotationRetryEligible(args)) return null;
  if (args.policy.limit_action !== "rotate") return null;
  args.triedProfiles.add(args.currentProfile.profile_id);
  const next = nextEligibleProfile(
    args.registry,
    args.harnessId,
    args.policy,
    args.currentProfile,
    args.snapshots,
    args.triedProfiles,
  );
  if (!next) return null;
  args.emit("route.profile.rotated", {
    harness_id: args.harnessId,
    attempt_id: args.attemptId,
    from_profile_id: args.currentProfile.profile_id,
    to_profile_id: next.profile_id,
    reason: "vendor_limit_rejected",
    retry_delay_ms: args.lastLimit?.retryDelayMs ?? null,
    resets_at: args.lastLimit?.resetsAt ?? null,
  });
  return next;
}

/**
 * INV-135 at the engine boundary: a cached vendor session resumes ONLY under
 * exactly the profile it was recorded with (null-default equality included) —
 * regardless of what the caller's map claims. Preflight rotation changing the
 * profile therefore starts fresh.
 */
export function resumeSessionForProfile(
  cached: { sessionId: string; profileId: string | null } | undefined,
  profile: CredentialProfile | null,
): string | null {
  if (!cached) return null;
  return (cached.profileId ?? null) === (profile?.profile_id ?? null) ? cached.sessionId : null;
}

/**
 * Record a harness-emitted native session id for future thread resume; the
 * observer never fails the run. profileId is the adapter's per-event stamp —
 * the EFFECTIVE profile (rotation makes it differ from the requested id).
 */
export function observeNativeSessionEvent(
  input:
    | {
        onSessionObserved?: (
          harnessId: string,
          nativeSessionId: string,
          observedModel?: string | null,
          profileId?: string | null,
        ) => void;
      }
    | undefined,
  harnessId: string,
  ev: HarnessEvent,
): void {
  if (!input?.onSessionObserved || ev.type !== "started") return;
  const nid = ev.payload?.["native_session_id"];
  if (typeof nid === "string" && nid.length > 0) {
    try {
      input.onSessionObserved(
        harnessId,
        nid,
        ev.observed_model ?? null,
        ev.credential_profile_id ?? null,
      );
    } catch {
      /* observer errors must never fail the run */
    }
  }
}

/**
 * Shared reactive-failover step for BOTH lanes: given the attempt's typed
 * evidence, plan a rotation and rebuild the spec on a NEW vendor session
 * under the next profile — or return null when the attempt must fail as-is.
 */
export function rotateSpecOnTypedLimit(args: {
  spec: HarnessRunSpec;
  harnessId: string;
  attemptId: string;
  policy: ProfilePolicy;
  registry: readonly CredentialProfile[];
  snapshots: readonly QuotaSnapshot[];
  triedProfiles: Set<string>;
  sawTypedLimit: boolean;
  deliverableEmpty: boolean;
  lastLimit: { retryDelayMs: number | null; resetsAt: string | null } | null;
  emit: EmitFn;
  newSessionId: () => string;
}): HarnessRunSpec | null {
  if (!args.spec.credential_profile) return null;
  const rotation = planReactiveRotation({
    currentProfile: args.spec.credential_profile,
    harnessId: args.harnessId,
    attemptId: args.attemptId,
    policy: args.policy,
    registry: args.registry,
    snapshots: args.snapshots,
    triedProfiles: args.triedProfiles,
    sawTypedLimit: args.sawTypedLimit,
    deliverableEmpty: args.deliverableEmpty,
    lastLimit: args.lastLimit,
    emit: args.emit,
  });
  if (!rotation) return null;
  return HarnessRunSpecSchema.parse({
    ...args.spec,
    session_id: args.newSessionId(),
    credential_profile: rotation,
    resume_session_id: null,
  });
}
