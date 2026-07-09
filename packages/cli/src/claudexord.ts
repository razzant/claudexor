#!/usr/bin/env node
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  DaemonClient,
  DaemonServer,
  InteractionRegistry,
  RunEventBus,
  ThreadStore,
  daemonDir,
  defaultSocketPath,
  ensureToken,
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
} from "@claudexor/util";
import {
  type AttachmentInput,
  type ControlRunStartRequest as ControlRunStartRequestDto,
  ControlSettingsUpdateRequest,
  InterviewAnswer,
} from "@claudexor/schema";
import { invalidateDoctorCache, validateModel } from "@claudexor/core";
import { resolveAttachments } from "./attachment-resolver.js";
import { buildGateway, buildRegistry, harnessModels } from "./registry.js";
import { buildAgentCapabilityCatalog } from "./capabilities.js";
import { applyHarnessSettingsPatches, assertSettingsPatchValid } from "./settings-service.js";
import { createSetupJobManager } from "./setup-jobs.js";
import {
  buildGroundingPrompt,
  extractQuestionsFromPlan,
  freezeSpecFromGrounding,
  persistSpec,
} from "./spec.js";


const NO_PROJECT_ROOT = noProjectRepoRoot();

async function main(): Promise<void> {
  // The daemon dir holds the auth token, jobs registry, and setup logs: it must
  // never be group/world readable (mkdir mode only applies on creation).
  mkdirSync(daemonDir(), { recursive: true, mode: 0o700 });
  chmodSync(daemonDir(), 0o700);
  const token = ensureToken();
  const socketPath = defaultSocketPath();

  // Live observation plane: every RunEvent is pushed onto the in-process bus
  // (SSE latency drops to immediate; events.jsonl stays the canonical log) and
  // harness questions park in the interaction registry until answered.
  const bus = new RunEventBus();
  const interactions = new InteractionRegistry();
  // Thread/session SSOT: durable conversation registry; vendor CLI session
  // ids are the re-hostable cache that lets later turns resume natively.
  const threads = new ThreadStore(join(daemonDir(), "threads.json"));

  const server = new DaemonServer({
    socketPath,
    token,
    // Durable run registry so the run list survives a daemon/Mac restart.
    persistPath: join(daemonDir(), "jobs.json"),
    // A terminal run must stop advertising waiting_on_user immediately —
    // cancelled/failed runs otherwise park their questions in the registry
    // until the interaction timeout.
    onRunTerminal: (runId) => interactions.dropForRun(runId),
    // A turn whose job died BEFORE a run bound (trust gate, preflight throw)
    // records the refusal on itself — the chat renders it inline instead of
    // an eternally-empty bubble.
    onTurnEnqueueFailed: (turnId, error, code) => threads.setTurnEnqueueError(turnId, error, code),
    runner: async (params, ctx) => {
      const p = normalizeDaemonRunStart(params);
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
      // Fail loud on bogus socket-caller thread/turn ids (job settles failed).
      const { threadId, turnId } = threads.assertKnownIds(p.threadId, p.turnId);
      // Resolve the execution tree: an ISOLATED thread runs in its persistent
      // worktree (lazily created); in-place threads and ordinary runs use the
      // project root. Config/artifacts stay anchored to repoRoot either way.
      let executionRoot: string | undefined;
      let inPlace = p.execution.isolation === "live";
      if (threadId && repoRoot !== NO_PROJECT_ROOT) {
        const thread = threads.getThread(threadId);
        if (thread?.workspace.mode === "isolated") {
          const wt = await ensureThreadWorktree(repoRoot, threadId);
          executionRoot = wt.path;
          // Persist the base ONLY on creation: `apply` advances base_sha, and a
          // later turn must not clobber it back to the worktree HEAD (which never
          // moves, since turns don't commit) — that would re-apply old work.
          if (wt.created) threads.setThreadWorktree(threadId, wt.path, wt.baseSha);
          inPlace = true; // isolated turns run in-place WITHIN the worktree
        }
      }
      // Single-writer turn binding: control-api pre-creates the turn and passes
      // its id, which we bind when the run starts. A thread run WITHOUT a
      // pre-created turn (a direct POST /runs with threadId) gets its turn
      // created and bound here, so "a run is always recorded on its thread".
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
        onEvent: (event) => bus.publish(event),
        onInteraction: (ctx2) => interactions.register(ctx2),
        interactionTimeoutMs: loadConfig(repoRoot).global.interaction_timeout_ms,
        threadId,
        executionRoot,
        // Native session continuity: resume each routed harness's own prior
        // conversation in this thread; record new native ids for future turns.
        resumeSessions: threadId ? threads.resumeMap(threadId) : undefined,
        onSessionObserved: threadId
          ? (harnessId, nativeSessionId, observedModel) =>
              threads.recordSession(threadId, harnessId, nativeSessionId, observedModel)
          : undefined,
        authPreference: p.authPreference,
        // Orchestrate autonomy (suggest/auto_safe/auto_full): consumed by the
        // executor in runOrchestrate. The daemon also lends the executor a live
        // answer-delivery service for answer_question steps (the engine does not
        // own the interaction registry).
        autonomy: p.autonomy,
        answerInteraction: async (subRunId, interactionId, answers) =>
          interactions.answer(subRunId, interactionId, answers).status === "delivered",
        repoRoot,
        prompt: String(p.prompt ?? ""),
        // Attachments ride on the turn (resolved to scoped paths); a direct
        // POST /runs without a turn resolves them here. Never base64 in jobs.json.
        attachments: turnId
          ? (threads.getTurn(turnId)?.attachments ?? [])
          : resolveAttachments((p as { attachments?: AttachmentInput[] }).attachments),
        // Agent-driven browser opt-in (Playwright MCP). The orchestrator gates it
        // on the harness's browser_tool capability + web policy != off.
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
        // Policy from the GUI composer / API client (applied, not just displayed).
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

  // SINGLETON GUARD FIRST: a second claudexord must refuse BEFORE crash GC —
  // otherwise it would reap the LIVE daemon's recorded children and sweep
  // envelopes its running jobs still own. server.start() re-checks (race-safe
  // enough: the window between the probe and listen is milliseconds, and GC
  // only runs when the probe found no live daemon).
  if (await socketAlive(socketPath)) {
    throw new Error(`a claudexor daemon is already listening on ${socketPath}; stop it first`);
  }

  // Crash GC before any new work (reap surviving children, sweep orphaned
  // envelopes/branches/tmp-homes), then arm live-children bookkeeping and
  // graceful SIGTERM/SIGINT shutdown.
  await runStartupCrashGc({ daemonDir: daemonDir(), logPath: logPath() });

  await server.start();
  appendFileSync(
    logPath(),
    `[${new Date().toISOString()}] claudexord listening on ${socketPath}\n`,
  );
  const lifecycle = armDaemonLifecycle({
    daemonDir: daemonDir(),
    logPath: logPath(),
    stop: () => server.stop(),
  });
  const control =
    process.env.CLAUDEXOR_NO_CONTROL_API === "1"
      ? null
      : new DaemonControlApiServer({
          token,
          daemon: new DaemonClient(socketPath, token),
          port: Number(process.env.CLAUDEXOR_CONTROL_PORT ?? 0),
          bus,
          services: controlServices(interactions, threads),
        });
  if (control) {
    const controlAddr = await control.start();
    writeFileSync(
      join(daemonDir(), "control-api.json"),
      JSON.stringify({ ...controlAddr, tokenPath: join(daemonDir(), "token") }, null, 2) + "\n",
      { mode: 0o600 },
    );
    appendFileSync(
      logPath(),
      `[${new Date().toISOString()}] claudexor control-api listening on http://${controlAddr.host}:${controlAddr.port}\n`,
    );
  } else {
    appendFileSync(
      logPath(),
      `[${new Date().toISOString()}] claudexor control-api disabled by CLAUDEXOR_NO_CONTROL_API=1\n`,
    );
  }
  await server.waitForShutdown();
  await control?.stop();
  lifecycle.finalize();
  appendFileSync(logPath(), `[${new Date().toISOString()}] claudexord shut down\n`);
  process.exit(0);
}

// Run-start normalization has exactly one owner (control-api); the socket
// runner path delegates so scope/secret/absolute-root rules cannot drift.
const normalizeDaemonRunStart = (raw: unknown): ControlRunStartRequestDto =>
  normalizeRunStartRequest(raw);

function projectRootFromScopedInput(p: Record<string, unknown>, purpose: string): string {
  if ("repoRoot" in p)
    throw new Error(
      "legacy repoRoot field is not accepted; use scope.kind=project with scope.root",
    );
  const scope = p["scope"];
  if (!scope || typeof scope !== "object" || Array.isArray(scope))
    throw new Error(`project scope is required for ${purpose}`);
  const s = scope as Record<string, unknown>;
  if (s["kind"] !== "project") throw new Error(`project scope is required for ${purpose}`);
  const root = typeof s["root"] === "string" ? s["root"].trim() : "";
  if (!root) throw new Error(`project scope root is required for ${purpose}`);
  if (!isAbsolute(root)) throw new Error("project root must be an absolute path");
  return root;
}

/** Deliver an isolated thread's accumulated worktree diff to its project. */
async function applyThreadDiff(
  threads: ThreadStore,
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
  // Best-effort: did the PROJECT advance past where this thread branched? (a
  // warning, not a blocker — git apply --3way still merges or fails loudly.)
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

function controlServices(interactions: InteractionRegistry, threads: ThreadStore) {
  const secretStore = new SecretStore();
  const setupJobs = createSetupJobManager();
  mkdirSync(NO_PROJECT_ROOT, { recursive: true, mode: 0o700 });
  return {
    createThread: async (input: unknown) =>
      threads.createThread((input ?? {}) as Parameters<ThreadStore["createThread"]>[0]),
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
      },
    ) =>
      threads.createTurn(id, prompt, {
        kind: opts.kind as any,
        parentRunId: opts.parentRunId,
        planRunId: opts.planRunId,
        attachments: resolveAttachments(opts.attachments),
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
    setTurnEnqueueError: (turnId: string, message: string, code: string | null, retryable?: boolean) =>
      threads.setTurnEnqueueError(turnId, message, code, retryable ?? true),
    // User-level trust surface (narrow by design): list per-repo trust files
    // and grant/revoke ONE flag — the same file/writer `claudexor trust` owns.
    listTrust: listTrustService,
    updateTrust: updateTrustService,
    pendingInteractions: (runId: string) => interactions.pendingForRun(runId),
    answerInteraction: (runId: string, interactionId: string, answers: unknown) =>
      interactions.answer(runId, interactionId, answers),
    harnesses: async () => {
      const statuses = await buildGateway({ includeFakes: false }).statusAll({
        cwd: NO_PROJECT_ROOT,
      });
      // The doctor's configured-model truth check rides the status DTO
      // so the UI renders the same honesty the CLI prints (never a green
      // harness with a doomed configured model).
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
      harnessModels(input.harnessId, NO_PROJECT_ROOT),
    // Derived catalog for external agents; same composer the CLI verb and the
    // MCP tool use, so all three surfaces answer identically.
    agentCapabilities: async () => buildAgentCapabilityCatalog(),
    createSetupJob: async (input: unknown) => setupJobs.create(input),
    listSetupJobs: async () => ({ jobs: setupJobs.list() }),
    setupJobStatus: async (input: unknown) => setupJobs.status(input),
    cancelSetupJob: async (input: unknown) => setupJobs.cancel(input),
    confirmSetupJob: async (input: unknown) => setupJobs.confirm(input),
    settings: async () => {
      const cfg = loadConfig(NO_PROJECT_ROOT);
      return {
        sources: cfg.sources,
        defaultPortfolio: cfg.global.default_portfolio,
        interactionTimeoutMs: cfg.global.interaction_timeout_ms,
        routing: {
          defaultPolicy: cfg.global.routing.default_policy,
          primaryHarness: cfg.global.routing.primary_harness,
          eligibleHarnesses: cfg.global.routing.eligible_harnesses,
          envInheritance: cfg.global.routing.env_inheritance,
          authPreference: cfg.global.routing.auth_preference,
        },
        budget: {
          maxUsdPerRun: cfg.global.budget.max_usd_per_run,
        },
        runtime: {
          reviewerTimeoutMs: cfg.global.runtime.reviewer_timeout_ms,
          harnessInactivityTimeoutMs: cfg.global.runtime.harness_inactivity_timeout_ms,
          transientRetry: {
            maxRetries: cfg.global.runtime.transient_retry.max_retries,
            initialDelayMs: cfg.global.runtime.transient_retry.initial_delay_ms,
            maxDelayMs: cfg.global.runtime.transient_retry.max_delay_ms,
          },
        },
        harnesses: Object.fromEntries(
          Object.entries(cfg.global.harnesses).map(([id, h]) => [
            id,
            {
              enabled: h.enabled,
              defaultModel: h.default_model,
              effort: h.effort,
              maxTurns: h.max_turns,
              maxRounds: h.max_rounds,
              maxUsd: h.max_usd,
              toolsAllow: h.tools_allow,
              toolsDeny: h.tools_deny,
              fallbackModel: h.fallback_model,
              web: h.web,
              authPreference: h.auth_preference,
            },
          ]),
        ),
      };
    },
    updateSettings: async (patch: unknown) => {
      // FAIL LOUDLY on malformed patches: a typo'd field name or bad enum must
      // surface as a 4xx, never be silently dropped.
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
      const updated = updateGlobalConfig((cfg) => ({
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
      // Routing/auth settings change harness readiness semantics: drop the
      // doctor TTL cache so the next /harnesses reflects the new truth.
      invalidateDoctorCache();
      return updated;
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
      // A new key changes auth readiness immediately: drop the doctor TTL cache.
      invalidateDoctorCache();
      // Keychain->file degradation is disclosed, not silent (UI shows it).
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
    specQuestions: async (input: unknown) => {
      const p = (input ?? {}) as Record<string, unknown>;
      const prompt = typeof p["prompt"] === "string" ? p["prompt"] : "";
      if (!prompt.trim()) throw new Error("prompt is required");
      const repoRoot = projectRootFromScopedInput(p, "spec questions");
      // Drive an interactive, CHOICE-BASED interview: the read-only grounding plan
      // must end with a structured "## Open Questions" section that
      // extractQuestionsFromPlan parses into single/multi/text questions with options.
      // The instruction + its parser are a co-located contract pair in spec.ts.
      // Prior tiers' answers: carried so each round goes DEEPER (adaptive interview).
      const priorDecisions = Array.isArray(p["priorDecisions"])
        ? (p["priorDecisions"] as unknown[]).filter(
            (d): d is { question: string; answer: string } =>
              !!d &&
              typeof d === "object" &&
              typeof (d as Record<string, unknown>).question === "string" &&
              typeof (d as Record<string, unknown>).answer === "string",
          )
        : [];
      const plan = await new Orchestrator({ registry: buildRegistry() }).run({
        repoRoot,
        prompt: buildGroundingPrompt(prompt, priorDecisions),
        mode: "plan",
        harnesses: Array.isArray(p["harnesses"])
          ? p["harnesses"].filter((x): x is string => typeof x === "string")
          : undefined,
        access: "readonly",
      });
      const planText = readTextSafe(join(plan.runDir, "final", "plan.md")) ?? plan.summary;
      return {
        planRunId: plan.runId,
        planDir: plan.runDir,
        questions: extractQuestionsFromPlan(planText),
      };
    },
    specFreeze: async (input: unknown) => {
      const p = (input ?? {}) as Record<string, unknown>;
      const prompt = typeof p["prompt"] === "string" ? p["prompt"] : "";
      const planDir = typeof p["planDir"] === "string" ? p["planDir"] : "";
      const plan =
        typeof p["plan"] === "string"
          ? p["plan"]
          : (readTextSafe(join(planDir, "final", "plan.md")) ?? "");
      if (!prompt.trim() || !plan.trim()) throw new Error("prompt and plan/planDir are required");
      const repoRoot = projectRootFromScopedInput(p, "spec freeze");
      // Forward the full SpecAnswersFile shape — not just answers — so a client that
      // edited the draft's summary / criteria / non-goals / gates doesn't have them
      // silently dropped from the frozen SpecPack. Fail LOUDLY on a malformed field
      // (e.g. tests:[123]) rather than silently filtering it.
      const strArr = (v: unknown, field: string): string[] | undefined => {
        if (v === undefined) return undefined;
        if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
          throw new Error(`spec freeze: "${field}" must be an array of strings`);
        }
        return v as string[];
      };
      const strOpt = (v: unknown, field: string): string | undefined => {
        if (v === undefined) return undefined;
        if (typeof v !== "string") throw new Error(`spec freeze: "${field}" must be a string`);
        return v;
      };
      // Schema-parse the answers at the wire boundary (Bible §3): a malformed item
      // (missing/typed question_id, bad option_ids) fails loudly with a typed error,
      // rather than slipping through an `as never[]` cast. Absent => no answers.
      const answers = p["answers"] === undefined ? [] : InterviewAnswer.array().parse(p["answers"]);
      // Multi-tier interview: prior-tier decisions are folded into decided_tradeoffs
      // so the frozen SpecPack carries EVERY tier, not just the last one the client
      // sent as `answers` (the v0.13 freeze-drops-prior-tiers bug, #8/#9).
      const priorDecisions = Array.isArray(p["priorDecisions"])
        ? (p["priorDecisions"] as unknown[]).filter(
            (d): d is { question: string; answer: string } =>
              !!d &&
              typeof (d as { question?: unknown }).question === "string" &&
              typeof (d as { answer?: unknown }).answer === "string",
          )
        : [];
      const priorLines = priorDecisions.map(
        (d) => `Interview (prior tier) — ${d.question} → ${d.answer}`,
      );
      const explicitTradeoffs = strArr(p["decided_tradeoffs"], "decided_tradeoffs") ?? [];
      const mergedTradeoffs = [...priorLines, ...explicitTradeoffs];
      const spec = await freezeSpecFromGrounding(prompt, plan, {
        answers,
        summary: strOpt(p["summary"], "summary"),
        success_criteria: strArr(p["success_criteria"], "success_criteria"),
        non_goals: strArr(p["non_goals"], "non_goals"),
        forbidden_approaches: strArr(p["forbidden_approaches"], "forbidden_approaches"),
        // undefined-when-empty keeps single-tier behavior byte-identical.
        decided_tradeoffs: mergedTradeoffs.length ? mergedTradeoffs : undefined,
        tests: strArr(p["tests"], "tests"),
      });
      const persisted = persistSpec(repoRoot, spec, plan);
      // specPath = the frozen SpecPack file an Implement run reads (a bare specId
      // does not load content). Single producer; the layout matches persistSpec.
      return {
        specId: spec.id,
        specDir: persisted.specDir,
        specPath: join(persisted.specDir, "spec.json"),
        specHash: persisted.specHash,
        changes: persisted.changes,
      };
    },
  };
}

main().catch((err: unknown) => {
  process.stderr.write(`claudexord: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
