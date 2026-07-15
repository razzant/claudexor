#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DaemonClient,
  commandProjection,
  interactionProjection,
  operatorDecisionProjection,
  type OperatorDecisionRecord,
  runEventProjection,
  JournalManager,
  DaemonServer,
  InteractionRegistry,
  ProjectPartitions,
  ProjectStore,
  projectProjection,
  RunEventBus,
  threadProjection,
  daemonDir,
  defaultSocketPath,
  acquireDaemonWriterLease,
  ensureToken,
  ensureDaemonRuntimeRoot,
  logPath,
  socketAlive,
} from "@claudexor/daemon";
import { DaemonControlApiServer, normalizeRunStartRequest } from "@claudexor/control-api";
import { armDaemonLifecycle, runStartupCrashGc } from "./daemon-lifecycle.js";
import { Orchestrator } from "@claudexor/orchestrator";
import { loadConfig, updateGlobalConfig } from "@claudexor/config";
import { listTrustService, updateTrustService } from "./trust-services.js";
import { SecretStore } from "@claudexor/secrets";
import { ensureThreadWorktree, diffStaged, git, snapshotTree } from "@claudexor/workspace";
import { deliver } from "@claudexor/delivery";
import {
  containsSecretLikeToken,
  noProjectRepoRoot,
  readTextSafe,
  redactSecrets,
} from "@claudexor/util";
import {
  type AttachmentInput,
  type ControlSpecAnswersRequest,
  type ControlSpecQuestionsRequest,
  ControlSettingsUpdateRequest,
} from "@claudexor/schema";
import { invalidateDoctorCache, validateModel } from "@claudexor/core";
import { AuthReadinessService } from "@claudexor/gateway";
import { resolveAttachments } from "./attachment-resolver.js";
import { buildGateway, buildRegistry, harnessModels } from "./registry.js";
import { buildAgentCapabilityCatalog } from "./capabilities.js";
import {
  applyHarnessSettingsPatches,
  assertSettingsPatchValid,
  settingsSnapshot,
} from "./settings-service.js";
import { createSetupJobManager } from "./setup-jobs.js";
import { SetupJobStore } from "./setup-job-store.js";
import { SetupLifecycleBinding } from "./setup-lifecycle-binding.js";
import { DaemonRuntimeShutdown } from "./daemon-runtime-shutdown.js";
import {
  buildGroundingPrompt,
  extractQuestionsFromPlan,
  freezeSpecFromGrounding,
  persistSpecAt,
} from "./spec.js";
const NO_PROJECT_ROOT = noProjectRepoRoot();

