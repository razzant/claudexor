import {
  observeHarnessProgram,
  type AdapterRegistry,
  type ModelAdapter,
  type ProgramObservation,
} from "@claudexor/core";
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
  if (harness?.enabled === false) throw sourceDisabled();
  const profiles = managedRows(cfg);
  const pinnedProfile =
    account.mode === "pin" ? pinnedRow(cfg, harnessId, account.profileId) : null;
  readiness.prune(cfg.credential_profiles);
  const adapter = registry.get(harnessId);
  // One program observation serves every profile of this selection.
  let program: Promise<ProgramObservation> | undefined;
  const probe = adapter?.probeCredentialProfile
    ? async (profile: CredentialProfile) => {
        signal.throwIfAborted();
        // A vendor revocation is stronger than local login readiness. No child is
        // needed to rediscover it, and the resolver still composes live evidence.
        if (credentialRefusal(source.adapter.id, profile, quotaEvidence(), unusable.live(), model))
          return probeCredentialProfileStatus(profile, undefined);
        program ??= observeHarnessProgram(adapter.program);
        return readiness.probe(profile, adapter, signal, program);
      }
    : undefined;
  if (pinnedProfile) {
    // Preserve a confirmed sign-in remedy across subsequent pinned calls.
    // Local probe failures and generic unavailability do not prove revocation.
    const refusal = credentialRefusal(
      source.adapter.id,
      pinnedProfile,
      quotaEvidence(),
      unusable.live(),
      model,
    );
    if (refusal) throw refusal;
    const raw = await probeCredentialProfileStatus(pinnedProfile, probe);
    signal.throwIfAborted();
    const status = composeCredentialProfileEvidence(raw, {
      quota: quotaEvidence(),
      unusable: unusable.live(),
      model,
      route: "vendor_native",
    });
    if (!profileStatusAdmits(pinnedProfile, status)) throw modelError("auth_unavailable", NO_LOGIN);
  }
  return { sourceId: source.adapter.id, harnessId, policy, profiles, probe, pinnedProfile, signal };
}

const NO_LOGIN = "The pinned model account has no verified current authentication";
const sourceDisabled = () =>
  modelError("model_source_unavailable", "This model source is disabled in settings");
// The first model transport admits only the existing managed-login rows.
// API-key and OAuth secret-reference rows remain Agent capabilities.
const managedRows = (cfg: GlobalConfig) =>
  cfg.credential_profiles.filter((row) => row.credential_kind === "config_dir_login");

function pinnedRow(cfg: GlobalConfig, harnessId: string, profileId: string): CredentialProfile {
  try {
    return resolveCredentialProfile(managedRows(cfg), profileId, harnessId);
  } catch {
    throw modelError(
      "model_account_unavailable",
      "The pinned managed model account is unknown, disabled, or incompatible",
    );
  }
}

/** A live credential verdict outranks local login readiness: a revocation is a
 * sign-in remedy with its date; any other unusable verdict leaves no verified login.
 * The probe shortcut, pin admission and the post-wait re-check share this refusal. */
function credentialRefusal(
  sourceId: string,
  profile: CredentialProfile,
  quota: VendorQuotaObservations,
  unusable: readonly CredentialUnusableObservation[],
  model: string | null,
): Error | null {
  const dead = applicableCredentialUnusable(profile, {
    quota,
    unusable,
    model,
    route: "vendor_native",
  });
  const vendor = vendorCredentialObservation(quota, profile.harness_id, profile.profile_id);
  const observedAt =
    (dead?.code === "auth_revoked" ? dead.observed_at : null) ??
    (vendor?.outcome === "revoked" ? vendor.observed_at : null);
  if (!observedAt) return dead ? modelError("auth_unavailable", NO_LOGIN) : null;
  const message = "The pinned managed model account requires sign-in";
  return Object.assign(modelError("auth_required", message), {
    problem: ControlProblem.parse({
      code: "auth_required",
      message,
      retryable: false,
      context: { source: sourceId, credentialProfileId: profile.profile_id, observedAt },
    }),
  });
}

/** After a wait only the account waited for is judged again, from its own live
 * facts and with the refusals a strict pin of it gets: a disabled source (thrown,
 * as admission refuses every account), an unknown or disabled row, a revoked or
 * unusable credential, then live usage against the admission-time headroom policy.
 * Marks only reorder; selection reads them live. No probe or vendor read. */
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
}): Promise<Error | null> {
  const { harnessId, model, quota, unusable } = args;
  if (args.config.harnesses[harnessId]?.enabled === false) throw sourceDisabled();
  let row: CredentialProfile;
  try {
    row = pinnedRow(args.config, harnessId, args.profileId);
  } catch (error) {
    return error as Error;
  }
  const refusal = credentialRefusal(args.sourceId, row, quota, unusable, model);
  if (refusal) return refusal;
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
    // The strict pin's own typed quota refusal, exactly as a repeat throws it.
    if (error instanceof Error && "problem" in error) return error;
    throw error;
  }
}
