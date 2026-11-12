/** Bind typed control operations to daemon stores and engine entrypoints. */
import { mkdirSync } from "node:fs";
import {
  type OperatorDecisionRecord,
  PartitionControlPort,
  InteractionRegistry,
  LiveInputRegistry,
  ProjectControlPort,
  ProjectStorePort,
  ResourceStorePort,
  QuotaRegistry,
  AccountEvidence,
} from "@claudexor/daemon";
import { loadConfig } from "@claudexor/config";
import { listTrustService, updateTrustService } from "./trust-services.js";
import { SecretStore, isManagedSecretName } from "@claudexor/secrets";
import { probeGitCapability } from "@claudexor/workspace";
import { noProjectRepoRoot } from "@claudexor/util";
import {
  type ResourceAttachmentRef,
  ControlAccountsMigrationRollbackRequest,
  ControlCredentialProfileCreateRequest,
  type LiveMessageInput,
  type RuntimeConcurrencyCaps,
} from "@claudexor/schema";
import { rollbackAccountsUnifiedMigration } from "./accounts-unified-migration.js";
import { credentialProfileMutations } from "./credential-profile-mutations.js";
import { quotaControlServices } from "./quota-services.js";
import { uploadServices } from "./upload-services.js";
import { registerConfigDirProfile } from "./profile-registration.js";
import { StatusProjectionCache, globalConfigVersion } from "./status-projection-cache.js";
import { vendorVerifiedProfileStatus } from "@claudexor/orchestrator";
import { profileDoctorStatus } from "./accounts-projection.js";
import { createNativeHomeRetention } from "./native-home-retention.js";
import { createRetentionRunner } from "./retention-service.js";
import { AuthReadinessService } from "@claudexor/gateway";
import { buildGateway, harnessModels, harnessAccountModels } from "./registry.js";
import {
  createCredentialProfilesService,
  projectHarnessStatuses,
  type HarnessListInput,
} from "./accounts-services.js";
import { buildAgentCapabilityCatalog } from "./capabilities.js";
import { settingsControlServices } from "./settings-service.js";
import {
  bustCredentialStatusCaches,
  type CredentialMutationSubject,
} from "./credential-status-invalidation.js";
import { createSetupJobManager } from "./setup-jobs.js";
import type { SetupJobStorePort } from "./setup-job-projection.js";
import { activeProfileLoginJob } from "./setup-job-support.js";
import { setupJobControlServices } from "./setup-job-control-services.js";
import { SetupLifecycleBinding } from "./setup-lifecycle-binding.js";
import { createThreadAwareRunRequirementsPreflights } from "./request-preflight.js";
import { applyThreadDiff, type ThreadApplyOptions } from "./thread-delivery.js";
import { assertCredentialProfileCompatibility } from "./profile-compatibility.js";
import { recoveryControlServices } from "./recovery-control-services.js";
import { remoteFilesystemServices } from "./remote-filesystem.js";
import { projectRunApplicability } from "./run-applicability.js";
import { threadTurnServices } from "./thread-turn-services.js";
import { threadPurgeOwner, type ThreadPurgeDurability } from "./thread-purge.js";
import { laneCredentialStores, threadExportService } from "./thread-export-services.js";
import { projectRemovalService } from "./project-removal.js";
const NO_PROJECT_ROOT = noProjectRepoRoot();
type SetupJobManager = ReturnType<typeof createSetupJobManager>;
type SetupBinding = Pick<
  SetupLifecycleBinding<SetupJobStorePort, SetupJobManager>,
  "current" | "isBoundToCurrentGeneration" | "replaceAfter" | "hasActiveWork"
