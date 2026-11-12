import { loadConfig } from "@claudexor/config";
import type { AccountEvidence, QuotaRegistry } from "@claudexor/daemon";
import { StatusProjectionCache, globalConfigVersion } from "./status-projection-cache.js";
import { normalizeReadiness, type HarnessStatus } from "@claudexor/gateway";
import { probeGitCapability } from "@claudexor/workspace";
import { noProjectRepoRoot } from "@claudexor/util";
import type {
  CredentialProfile,
  CredentialProfileStatus,
  CredentialRoute,
  CredentialUnusableObservation,
  ModelScopedCredentialUnusable,
} from "@claudexor/schema";
import {
  composeCredentialProfileEvidence,
  modelScopedCredentialUnusable,
  type VendorQuotaObservations,
} from "@claudexor/orchestrator";
import { accountPoolsProjection, profileAccountProjection } from "./accounts-projection.js";
import { buildGateway, buildRegistry, checkHarnessModel } from "./registry.js";
import { delegationCapabilityFor } from "./delegation-capability.js";
import { accountObservations } from "./account-observations.js";
import { effectiveSetupLoginCapability } from "./setup-login-capability.js";

import { accountResourcesResponse, legacyQuotaResponse } from "./quota-services.js";

const NO_PROJECT_ROOT = noProjectRepoRoot();

export type HarnessListInput = {
  fresh?: boolean;
  includeFakes?: boolean;
  harnessIds?: string[];
};

export async function projectHarnessStatuses(statuses: readonly HarnessStatus[]) {
  const cfg = loadConfig(NO_PROJECT_ROOT);
  const adapters = buildRegistry({ includeFakes: false });
  return Promise.all(
    statuses.map(async (status) => {
      const configured = cfg.global.harnesses[status.id]?.default_model ?? null;
      // The doctor's configured-model verdict honours the harness's own
      // absence declaration (INV-104): an advisory harness passes with the
      // note in the readiness detail instead of failing on a hint-list miss.
      const check = configured
        ? (await checkHarnessModel(status.id, configured, NO_PROJECT_ROOT, true)).check
        : null;
      return {
        ...status,
        configuredModel: configured,
        configuredModelCheck: check,
        delegation: delegationCapabilityFor(status.manifest),
        setupLogin: await effectiveSetupLoginCapability(status.id, {
          getAdapter: (id) => adapters.get(id),
        }),
        readiness: normalizeReadiness({
          checks: status.checks,
          authSources: status.authSources,
          configuredModel: configured,
          configuredModelCheck: check,
        }),
      };
    }),
  );
}

/** One server-owned Accounts response builder. The opt-in form refreshes quota
 * first and then derives next_up from that exact returned response; no client
 * can accidentally pair a newer quota card with an older routing identity.
 * Returns the listing service plus the pool-authority read
 * (`GET /v2/account-pools`) so both share one cached projection, and the
 * additive model-scoped routing-evidence read. */
