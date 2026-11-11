/**
 * Per-harness POOL AUTHORITY projection of the unified account model
 * (INV-135): every account is a named registry row; `accountPools` carries
 * the routing facts (who an UNPINNED run routes to next), computed ONCE on
 * the server by the same pool owner run admission uses so no surface
 * re-derives it. The legacy `harnessAccounts` carrier stays on the wire as
 * `[]` for strict old clients; its native "CLI login" pseudo-row is gone —
 * detected default-store logins are auto-registered as ordinary rows at
 * daemon start.
 */
import type {
  AccountIdentity,
  ControlHarnessAccountPool,
  CredentialProfile,
  CredentialProfileStatus,
  CredentialUnusableObservation,
  QuotaSnapshot,
} from "@claudexor/schema";
import { estimateEffectiveAuthRoute } from "@claudexor/schema";
import { loadConfig } from "@claudexor/config";
import {
  effectiveAuthPreference,
  composeCredentialProfileEvidence,
  probeCredentialProfileStatus,
  profileStatusAdmits,
  selectFromAccountPool,
  type VendorQuotaObservations,
} from "@claudexor/orchestrator";
import type { HarnessStatus } from "@claudexor/gateway";
import type { AccountEvidence } from "@claudexor/daemon";
import { credentialProfilePolicyState } from "@claudexor/core";
import { displayAccountObservation, profileAccountIdentity } from "./account-observations.js";
import { buildGateway, buildRegistry } from "./registry.js";

/**
 * Doctor readiness projection for one credential profile (INV-135) — the ONE
 * live probe the accounts response and the profile mutation receipts share.
 * Adapters without profile support report an honest unknown.
 */
export async function profileDoctorStatus(
  profile: CredentialProfile,
  platform: NodeJS.Platform = process.platform,
): Promise<CredentialProfileStatus> {
  const adapter = buildRegistry().get(profile.harness_id);
  const policy = credentialProfilePolicyState({ adapter, registry: [profile], platform });
  if (!profile.enabled && disabledProfileSharesOsUserCredential(policy)) {
    return inactiveProfileStatus(profile, "This profile is disabled and was not probed.");
  }
  return probeCredentialProfileStatus(profile, adapter?.probeCredentialProfile?.bind(adapter));
}

function inactiveProfileStatus(
  profile: CredentialProfile,
  detail: string,
): CredentialProfileStatus {
  return {
    profile_id: profile.profile_id,
    harness_id: profile.harness_id,
    availability: "unavailable",
    verification: "not_run",
    verification_source: "local_store",
    detail,
    last_verified_at: null,
  };
}

export function disabledProfileSharesOsUserCredential(
  state: ReturnType<typeof credentialProfilePolicyState>,
): boolean {
  return state.policy.identity_scope === "os_user";
}

/**
 * Accounts projection for one named profile. A rich adapter owns readiness and
 * identity in ONE call; adapters without it keep the existing doctor + owned-
 * store identity path. A malformed rich receipt loses identity and fails
 * closed through the shared readiness wrapper.
 */
export async function profileAccountProjection(
  profile: CredentialProfile,
  registry: readonly CredentialProfile[] = [profile],
  platform: NodeJS.Platform = process.platform,
  fresh = false,
): Promise<{
  profile: CredentialProfile;
  status: CredentialProfileStatus;
  identity: AccountIdentity | null;
}> {
  const adapter = buildRegistry().get(profile.harness_id);
  const cardinality = credentialProfilePolicyState({ adapter, registry, platform });
  if (!profile.enabled && disabledProfileSharesOsUserCredential(cardinality)) {
    return {
      profile,
      status: inactiveProfileStatus(profile, "This profile is disabled and was not probed."),
      identity: profileAccountIdentity(profile),
    };
  }
  if (profile.enabled && cardinality.ambiguous) {
    return {
      profile,
      status: inactiveProfileStatus(
        profile,
        `${profile.harness_id} has ${cardinality.enabledProfileCount} enabled bindings on ${cardinality.platform}; disable extra profiles before this OS-user-scoped credential can be selected or probed.`,
      ),
      identity: profileAccountIdentity(profile),
    };
  }
  return { profile, ...(await displayAccountObservation(profile, adapter, fresh)) };
}

/**
 * The per-harness pool routing verdict (`GET /v2/account-pools` and the
 * additive `accountPools` key of the credential-profiles response). Routing
 * facts ONLY — account facts live on the profile rows. The API-key ROUTE
 * appears exclusively here (`api_key_route`) so legacy strict `next_up`
 * decoders never see an unknown kind.
 */