async function main(): Promise<void> {
  ensureDaemonRuntimeRoot();
  const socketPath = defaultSocketPath();
  const writerLease = acquireDaemonWriterLease(socketPath);
  let shutdownRuntime: DaemonRuntimeShutdown | null = null;
  let lifecycle: ReturnType<typeof armDaemonLifecycle> | null = null;
  try {
    const token = ensureToken();
    let requestRootShutdown: () => Promise<void> = async () => {
      throw new Error("daemon shutdown coordinator is not initialized");
    };

    if (await socketAlive(socketPath)) {
      throw new Error(`a claudexor daemon is already listening on ${socketPath}; stop it first`);
    }
    await runStartupCrashGc({ daemonDir: daemonDir(), logPath: logPath() });

    const bus = new RunEventBus();
    const journalManager = new JournalManager(daemonDir());
    const commandStoreSlot = journalManager.registerProjection(commandProjection());
    const interactionStoreSlot = journalManager.registerProjection(interactionProjection());
    const operatorDecisionStoreSlot = journalManager.registerProjection(
      operatorDecisionProjection(),
    );
    const runEventStoreSlot = journalManager.registerProjection(runEventProjection());
    const projectStoreSlot = journalManager.registerProjection(projectProjection());
    const threadStoreSlot = journalManager.registerProjection(threadProjection());
    const setupStoreSlot = journalManager.registerProjection({
      name: "setup",
      create: (journal) => new SetupJobStore(daemonDir(), { journal }),
      validate: (store) => store.validateProjection(),
    });
    journalManager.start();
    const threads = new ProjectPartitions(
      daemonDir(),
      projectStoreSlot,
      commandStoreSlot,
      interactionStoreSlot,
      operatorDecisionStoreSlot,
      runEventStoreSlot,
      threadStoreSlot,
    );
    const interactions = new InteractionRegistry({
      forRequest: (params) => threads.interactionsForRequest(params),
      all: () => threads.interactionStores(),
    });

    const server = new DaemonServer({
      socketPath,
      token,
      commands: threads,
      onRunTerminal: (runId) => interactions.dropForRun(runId),
      onTurnEnqueueFailed: (turnId, error, code) =>
        threads.setTurnEnqueueError(turnId, error, code),
      onShutdownRequested: () => requestRootShutdown(),
      runner: async (params, ctx) => {
        const p = normalizeRunStartRequest(params);
        const mode = p.mode;
        const noProjectAsk = mode === "ask" && p.scope.kind === "none";
        const repoRoot = p.scope.kind === "project" ? p.scope.root : NO_PROJECT_ROOT;
        if (noProjectAsk) mkdirSync(NO_PROJECT_ROOT, { recursive: true, mode: 0o700 });
        const orchestrator = new Orchestrator({
          registry: buildRegistry(),
          portfolio: p.portfolio,
          reviewerPanel: p.reviewerPanel,
          reviewerModels:
            p.reviewerModels && typeof p.reviewerModels === "object" ? p.reviewerModels : undefined,
          reviewerEfforts:
            p.reviewerEfforts && typeof p.reviewerEfforts === "object"
              ? p.reviewerEfforts
              : undefined,
        });
        const { threadId, turnId } = threads.assertKnownIds(p.threadId, p.turnId);
        // Isolated threads use their persistent worktree; other runs use the project root.
        let executionRoot: string | undefined;
        let inPlace = p.execution.isolation === "live";
        if (threadId && repoRoot !== NO_PROJECT_ROOT) {
          const thread = threads.getThread(threadId);
          if (thread?.workspace.mode === "isolated") {
            const wt = await ensureThreadWorktree(repoRoot, threadId);
            executionRoot = wt.path;
            // Only creation owns the base; apply advances it independently.
            if (wt.created) threads.setThreadWorktree(threadId, wt.path, wt.baseSha);
            inPlace = true; // isolated turns run in-place WITHIN the worktree
          }
        }
        const onRunStart = (info: { runId: string; taskId: string; runDir: string }): void => {
          ctx.onRunStart?.(info);
          if (!threadId) return;
          try {
            if (turnId) {
              threads.bindTurnRun(turnId, info.runId);
            } else {
              const turn = threads.createTurn(threadId, String(p.prompt ?? ""), {
                parentRunId: typeof p.parentRunId === "string" ? p.parentRunId : null,
              });
              threads.bindTurnRun(turn.id, info.runId);
            }
          } catch {
            /* turn binding must never fail the run */
          }
        };
        return orchestrator.run({
          onEvent: (event) => {
            threads.recordRunEvent(p, event);
            bus.publish(event);
          },
          onInteraction: (ctx2) => interactions.register(ctx2, p),
          interactionTimeoutMs: loadConfig(repoRoot).global.interaction_timeout_ms,
          threadId,
          executionRoot,
          resumeSessions: threadId ? threads.resumeMap(threadId) : undefined,
          onSessionObserved: threadId
            ? (harnessId, nativeSessionId, observedModel) =>
                threads.recordSession(threadId, harnessId, nativeSessionId, observedModel)
            : undefined,
          authPreference: p.authPreference,
          autonomy: p.autonomy,
          answerInteraction: async (subRunId, interactionId, answers) =>
            interactions.answer(subRunId, interactionId, answers).status === "delivered",
          repoRoot,
          prompt: String(p.prompt ?? ""),
          attachments: turnId
            ? (threads.getTurn(turnId)?.attachments ?? [])
            : resolveAttachments((p as { attachments?: AttachmentInput[] }).attachments),
          browser: (p as { browser?: boolean }).browser === true,
          mode: p.mode,
          contextMode: noProjectAsk
            ? "off"
            : p.scope.kind === "project"
              ? p.scope.context
              : undefined,
          harnesses: p.harnesses,
          primaryHarness: p.primaryHarness,
          portfolio: p.portfolio,
          n: p.n,
          attempts: p.attempts ?? null,
          untilClean: p.untilClean === true,
          swarm: p.swarm === true,
          create: p.create === true,
          synthesis: p.synthesis,
          maxUsd: p.maxUsd ?? null,
          maxToolCalls: p.maxToolCalls ?? null,
          access: p.access,
          web: p.web ?? p.externalContextPolicy,
          externalContextPolicy: p.externalContextPolicy ?? p.web,
          model: p.model,
          models: p.models,
          effort: p.effort,
          tests: Array.isArray(p.tests) ? p.tests : undefined,
          protectedPathApprovals: Array.isArray(p.protectedPathApprovals)
            ? p.protectedPathApprovals
            : undefined,
          specId: typeof p.specId === "string" ? p.specId : undefined,
          specHash: typeof p.specHash === "string" ? p.specHash : undefined,
          specPath: typeof p.specPath === "string" ? p.specPath : undefined,
          inPlace,
          signal: ctx.signal,
          onRunStart,
        });
      },
    });

    const authReadiness = new AuthReadinessService(buildGateway({ includeFakes: false }), {
      cwd: NO_PROJECT_ROOT,
    });
    const setupBinding = new SetupLifecycleBinding(setupStoreSlot, (store) =>
      createSetupJobManager({
        rootDir: daemonDir(),
        store,
        onCredentialStateMayHaveChanged: (harness) => authReadiness.invalidate(harness),
      }),
    );
    let control: DaemonControlApiServer | null = null;
    shutdownRuntime = new DaemonRuntimeShutdown({
      daemon: server,
      setup: setupBinding,
      control: () => control,
      journal: {
        close: () => {
          threads.close();
          journalManager.close();
        },
      },
    });
    requestRootShutdown = () => shutdownRuntime!.request();
    control =
      process.env.CLAUDEXOR_NO_CONTROL_API === "1"
        ? null
        : new DaemonControlApiServer({
            token,
            daemon: new DaemonClient(socketPath, token),
            port: Number(process.env.CLAUDEXOR_CONTROL_PORT ?? 0),
            bus,
            services: controlServices(
              interactions,
              () => projectStoreSlot.current(),
              threads,
              setupBinding,
              journalManager,
              authReadiness,
            ),
          });
    // Arm signals before startup awaits; serialized lifecycle fences late listeners.
    lifecycle = armDaemonLifecycle({
      daemonDir: daemonDir(),
      logPath: logPath(),
      stop: () => shutdownRuntime!.request(),
    });

    await setupBinding.start();
    if (!shutdownRuntime.requested()) await server.start();
    if (!shutdownRuntime.requested()) {
      appendFileSync(
        logPath(),
        `[${new Date().toISOString()}] claudexord listening on ${socketPath}\n`,
      );
    }
    if (control && !shutdownRuntime.requested()) {
      const controlAddr = await control.start();
      if (!shutdownRuntime.requested()) {
        writeFileSync(
          join(daemonDir(), "control-api.json"),
          `${JSON.stringify({ ...controlAddr, tokenPath: join(daemonDir(), "token") }, null, 2)}\n`,
          { mode: 0o600 },
        );
        appendFileSync(
          logPath(),
          `[${new Date().toISOString()}] claudexor control-api listening on http://${controlAddr.host}:${controlAddr.port}\n`,
        );
      }
    } else if (!control && !shutdownRuntime.requested()) {
      appendFileSync(
        logPath(),
        `[${new Date().toISOString()}] claudexor control-api disabled by CLAUDEXOR_NO_CONTROL_API=1\n`,
      );
    }
    await shutdownRuntime.wait();
    lifecycle.finalize();
    lifecycle = null;
    appendFileSync(logPath(), `[${new Date().toISOString()}] claudexord shut down\n`);
  } catch (error) {
    try {
      appendFileSync(
        logPath(),
        `[${new Date().toISOString()}] daemon lifecycle FAILED: ${redactSecrets(
          error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        )}\n`,
      );
    } catch {
      /* preserve the lifecycle failure */
    }
    if (shutdownRuntime) {
      try {
        await shutdownRuntime.request();
        lifecycle?.finalize();
        lifecycle = null;
      } catch (shutdownError) {
        try {
          appendFileSync(
            logPath(),
            `[${new Date().toISOString()}] shutdown FAILED: ${redactSecrets(
              shutdownError instanceof Error ? shutdownError.message : String(shutdownError),
            )}\n`,
          );
        } catch {
          /* preserve the shutdown failure */
        }
        throw new AggregateError(
          [error, shutdownError],
          "claudexord failed and could not complete shutdown",
        );
      }
    }
    throw error;
  } finally {
    writerLease.release();
  }
}
/** Deliver an isolated thread's accumulated worktree diff to its project. */
async function applyThreadDiff(
  threads: ProjectPartitions,
  id: string,
  opts: { mode: string; branch?: string; message?: string },
): Promise<{ applied: boolean; status: string; headMoved: boolean; detail: string | null }> {
  const thread = threads.getThread(id);
  if (!thread) throw Object.assign(new Error(`no such thread: ${id}`), { status: 404 });
  const ws = thread.workspace;
  if (ws.mode !== "isolated" || !ws.worktree_path || !thread.repo) {
    throw Object.assign(
      new Error(
        "thread has no isolated worktree to apply (in-place threads write the project directly)",
      ),
      { status: 400 },
    );
  }
  const projectRoot = thread.repo.root;
  const base = ws.base_sha ?? "HEAD";
  const patch = await diffStaged(ws.worktree_path, base);
  if (!patch.trim())
    return { applied: false, status: "empty", headMoved: false, detail: "no changes to apply" };
  if (containsSecretLikeToken(patch))
    return {
      applied: false,
      status: "rejected",
      headMoved: false,
      detail: "patch contains a secret-like token; refusing apply",
    };
  // Warn if the project advanced; preimage-bound apply still refuses stale content.
  let headMoved = false;
  try {
    const head = (await git(projectRoot, ["rev-parse", "HEAD"])).stdout.trim();
    const mb = (await git(projectRoot, ["merge-base", "HEAD", base])).stdout.trim();
    headMoved = mb !== "" && head !== "" && mb !== head;
  } catch {
    /* best-effort */
  }
  const mode = (["apply", "branch", "commit", "pr"].includes(opts.mode) ? opts.mode : "apply") as
    | "apply"
    | "branch"
    | "commit"
    | "pr";
  const delivered = await deliver(projectRoot, patch, {
    mode,
    branch: opts.branch,
    message: opts.message,
  });
  if (delivered.applied) {
    // Re-base the thread on the new project state so the next apply diffs only new work.
    threads.setThreadWorktree(id, ws.worktree_path, await snapshotTree(ws.worktree_path));
  }
  const status = !delivered.applied
    ? "conflict"
    : mode === "branch"
      ? "branched"
      : mode === "commit"
        ? "committed"
        : mode === "pr"
          ? "pr_opened"
          : "applied";
  return { applied: delivered.applied, status, headMoved, detail: delivered.detail ?? null };
}
type SetupJobManager = ReturnType<typeof createSetupJobManager>;
type SetupBinding = SetupLifecycleBinding<SetupJobStore, SetupJobManager>;
type HarnessListInput = { fresh?: boolean; includeFakes?: boolean; harnessIds?: string[] };
function controlServices(
  interactions: InteractionRegistry,
  projects: () => ProjectStore,
  threads: ProjectPartitions,
  setupBinding: SetupBinding,
  journalManager: JournalManager,
  authReadiness: AuthReadinessService,
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
        maxUsd: material.request.maxUsd ?? null,
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
  return {
    listProjects: async () => ({ projects: projects().list() as unknown[] }),
    registerProject: async (input: Parameters<ProjectStore["register"]>[0]) =>
      threads.registerProject(input),
    relinkProject: async (id: string, root: string) => threads.relinkProject(id, root),
    createThread: async (input: unknown) =>
      threads.createThread((input ?? {}) as Parameters<ProjectPartitions["createThread"]>[0]),
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
        attachments?: AttachmentInput[];
        idempotency?: { key: string; client: string; request: unknown };
      },
    ) =>
      threads.createTurn(id, prompt, {
        kind: opts.kind as any,
        parentRunId: opts.parentRunId,
        planRunId: opts.planRunId,
        attachments: resolveAttachments(opts.attachments),
        idempotency: opts.idempotency,
      }),
    updateThread: async (
      id: string,
      patch: {
        title?: string;
        state?: string;
        primaryHarness?: string | null;
        eligibleHarnesses?: string[];
      },
    ) =>
      threads.updateThread(id, {
        title: patch.title,
        state: patch.state as any,
        primaryHarness: patch.primaryHarness,
        eligibleHarnesses: patch.eligibleHarnesses,
      }),
    applyThread: async (id: string, opts: { mode: string; branch?: string; message?: string }) =>
      applyThreadDiff(threads, id, opts),
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
            if (!configured) return { ...s, configuredModel: null, configuredModelCheck: null };
            const truth = await harnessModels(s.id, NO_PROJECT_ROOT, true);
            const check = validateModel(
              configured,
              truth.models.map((m) => m.id),
              truth.source === "api" ? "api" : "manifest",
            );
            return { ...s, configuredModel: configured, configuredModelCheck: check };
          }),
        ),
      };
    },
    harnessModels: async (input: { harnessId: string }) =>
      harnessModels(input.harnessId, NO_PROJECT_ROOT, true),
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
        default_portfolio: p.defaultPortfolio ?? cfg.default_portfolio,
        interaction_timeout_ms: p.interactionTimeoutMs ?? cfg.interaction_timeout_ms,
        routing: {
          ...cfg.routing,
          primary_harness: nullableName(p.primaryHarness, cfg.routing.primary_harness),
          default_policy: p.routingPolicy ?? cfg.routing.default_policy,
          env_inheritance: p.envInheritance ?? cfg.routing.env_inheritance,
          eligible_harnesses: p.eligibleHarnesses ?? cfg.routing.eligible_harnesses,
          auth_preference: p.authPreference ?? cfg.routing.auth_preference,
        },
        budget: {
          ...cfg.budget,
          max_usd_per_run:
            p.clearMaxUsdPerRun === true ? null : (p.maxUsdPerRun ?? cfg.budget.max_usd_per_run),
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
      // A removed key changes auth readiness immediately: drop the doctor cache.
      invalidateDoctorCache();
      return { name, deleted: true };
    },
    createSpecSession: async (input: {
      request: ControlSpecQuestionsRequest;
      idempotencyKey: string;
      clientId: string;
    }) => {
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
      store.restart(id);
      return groundSpec(id);
    },
  };
}

main().catch((err: unknown) => {
  process.stderr.write(`claudexord: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
