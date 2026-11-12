import type { AdapterRegistry, ModelAdapter } from "@claudexor/core";
import type {
  CredentialUnusableLedger,
  QuotaRegistry,
  ModelSubstitutionLedger,
  PreProgressRefusalLedger,
} from "@claudexor/daemon";
import {
  probeCredentialProfileStatus,
  profileStatusAdmits,
  resolveCredentialProfile,
  composeCredentialProfileEvidence,
  applicableCredentialUnusable,
  vendorCredentialObservation,
  type VendorQuotaObservations,
} from "@claudexor/orchestrator";
import {
  ControlProblem,
  type CredentialProfile,
  type GlobalConfig,
  type ModelAccountChoice,
} from "@claudexor/schema";
import { measureModelPreparation } from "@claudexor/util";
import type { ModelLoginReadiness } from "./model-login-readiness.js";
import { modelError } from "./model-service-refusals.js";

/** Pin/pool readiness only. Mutable decision facts are re-read after awaits;
 * this consumes raw observations, never account display projections. */
export async function admitModelAccount(args: {
  source: { credentialHarness: string; adapter: Pick<ModelAdapter, "id"> };
  account: ModelAccountChoice;
  model: string | null;
  signal: AbortSignal;
  config: () => GlobalConfig;
  registry: AdapterRegistry;
  readiness: ModelLoginReadiness;
  quotaEvidence: () => VendorQuotaObservations;
  unusable: CredentialUnusableLedger;
}) {
  const { source, account, model, signal, config, registry, readiness, quotaEvidence, unusable } =
    args;
  signal.throwIfAborted();
  const cfg = config();
  const cfgKey = JSON.stringify(cfg);
  const harnessId = source.credentialHarness;
  const harness = cfg.harnesses[harnessId];
  if (harness?.enabled === false)
    throw modelError("model_source_unavailable", "This model source is disabled in settings");
  // The first model transport admits only the existing managed-login rows.
  // API-key and OAuth secret-reference rows remain Agent capabilities.
  const profiles = cfg.credential_profiles.filter(
    (row) => row.credential_kind === "config_dir_login",
  );
  let pinnedProfile: CredentialProfile | null = null;
  if (account.mode === "pin") {
    try {
      pinnedProfile = resolveCredentialProfile(profiles, account.profileId, harnessId);
    } catch {
      throw modelError(
        "model_account_unavailable",
        "The pinned managed model account is unknown, disabled, or incompatible",
      );
    }
  }
  readiness.prune(cfg.credential_profiles);
  const adapter = registry.get(harnessId);
  const probe = adapter?.probeCredentialProfile
    ? async (profile: CredentialProfile) => {
        signal.throwIfAborted();
        // A vendor revocation is stronger than local login readiness. No child is
        // needed to rediscover it, and the resolver still composes live evidence.
        const quota = quotaEvidence();
        const dead = applicableCredentialUnusable(profile, {
          quota,
          unusable: unusable.live(),
          model,
          route: "vendor_native",
        });
        if (
          dead ||
          vendorCredentialObservation(quota, harnessId, profile.profile_id)?.outcome === "revoked"
        )
          return probeCredentialProfileStatus(profile, undefined);
        return measureModelPreparation("loginProbe", () =>
          readiness.probe(profile, adapter, signal),
        );
      }
    : undefined;
  const quota = quotaEvidence();
  if (pinnedProfile) {
    // Preserve a confirmed sign-in remedy across subsequent pinned calls.
    // Local probe failures and generic unavailability do not prove revocation.
    const evidence = { quota, unusable: unusable.live(), model, route: "vendor_native" as const };
    const refusal = applicableCredentialUnusable(pinnedProfile, evidence);
    const revoked = refusal?.code === "auth_revoked" ? refusal : null;
    const vendor = vendorCredentialObservation(quota, harnessId, pinnedProfile.profile_id);
    const revokedAt =
      revoked?.observed_at ?? (vendor?.outcome === "revoked" ? vendor.observed_at : null);
    if (revokedAt)
      throw Object.assign(
        modelError("auth_required", "The pinned managed model account requires sign-in"),
        {
          problem: ControlProblem.parse({
            code: "auth_required",
            message: "The pinned managed model account requires sign-in",
            retryable: false,
            context: {
              source: source.adapter.id,
              credentialProfileId: pinnedProfile.profile_id,
              observedAt: revokedAt,
            },
          }),
        },
      );
    const raw = await probeCredentialProfileStatus(pinnedProfile, probe);
    signal.throwIfAborted();
    const status = composeCredentialProfileEvidence(raw, {
      ...evidence,
      quota: quotaEvidence(),
      unusable: unusable.live(),
    });
    if (!profileStatusAdmits(pinnedProfile, status))
      throw modelError(
        "auth_unavailable",
        "The pinned model account has no verified current authentication",
      );
  }
  return { cfgKey, harnessId, harness, profiles, probe, pinnedProfile, signal };
}

/** Compare decision inputs after I/O, without making a display cache or retaining
 * an eligible set. A timestamp-only restatement of the same fact is not a new
 * decision; freshness/reset changes still are. Catalog honor is omitted during
 * discovery because the read itself records it, but included after probes. */
export function modelSelectionFacts(deps: {
  config: () => GlobalConfig;
  quota: () => QuotaRegistry;
  unusable: CredentialUnusableLedger;
  substitutions: ModelSubstitutionLedger;
  refusals?: PreProgressRefusalLedger;
}) {
  return (includeHonored = false) => {
    const config = deps.config();
    const quota = { ...deps.quota().read(), honored: deps.unusable.honored() };
    return JSON.stringify(
      [
        config,
        quota.snapshots,
        quota.absences,
        deps.quota().readAdmission(),
        deps.unusable.live(),
        deps.substitutions.live(),
        deps.refusals?.live(),
        includeHonored
          ? config.credential_profiles.map(
              (profile) =>
                vendorCredentialObservation(quota, profile.harness_id, profile.profile_id)?.outcome,
            )
          : null,
      ],
      (key, value) =>
        ["observed_at", "observedAt", "refreshed_at"].includes(key) ? undefined : value,
    );
  };
}
