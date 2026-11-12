import type { AdapterRegistry, ModelAdapter } from "@claudexor/core";
import type { CredentialUnusableLedger } from "@claudexor/daemon";
import {
  probeCredentialProfileStatus,
  profileStatusAdmits,
  resolveAccountForRun,
  resolveCredentialProfile,
  composeCredentialProfileEvidence,
  applicableCredentialUnusable,
  vendorCredentialObservation,
  type VendorQuotaObservations,
} from "@claudexor/orchestrator";
import {
  ControlProblem,
  GlobalConfig,
  type CredentialProfile,
  type CredentialUnusableObservation,
  type ModelAccountChoice,
  type QuotaRequestKind,
  type QuotaSnapshot,
} from "@claudexor/schema";
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
  const harnessId = source.credentialHarness;
  const harness = cfg.harnesses[harnessId];
  const policy =
    harness?.profile_policy ??
    GlobalConfig.parse({ harnesses: { [harnessId]: {} } }).harnesses[harnessId]!.profile_policy;
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
        return readiness.probe(profile, adapter, signal);
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
  return { sourceId: source.adapter.id, harnessId, policy, profiles, probe, pinnedProfile, signal };
}

/** After a wait only the picked account's own live facts decide again: its row
 * is still enabled, its credential is neither revoked nor unusable, and its quota
 * and headroom admit it now, judged as a strict pin of it is. Marks only reorder;
 * selection reads them live. No probe or vendor read; the refusal, or null. */
export async function liveAccountRefusal(args: {
  sourceId: string;
  harnessId: string;
  profileId: string;
  model: string | null;
  requestKind: QuotaRequestKind;
  config: GlobalConfig;
  policy: GlobalConfig["harnesses"][string]["profile_policy"];
  quota: VendorQuotaObservations & { snapshots: readonly QuotaSnapshot[] };
  unusable: readonly CredentialUnusableObservation[];
}): Promise<ControlProblem | null> {
  const { harnessId, profileId, model, quota, unusable } = args;
  const refusal = (code: string, message: string, observedAt?: string | null) =>
    ControlProblem.parse({
      code,
      message,
      retryable: false,
      context: {
        source: args.sourceId,
        credentialProfileId: profileId,
        ...(observedAt ? { observedAt } : {}),
      },
    });
  const row = args.config.credential_profiles.find(
    (p) =>
      p.harness_id === harnessId &&
      p.profile_id === profileId &&
      p.credential_kind === "config_dir_login",
  );
  if (!row?.enabled || args.config.harnesses[harnessId]?.enabled === false)
    return refusal(
      "model_account_unavailable",
      "The selected managed model account is unknown, disabled, or incompatible",
    );
  const dead = applicableCredentialUnusable(row, {
    quota,
    unusable,
    model,
    route: "vendor_native",
  });
  const vendor = vendorCredentialObservation(quota, harnessId, profileId);
  const revokedAt =
    (dead?.code === "auth_revoked" ? dead.observed_at : null) ??
    (vendor?.outcome === "revoked" ? vendor.observed_at : null);
  if (revokedAt)
    return refusal(
      "auth_required",
      "The selected managed model account requires sign-in",
      revokedAt,
    );
  if (dead)
    return refusal(
      "auth_unavailable",
      "The selected model account has no verified current authentication",
    );
  try {
    await resolveAccountForRun({
      harnessId,
      registry: [row],
      policy: args.policy,
      snapshots: quota.snapshots,
      quota,
      unusable,
      requestKind: args.requestKind,
      probe: undefined,
      pinnedProfile: row,
      boundProfileId: null,
      threadId: null,
      model,
      defaultRoute: null,
      nativeCredentialsDisabled: true,
      authPreference: "subscription",
      notePoolApiKeyRoute: () => {},
      emit: () => {},
    });
    return null;
  } catch (error) {
    const typed = ControlProblem.safeParse(
      error && typeof error === "object" && "problem" in error ? error.problem : null,
    );
    if (typed.success) return typed.data;
    throw error;
  }
}
