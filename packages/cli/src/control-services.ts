/**
 * Factory of the daemon's control-api service closures (extracted from the
 * claudexord composition root, which stays thin). Each closure binds one
 * typed control operation to the daemon's stores and engine entrypoints.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import {
  type OperatorDecisionRecord,
  JournalManager,
  InteractionRegistry,
  ProjectPartitions,
  ProjectStore,
  ResourceStore,
  QuotaRegistry,
  daemonDir,
} from "@claudexor/daemon";
import { Orchestrator } from "@claudexor/orchestrator";
import { loadConfig, updateGlobalConfig } from "@claudexor/config";
import { listTrustService, updateTrustService } from "./trust-services.js";
import { SecretStore, isManagedSecretName } from "@claudexor/secrets";
import { purgeThreadWorktree } from "@claudexor/workspace";
import { claudexorOwnedRoot, noProjectRepoRoot, readTextSafe } from "@claudexor/util";
import {
  type ResourceAttachmentRef,
  type ControlSpecAnswersRequest,
  type ControlSpecQuestionsRequest,
  ControlCredentialProfileCreateRequest,
  type CredentialProfile,
  type CredentialProfileStatus,
  ControlSettingsUpdateRequest,
} from "@claudexor/schema";
import { registerConfigDirProfile, removeProfileFromRegistry } from "./profile-registration.js";
import { createRetentionRunner } from "./retention-service.js";
import {
  canonicalIsolationLocator,
  invalidateDoctorCache,
  normalizeThroughExistingAncestor,
  validateModel,
} from "@claudexor/core";
import { canonicalProfileConfigDir } from "@claudexor/harness-claude";
import { canonicalCodexProfileHome } from "@claudexor/harness-codex";
import { AuthReadinessService, normalizeReadiness } from "@claudexor/gateway";
import { buildGateway, buildRegistry, harnessModels } from "./registry.js";
import { buildAgentCapabilityCatalog } from "./capabilities.js";
import {
  applyHarnessSettingsPatches,
  assertSettingsPatchValid,
  settingsSnapshot,
} from "./settings-service.js";
import { createSetupJobManager } from "./setup-jobs.js";
import { ACTIVE_SETUP_STATES, SetupJobStore } from "./setup-job-store.js";
import { SetupLifecycleBinding } from "./setup-lifecycle-binding.js";
import { createRunRequirementsPreflight } from "./request-preflight.js";
import { applyThreadDiff, type ThreadApplyOptions } from "./thread-delivery.js";
import {
  assertCredentialProfileCompatibility,
  assertCredentialProfileRegistered,
} from "./profile-compatibility.js";
import { assertSpecThreadScope } from "./spec-thread-scope.js";
import {
  buildGroundingPrompt,
  extractQuestionsFromPlan,
  freezeSpecFromGrounding,
  persistSpecAt,
} from "./spec.js";

const NO_PROJECT_ROOT = noProjectRepoRoot();

async function profileDoctorStatus(profile: CredentialProfile): Promise<CredentialProfileStatus> {
  const adapter = buildRegistry().get(profile.harness_id);
  return adapter?.probeCredentialProfile
    ? adapter.probeCredentialProfile(profile)
    : {
        profile_id: profile.profile_id,
        harness_id: profile.harness_id,
        availability: "unknown" as const,
        verification: "not_run" as const,
        detail: `harness "${profile.harness_id}" has no profile probe`,
        last_verified_at: null,
      };
}

type SetupJobManager = ReturnType<typeof createSetupJobManager>;
type SetupBinding = SetupLifecycleBinding<SetupJobStore, SetupJobManager>;
type HarnessListInput = { fresh?: boolean; includeFakes?: boolean; harnessIds?: string[] };
export function controlServices(
  interactions: InteractionRegistry,
  projects: () => ProjectStore,
  threads: ProjectPartitions,
  setupBinding: SetupBinding,
  journalManager: JournalManager,
  authReadiness: AuthReadinessService,
  resources: ResourceStore,
  quotaRegistry: () => QuotaRegistry,
  daemonJobs: () => Promise<Array<{ runId?: string; state: string; finishedAt?: string }>>,
) {
  const secretStore = new SecretStore();
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
  const requireSpecStore = (id: string) => {
    const store = threads.specStoreForSession(id);
    if (!store) throw Object.assign(new Error(`no such spec session: ${id}`), { status: 404 });
    return store;
  };
  const specControllers = new Map<string, AbortController>();
  const groundSpec = async (id: string) => {
    const store = requireSpecStore(id);
    const material = store.material(id);
    const controller = new AbortController();
    specControllers.set(id, controller);
    try {
      const plan = await new Orchestrator({
        registry: buildRegistry(),
        quotaSnapshots: () => quotaRegistry().read().snapshots,
        quotaEventSink: (harnessId, event) => quotaRegistry().ingest(harnessId, event),
        reviewerPanel: material.request.reviewerPanel,
        reviewerModels: material.request.reviewerModels,
        reviewerEfforts: material.request.reviewerEfforts,
      }).run({
        repoRoot: material.request.scope.root,
        prompt: buildGroundingPrompt(
          material.request.prompt,
          material.request.priorDecisions ?? [],
        ),
        mode: "plan",
        harnesses: material.request.harnesses,
        n: material.request.n,
        effort: material.request.effort,
        paidBudget: material.request.paidBudget,
        web: material.request.web,
        signal: controller.signal,
        access: "readonly",
      });
      const planText = readTextSafe(join(plan.runDir, "final", "plan.md")) ?? plan.summary;
      return store.completeGrounding(id, {
        planRunId: plan.runId,
        planText,
        questions: extractQuestionsFromPlan(planText),
      });
    } catch (error) {
      const current = store.get(id);
      if (current?.state === "cancelled") return current;
      store.fail(id, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      if (specControllers.get(id) === controller) specControllers.delete(id);
    }
  };
  const freezeSpecSession = async (id: string) => {
    const store = requireSpecStore(id);
    const material = store.material(id);
    const active = store.beginFreeze(id);
    try {
      const priorLines = material.answers.priorDecisions?.map(
        (decision) => `Interview (prior tier) — ${decision.question} → ${decision.answer}`,
      );
      const spec = await freezeSpecFromGrounding(material.request.prompt, material.planText, {
        answers: material.answers.answers,
        decided_tradeoffs: priorLines,
      });
      const persisted = persistSpecAt(join(daemonDir(), "specs"), spec, material.planText);
      return store.completeFreeze(id, {
        specId: spec.id,
        specDir: persisted.specDir,
        specPath: join(persisted.specDir, "spec.json"),
        specHash: persisted.specHash,
        changes: persisted.changes,
      });
    } catch (error) {
      store.rejectFreeze(active.sessionId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
  mkdirSync(NO_PROJECT_ROOT, { recursive: true, mode: 0o700 });
  const preflightRunRequirements = createRunRequirementsPreflight(resources, NO_PROJECT_ROOT);
  return {
    preflightRunRequirements,
    createUpload: async (input: unknown, idempotencyKey: string) =>
      resources.create(input, idempotencyKey),
    writeUpload: async (uploadId: string, chunks: AsyncIterable<Uint8Array>) =>
      resources.write(uploadId, chunks),
    uploadStatus: async (uploadId: string) => resources.status(uploadId),
    cancelUpload: async (uploadId: string) => resources.cancel(uploadId),
    finalizeUpload: async (
      uploadId: string,
      expectedSha256: string | undefined,
      idempotencyKey: string,
    ) => resources.finalize(uploadId, expectedSha256, idempotencyKey),
    validateResources: async (refs: ResourceAttachmentRef[]) => {
      resources.resolve(refs);
    },
    runRetention: createRetentionRunner({ projects, threads, daemonJobs }),
    listProjects: async () => ({ projects: projects().list() as unknown[] }),
    registerProject: async (input: Parameters<ProjectStore["register"]>[0]) =>
      threads.registerProject(input),
    relinkProject: async (id: string, root: string) => threads.relinkProject(id, root),
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
    listThreads: async () => ({ threads: threads.listThreads() as unknown[] }),
    threadDetail: async (id: string) => {
      const thread = threads.getThread(id);
      if (!thread) throw Object.assign(new Error(`no such thread: ${id}`), { status: 404 });
      return {
        thread: thread as unknown,
        sessions: threads.sessionsForThread(id) as unknown[],
        turns: threads.turnsFor(id) as unknown[],
      };
    },
    createThreadTurn: async (
      id: string,
      prompt: string,
      opts: {
        kind?: unknown;
        parentRunId?: string | null;
        planRunId?: string | null;
        planHash?: string | null;
        planOverridden?: boolean;
        attachments?: ResourceAttachmentRef[];
        idempotency?: { key: string; client: string; request: unknown };
      },
    ) =>
      threads.createTurn(id, prompt, {
        kind: opts.kind as any,
        parentRunId: opts.parentRunId,
        planRunId: opts.planRunId,
        planHash: opts.planHash,
        planOverridden: opts.planOverridden,
        attachments: resources.resolve(opts.attachments),
        idempotency: opts.idempotency,
      }),
    updateThread: async (
      id: string,
      patch: {
        title?: string;
        state?: string;
        primaryHarness?: string | null;
        credentialProfileId?: string | null;
        eligibleHarnesses?: string[];
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
        state: patch.state as any,
        primaryHarness: patch.primaryHarness,
        credentialProfileId: patch.credentialProfileId,
        eligibleHarnesses: patch.eligibleHarnesses,
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
      return purged;
    },
    applyThread: async (id: string, opts: ThreadApplyOptions) => applyThreadDiff(threads, id, opts),
    setTurnEnqueueError: (
      turnId: string,
      message: string,
      code: string | null,
      retryable?: boolean,
    ) => threads.setTurnEnqueueError(turnId, message, code, retryable ?? true),
    listTrust: listTrustService,
    updateTrust: updateTrustService,
    pendingInteractions: (runId: string) => interactions.pendingForRun(runId),
    answerInteraction: (runId: string, interactionId: string, answers: unknown) =>
      interactions.answer(runId, interactionId, answers),
    operatorDecision: (runId: string, params: unknown) => threads.operatorDecision(params, runId),
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
    harnesses: async (input?: HarnessListInput) => {
      const statuses = await buildGateway({ includeFakes: input?.includeFakes ?? false }).statusAll(
        { cwd: NO_PROJECT_ROOT, fresh: input?.fresh ?? false },
        input?.harnessIds,
      );
      const cfg = loadConfig(NO_PROJECT_ROOT);
      return {
        harnesses: await Promise.all(
          statuses.map(async (s) => {
            const configured = cfg.global.harnesses[s.id]?.default_model ?? null;
            let check: { status: "ok" | "rejected"; message?: string | null } | null = null;
            if (configured) {
              const truth = await harnessModels(s.id, NO_PROJECT_ROOT, true);
              check = validateModel(
                configured,
                truth.models.map((m) => m.id),
                truth.source === "api" ? "api" : "manifest",
              );
            }
            return {
              ...s,
              configuredModel: configured,
              configuredModelCheck: check,
              // The display-ready readiness list (W4.7): normalized ONCE here;
              // Swift renders it verbatim and never parses ids or strings.
              readiness: normalizeReadiness({
                checks: s.checks,
                authSources: s.authSources,
                configuredModel: configured,
                configuredModelCheck: check,
              }),
            };
          }),
        ),
      };
    },
    harnessModels: async (input: { harnessId: string; route?: "local_session" | "api_key" }) =>
      harnessModels(input.harnessId, NO_PROJECT_ROOT, true, input.route),
    authReadiness: async (input: { harnessId: string; request: unknown }) =>
      authReadiness.refresh(input.harnessId, input.request),
    agentCapabilities: async () => buildAgentCapabilityCatalog(),
    createSetupJob: async (input: { request: unknown; idempotencyKey: string; clientId: string }) =>
      setupJobs().create(input.request, {
        key: input.idempotencyKey,
        client: input.clientId,
      }),
    listSetupJobs: async (input?: unknown) => {
      const jobs = setupJobs();
      return { jobs: jobs.list(input as Parameters<typeof jobs.list>[0]) };
    },
    setupJobStatus: async (input: unknown) => setupJobs().status(input),
    setupJobSnapshot: async (input: unknown) => setupJobs().snapshot(input),
    setupJobEvents: async (input: unknown) => setupJobs().events(input),
    cancelSetupJob: async (input: unknown) => setupJobs().cancel(input),
    reconcileSetupJob: async (input: unknown) => setupJobs().reconcile(input),
    extendSetupJob: async (input: unknown) => setupJobs().extend(input),
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
    settings: async () => settingsSnapshot(NO_PROJECT_ROOT),
    quota: async () => quotaRegistry().read(),
    refreshQuota: async () => quotaRegistry().refresh(),
    // INV-135: durable registry + live doctor projection, one probe per
    // profile; adapters without profile support report honest unknown.
    credentialProfiles: async () => {
      const profiles = loadConfig(NO_PROJECT_ROOT).global.credential_profiles;
      const out = [];
      for (const profile of profiles) {
        out.push({ profile, status: await profileDoctorStatus(profile) });
      }
      return { profiles: out };
    },
    // INV-135 deletion: registry first; scoped material cleanup is fenced and disclosed.
    deleteCredentialProfile: async (input: unknown) => {
      const p = (input ?? {}) as Record<string, unknown>;
      const harnessId = typeof p["harnessId"] === "string" ? p["harnessId"] : "";
      const profileId = typeof p["profileId"] === "string" ? p["profileId"] : "";
      if (!harnessId || !profileId) {
        throw Object.assign(new Error("harnessId and profileId are required"), { status: 400 });
      }
      const activeLogin = setupJobs()
        .list({ harness: harnessId as "claude" | "codex" | "cursor" })
        .find((job) => ACTIVE_SETUP_STATES.has(job.state) && job.profileId === profileId);
      if (activeLogin) {
        throw Object.assign(
          new Error(
            `a login for this account is in progress (${activeLogin.jobId}); cancel it before removing the account`,
          ),
          { status: 409 },
        );
      }
      assertCredentialProfileRegistered(
        loadConfig(NO_PROJECT_ROOT).global.credential_profiles,
        harnessId,
        profileId,
      );
      threads.invalidateCredentialProfile(harnessId, profileId);
      quotaRegistry().removeSubject(harnessId, profileId);
      const entry = removeProfileFromRegistry(harnessId, profileId);
      let credentialCleanup: "config_dir_removed" | "secret_deleted" | "none" = "none";
      const cleanupWarnings: string[] = [];
      try {
        if (entry.credential_kind === "config_dir_login" && entry.isolation_locator) {
          const dir =
            harnessId === "claude"
              ? canonicalProfileConfigDir(entry.isolation_locator)
              : harnessId === "codex"
                ? canonicalCodexProfileHome(entry.isolation_locator)
                : canonicalIsolationLocator(entry.isolation_locator, "credential profile dir");
          // Recursive deletion is fenced to a strict descendant of the profiles tree.
          const profilesRoot = normalizeThroughExistingAncestor(
            join(claudexorOwnedRoot(), "profiles"),
          );
          if (!dir.startsWith(profilesRoot + sep)) {
            throw new Error(
              `refusing to delete "${dir}": not inside the profiles tree ${profilesRoot}`,
            );
          }
          if (existsSync(dir)) {
            rmSync(dir, { recursive: true, force: true });
            credentialCleanup = "config_dir_removed";
          }
        } else if (entry.secret_ref) {
          secretStore.delete(entry.secret_ref);
          credentialCleanup = "secret_deleted";
        }
      } catch (err) {
        cleanupWarnings.push(
          `registry entry removed, but credential cleanup failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      invalidateDoctorCache();
      return {
        profile: entry,
        removed: true,
        credentialCleanup,
        ...(cleanupWarnings.length > 0 ? { cleanupWarning: cleanupWarnings.join("; ") } : {}),
      };
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
      invalidateDoctorCache();
      return { profile, status: await profileDoctorStatus(profile) };
    },
    updateSettings: async (patch: unknown) => {
      const p = ControlSettingsUpdateRequest.parse(patch ?? {});
      await assertSettingsPatchValid(p);
      const nullableName = (
        value: string | null | undefined,
        current: string | null,
      ): string | null => {
        if (value === undefined) return current;
        if (value === null) return null;
        return value;
      };
      updateGlobalConfig((cfg) => ({
        ...cfg,
        interaction_timeout_ms: p.interactionTimeoutMs ?? cfg.interaction_timeout_ms,
        routing: {
          ...cfg.routing,
          primary_harness: nullableName(p.primaryHarness, cfg.routing.primary_harness),
          env_inheritance: p.envInheritance ?? cfg.routing.env_inheritance,
          eligible_harnesses: p.eligibleHarnesses ?? cfg.routing.eligible_harnesses,
          auth_preference: p.authPreference ?? cfg.routing.auth_preference,
          goal: p.routingGoal ?? cfg.routing.goal,
          paid_fallback: p.paidFallback ?? cfg.routing.paid_fallback,
          quality_tiers: p.qualityTiers ?? cfg.routing.quality_tiers,
        },
        budget: {
          ...cfg.budget,
          paid_budget_per_run: p.paidBudgetPerRun ?? cfg.budget.paid_budget_per_run,
        },
        harnesses: applyHarnessSettingsPatches(cfg.harnesses, p.harnesses),
      }));
      invalidateDoctorCache();
      return settingsSnapshot(NO_PROJECT_ROOT);
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
      invalidateDoctorCache();
      return {
        name,
        backend,
        stored: true,
        ...(secretStore.lastFallbackReason ? { warning: secretStore.lastFallbackReason } : {}),
      };
    },
    deleteSecret: async (name: string) => {
      secretStore.delete(name);
      invalidateDoctorCache();
      return { name, deleted: true };
    },
    createSpecSession: async (input: {
      request: ControlSpecQuestionsRequest;
      idempotencyKey: string;
      clientId: string;
    }) => {
      if (input.request.threadId) {
        assertSpecThreadScope(
          threads.getThread(input.request.threadId),
          input.request.threadId,
          input.request.scope.root,
        );
      }
      const store = threads.specsForRequest(input.request);
      const created = store.create(input);
      return created.reused ? created.session : groundSpec(created.session.sessionId);
    },
    listSpecSessions: async () => ({ sessions: threads.listSpecSessions() }),
    getSpecSession: async (id: string) => requireSpecStore(id).get(id),
    answerSpecSession: async (id: string, input: ControlSpecAnswersRequest) =>
      requireSpecStore(id).recordAnswers(id, input),
    freezeSpecSession,
    cancelSpecSession: async (id: string) => {
      specControllers.get(id)?.abort();
      return requireSpecStore(id).cancel(id);
    },
    resumeSpecSession: async (id: string) => {
      const store = requireSpecStore(id);
      const session = store.get(id)!;
      if (session.state !== "interrupted_unknown" && session.state !== "failed") return session;
      const resumed = store.restart(id);
      return resumed.action === "freezing" ? freezeSpecSession(id) : groundSpec(id);
    },
  };
}
