/**
 * A7: the failure-triggered DIFFERENTIAL probe of the CURRENT credential
 * subject, and the rotation-readiness composition that consumes its typed
 * `credential_unusable` observations.
 *
 * When an attempt dies rotation-eligible, knowing "quota spent" (come back at
 * reset — A4's cooldown evidence) apart from "credential dead" (a reset will
 * never help — re-login or entitlement change required) is what stops the pool
 * from burning attempts rediscovering the same dead credential. The probe is
 * deliberately CHEAP: it re-reads evidence that already exists — the quota
 * poller's authenticated vendor observations, the attempt's own typed
 * non-retryable refusals, and the adapter's local doctor probe. It NEVER
 * spawns a harness or spends quota: a config-dir login has no cheaper liveness
 * test than spending quota on a mini-run, so building one would cost exactly
 * what it measures (the credential-profiles design essay).
 *
 * Verdict precedence is evidence strength: a typed refusal the vendor just
 * sent on THIS attempt's stream outranks the poller's last cycle, which
 * outranks a local doctor probe. Quota evidence (cooldown/spent windows) is
 * deliberately NOT a verdict here — that is A4's lane and needs no
 * observation.
 */
import type {
  CredentialProfile,
  CredentialProfileStatus,
  CredentialUnusableObservation,
  QuotaAbsence,
  CredentialRoute,
} from "@claudexor/schema";
import { staticRotationCandidates, type ProfilePolicy } from "./credential-profile-rotation.js";
import {
  probeCredentialProfileStatus,
  profileStatusAdmits,
  vendorVerifiedProfileStatus,
  vendorCredentialObservation,
  type VendorQuotaObservations,
} from "./credential-profiles.js";
import type { TransientFailureObservation } from "./transientClassify.js";
import { composeCredentialProfileEvidence } from "./account-evidence.js";

/** Bounded per-code TTLs (clearing contract, half one: self-expiry). A vendor
 * credential rejection is high-confidence and worth hours; an entitlement/probe verdict can
 * be model- or configuration-shaped, so it self-heals within the hour even if
 * nothing clears it earlier. The ledger clamps every write to 24h max. */
const UNUSABLE_TTL_MS: Record<CredentialUnusableObservation["code"], number> = {
  auth_revoked: 6 * 60 * 60_000,
  capability_refused: 60 * 60_000,
  verification_failed: 60 * 60_000,
};

function observation(
  args: { harnessId: string; profileId: string | null; now: Date },
  code: CredentialUnusableObservation["code"],
  source: CredentialUnusableObservation["source"],
  model: string | null,
  detail: string | null,
): CredentialUnusableObservation {
  return {
    harness_id: args.harnessId,
    profile_id: args.profileId,
    model,
    code,
    source,
    detail,
    observed_at: args.now.toISOString(),
    expires_at: new Date(args.now.getTime() + UNUSABLE_TTL_MS[code]).toISOString(),
  };
}

/** Derived decision evidence, never a second stored credential verdict. */
function pollerRejection(absence: QuotaAbsence): CredentialUnusableObservation {
  return {
    ...observation(
      {
        harnessId: absence.subject.harness,
        profileId: absence.subject.subject_id,
        now: new Date(absence.observed_at),
      },
      "auth_revoked",
      "vendor_poller",
      null,
      absence.detail,
    ),
    credential_route: absence.subject.credential_route,
    expires_at: new Date(Date.now() + UNUSABLE_TTL_MS.auth_revoked).toISOString(),
  };
}

export function pollerCredentialRejections(
  quota: VendorQuotaObservations,
): CredentialUnusableObservation[] {
  return quota.absences
    .filter((row) => {
      if (row.reason !== "auth_revoked") return false;
      const route = row.subject.credential_route;
      const evidence = {
        snapshots: quota.snapshots.filter((item) => item.subject.credential_route === route),
        absences: quota.absences.filter((item) => item.subject.credential_route === route),
        honored: quota.honored?.filter((item) => item.credential_route === route),
      };
      return (
        vendorCredentialObservation(evidence, row.subject.harness, row.subject.subject_id)
          ?.outcome === "revoked"
      );
    })
    .map(pollerRejection);
}