export function createCredentialProfilesService(
  quotaRegistry: () => QuotaRegistry,
  accounts: AccountEvidence,
) {
  const projectProfiles = (fresh = false) => {
    const profiles = loadConfig(NO_PROJECT_ROOT).global.credential_profiles;
    return Promise.all(
      profiles.map((profile) =>
        profileAccountProjection(profile, profiles, process.platform, fresh),
      ),
    );
  };
  // Ordinary reads re-project current quota/config around the retained cold
  // observation. Expiry never starts another profile or catalog acquisition.
  const harnessCache = new StatusProjectionCache<HarnessStatus[]>({
    ttlMs: Infinity,
    versionOf: globalConfigVersion,
  });
  const readHarnesses = (fresh = false) =>
    harnessCache.read(
      async () => {
        try {
          return (
            await buildGateway({ includeFakes: false }).statusAllForAccounts({
              cwd: NO_PROJECT_ROOT,
              fresh,
            })
          ).map((receipt) => receipt.status);
        } catch (error) {
          if (fresh) throw error;
          return [];
        }
      },
      { fresh },
    );
  const buildPollResponse = async () => {
    const [probed, statuses] = await Promise.all([projectProfiles(), readHarnesses()]);
    // Cards keep display freshness; next_up judges each window like run admission (#457).
    const quota = quotaRegistry().read();
    const admission = quotaRegistry().readAdmission();
    const unusable = accounts.unusable.live();
    const evidence = { ...quota, honored: accounts.unusable.honored() };
    const out = withAccountEvidence(probed, evidence, unusable);
    return {
      profiles: out,
      // Unified account model: the legacy carrier stays PRESENT and empty for
      // strict old clients; routing facts ride accountPools.
      harnessAccounts: [],
      accountPools: await accountPoolsProjection(NO_PROJECT_ROOT, accounts, admission.snapshots, {
        profiles: out,
        statuses,
        quota: evidence,
        unusable,
      }),
    };
  };
  const credentialProfiles = async (input?: {
    snapshot?: boolean;
    view?: "resources";
    includeApiKeys?: boolean;
  }) => {
    if (input?.snapshot === true) {
      accountObservations.invalidateCatalogs();
      const [probed, statuses, git, fencedQuota] = await Promise.all([
        projectProfiles(true),
        readHarnesses(true),
        probeGitCapability(),
        quotaRegistry().refreshWithCursor(),
      ]);
      const rawQuota = fencedQuota.response;
      const unusable = accounts.unusable.live();
      const evidence = { ...rawQuota, honored: accounts.unusable.honored() };
      const out = withAccountEvidence(probed, evidence, unusable);
      // Explicit acquisition refreshes the display observation, not just TTL.
      return {
        profiles: out,
        harnessAccounts: [],
        // The cycle's own admission read of the state its response shows.
        accountPools: await accountPoolsProjection(
          NO_PROJECT_ROOT,
          accounts,
          fencedQuota.admission.snapshots,
          {
            profiles: out,
            statuses,
            quota: evidence,
            unusable,
          },
        ),
        harnesses: await projectHarnessStatuses(statuses),
        git,
        quota:
          input.view === "resources"
            ? accountResourcesResponse(
                quotaRegistry(),
                rawQuota,
                fencedQuota.resources,
                {},
                input.includeApiKeys === true,
              )
            : legacyQuotaResponse(quotaRegistry(), rawQuota, fencedQuota.resources),
        quotaEventCursor: fencedQuota.quotaEventCursor,
      };
    }
    return buildPollResponse();
  };
  const accountPools = async () => ({
    accountPools: (await buildPollResponse()).accountPools,
  });
  /** Each registered row's live model-scoped observations, judged with the
   * evidence its listed status is composed from (`withAccountEvidence`). */
  const modelScopedCredentialRefusals = (
    profiles: readonly CredentialProfile[],
  ): ModelScopedCredentialUnusable[] => {
    const evidence = {
      quota: { ...quotaRegistry().read(), honored: accounts.unusable.honored() },
      unusable: accounts.unusable.live(),
    };
    return profiles.flatMap((profile) =>
      modelScopedCredentialUnusable(profile, {
        ...evidence,
        route: profileRoute(profile),
      })
        .sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))
        .map((observation) => ({
          harness_id: profile.harness_id,
          profile_id: profile.profile_id,
          model: observation.model,
          code: observation.code,
          detail: observation.detail,
          observed_at: observation.observed_at,
          expires_at: observation.expires_at,
        })),
    );
  };
  /** `GET /v2/accounts/routing-evidence`: the live refusal marks, temporary
   * capability marks, model-scoped credential refusals and the durable
   * last-served facts of the registered rows.
   * Reads only: no probe, no quota refresh, no store write. Service facts are
   * routing evidence, never a
   * quota or authentication verdict. */
  const accountRoutingEvidence = async (
    include: { capabilities?: boolean; credentialUnusable?: boolean } = {},
  ) => {
    const profiles = loadConfig(NO_PROJECT_ROOT).global.credential_profiles;
    const registered = new Set(profiles.map((p) => `${p.harness_id}\0${p.profile_id}`));
    return {
      // Only clients that ask receive a field; strict legacy clients keep the old shape.
      ...(include.capabilities
        ? {
            capabilities: accounts.capabilities
              .live()
              .filter((mark) => registered.has(`${mark.harness_id}\0${mark.profile_id}`)),
          }
        : {}),
      ...(include.credentialUnusable
        ? { credentialUnusable: modelScopedCredentialRefusals(profiles) }
        : {}),
      refusals: accounts.refusals
        .live()
        .filter((mark) => registered.has(`${mark.harness_id}\0${mark.profile_id}`)),
      lastService: accounts.services?.latest(profiles) ?? [],
    };
  };
  return { credentialProfiles, accountPools, accountRoutingEvidence };
}

/**
 * Replace each profile's LOCAL verification verdict with the vendor's, wherever
 * the quota poller already has one. Applied before `harnessAccounts` is built
 * so the routing identity (`next_up`) and the listed status can never disagree:
 * a revoked profile must not be advertised as who the next run routes to.
 */
function withAccountEvidence<
  T extends { profile: CredentialProfile; status: CredentialProfileStatus },
>(
  entries: T[],
  quota: VendorQuotaObservations,
  unusable: readonly CredentialUnusableObservation[],
): T[] {
  return entries.map((entry) => ({
    ...entry,
    status: composeCredentialProfileEvidence(entry.status, {
      quota,
      unusable,
      model: null,
      route: profileRoute(entry.profile),
    }),
  }));
}

/** The credential route a registered row's runs use. */
function profileRoute(profile: CredentialProfile): CredentialRoute {
  return profile.credential_kind === "api_key" ? "managed_api_key" : "vendor_native";
}
