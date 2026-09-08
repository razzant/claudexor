/**
 * The orchestrator's credential-resolution cluster (INV-135 unified account
 * model), split from the orchestrator god-file to a smaller owner (complexity
 * ratchet): the strict-pin resolver, the per-run paid-route flags, the
 * A7-aware rotation-readiness epoch, the sibling differential-probe wiring,
 * and the thin wrapper over the ONE account-resolution owner
 * (account-resolution.ts). No run/lane state lives here — only per-decision
 * reads over the host's config and deps.
 */
import type {
  AuthPreference,
  AuthVerification,
  CredentialProfile,
  CredentialUnusableObservation,
  HarnessRunSpec,
  QuotaAbsence,
  QuotaSnapshot,
} from "@claudexor/schema";
import type { loadConfig } from "@claudexor/config";
import type { AdapterRegistry, HarnessAdapter } from "@claudexor/core";
import {
  HarnessUnavailableError,
  credentialProfilePolicyProblem,
  credentialProfilePolicyState,
} from "@claudexor/core";
import type { EventLog } from "@claudexor/event-log";
import { PoolRouteFlags, resolveAccountForRun } from "./account-resolution.js";
import { currentSubjectProber, readyProfilesForRotation } from "./credential-differential.js";
import {
  resolveCredentialProfile,
  probeCredentialProfileStatus,
  profileStatusAdmits,
  vendorVerifiedProfileStatus,
  type ProfilePolicy,
  type VendorQuotaObservations,
} from "./credential-profiles.js";
import type { TransientFailureObservation } from "./transientClassify.js";
import type { RunInput } from "./orchestrator.js";

/** Model-first reviewer account resolution input, without a fabricated RunInput. */
export interface ReviewerProfileResolutionInput {
  repoRoot: string;
  harnessId: string;
  model: string | null;
  authPreference: AuthPreference;
  credentialProfileId: string | null;
  excludedProfileIds?: ReadonlySet<string>;
}

export function reviewerProfileResolver(
  credentials: OrchestratorCredentials,
  repoRoot: string,
): (input: Omit<ReviewerProfileResolutionInput, "repoRoot">) => Promise<CredentialProfile | null> {
  return (input) => credentials.preflightReviewerProfile({ repoRoot, ...input });
}

/** The slice of the Orchestrator this cluster reads; accessor functions so the
 * host can defer to deps assigned after this field initializes. */
export interface CredentialResolutionHost {
  config(repoRoot: string): ReturnType<typeof loadConfig>;
  registry(): AdapterRegistry;
  quotaSnapshots(): readonly QuotaSnapshot[];
  quotaAbsences(): readonly QuotaAbsence[];
  credentialUnusable(): readonly CredentialUnusableObservation[];
  recordCredentialUnusable(obs: CredentialUnusableObservation): void;
  authPreferenceForHarness(
    repoRoot: string,
    harnessId: string,
    runPreference: RunInput["authPreference"],
  ): NonNullable<RunInput["authPreference"]>;
}

/**
 * INV-137: a mid-attempt credential rotation must move the spec's LANE home
 * with it. The lane env is keyed by the RESOLVED profile, so a rotated spec
 * that kept the pre-rotation env would write the rotated row's native session
 * into the PREVIOUS row's lane store while the session record points at the
 * rotated row — the next turn then provisions a fresh lane for that row and
 * its `--resume` silently starts over. Only a spec that actually RUNS in a
 * lane home is re-keyed: an isolated envelope keeps its disposable scoped
 * home (sessions are never retained there), and an in-place agent turn keeps
 * the native environment (adapters derive per-row state homes from the
 * resolved profile itself).
 */
export function rotatedSpecInLaneHome(
  previous: HarnessRunSpec,
  rotated: HarnessRunSpec,
  /** The caller's lane-env resolver, keyed by the resolved account (null =
   * this run has no lane home — non-thread one-shots). */
  laneEnvFor: (resolvedProfileId: string | null) => Record<string, string> | null,
  /** The spec build's pin fallback key (the run's requested profile id). */
  requestedProfileId: string | null,
): HarnessRunSpec {
  // The same key the spec build used (record and resume share one home).
  const previousLane = laneEnvFor(previous.credential_profile?.profile_id ?? requestedProfileId);
  if (!previousLane || previous.env?.["HOME"] !== previousLane["HOME"]) return rotated;
  const rotatedLane = laneEnvFor(rotated.credential_profile?.profile_id ?? null);
  return rotatedLane ? { ...rotated, env: rotatedLane } : rotated;
}

export class OrchestratorCredentials {
  /** Q3=A explicit paid-route flags, keyed per run input (see PoolRouteFlags). */
  private readonly poolApiKeyRoutes = new PoolRouteFlags();

  constructor(private readonly host: CredentialResolutionHost) {}

  /** The EXPLICIT pin (INV-135): strict. Null = unpinned (preflightProfile). */
  effectiveProfileId(input: RunInput, _harnessId: string): string | null {
    return input.credentialProfileId ?? null;
  }

