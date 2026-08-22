import type {
  AuthPreference,
  CredentialProfile,
  CredentialProfileStatus,
  CredentialUnusableObservation,
  HarnessEvent,
  QuotaAbsence,
  QuotaSnapshot,
} from "@claudexor/schema";
import {
  CredentialProfileStatus as CredentialProfileStatusSchema,
  quotaSourceTraits,
} from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import { liveUnusableFor } from "./credential-cooldown.js";
export {
  effectiveLimitAction,
  limitSubjectRoute,
  nextEligibleProfile,
  planReactiveRotation,
  profileHeadroomBreach,
  rotateSpecOnTypedLimit,
  rotationRetryEligible,
  staticRotationCandidates,
  type ProfilePolicy,
} from "./credential-profile-rotation.js";
export { preflightDefaultSubject } from "./credential-preflight.js";

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

export async function selectedProfileAvailability(input: {
  registry: readonly CredentialProfile[];
  profileId?: string | null;
  harnessId: string;
  probe?: (profile: CredentialProfile) => Promise<CredentialProfileStatus>;
  /** The quota poller's authenticated vendor evidence, when the caller holds
   * it. Omitting it admits on the LOCAL store alone — which is the reading of
   * `verification: passed` that let a run dispatch into a revoked token. */
  quota?: VendorQuotaObservations | null;
  /** Live typed credential failures are stronger than a local LKG status.
   * Admission must reject the row before probing or dispatching it. */
  unusable?: readonly CredentialUnusableObservation[];
  model?: string | null;
  /** Only an already selected profile (explicit pin or durable binding) may
   * consume the adapter's bounded stale observation. Pool/rotation selection
   * remains fresh-only. */
  allowStale?: boolean;
}): Promise<string | null> {
  if (!input.profileId) return null;
  let profile: CredentialProfile;
  try {
    profile = resolveCredentialProfile(input.registry, input.profileId, input.harnessId);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const dead = liveUnusableFor(
    input.unusable ?? [],
    input.harnessId,
    profile.profile_id,
    input.model,
  );
  if (dead) {
    return `credential profile "${profile.profile_id}" credential is unusable (${dead.code})`;
  }
  if (!input.probe) return `harness "${input.harnessId}" has no profile probe`;
  const result = vendorVerifiedProfileStatus(
    await probeCredentialProfileStatus(profile, input.probe),
    input.quota,
  );
  return profileStatusAdmits(profile, result, { allowStale: input.allowStale === true })
    ? "available"
    : (result.detail ?? `${result.availability}/${result.verification}`);
}

/** What the quota poller's last authenticated vendor contact says about ONE
 * credential subject's liveness. Null = the poller has no verdict to offer. */
export type VendorCredentialObservation =
  | { outcome: "honored"; observed_at: string }
  | { outcome: "revoked"; observed_at: string; detail: string };

/**
 * The poller's verdict for one profile, if it has one (INV-135 honesty).
 *
 * The quota poller ALREADY calls the vendor once a minute with each profile's
 * own token; a fresh snapshot from such a call means the credential was
 * honored, and a typed `auth_revoked` absence means it was rejected. Reading
 * that existing evidence is why profile verification can be live without a
 * probe run — a config-dir login has no cheaper liveness test than spending
 * quota on a mini-run, so building one would cost exactly what it measures.
 */
export function vendorCredentialObservation(
  quota: { snapshots: readonly QuotaSnapshot[]; absences: readonly QuotaAbsence[] },
  harnessId: string,
  profileId: string,
): VendorCredentialObservation | null {
  const owns = (subject: QuotaSnapshot["subject"]): boolean =>
    subject.harness === harnessId && (subject.subject_id ?? null) === profileId;
  // A rejection outranks a cached success. The registry retires a snapshot the
  // vendor has contradicted, but snapshots and absences are read through two
  // separate calls, so a cycle landing between them can still hand this one
  // subject both. Reading the older success first is what made a revoked
  // credential report as honored; the fail-closed order is the honest one.
  const revoked = quota.absences.find(
    (item) => owns(item.subject) && item.reason === "auth_revoked",
  );
  if (revoked) {
    return {
      outcome: "revoked",
      observed_at: revoked.observed_at,
      detail: revoked.detail ?? "the vendor rejected this profile's credential",
    };
  }
  const snapshot = quota.snapshots.find(
    (item) => owns(item.subject) && quotaSourceTraits(item.source).vendorAuthenticated,
  );
  return snapshot ? { outcome: "honored", observed_at: snapshot.observed_at } : null;
}

/**
 * Overlay the vendor's verdict onto a locally-probed profile status, so
 * `verification` means what a router assumes it means.
 *
 * The overlay may DOWNGRADE freely — a rejected credential is a fact the local
 * store cannot see, and it is exactly the case that made a `passed` profile
 * fail a run one minute later. It may not UPGRADE: a local probe that already
 * said "this dir is logged in under the wrong method" knows something the usage
 * endpoint does not, so a successful vendor call only re-stamps provenance on
 * an already-passing verdict. Absent a verdict the status is returned
 * untouched, still declaring `local_store`.
 */
export function withVendorCredentialObservation(
  status: CredentialProfileStatus,
  observation: VendorCredentialObservation | null,
): CredentialProfileStatus {
  if (!observation) return status;
  if (observation.outcome === "revoked") {
    return {
      ...status,
      verification: "failed",
      verification_source: "vendor",
      detail: redactSecrets(observation.detail),
      last_verified_at: observation.observed_at,
    };
  }
  if (status.verification !== "passed") return status;
  return {
    ...status,
    verification_source: "vendor",
    last_verified_at: observation.observed_at,
  };
}

/** The quota poller's evidence for every subject: what an authenticated vendor
 *  call last returned, and which subjects it could not answer for. */
export interface VendorQuotaObservations {
  snapshots: readonly QuotaSnapshot[];
  absences: readonly QuotaAbsence[];
}

/**
 * The vendor-verified reading of ONE probed profile status — the single
 * composition behind every consumer of `profileStatusAdmits`: run admission,
 * rotation readiness, and the accounts projection. Keeping the overlay in one
 * place is the point: applying it on the listing branch alone is what let the
 * Accounts card say `revoked` while the router dispatched into the same token.
 *
 * `probeCredentialProfileStatus` guarantees the status carries its own
 * profile's identity, so the subject is read from the status itself. Without
 * quota evidence the local verdict stands untouched.
 */
export function vendorVerifiedProfileStatus(
  status: CredentialProfileStatus,
  quota: VendorQuotaObservations | null | undefined,
): CredentialProfileStatus {
  if (!quota) return status;
  return withVendorCredentialObservation(
    status,
    vendorCredentialObservation(quota, status.harness_id, status.profile_id),
  );
}

/** One readiness predicate shared by run admission and accounts projection. */
export function profileStatusAdmits(
  profile: Pick<CredentialProfile, "credential_kind">,
  result: { availability: string; verification: string; stale?: boolean },
  options: { allowStale?: boolean } = {},
): boolean {
  const verificationAdmits =
    result.verification === "passed" ||
    (profile.credential_kind === "api_key" && result.verification === "not_run");
  const staleSelectedRoute =
    options.allowStale === true &&
    profile.credential_kind === "config_dir_login" &&
    result.stale === true &&
    result.availability === "unknown" &&
    result.verification === "not_run";
  return (result.availability === "available" && verificationAdmits) || staleSelectedRoute;
}

/** One fail-closed profile doctor wrapper shared by Accounts and runtime
 * selection. Probe failures are readiness facts, never selector exceptions. */
export async function probeCredentialProfileStatus(
  profile: CredentialProfile,
  probe?: (profile: CredentialProfile) => Promise<CredentialProfileStatus>,
): Promise<CredentialProfileStatus> {
  if (!probe) {
    return {
      profile_id: profile.profile_id,
      harness_id: profile.harness_id,
      availability: "unknown",
      verification: "not_run",
      verification_source: "local_store",
      detail: `harness "${profile.harness_id}" has no profile probe`,
      last_verified_at: null,
    };
  }
  try {
    const result = CredentialProfileStatusSchema.parse(await probe(profile));
    if (result.profile_id !== profile.profile_id || result.harness_id !== profile.harness_id) {
      throw new Error("profile readiness probe returned status for a different profile");
    }
    return {
      ...result,
      ...(result.detail === undefined ? {} : { detail: redactSecrets(result.detail) }),
    };
  } catch (error) {
    return {
      profile_id: profile.profile_id,
      harness_id: profile.harness_id,
      availability: "unknown",
      verification: "not_run",
      verification_source: "local_store",
      detail: `profile readiness probe failed: ${redactSecrets(
        error instanceof Error ? error.message : String(error),
      )}`,
      last_verified_at: null,
    };
  }
}

/** Same precedence used by run admission: the first explicit route wins;
 * `auto` means fall through rather than shadow a more general setting. */
export function effectiveAuthPreference(
  ...values: Array<AuthPreference | null | undefined>
): AuthPreference {
  return (
    values.find((value) => value !== undefined && value !== null && value !== "auto") ?? "auto"
  );
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