>;
export function controlServices(
  interactions: InteractionRegistry,
  liveInputs: LiveInputRegistry,
  projects: () => ProjectStorePort,
  threads: ProjectControlPort,
  setupBinding: SetupBinding,
  journalManager: PartitionControlPort,
  authReadiness: AuthReadinessService,
  /** Lazy accessor (C5b): the store mkdirs on construction and only product
   * routes touch it, so the recovery plane must never materialize it. */
  resources: () => ResourceStorePort,
  quotaRegistry: () => QuotaRegistry,
  /** The store's account evidence graph: invalidation and Accounts reads share it. */
  accounts: AccountEvidence,
  daemonJobs: () => Array<{ runId?: string; state: string; finishedAt?: string; params?: unknown }>,
  effectiveConcurrencyCaps?: RuntimeConcurrencyCaps,
  purgeDurability?: ThreadPurgeDurability,
) {
  const secretStore = new SecretStore();
  const listHarnesses = async (input?: HarnessListInput) => {
    const [statuses, git] = await Promise.all([
      buildGateway({ includeFakes: input?.includeFakes ?? false }).statusAll(
        { cwd: NO_PROJECT_ROOT, fresh: input?.fresh ?? false },
        input?.harnessIds,
      ),
      probeGitCapability(),
    ]);
    // git is additive/optional on the wire so older clients can ignore it.
    return { git, harnesses: await projectHarnessStatuses(statuses) };
  };
  // Default-shape polls ride the TTL cache: a sweep per 5s tick starved the daemon (2026-08-04).
  const harnessesPollCache = new StatusProjectionCache<Awaited<ReturnType<typeof listHarnesses>>>({
    versionOf: globalConfigVersion,
  });
  // The capability catalog is the same sweep plus model truth per harness. Read
  // per run entry, it kept doctors running after 3 s callers left (2026-11-01).
  const catalogCache = new StatusProjectionCache<
    Awaited<ReturnType<typeof buildAgentCapabilityCatalog>>
  >({ versionOf: globalConfigVersion });
  const bustStatusCaches = (subject?: CredentialMutationSubject) =>
    bustCredentialStatusCaches(quotaRegistry, accounts, subject);
  const journalPartition = (partition: string): PartitionControlPort =>
    partition === "global" ? journalManager : threads.journal(partition);
  const setupJobs = (): SetupJobManager => {
    try {
      return setupBinding.current();
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        ((error as { code: unknown }).code === "journal_recovery_required" ||
          (error as { code: unknown }).code === "journal_append_uncertain")
      ) {
        Object.assign(error, { evidenceRefs: journalManager.inspect().evidenceRefs });
      }
      throw error;
    }
  };
  mkdirSync(NO_PROJECT_ROOT, { recursive: true, mode: 0o700 });
  const lazyResources: Pick<ResourceStorePort, "resolve"> = {
    // The holder rides along (#249): a recorded turn's own refs, never a new reference.
    resolve: (refs, heldBy) => resources().resolve(refs, heldBy),
  };
  const { preflightRunRequirements, preflightThreadRunRequirements } =
    createThreadAwareRunRequirementsPreflights(lazyResources, NO_PROJECT_ROOT, threads);
  // Routes and retention share one thread purge and durability owner.
  const { purgeThread, hasPurgeLeftovers, finishPurge } = threadPurgeOwner(
    threads,
    NO_PROJECT_ROOT,
    purgeDurability,
    laneCredentialStores,
  );
  return {
    preflightRunRequirements,
    preflightThreadRunRequirements,
    ...uploadServices(resources),
    validateResources: async (
      refs: ResourceAttachmentRef[],
      heldBy?: { owner: "turn"; id: string },
    ) => {
      resources().resolve(refs, heldBy);
    },
    runRetention: createRetentionRunner({
      projects,
      threads,
      daemonJobs,
      purgeThread,
      hasPurgeLeftovers,
      nativeHomes: createNativeHomeRetention({
        threads,
        // Product admission is covered by the SQL snapshot and its fresh
        // change proof. Only setup's in-memory activity needs a separate read.
        isBusy: () => setupBinding.hasActiveWork(),
      }),
    }),
    // Nested projects are disclosed, never refused.
    listProjects: async () => ({ projects: projects().listWithNesting() as unknown[] }),
    // Filesystem routes are available only on the remote runtime.
    ...remoteFilesystemServices(projects),
    registerProject: async (input: Parameters<ProjectStorePort["register"]>[0]) => {
      const { project, created } = threads.registerProject(input);
      return { ...project, nesting: projects().nestingFor(project.id), created };
    },
    relinkProject: async (id: string, root: string) => {
      const project = threads.relinkProject(id, root);
      return { ...project, nesting: projects().nestingFor(project.id) };
    },
    // QA-049/#333: project remove and its explicit trashed-thread purge opt-in.
    removeProject: projectRemovalService(threads, daemonJobs, finishPurge),
    createThread: async (input: unknown) => {
      const request = (input ?? {}) as Parameters<ProjectControlPort["createThread"]>[0];
      assertCredentialProfileCompatibility(
        request.credentialProfileId,
        request.primaryHarness,
        request.eligibleHarnesses ?? [],
        loadConfig(NO_PROJECT_ROOT).global.credential_profiles,
      );
      return threads.createThread(request);
    },
    listThreads: async () => {
      const { threads: rows, problems } = threads.listThreadsResilient();
      return { threads: rows as unknown[], problems: problems as unknown[] };
    },
    ...threadTurnServices(threads, lazyResources),
    updateThread: async (
      id: string,
      patch: {
        title?: string;
        folder?: string | null;
        state?: string;
        primaryHarness?: string | null;
        credentialProfileId?: string | null;
        eligibleHarnesses?: string[];
        access?: string | null;
      },
    ) => {
      const current = threads.getThread(id);
      if (!current) throw Object.assign(new Error(`no such thread: ${id}`), { status: 404 });
      const profileId =
        patch.credentialProfileId === undefined
          ? current.credential_profile_id
          : patch.credentialProfileId;
      const pool = patch.eligibleHarnesses ?? current.eligible_harnesses;
      const primary =
        patch.primaryHarness === undefined ? current.primary_harness : patch.primaryHarness;
      if (
        patch.credentialProfileId !== undefined ||
        patch.primaryHarness !== undefined ||
        patch.eligibleHarnesses !== undefined
      ) {
        assertCredentialProfileCompatibility(
          profileId,
          primary,
          pool,
          loadConfig(NO_PROJECT_ROOT).global.credential_profiles,
        );
      }
      return threads.updateThread(id, {
        title: patch.title,
        folder: patch.folder,
        state: patch.state as any,
        primaryHarness: patch.primaryHarness,
        credentialProfileId: patch.credentialProfileId,
        eligibleHarnesses: patch.eligibleHarnesses,
        // Sticky write scope: forward exactly like the sibling fields so an
        // omitted access leaves it unchanged, a concrete value sets it, and null
        // clears it back to the repo trust default. Dropping it here silently
        // voided every access PATCH at HTTP 200 and let a de-escalated thread
        // keep its stale scope for the next omitted-body turn (QA-037).
        access: patch.access as any,
      });
    },
    trashThread: async (id: string) => threads.trashThread(id),
    restoreThread: async (id: string) => threads.restoreThread(id),
    purgeThread,
    threadExport: threadExportService(threads, lazyResources, finishPurge, hasPurgeLeftovers),
    applyThread: async (id: string, opts: ThreadApplyOptions) => applyThreadDiff(threads, id, opts),
    listTrust: listTrustService,
    updateTrust: updateTrustService,
    pendingInteractions: (runId: string) => interactions.pendingForRun(runId),
    answerInteraction: (runId: string, interactionId: string, answers: unknown) =>
      interactions.answer(runId, interactionId, answers),
    sendRunMessage: (input: LiveMessageInput) => liveInputs.send(input),
    operatorDecision: (runId: string, params: unknown) => threads.operatorDecision(params, runId),
    findOperatorDecisionByIdempotency: (
      runId: string,
      params: unknown,
      idempotency: { key: string; client: string; request: unknown },
    ) => threads.findOperatorDecisionByIdempotency(params, runId, idempotency),
    recordOperatorDecision: (
      runId: string,
      params: unknown,
      decision: Omit<OperatorDecisionRecord, "runId">,
      idempotency?: { key: string; client: string; request: unknown },
    ) => threads.recordOperatorDecision(params, { runId, ...decision }, idempotency),
    beginDelivery: async (
      params: unknown,
      input: { key: string; client: string; operation: string; request: unknown },
    ) => threads.beginDelivery(params, input),
    completeDelivery: async (id: string, result: unknown) => threads.completeDelivery(id, result),
    failDelivery: async (id: string, error: unknown) => threads.failDelivery(id, error),
    harnesses: async (input?: HarnessListInput) =>
      !input?.includeFakes && !input?.fresh && !input?.harnessIds?.length
        ? harnessesPollCache.read(() => listHarnesses())
        : listHarnesses(input),
    harnessModels: async (input: {
      harnessId: string;
      route?: "local_session" | "api_key";
      view?: "accounts";
      credentialProfileId?: string;
    }) =>
      input.view === "accounts"
        ? harnessAccountModels({
            ...input,
            cwd: NO_PROJECT_ROOT,
            config: loadConfig(NO_PROJECT_ROOT).global,
            quota: { ...quotaRegistry().read(), honored: accounts.unusable.honored() },
            unusable: accounts.unusable.live(),
          })
        : harnessModels(input.harnessId, NO_PROJECT_ROOT, true, input.route),
    authReadiness: async (input: { harnessId: string; request: unknown }) =>
      authReadiness.refresh(input.harnessId, input.request),
    agentCapabilities: async () => catalogCache.read(() => buildAgentCapabilityCatalog()),
    runApplicability: async (input: { repoRoot: string }) =>
      projectRunApplicability(input.repoRoot),
    ...setupJobControlServices(setupJobs),
    ...recoveryControlServices({ partition: journalPartition, setup: () => setupBinding }),
    ...settingsControlServices(NO_PROJECT_ROOT, effectiveConcurrencyCaps, bustStatusCaches),
    ...quotaControlServices(quotaRegistry),
    // INV-135: durable registry + live doctor projection, one probe per
    // profile; adapters without profile support report honest unknown.
    // The pool-authority read (GET /v2/account-pools) shares the same cached
    // projection so the listing and the pool verdict cannot disagree.
    ...createCredentialProfilesService(quotaRegistry, accounts),
    // PATCH + DELETE /credential-profiles/:harness/:id — the Enabled toggle
    // (with the migrated row's native_credentials_enabled downgrade mirror)
    // and the provable D-U4 removal, owned by credential-profile-mutations.ts.
    ...credentialProfileMutations({
      threads,
      quotaRegistry,
      secretStore,
      bustStatusCaches,
      activeLoginJob: (harnessId, profileId) =>
        activeProfileLoginJob(setupJobs, harnessId, profileId),
    }),
    // POST /accounts-migration/rollback — the supported downgrade path's
    // first step (unified account model): surgically reverses the startup
    // migration (sessions/checkpoints/lane homes back to the engine-default
    // keys, the auto-registered row out of the registry, its enabled state
    // back onto the native_credentials_enabled mirror). Run BEFORE installing
    // an engine whose canonicalizers refuse the native locator.
    rollbackAccountsMigration: async (input: unknown) => {
      const request = ControlAccountsMigrationRollbackRequest.parse(input ?? {});
      const rolledBack = rollbackAccountsUnifiedMigration(
        { threads, quota: quotaRegistry() },
        request.harnessId,
      );
      bustStatusCaches();
      return { rolledBack };
    },
    // POST /credential-profiles: the SAME ONE registration owner the CLI's
    // `profiles add` uses (profile-registration.ts) — never a second write
    // path. Returns the initial doctor projection so the UI can immediately
    // offer the login step for the still-logged-out profile.
    createCredentialProfile: async (input: unknown) => {
      const request = ControlCredentialProfileCreateRequest.parse(input ?? {});
      const { profile } = registerConfigDirProfile({
        harnessId: request.harnessId,
        profileId: request.profileId,
        displayName: request.displayName,
      });
      bustStatusCaches({ harnessId: request.harnessId, profileId: request.profileId });
      return {
        profile,
        status: vendorVerifiedProfileStatus(
          await profileDoctorStatus(profile),
          quotaRegistry().read(),
        ),
      };
    },
    listSecrets: async () => ({
      backend: secretStore.resolvedBackend(),
      secrets: secretStore.list(),
    }),
    setSecret: async (input: unknown) => {
      const p = (input ?? {}) as Record<string, unknown>;
      const name = typeof p["name"] === "string" ? p["name"] : "";
      const value = typeof p["value"] === "string" ? p["value"] : "";
      if (!name || !value) throw new Error("name and value are required");
      // ONE grammar for every ingress (release wave round-11): the HTTP path
      // must bound names exactly like the CLI, or profile secret_refs written
      // against the namespaced allowlist stop meaning anything.
      if (!isManagedSecretName(name)) {
        throw Object.assign(
          new Error(`secret name must be a managed name or managed:profile slot, got "${name}"`),
          { status: 400 },
        );
      }
      const backend = secretStore.set(name, value);
      bustStatusCaches({ secretName: name });
      return {
        name,
        backend,
        stored: true,
        ...(secretStore.lastFallbackReason ? { warning: secretStore.lastFallbackReason } : {}),
      };
    },
    deleteSecret: async (name: string) => {
      secretStore.delete(name);
      bustStatusCaches({ secretName: name });
      return { name, deleted: true };
    },
  };
}