  poolApiKeyRoute(input: RunInput, harnessId: string): boolean {
    return this.poolApiKeyRoutes.has(input, harnessId);
  }

  /** Whether the native/CLI login is EXCLUDED from this harness's credential
   * ladder (INV-135). When excluded, a harness with no effective profile has
   * nothing routable and must refuse — never silently fall back into it. */
  nativeCredentialsDisabled(repoRoot: string, harnessId: string): boolean {
    return (
      this.host.config(repoRoot)?.global.harnesses?.[harnessId]?.native_credentials_enabled ===
      false
    );
  }

  resolveCredentialProfile(input: RunInput, harnessId: string): CredentialProfile | null {
    const explicit = input.credentialProfileId ?? null;
    const wanted = this.effectiveProfileId(input, harnessId);
    if (!wanted) return null;
    const registry = this.host.config(input.repoRoot)?.global.credential_profiles ?? [];
    try {
      return resolveCredentialProfile(registry, wanted, harnessId);
    } catch (err) {
      // With Active removed, `wanted` is always the explicit pin; keep the
      // fail-closed guard so any future non-pin source still refuses loudly.
      if (!explicit) {
        throw new Error(
          `harness "${harnessId}" credential profile "${wanted}" is unusable: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      throw err;
    }
  }

  /** The typed effective auth route for a SELECTED credential profile
   * (round-18 #2): adapters execute strictly by credential_kind, so routing,
   * billing classification, model truth, and quota lookup must share this
   * one fact — never the default store's sources or a previous default-route
   * metric. null = no profile selected or it does not resolve here. */
  profileAuthRoute(input: RunInput, harnessId: string): "local_session" | "api_key" | null {
    try {
      const profile = this.resolveCredentialProfile(input, harnessId);
      if (!profile) return null;
      return profile.credential_kind === "api_key" ? "api_key" : "local_session";
    } catch {
      return null;
    }
  }

  profilePolicy(repoRoot: string, harnessId: string): ProfilePolicy {
    const policy = this.host.config(repoRoot)?.global.harnesses?.[harnessId]?.profile_policy;
    // A6: an ABSENT policy means `auto` (kind-aware: rotate for subscription
    // subjects, fail for metered) — resolved later by effectiveLimitAction.
    return policy ?? { limit_action: "auto", rotation_eligible: [], headroom_threshold: 0.9 };
  }

  /** The quota poller's authenticated vendor evidence for THIS decision epoch,
   * read once so every profile in the epoch is judged against one observation
   * set. This is what makes profile readiness at admission mean the same thing
   * it means on the Accounts card (INV-135 honesty). */
  vendorQuotaObservations(): VendorQuotaObservations {
    return {
      snapshots: this.host.quotaSnapshots(),
      absences: this.host.quotaAbsences(),
    };
  }

  /** Fresh profile readiness for one rotation decision epoch (composition in
   * `readyProfilesForRotation`): probe wrapper + vendor overlay + admission
   * predicate + the A7 live-observation refusal. */
  async readyProfileIdsForRotation(
    input: RunInput,
    harnessId: string,
    current: Pick<CredentialProfile, "profile_id" | "credential_kind"> | null,
    excluded: ReadonlySet<string> = new Set(),
    model: string | null = null,
  ): Promise<ReadonlySet<string>> {
    const adapter = this.host.registry().get(harnessId);
    return readyProfilesForRotation({
      registry: this.host.config(input.repoRoot)?.global.credential_profiles ?? [],
      harnessId,
      policy: this.profilePolicy(input.repoRoot, harnessId),
      current,
      excluded,
      probe: adapter?.probeCredentialProfile?.bind(adapter),
      quota: this.vendorQuotaObservations(),
      unusable: this.host.credentialUnusable(),
      model,
    });
  }

  /** A7 wiring for one reactive rotation decision: the sibling differential
   * prober of the CURRENT subject plus this epoch's live observations. */
  rotationObservations(
    adapter: HarnessAdapter,
    spec: HarnessRunSpec,
    transients: readonly TransientFailureObservation[],
  ) {
    return {
      probeCurrentSubject: currentSubjectProber({
        harnessId: adapter.id,
        profile: spec.credential_profile ?? null,
        model: spec.model_hint ?? null,
        quota: this.vendorQuotaObservations(),
        transients,
        probe: adapter.probeCredentialProfile?.bind(adapter),
        record: (obs) => this.host.recordCredentialUnusable(obs),
      }),
      liveUnusable: this.host.credentialUnusable(),
    };
  }

  /** Resolve one reviewer slot through the ordinary account-pool owner. */
  async preflightReviewerProfile(
    input: ReviewerProfileResolutionInput,
  ): Promise<CredentialProfile | null> {
    const adapter = this.host.registry().get(input.harnessId);
    const registry = this.host.config(input.repoRoot)?.global.credential_profiles ?? [];
    const profileCardinality = credentialProfilePolicyState({ adapter, registry });
    if (profileCardinality.ambiguous)
      throw credentialProfilePolicyProblem(profileCardinality, "credential_profile_ambiguous");
    let pinnedProfile: CredentialProfile | null = null;
    if (input.credentialProfileId) {
      try {
        pinnedProfile = resolveCredentialProfile(
          registry,
          input.credentialProfileId,
          input.harnessId,
        );
      } catch (error) {
        throw new HarnessUnavailableError(error instanceof Error ? error.message : String(error));
      }
    }
    if (input.credentialProfileId && !pinnedProfile) {
      throw new HarnessUnavailableError(
        `reviewer credential profile "${input.credentialProfileId}" is unknown, disabled, or belongs to another harness (${input.harnessId})`,
      );
    }
    const quota = this.vendorQuotaObservations();
    // The reviewer preflight must prove an explicit pin before any model
    // inventory call. The ordinary resolver intentionally keeps this probe
    // optional for legacy run admission; this caller opts into the stricter
    // reviewer contract without changing ordinary runs.
    if (pinnedProfile) {
      const status = vendorVerifiedProfileStatus(
        await probeCredentialProfileStatus(
          pinnedProfile,
          adapter?.probeCredentialProfile?.bind(adapter),
        ),
        quota,
      );
      if (!profileStatusAdmits(pinnedProfile, status)) {
        throw new HarnessUnavailableError(
          `reviewer credential profile "${pinnedProfile.profile_id}" (${input.harnessId}) is not ready: ${status.detail ?? `${status.availability}/${status.verification}`}`,
        );
      }
    }
    const defaultRoute =
      input.authPreference === "api_key"
        ? "api_key"
        : input.authPreference === "subscription"
          ? "local_session"
          : null;
    return resolveAccountForRun({
      harnessId: input.harnessId,
      registry,
      policy: this.profilePolicy(input.repoRoot, input.harnessId),
      profileCardinality,
      snapshots: this.host.quotaSnapshots(),
      quota,
      unusable: this.host.credentialUnusable(),
      probe: adapter?.probeCredentialProfile?.bind(adapter),
      pinnedProfile,
      excludedProfileIds: input.excludedProfileIds,
      boundProfileId: null,
      threadId: null,
      model: input.model,
      defaultRoute,
      nativeCredentialsDisabled: this.nativeCredentialsDisabled(input.repoRoot, input.harnessId),
      authPreference: input.authPreference,
      // Reviewer resolution has no ordinary RunInput identity to retain. The
      // selected profile is returned directly; explicit api_key remains in the
      // auth preference and therefore needs no pool flag.
      notePoolApiKeyRoute: () => {},
      emit: () => {},
    });
  }

  async preflightProfile(
    input: RunInput,
    harnessId: string,
    model: string | null,
    log: EventLog | undefined,
    defaultRoute: "local_session" | "api_key" | null,
  ): Promise<CredentialProfile | null> {
    const adapter = this.host.registry().get(harnessId);
    const registry = this.host.config(input.repoRoot)?.global.credential_profiles ?? [];
    const profileCardinality = credentialProfilePolicyState({ adapter, registry });
    if (profileCardinality.ambiguous)
      throw credentialProfilePolicyProblem(profileCardinality, "credential_profile_ambiguous");
    return resolveAccountForRun({
      harnessId,
      registry,
      policy: this.profilePolicy(input.repoRoot, harnessId),
      profileCardinality,
      snapshots: this.host.quotaSnapshots(),
      quota: this.vendorQuotaObservations(),
      unusable: this.host.credentialUnusable(),
      probe: adapter?.probeCredentialProfile?.bind(adapter),
      pinnedProfile: this.resolveCredentialProfile(input, harnessId),
      boundProfileId: input.threadAccountBindings?.[harnessId] ?? null,
      threadId: input.threadId ?? null,
      model,
      defaultRoute,
      nativeCredentialsDisabled: this.nativeCredentialsDisabled(input.repoRoot, harnessId),
      authPreference: this.host.authPreferenceForHarness(
        input.repoRoot,
        harnessId,
        input.authPreference,
      ),
      notePoolApiKeyRoute: () => this.poolApiKeyRoutes.note(input, harnessId),
      emit: (type, payload) => log?.emit(type, payload),
    });
  }

  /** Billing evidence for the exact profile selected by preflight. The default
   * doctor's auth sources describe a different credential store, so they must
   * not classify a named profile. Only a vendor-backed profile verification is
   * strong enough to prove a subscription-entitled native route. */
  async profileAuthVerification(profile: CredentialProfile): Promise<AuthVerification> {
    const adapter = this.host.registry().get(profile.harness_id);
    const status = vendorVerifiedProfileStatus(
      await probeCredentialProfileStatus(profile, adapter?.probeCredentialProfile?.bind(adapter)),
      this.vendorQuotaObservations(),
    );
    return status.verification_source === "vendor" ? status.verification : "not_run";
  }
}
