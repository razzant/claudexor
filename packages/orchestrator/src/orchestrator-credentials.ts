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
  CredentialProfileStatus,
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
  stampCredentialProfileSelection,
  bindCredentialExecutionObserverFactory,
  type CredentialExecutionObserverFactory,
  type CredentialEvidenceAuthority,
  credentialExecutionSubject,
} from "@claudexor/core";
import type { EventLog } from "@claudexor/event-log";
import { accountPoolRows } from "./account-pool.js";
import { PoolRouteFlags, resolveAccountForRun } from "./account-resolution.js";
import type { AttemptOutputMarkers } from "./attemptOutputMarkers.js";
import { profileBillingVerification } from "./auth-route-classification.js";
import {
  currentSubjectProber,
  readyProfilesForRotation,
  pollerCredentialRejections,
} from "./credential-differential.js";
import {
  resolveCredentialProfile,
  probeCredentialProfileStatus,
  profileStatusAdmits,
  selectedProfileAvailability,
  type ProfilePolicy,
  type VendorQuotaObservations,
} from "./credential-profiles.js";
import {
  preProgressRefusalSubject,
  type PreProgressRefusalMemory,
  type PreProgressRefusalSubject,
  type ServiceProducer,
} from "./pre-progress-refusal.js";
import type { TransientFailureObservation } from "./transientClassify.js";
import type { RunInput } from "./orchestrator.js";
import { composeCredentialProfileEvidence } from "./account-evidence.js";

/** Model-first reviewer account resolution input, without a fabricated RunInput. */
export interface ReviewerProfileResolutionInput {
  repoRoot: string;
  harnessId: string;
  model: string | null;
  authPreference: AuthPreference;
  credentialProfileId: string | null;
  excludedProfileIds?: ReadonlySet<string>;
  /** The run's cancellation, under which an explicit seat's pin waits (#532). */
  signal?: AbortSignal;
}

