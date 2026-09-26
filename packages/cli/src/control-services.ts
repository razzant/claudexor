/** Bind typed control operations to daemon stores and engine entrypoints. */
import { mkdirSync, realpathSync } from "node:fs";
import {
  type OperatorDecisionRecord,
  JournalManager,
  InteractionRegistry,
  LiveInputRegistry,
  ProjectPartitions,
  ProjectStore,
  ResourceStore,
  QuotaRegistry,
} from "@claudexor/daemon";
import { loadConfig } from "@claudexor/config";
import { listTrustService, updateTrustService } from "./trust-services.js";
import { SecretStore, isManagedSecretName } from "@claudexor/secrets";
import { probeGitCapability, purgeThreadLanes, purgeThreadWorktree } from "@claudexor/workspace";
import { noProjectRepoRoot } from "@claudexor/util";
import {
  type ResourceAttachmentRef,
  ControlAccountsMigrationRollbackRequest,
  ControlCredentialProfileCreateRequest,
  type ControlRunStartRequest,
  type LiveMessageInput,
  type RuntimeConcurrencyCaps,
  RunScope,
  TERMINAL_LIFECYCLES,
} from "@claudexor/schema";
import { rollbackAccountsUnifiedMigration } from "./accounts-unified-migration.js";
import { credentialProfileMutations } from "./credential-profile-mutations.js";
import { quotaControlServices } from "./quota-services.js";
import { registerConfigDirProfile } from "./profile-registration.js";
import { StatusProjectionCache, globalConfigVersion } from "./status-projection-cache.js";
import { vendorVerifiedProfileStatus } from "@claudexor/orchestrator";
import { profileDoctorStatus } from "./accounts-projection.js";
import { createRetentionRunner } from "./retention-service.js";
import { AuthReadinessService } from "@claudexor/gateway";
import { buildGateway, harnessModels, harnessAccountModels } from "./registry.js";
import { credentialUnusableLedger } from "./run-orchestrator.js";
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
import { SetupJobStore } from "./setup-job-store.js";
import { activeProfileLoginJob } from "./setup-job-support.js";
import { setupJobControlServices } from "./setup-job-control-services.js";
import { SetupLifecycleBinding } from "./setup-lifecycle-binding.js";
import { createRunRequirementsPreflight } from "./request-preflight.js";
import { threadRunStartRequiresGit } from "./thread-execution-workspace.js";
import { applyThreadDiff, type ThreadApplyOptions } from "./thread-delivery.js";
import { assertCredentialProfileCompatibility } from "./profile-compatibility.js";
import { remoteFilesystemServices } from "./remote-filesystem.js";
import { projectRunApplicability } from "./run-applicability.js";
import { threadTurnServices } from "./thread-turn-services.js";
const NO_PROJECT_ROOT = noProjectRepoRoot();
type SetupJobManager = ReturnType<typeof createSetupJobManager>;
type SetupBinding = SetupLifecycleBinding<SetupJobStore, SetupJobManager>;
/**
 * The project ROOT a non-terminal job runs against (project-remove active-run
 * fence), or null when it holds no project. Parsed via the typed `RunScope`
 * schema, not a widening `{scope?:{kind?;root?}}` cast (Ф2 finding 7): a project
 * scope always carries a root, so a live project run can't silently drop out of
 * the fence. A live RUN whose scope can't be parsed FAILS CLOSED (we can't prove
 * it doesn't reference the project); a non-run job (no runId) is ignored.
 */
function activeRunProjectRoot(job: { runId?: string; params?: unknown }): string | null {
  const scope = (job.params as { scope?: unknown } | null | undefined)?.scope;
  const parsed = RunScope.safeParse(scope);
  if (parsed.success) return parsed.data.kind === "project" ? parsed.data.root : null;
  if (job.runId) {
    throw Object.assign(
      new Error(`cannot resolve the scope of active run ${job.runId} for the project-remove fence`),
      { code: "active_run_scope_unresolved", status: 409 },
    );
  }
  return null;
}