/**
 * The cheap typed stream intake and the ONE owner of a refusal's scope, which
 * follows what the vendor's typed category proves, never whether the run named
 * a model (`model: null` on an observation means credential-wide):
 * - an auth rejection condemns the credential for every model;
 * - a denial of subscription access the adapter proved (`entitlementDenied`: the
 *   vendor's exact `oauth_org_not_allowed` code or its recorded result, never a
 *   category inferred from prose) condemns that credential for every model on
 *   the observed subscription route, and proves nothing about an API key or
 *   another route;
 * - any other capability refusal concerns the model the run requested: a known
 *   model stays exact, and a run that named none proves nothing about the
 *   credential, so nothing is recorded and the diagnostics stay the run's own.
 * No profile probing or routing policy.
 */
export function credentialStreamRefusal(args: {
  harnessId: string;
  profileId: string | null;
  model: string | null;
  route?: CredentialRoute;
  refusal: TransientFailureObservation;
  now?: Date;
}): CredentialUnusableObservation | null {
  const { refusal } = args;
  if (refusal.retryable || !["auth_failed", "capability_refused"].includes(refusal.category))
    return null;
  const authFailed = refusal.category === "auth_failed";
  const credentialWide =
    authFailed || (refusal.entitlementDenied === true && args.route === "vendor_native");
  if (!credentialWide && args.model === null) return null;
  return {
    ...observation(
      { harnessId: args.harnessId, profileId: args.profileId, now: args.now ?? new Date() },
      authFailed ? "auth_revoked" : "capability_refused",
      "attempt_stream",
      credentialWide ? null : args.model,
      refusal.adapterCode,
    ),
    ...(args.route ? { credential_route: args.route } : {}),
  };
}

/**
 * The differential verdict for ONE subject, from evidence that already exists.
 * Returns a typed observation ONLY when the evidence distinguishes a dead
 * credential from spent quota; "quota spent" and "inconclusive" both return
 * null (rotation's cooldown/limit machinery already owns those).
 */
export async function differentialSubjectVerdict(args: {
  harnessId: string;
  /** The triggering subject: a pinned profile, or null for the default. */
  profile: CredentialProfile | null;
  model: string | null;
  route?: CredentialRoute | null;
  quota: VendorQuotaObservations;
  /** THIS try's typed failure observations from the attempt stream. */
  transients: readonly TransientFailureObservation[];
  /** The adapter's local doctor probe, when it has one (profiles only). */
  probe?: (profile: CredentialProfile) => Promise<CredentialProfileStatus>;
  now?: Date;
}): Promise<CredentialUnusableObservation | null> {
  const profileId = args.profile?.profile_id ?? null;
  const route =
    args.route ??
    (args.profile
      ? args.profile.credential_kind === "api_key"
        ? "managed_api_key"
        : "vendor_native"
      : null);
  const ctx = { harnessId: args.harnessId, profileId, now: args.now ?? new Date() };
  // 1. The attempt's own stream: a typed NON-RETRYABLE auth/entitlement refusal
  // the vendor just sent under this exact credential, in the scope
  // `credentialStreamRefusal` proves for it; the try's broadest proven scope
  // wins. A refusal that proves nothing about this credential is no verdict, so
  // the independent evidence below still answers.
  const verdicts = args.transients.flatMap(
    (refusal) =>
      credentialStreamRefusal({ ...ctx, model: args.model, route: route ?? undefined, refusal }) ??
      [],
  );
  const streamVerdict = verdicts.find((verdict) => verdict.model === null) ?? verdicts[0];
  if (streamVerdict) return streamVerdict;
  // 2. The quota poller's last authenticated vendor contact: a typed
  // `auth_revoked` absence means the vendor rejected this subject's own token.
  const quota = route
    ? {
        snapshots: args.quota.snapshots.filter((item) => item.subject.credential_route === route),
        absences: args.quota.absences.filter((item) => item.subject.credential_route === route),
        honored: args.quota.honored?.filter((item) => item.credential_route === route),
      }
    : args.quota;
  const rejected = pollerCredentialRejections(quota).find(
    (item) => item.harness_id === args.harnessId && item.profile_id === profileId,
  );
  if (rejected) return rejected;
  // 3. The local doctor probe (pinned profiles only — the default subject has
  // no per-profile probe surface): a FAILED verification, vendor overlay
  // included, is a dead-credential fact the quota path cannot see.
  if (args.profile && args.probe) {
    const status = vendorVerifiedProfileStatus(
      await probeCredentialProfileStatus(args.profile, args.probe),
      quota,
    );
    if (status.verification === "failed") {
      return observation(ctx, "verification_failed", "local_probe", null, status.detail ?? null);
    }
  }
  return null;
}