export function reviewerProfileResolver(
  credentials: OrchestratorCredentials,
  repoRoot: string,
  signal?: AbortSignal,
): (
  input: Omit<ReviewerProfileResolutionInput, "repoRoot" | "signal">,
) => Promise<CredentialProfile | null> {
  return (input) => credentials.preflightReviewerProfile({ repoRoot, signal, ...input });
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
  credentialObserverFactory?(): CredentialExecutionObserverFactory | undefined;
  credentialEvidence?(): CredentialEvidenceAuthority | undefined;
  /** #363 cross-run pre-progress refusal memory (absent = nothing remembered). */
  preProgressRefusals(): PreProgressRefusalMemory | undefined;
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

type ProfileProbe = NonNullable<HarnessAdapter["probeCredentialProfile"]>;

/** The profile probes ONE admission pass made, recorded as they happen so the
 * billing read (#260) reuses the verdict that admitted a row instead of
 * probing it again. Latest wins: the selection's own probe overwrites an
 * earlier gate probe of the same row. */
export class AdmissionProfileProbes {
  private readonly made = new Map<string, Promise<CredentialProfileStatus>>();

  record(probe: ProfileProbe | undefined): ProfileProbe | undefined {
    return (
      probe &&
      ((profile, ...wait) => {
        const status = probe(profile, ...wait);
        this.made.set(`${profile.harness_id}\0${profile.profile_id}`, status);
        return status;
      })
    );
  }

  /** This exact row's recorded probe, else the adapter probe itself. */
  reuse(profile: CredentialProfile, probe: ProfileProbe | undefined): ProfileProbe | undefined {
    const made = this.made.get(`${profile.harness_id}\0${profile.profile_id}`);
    return made ? () => made : probe;
  }
}

export class OrchestratorCredentials {
  /** Q3=A explicit paid-route flags, keyed per run input (see PoolRouteFlags). */
  private readonly poolApiKeyRoutes = new PoolRouteFlags();

  constructor(private readonly host: CredentialResolutionHost) {}

  /** The EXPLICIT pin (INV-135): strict. Null = unpinned (preflightProfile). */
  effectiveProfileId(input: RunInput, _harnessId: string): string | null {
    return input.credentialProfileId ?? null;
  }

  /** #363: tell the adapter's spawn-time route check whether `spec`'s resolved
   * profile is this run's explicit pin; only an unpinned choice may start on a
   * row's bounded last positive status answer. */
  stampProfileSelection(spec: HarnessRunSpec, input: RunInput, harnessId: string): void {
    bindCredentialExecutionObserverFactory(spec, this.host.credentialObserverFactory?.());
    stampCredentialProfileSelection(spec, {
      pinned: this.effectiveProfileId(input, harnessId) !== null,
    });
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
    return policy ?? { limit_action: "auto", rotation_eligible: [], headroom_threshold: 1 };
  }

  /** The quota poller's authenticated vendor evidence for THIS decision epoch,
   * read once so every profile in the epoch is judged against one observation
   * set. This is what makes profile readiness at admission mean the same thing
   * it means on the Accounts card (INV-135 honesty). */
  vendorQuotaObservations(): VendorQuotaObservations {
    return {
      snapshots: this.host.quotaSnapshots(),
      absences: this.host.quotaAbsences(),
      honored: this.host.credentialEvidence?.()?.honored?.(),
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

  /** #363: bind one try's pre-progress refusal and last-served subject before
   * its session spawns, so its outcome never crosses a credential change made
   * mid-try. */
  bindPreProgressRefusal(harnessId: string, spec: HarnessRunSpec, producer: ServiceProducer) {
    return preProgressRefusalSubject(this.host.preProgressRefusals(), harnessId, spec, producer);
  }

  /** A7 wiring for one reactive rotation decision: the sibling differential
   * prober of the CURRENT subject plus this epoch's live observations, and the
   * #363 sink for a started session's pre-progress refusal. */
  rotationObservations(
    adapter: HarnessAdapter,
    spec: HarnessRunSpec,
    transients: readonly TransientFailureObservation[],
    refusal: PreProgressRefusalSubject | null,
  ) {
    const quota = this.vendorQuotaObservations();
    const authority = this.host.credentialEvidence?.();
    const binding = authority?.bind(credentialExecutionSubject(adapter.id, spec));
    return {
      probeCurrentSubject: currentSubjectProber({
        harnessId: adapter.id,
        profile: spec.credential_profile ?? null,
        model: spec.model_hint ?? null,
        route: credentialExecutionSubject(adapter.id, spec).route,
        quota,
        transients,
        probe: adapter.probeCredentialProfile?.bind(adapter),
        // #363: a verdict about a credential the try no longer holds — a
        // login or profile change landed since it spawned — is not recorded.
        record: (obs) => {
          // Keep the verdict/event, while its dispatch-bound observer owns storage.
          if (obs.source === "attempt_stream" && this.host.credentialObserverFactory?.()) return;
          if (authority && binding)
            authority.recordBound(binding, {
              ...obs,
              ...(binding.subject.route ? { credential_route: binding.subject.route } : {}),
            });
          else if (refusal?.current() ?? true) this.host.recordCredentialUnusable(obs);
        },
      }),
      liveUnusable: [...this.host.credentialUnusable(), ...pollerCredentialRejections(quota)],
      notePreProgressRefusal: () => refusal?.note(),
    };
  }

  /** #363 clearing: a try whose account made agent progress, or delivered
   * without an error, served its requested model — its refusal mark is stale. */
  noteTryServed(
    refusal: PreProgressRefusalSubject | null,
    markers: AttemptOutputMarkers,
    delivered: boolean,
  ): void {
    try {
      refusal?.noteServed(markers, delivered);
    } catch {
      /* ordering evidence must never fail the attempt */
    }
  }

  /**
   * Row admission for one harness lane (INV-135): an explicit pin is judged
   * alone (bounded stale LKG allowed, a last positive after a timeout not);
   * otherwise, when the default login is not ready, the bound row and then
   * every enabled pool row are judged on their OWN readiness until one admits
   * (only the bound row may consume stale LKG; any unpinned row may consume a
   * last positive after a timeout, #363). When unpinned rows exist and
   * none admits, `unreadyRows` names each row with what its probe observed —
   * the default login's doctor advice never speaks for registered rows (#363).
   * Every probe runs under the run's cancellation; the pin's probe also carries
   * the pin fact, so a slow native sign-in check is awaited, never guessed,
   * while unpinned rows keep the ordinary probe budget (#532).
   */
  async admitRouteRows(args: {
    input: RunInput;
    harnessId: string;
    defaultReady: boolean;
    model: string | null;
    quota: VendorQuotaObservations;
    unusable: readonly CredentialUnusableObservation[];
    probe: ProfileProbe | undefined;
  }): Promise<{ admitted: boolean; pinVerdict: string | null; unreadyRows: string | null }> {
    const { input, harnessId } = args;
    const registry = this.host.config(input.repoRoot)?.global.credential_profiles ?? [];
    const explicitPin = this.effectiveProfileId(input, harnessId);
    const bound = input.threadAccountBindings?.[harnessId] ?? null;
    const candidateIds: string[] = [];
    if (explicitPin) {
      candidateIds.push(explicitPin);
    } else if (!args.defaultReady) {
      const pool = accountPoolRows(registry, harnessId);
      candidateIds.push(
        ...(bound && pool.some((row) => row.profile_id === bound) ? [bound] : []),
        ...pool.map((row) => row.profile_id).filter((rowId) => rowId !== bound),
      );
    }
    const verdicts: string[] = [];
    let lastVerdict: string | null = null;
    const adapterProbe = args.probe;
    const pinned = explicitPin ? { pinned: true } : undefined;
    const probe =
      adapterProbe && ((profile: CredentialProfile) => adapterProbe(profile, input.signal, pinned));
    for (const candidateId of candidateIds) {
      const verdict = await selectedProfileAvailability({
        registry,
        profileId: candidateId,
        harnessId,
        probe,
        // `verification: passed` from the local store only means a login file
        // is present. The poller's authenticated vendor call is the only
        // liveness evidence; admission must act on it or dispatch may use a revoked token.
        quota: args.quota,
        unusable: args.unusable,
        model: args.model,
        // Only an explicit/bound route may consume bounded stale LKG evidence;
        // only an unpinned one may consume a last positive after a timeout.
        allowStale: explicitPin !== null || bound === candidateId,
        unpinned: explicitPin === null,
      });
      if (verdict === "available") return { admitted: true, pinVerdict: null, unreadyRows: null };
      lastVerdict = verdict;
      verdicts.push(`${candidateId}: ${verdict ?? "not ready"}`);
    }
    return {
      admitted: false,
      pinVerdict: explicitPin ? lastVerdict : null,
      unreadyRows:
        !explicitPin && verdicts.length > 0
          ? `${harnessId} has no ready account (${verdicts.join("; ")})`
          : null,
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
      // The seat's pin waits for its sign-in check like a run's pin (#532).
      const adapterProbe = adapter?.probeCredentialProfile?.bind(adapter);
      const status = composeCredentialProfileEvidence(
        await probeCredentialProfileStatus(
          pinnedProfile,
          adapterProbe && ((profile) => adapterProbe(profile, input.signal, { pinned: true })),
        ),
        {
          quota,
          unusable: this.host.credentialUnusable(),
          model: input.model,
          route: pinnedProfile.credential_kind === "api_key" ? "managed_api_key" : "vendor_native",
        },
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
      refusals: this.host.preProgressRefusals()?.live(),
      lastService: this.host.preProgressRefusals()?.services,
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
    probes?: AdmissionProfileProbes,
  ): Promise<CredentialProfile | null> {
    const adapter = this.host.registry().get(harnessId);
    const registry = this.host.config(input.repoRoot)?.global.credential_profiles ?? [];
    const profileCardinality = credentialProfilePolicyState({ adapter, registry });
    if (profileCardinality.ambiguous)
      throw credentialProfilePolicyProblem(profileCardinality, "credential_profile_ambiguous");
    const probe = adapter?.probeCredentialProfile?.bind(adapter);
    return resolveAccountForRun({
      harnessId,
      registry,
      policy: this.profilePolicy(input.repoRoot, harnessId),
      profileCardinality,
      snapshots: this.host.quotaSnapshots(),
      quota: this.vendorQuotaObservations(),
      unusable: this.host.credentialUnusable(),
      refusals: this.host.preProgressRefusals()?.live(),
      lastService: this.host.preProgressRefusals()?.services,
      probe: probes ? probes.record(probe) : probe,
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

  /** Billing verification for the EXACT profile quota admission selected
   * (#260): the default doctor's auth sources describe another credential
   * store, so they never classify a named profile. The pass's recorded probe
   * is reused; the adapter is probed only when this pass never probed the row. */
  async selectedProfileBillingVerification(
    profile: CredentialProfile,
    probes?: AdmissionProfileProbes,
  ): Promise<AuthVerification> {
    const adapter = this.host.registry().get(profile.harness_id);
    const adapterProbe = adapter?.probeCredentialProfile?.bind(adapter);
    const probe = probes ? probes.reuse(profile, adapterProbe) : adapterProbe;
    return profileBillingVerification(
      composeCredentialProfileEvidence(await probeCredentialProfileStatus(profile, probe), {
        quota: this.vendorQuotaObservations(),
        unusable: this.host.credentialUnusable(),
        route: profile.credential_kind === "api_key" ? "managed_api_key" : "vendor_native",
      }),
    );
  }
}