export async function accountPoolsProjection(
  repoRoot: string,
  accounts: AccountEvidence,
  quotaSnapshots: readonly QuotaSnapshot[] = [],
  snapshot?: {
    statuses?: readonly HarnessStatus[];
    profiles?: readonly { profile: CredentialProfile; status: CredentialProfileStatus }[];
    quota?: VendorQuotaObservations;
    unusable?: readonly CredentialUnusableObservation[];
  },
): Promise<ControlHarnessAccountPool[]> {
  const cfg = loadConfig(repoRoot).global;
  const harnessIds = [...buildRegistry({ includeFakes: false }).keys()].sort();
  let statuses: readonly HarnessStatus[] = snapshot?.statuses ?? [];
  if (!snapshot?.statuses) {
    try {
      statuses = await buildGateway({ includeFakes: false }).statusAll(
        { cwd: repoRoot },
        harnessIds,
      );
    } catch {
      statuses = [];
    }
  }
  const statusById = new Map(statuses.map((status) => [status.id, status]));
  const unusable = snapshot?.unusable ?? accounts.unusable.live();
  const profiles = (snapshot?.profiles ?? []).map((entry) => ({
    ...entry,
    status: composeCredentialProfileEvidence(entry.status, {
      quota: snapshot?.quota ?? {
        snapshots: quotaSnapshots,
        absences: [],
        honored: accounts.unusable.honored(),
      },
      unusable,
      model: cfg.harnesses[entry.profile.harness_id]?.default_model ?? null,
      route: entry.profile.credential_kind === "api_key" ? "managed_api_key" : "vendor_native",
    }),
  }));
  const readyProfiles = new Map<string, Set<string>>();
  for (const entry of profiles) {
    // next_up is an unpinned pool verdict: the same admission as pool routing.
    if (
      !entry.profile.enabled ||
      !profileStatusAdmits(entry.profile, entry.status, { unpinned: true })
    )
      continue;
    const ready = readyProfiles.get(entry.profile.harness_id) ?? new Set<string>();
    ready.add(entry.profile.profile_id);
    readyProfiles.set(entry.profile.harness_id, ready);
  }
  return harnessIds.map((harnessId): ControlHarnessAccountPool => {
    const h = cfg.harnesses[harnessId];
    if (h?.enabled === false) {
      return {
        harness_id: harnessId,
        next_up: {
          kind: "none",
          reason: `harness is disabled in settings (harnesses.${harnessId}.enabled=false)`,
        },
      };
    }
    const cardinality = credentialProfilePolicyState({
      adapter: buildRegistry({ includeFakes: false }).get(harnessId),
      registry: cfg.credential_profiles,
    });
    if (cardinality.ambiguous) {
      return {
        harness_id: harnessId,
        next_up: {
          kind: "none",
          reason: `${harnessId} has an ambiguous enabled profile set; disable extra profiles before routing`,
        },
      };
    }
    // next_up must never advertise a row the runtime would not select: a
    // NON-EMPTY rotation_eligible list restricts the runtime's candidates
    // (staticRotationCandidates), so the projection applies the same filter.
    const rotationEligible = h?.profile_policy?.rotation_eligible ?? [];
    const ready = readyProfiles.get(harnessId) ?? new Set<string>();
    const eligibleReady =
      rotationEligible.length > 0
        ? new Set([...ready].filter((id) => rotationEligible.includes(id)))
        : ready;
    const selection = selectFromAccountPool({
      registry: cfg.credential_profiles,
      harnessId,
      snapshots: quotaSnapshots,
      readyProfileIds: eligibleReady,
      headroomThreshold: h?.profile_policy?.headroom_threshold ?? 1,
      model: h?.default_model ?? null,
      // Same pool owner as run admission, so a row a recent unpinned run saw
      // refuse before progress is not advertised ahead of its siblings, and the
      // row that last served the default model leads its unknown-headroom ties.
      refusals: accounts.refusals.live(),
      lastService: accounts.services,
    });
    if (selection.outcome === "selected") {
      return {
        harness_id: harnessId,
        next_up: { kind: "profile", profileId: selection.candidate.profile.profile_id },
      };
    }
    // Pool exhaustion is the typed `credential_pool_exhausted` terminal at
    // run time (owner Q3=A): the paid API-key ROUTE serves it ONLY under the
    // EXPLICIT api_key preference — never silently under auto — so next_up
    // advertises the paid route exactly when the runtime would take it.
    const preference = effectiveAuthPreference(h?.auth_preference, cfg.routing.auth_preference);
    const status = statusById.get(harnessId);
    const keyRouteReady =
      preference === "api_key" &&
      status !== undefined &&
      estimateEffectiveAuthRoute("api_key", status.authSources) === "api_key";
    if (keyRouteReady) {
      return { harness_id: harnessId, next_up: { kind: "api_key_route" } };
    }
    // Enabled rows that are registered but not ready are named with what their
    // probe observed: an unanswered probe is unknown, never "not signed in".
    const unready = profiles.filter(
      (entry) =>
        entry.profile.harness_id === harnessId &&
        entry.profile.enabled &&
        entry.profile.credential_kind !== "api_key" &&
        !profileStatusAdmits(entry.profile, entry.status, { unpinned: true }),
    );
    return {
      harness_id: harnessId,
      next_up: {
        kind: "none",
        reason:
          selection.outcome === "exhausted"
            ? selection.reopening === "unknown"
              ? "every enabled account is unavailable, and the vendor refused further usage on at least one with no reopening time named, so no reset is known (the paid API-key route requires the explicit api_key preference)"
              : `${selection.reserveOnly ? `every enabled account has reached its saved quota reserve (headroom_threshold ${Math.round((h?.profile_policy?.headroom_threshold ?? 1) * 100)}%) while the provider still reports quota left` : "every enabled account is over its quota window"}${selection.resets_at ? ` (earliest reset ${selection.resets_at})` : ""}; unpinned runs wait for the reset (the paid API-key route requires the explicit api_key preference)`
            : unready.length > 0
              ? `no enabled account is ready (${unready
                  .map(
                    ({ profile, status }) =>
                      `${profile.profile_id}: ${status.detail ?? `${status.availability}/${status.verification}`}`,
                  )
                  .join("; ")})`
              : "no enabled account is signed in for this harness; connect an account or pin one per-run (--profile)",
      },
    };
  });
}