/**
 * Factory for the SIBLING probe `rotateSpecOnTypedLimit` fires next to its
 * candidate-readiness probe (grok amendment: the current subject is
 * structurally excluded from `staticRotationCandidates`, so it gets its own
 * call, never a seat in the candidate list). Records the observation through
 * the caller's sink when one is configured; the rotation module owns the run
 * event.
 */
export function currentSubjectProber(args: {
  harnessId: string;
  profile: CredentialProfile | null;
  model: string | null;
  route?: CredentialRoute | null;
  quota: VendorQuotaObservations;
  transients: readonly TransientFailureObservation[];
  probe?: (profile: CredentialProfile) => Promise<CredentialProfileStatus>;
  record?: (obs: CredentialUnusableObservation) => void;
}): () => Promise<CredentialUnusableObservation | null> {
  return async () => {
    const verdict = await differentialSubjectVerdict(args);
    if (verdict) {
      try {
        args.record?.(verdict);
      } catch {
        /* the evidence sink must never fail the rotation decision */
      }
    }
    return verdict;
  };
}

/**
 * Unpinned profile readiness for one rotation decision epoch (hoisted from the
 * orchestrator so the composition lives beside the probe it siblings).
 * Accounts uses the same probe wrapper + vendor overlay + admission predicate
 * when projecting next_up. A LIVE `credential_unusable` observation refuses a
 * candidate at this SAME composition point (A7): rotating INTO a profile we
 * observed dead would spend a whole attempt to rediscover the refusal.
 */
export async function readyProfilesForRotation(args: {
  registry: readonly CredentialProfile[];
  harnessId: string;
  policy: ProfilePolicy;
  current: Pick<CredentialProfile, "profile_id" | "credential_kind"> | null;
  excluded?: ReadonlySet<string>;
  probe?: (profile: CredentialProfile) => Promise<CredentialProfileStatus>;
  quota: VendorQuotaObservations;
  unusable?: readonly CredentialUnusableObservation[];
  model?: string | null;
}): Promise<ReadonlySet<string>> {
  const profiles = staticRotationCandidates({
    registry: args.registry,
    harnessId: args.harnessId,
    policy: args.policy,
    current: args.current,
    excluded: args.excluded ?? new Set(),
  });
  const entries = await Promise.all(
    profiles.map(async (profile) => ({
      profile,
      // Rotating INTO a profile the vendor has already rejected would spend a
      // whole attempt to rediscover the 401 the poller reported a minute ago.
      status: composeCredentialProfileEvidence(
        await probeCredentialProfileStatus(profile, args.probe),
        {
          quota: args.quota,
          unusable: args.unusable,
          model: args.model,
          route: profile.credential_kind === "api_key" ? "managed_api_key" : "vendor_native",
        },
      ),
    })),
  );
  return new Set(
    entries
      .filter(({ profile, status }) =>
        // Pool and rotation choices are unpinned by construction (a pin
        // never rotates): a last positive after a timeout may admit (#363).
        profileStatusAdmits(profile, status, { unpinned: true }),
      )
      .map(({ profile }) => profile.profile_id),
  );
}