export function controlServices(
  interactions: InteractionRegistry,
  liveInputs: LiveInputRegistry,
  projects: () => ProjectStore,
  threads: ProjectPartitions,
  setupBinding: SetupBinding,
  journalManager: JournalManager,
  authReadiness: AuthReadinessService,
  /** Lazy accessor (C5b): the store mkdirs on construction and only product
   * routes touch it, so the recovery plane must never materialize it. */
  resources: () => ResourceStore,
  quotaRegistry: () => QuotaRegistry,
  daemonJobs: () => Promise<
    Array<{ runId?: string; state: string; finishedAt?: string; params?: unknown }>
  >,
  effectiveConcurrencyCaps?: RuntimeConcurrencyCaps,
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
  const bustStatusCaches = (subject?: CredentialMutationSubject) =>
    bustCredentialStatusCaches(quotaRegistry, subject);
  const journalPartition = (partition: string): JournalManager =>
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
  const lazyResources: Pick<ResourceStore, "resolve"> = {
    resolve: (refs) => resources().resolve(refs),
  };
  const runStartRequiresGit = (request: ControlRunStartRequest): boolean => {
    const root = request.scope.kind === "project" ? request.scope.root : NO_PROJECT_ROOT;
    const thread = request.threadId ? threads.getThread(request.threadId) : undefined;
    const config = loadConfig(root);
    return threadRunStartRequiresGit(
      request,
      thread,
      config.project.constraints.protected_paths,
      config.trust.access_default,
    );
  };
  const preflightRunRequirements = createRunRequirementsPreflight(lazyResources, NO_PROJECT_ROOT, {
    requiresGit: runStartRequiresGit,
  });
  const preflightThreadRunRequirements = createRunRequirementsPreflight(
    lazyResources,
    NO_PROJECT_ROOT,
    { requiresGit: runStartRequiresGit },
    { git: "durable_job" },
  );
  return {
    preflightRunRequirements,
    preflightThreadRunRequirements,
    createUpload: async (input: unknown, idempotencyKey: string) =>
      resources().create(input, idempotencyKey),
    writeUpload: async (uploadId: string, chunks: AsyncIterable<Uint8Array>) =>
      resources().write(uploadId, chunks),
    uploadStatus: async (uploadId: string) => resources().status(uploadId),
    cancelUpload: async (uploadId: string) => resources().cancel(uploadId),
    finalizeUpload: async (
      uploadId: string,
      expectedSha256: string | undefined,
      idempotencyKey: string,
    ) => resources().finalize(uploadId, expectedSha256, idempotencyKey),
    validateResources: async (refs: ResourceAttachmentRef[]) => {
      resources().resolve(refs);
    },
    runRetention: createRetentionRunner({ projects, threads, daemonJobs }),
    // F3 nested-project disclosure: each project carries its recomputed
    // nesting relations — surfaces disclose "nested inside <root>", never refuse.
    listProjects: async () => {
      const store = projects();
      return {
        projects: store.list().map((p) => ({ ...p, nesting: store.nestingFor(p.id) })) as unknown[],
      };
    },
    // QA-067: filesystem routes are a remote-runtime-only surface — the local
    // daemon never serves them (the routes answer 501 without these services).
    ...remoteFilesystemServices(projects),
    registerProject: async (input: Parameters<ProjectStore["register"]>[0]) => {
      const project = threads.registerProject(input);
      return { ...project, nesting: projects().nestingFor(project.id) };
    },
    relinkProject: async (id: string, root: string) => {
      const project = threads.relinkProject(id, root);
      return { ...project, nesting: projects().nestingFor(project.id) };
    },
    // QA-049 minimal project remove: retire the durable registry entry + archive
    // the journal partition, fenced against non-purged threads and live/queued
    // runs. The thread fence lives in ProjectPartitions; the active-run set is
    // derived here from the daemon job list (project-scoped, non-terminal runs),
    // canonicalized to match the store's realpath'd roots.
    removeProject: async (id: string) => {
      const activeRunRoots = new Set<string>();
      for (const job of await daemonJobs()) {
        if ((TERMINAL_LIFECYCLES as ReadonlySet<string>).has(job.state)) continue;
        const root = activeRunProjectRoot(job);
        if (root === null) continue;
        try {
          activeRunRoots.add(realpathSync(root));
        } catch {
          activeRunRoots.add(root);
        }
      }
      return threads.removeProject(id, activeRunRoots);
    },
    createThread: async (input: unknown) => {
      const request = (input ?? {}) as Parameters<ProjectPartitions["createThread"]>[0];
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
    purgeThread: async (id: string) => {
      const thread = threads.getThread(id);
      if (!thread) throw Object.assign(new Error(`no such thread: ${id}`), { status: 404 });
      // Journal the explicit purge authority before deleting bytes. If owned
      // cleanup fails, a repeated purge can safely finish it; validation can
      // never fail after user state has already been removed.
      const purged = threads.purgeThread(id);
      if (thread.repo && thread.workspace.mode === "isolated") {
        await purgeThreadWorktree(thread.repo.root, id);
      }
      // Durable per-lane read-only homes exist regardless of workspace mode
      // (in_place threads have them too), so sweep them for EVERY purged thread
      // (INV-034 lifecycle owner (a)).
      purgeThreadLanes(thread.repo?.root ?? NO_PROJECT_ROOT, id);
      return purged;
    },
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
            quota: quotaRegistry().read(),
            unusable: credentialUnusableLedger.live(),
          })
        : harnessModels(input.harnessId, NO_PROJECT_ROOT, true, input.route),
    authReadiness: async (input: { harnessId: string; request: unknown }) =>
      authReadiness.refresh(input.harnessId, input.request),
    agentCapabilities: async () => buildAgentCapabilityCatalog(),
    runApplicability: async (input: { repoRoot: string }) =>
      projectRunApplicability(input.repoRoot),
    ...setupJobControlServices(setupJobs),
    journalEvents: async (partition: string, afterCursor?: string) =>
      journalPartition(partition).events(afterCursor),
    recoveryInspectPartition: async (partition: string) => journalPartition(partition).inspect(),
    recoveryValidatePartition: async (partition: string) => journalPartition(partition).validate(),
    recoveryExportPartition: async (partition: string) =>
      journalPartition(partition).exportRecovery(),
    recoveryQuarantinePartition: async (partition: string, input: unknown) => {
      const request = input as Parameters<JournalManager["quarantineAndStartFresh"]>[0];
      if (partition !== "global") {
        return journalPartition(partition).quarantineAndStartFresh(request);
      }
      const preflight = journalManager.preflightQuarantine(request);
      if (preflight.disposition === "completed" && setupBinding.isBoundToCurrentGeneration()) {
        return preflight.receipt;
      }
      return setupBinding.replaceAfter(() => journalManager.quarantineAndStartFresh(request));
    },
    ...settingsControlServices(NO_PROJECT_ROOT, effectiveConcurrencyCaps, bustStatusCaches),
    ...quotaControlServices(quotaRegistry),
    // INV-135: durable registry + live doctor projection, one probe per
    // profile; adapters without profile support report honest unknown.
    // The pool-authority read (GET /v2/account-pools) shares the same cached
    // projection so the listing and the pool verdict cannot disagree.
    ...createCredentialProfilesService(quotaRegistry),
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
