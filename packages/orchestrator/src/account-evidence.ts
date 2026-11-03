import type {
  CredentialProfileStatus,
  CredentialRoute,
  CredentialUnusableObservation,
} from "@claudexor/schema";
import { quotaSourceTraits } from "@claudexor/schema";
import {
  vendorVerifiedProfileStatus,
  type VendorQuotaObservations,
} from "./credential-profiles.js";

export interface CredentialProfileEvidence {
  quota?: VendorQuotaObservations | null;
  unusable?: readonly CredentialUnusableObservation[];
  model?: string | null;
  route?: CredentialRoute | null;
}

/** Full vendor contact can recover auth independently of its numeric quota age. */
export function applicableCredentialUnusable(
  status: Pick<CredentialProfileStatus, "harness_id" | "profile_id">,
  evidence: CredentialProfileEvidence,
): CredentialUnusableObservation | null {
  const now = Date.now();
  for (const observation of evidence.unusable ?? []) {
    if (
      observation.harness_id !== status.harness_id ||
      observation.profile_id !== status.profile_id
    )
      continue;
    if (observation.model !== null && observation.model !== (evidence.model ?? null)) continue;
    if (
      observation.credential_route !== undefined &&
      evidence.route !== observation.credential_route
    )
      continue;
    if (Date.parse(observation.expires_at) <= now) continue;
    const honored =
      observation.code === "auth_revoked" &&
      (evidence.quota?.honored?.some(
        (item) =>
          item.harness_id === status.harness_id &&
          item.profile_id === status.profile_id &&
          item.model === null &&
          item.credential_route === (observation.credential_route ?? evidence.route) &&
          Date.parse(item.observed_at) > Date.parse(observation.observed_at),
      ) ||
        evidence.quota?.snapshots.some(
          (snapshot) =>
            snapshot.subject.harness === status.harness_id &&
            snapshot.subject.subject_id === status.profile_id &&
            (observation.credential_route === undefined ||
              snapshot.subject.credential_route === observation.credential_route) &&
            quotaSourceTraits(snapshot.source).vendorAuthenticated &&
            Date.parse(snapshot.observed_at) > Date.parse(observation.observed_at),
        ));
    if (!honored) return observation;
  }
  return null;
}

/** The live model-scoped observations of one row: each is one that a run of
 * exactly its model on this row would apply. Credential-wide (model null)
 * observations are excluded; `composeCredentialProfileEvidence` already
 * composes them into the row status. */
export function modelScopedCredentialUnusable(
  status: Pick<CredentialProfileStatus, "harness_id" | "profile_id">,
  evidence: Omit<CredentialProfileEvidence, "model">,
): Array<CredentialUnusableObservation & { model: string }> {
  return (evidence.unusable ?? []).filter(
    (observation): observation is CredentialUnusableObservation & { model: string } =>
      observation.model !== null &&
      applicableCredentialUnusable(status, {
        ...evidence,
        unusable: [observation],
        model: observation.model,
      }) !== null,
  );
}

/** Cheap live composition; the caller caches only the expensive local probe. */
export function composeCredentialProfileEvidence(
  status: CredentialProfileStatus,
  evidence: CredentialProfileEvidence,
): CredentialProfileStatus {
  const quota =
    evidence.quota && evidence.route
      ? {
          snapshots: evidence.quota.snapshots.filter(
            (snapshot) => snapshot.subject.credential_route === evidence.route,
          ),
          absences: evidence.quota.absences.filter(
            (absence) => absence.subject.credential_route === evidence.route,
          ),
          honored: evidence.quota.honored?.filter(
            (item) => item.credential_route === evidence.route,
          ),
        }
      : evidence.quota;
  const composed = vendorVerifiedProfileStatus(status, quota);
  const refusal = applicableCredentialUnusable(status, evidence);
  if (!refusal) return composed;
  return {
    ...composed,
    verification: "failed",
    verification_source: refusal.source === "local_probe" ? "local_store" : "vendor",
    detail: refusal.detail ?? `credential is unusable (${refusal.code})`,
    last_verified_at: refusal.observed_at,
  };
}
