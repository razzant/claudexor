import { credentialProfilePolicyState, type HarnessAdapter } from "@claudexor/core";
import {
  composeCredentialProfileEvidence,
  applicableCredentialUnusable,
  profileQuotaBlock,
  profileStatusAdmits,
  resolveCredentialProfile,
  type VendorQuotaObservations,
} from "@claudexor/orchestrator";
import {
  ControlProblem,
  REOPENING_UNKNOWN_REFUSAL_CODE,
  type AccountCatalogAvailability,
  type CredentialProfile,
  type CredentialUnusableObservation,
  type GlobalConfig,
} from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import { accountObservations, displayAccountObservation } from "./account-observations.js";

export interface AccountCatalogContext {
  config: GlobalConfig;
  quota: VendorQuotaObservations;
  unusable?: readonly CredentialUnusableObservation[];
}

function catalogProblem(code: string, message: string, context = {}): ControlProblem {
  return ControlProblem.parse({ code, message, retryable: false, context });
}

/** Display membership uses the durable enabled registry, never the inference pool selector. */
export function catalogProfiles(
  context: AccountCatalogContext,
  harnessId: string,
  credentialProfileId?: string,
  managedLoginOnly = false,
): CredentialProfile[] {
  const profiles = context.config.credential_profiles.filter(
    (profile) => !managedLoginOnly || profile.credential_kind === "config_dir_login",
  );
  if (credentialProfileId) {
    try {
      return [resolveCredentialProfile(profiles, credentialProfileId, harnessId)];
    } catch {
      throw Object.assign(
        new Error("The pinned catalog account is unknown, disabled, or incompatible"),
        {
          code: "model_account_unavailable",
          status: 409,
          retryable: false,
        },
      );
    }
  }
  return profiles.filter((profile) => profile.enabled && profile.harness_id === harnessId);
}

async function accountAvailability(
  context: AccountCatalogContext,
  adapter: HarnessAdapter | undefined,
  profile: CredentialProfile,
  signal?: AbortSignal,
): Promise<AccountCatalogAvailability & { canReadCatalog: boolean }> {
  const row = { credentialProfileId: profile.profile_id };
  const unavailable = (problem: ControlProblem) => ({
    ...row,
    availability: "unavailable" as const,
    problem,
    canReadCatalog: false,
  });
  if (context.config.harnesses[profile.harness_id]?.enabled === false)
    return unavailable(
      catalogProblem("model_source_unavailable", "This harness is disabled in settings"),
    );
  const cardinality = credentialProfilePolicyState({
    adapter,
    registry: context.config.credential_profiles,
  });
  if (cardinality.ambiguous && profile.credential_kind !== "api_key")
    return unavailable(
      catalogProblem(
        "credential_profile_ambiguous",
        "The enabled profile set exceeds this platform's credential policy",
      ),
    );
  const evidence = {
    quota: context.quota,
    unusable: context.unusable ?? [],
    model: null,
    route:
      profile.credential_kind === "api_key"
        ? ("managed_api_key" as const)
        : ("vendor_native" as const),
  };
  const status = composeCredentialProfileEvidence(
    (await displayAccountObservation(profile, adapter, false, signal)).status,
    evidence,
  );
  if (!profileStatusAdmits(profile, status)) {
    const refusal = applicableCredentialUnusable(status, evidence);
    const revoked = refusal
      ? refusal.code === "auth_revoked"
      : status.verification_source === "vendor" && status.verification === "failed";
    const unknown = !revoked && (status.availability === "unknown" || status.stale === true);
    return {
      ...row,
      availability: unknown ? "unknown" : "unavailable",
      problem: catalogProblem(
        unknown
          ? "catalog_account_status_unknown"
          : revoked
            ? "auth_required"
            : refusal
              ? "credential_unusable"
              : "auth_unavailable",
        "The account has no verified current catalog credential",
        { observedAt: status.last_verified_at },
      ),
      canReadCatalog: false,
    };
  }
  const blocked = profileQuotaBlock(
    context.quota.snapshots,
    profile.harness_id,
    profile.profile_id,
    profile.credential_kind === "api_key" ? "api_key" : "local_session",
  );
  return {
    ...row,
    availability: blocked ? "unavailable" : "available",
    problem: blocked
      ? blocked.reopening === "unknown"
        ? catalogProblem(
            REOPENING_UNKNOWN_REFUSAL_CODE,
            "The vendor refused further usage on this account, with no reopening time named",
            { resetsAt: null },
          )
        : catalogProblem("subscription_window_exhausted", "The account has an active quota limit", {
            resetsAt: blocked.resets_at,
          })
      : null,
    // Quota blocks inference, not a read of the account's inventory.
    canReadCatalog: true,
  };
}

/** Each account retains its own cold display acquisition, including failure. */
export async function enumerateAccountCatalogs<T>(input: {
  context: AccountCatalogContext;
  adapter: HarnessAdapter | undefined;
  profiles: readonly CredentialProfile[];
  read(profile: CredentialProfile, canReadCatalog: boolean, signal: AbortSignal): Promise<T | null>;
  signal?: AbortSignal;
  observationKey: string;
}): Promise<Array<AccountCatalogAvailability & { catalog: T | null }>> {
  return Promise.all(
    input.profiles.map(async (profile) => {
      const { canReadCatalog, ...facts } = await accountAvailability(
        input.context,
        input.adapter,
        profile,
        input.signal,
      );
      try {
        const { value: catalog } = await accountObservations.read(
          input.observationKey,
          profile,
          (signal) => input.read(profile, canReadCatalog, signal),
          false,
          input.adapter?.program,
          input.signal,
        );
        return catalog === null && facts.problem === null
          ? {
              ...facts,
              availability: "unknown" as const,
              problem: catalogProblem(
                "model_catalog_unavailable",
                "This account has no catalog observation",
              ),
              catalog,
            }
          : { ...facts, catalog };
      } catch (error) {
        input.signal?.throwIfAborted();
        const provided = ControlProblem.safeParse(
          error && typeof error === "object" && "problem" in error ? error.problem : null,
        );
        const problem = provided.success
          ? provided.data
          : catalogProblem("model_catalog_unavailable", "This account's catalog could not be read");
        // An upstream outage does not prove authentication is absent or revoked.
        const refused =
          problem.code === "auth_required" || problem.code === "subscription_window_exhausted";
        return {
          ...facts,
          availability: refused
            ? ("unavailable" as const)
            : facts.availability === "unavailable"
              ? ("unavailable" as const)
              : ("unknown" as const),
          problem: ControlProblem.parse(JSON.parse(redactSecrets(JSON.stringify(problem)))),
          catalog: null,
        };
      }
    }),
  );
}
