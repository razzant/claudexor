#!/usr/bin/env node
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DaemonClient, DaemonServer, InteractionRegistry, RunEventBus, ThreadStore, daemonDir, defaultSocketPath, ensureToken, logPath } from "@claudexor/daemon";
import { DaemonControlApiServer, normalizeRunStartRequest } from "@claudexor/control-api";
import { Orchestrator } from "@claudexor/orchestrator";
import { loadConfig, updateGlobalConfig } from "@claudexor/config";
import { SecretStore } from "@claudexor/secrets";
import { ensureThreadWorktree, diffStaged, git, snapshotTree } from "@claudexor/workspace";
import { deliver } from "@claudexor/delivery";
import { containsSecretLikeToken, noProjectRepoRoot, readTextSafe, redactSecrets } from "@claudexor/util";
import { type ControlRunStartRequest as ControlRunStartRequestDto, ControlSettingsUpdateRequest, GlobalConfig } from "@claudexor/schema";
import { invalidateDoctorCache } from "@claudexor/core";
import { buildGateway, buildRegistry } from "./registry.js";
import { createSetupJobManager, setupHarness } from "./setup-jobs.js";
import { extractQuestionsFromPlan, freezeSpecFromGrounding, persistSpec } from "./spec.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

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
  // Thread/session SSOT (A2): durable conversation registry; vendor CLI session
  // ids are the re-hostable cache that lets later turns resume natively.
  const threads = new ThreadStore(join(daemonDir(), "threads.json"));

  const server = new DaemonServer({
    socketPath,
    token,
    // Durable run registry so the run list survives a daemon/Mac restart.
    persistPath: join(daemonDir(), "jobs.json"),
    runner: async (params, ctx) => {
      const p = normalizeDaemonRunStart(params);
      const mode = p.mode;
      const noProjectAsk = mode === "ask" && p.scope.kind === "none";
      const repoRoot = p.scope.kind === "project" ? p.scope.root : NO_PROJECT_ROOT;
      if (noProjectAsk) mkdirSync(NO_PROJECT_ROOT, { recursive: true, mode: 0o700 });
      const orchestrator = new Orchestrator({
        registry: buildRegistry(),
        portfolio: p.portfolio,
        reviewerModels: p.reviewerModels && typeof p.reviewerModels === "object" ? p.reviewerModels : undefined,
        reviewerEfforts: p.reviewerEfforts && typeof p.reviewerEfforts === "object" ? p.reviewerEfforts : undefined,
      });
      const threadId = typeof p.threadId === "string" && p.threadId ? p.threadId : undefined;
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
          // moves, since turns don't commit) — that would re-apply old work (D2).
          if (wt.created) threads.setThreadWorktree(threadId, wt.path, wt.baseSha);
          inPlace = true; // isolated turns run in-place WITHIN the worktree
        }
      }
      // Single-writer turn binding: control-api pre-creates the turn and passes
      // its id, which we bind when the run starts. A thread run WITHOUT a
      // pre-created turn (a direct POST /runs with threadId) gets its turn
      // created and bound here, so "a run is always recorded on its thread".
      const turnId = typeof p.turnId === "string" && p.turnId ? p.turnId : undefined;
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
          ? (harnessId, nativeSessionId, observedModel) => threads.recordSession(threadId, harnessId, nativeSessionId, observedModel)
          : undefined,
        authPreference: p.authPreference,
        repoRoot,
        prompt: String(p.prompt ?? ""),
        mode: p.mode,
        contextMode: noProjectAsk ? "off" : p.scope.kind === "project" ? p.scope.context : undefined,
        harnesses: p.harnesses,
        primaryHarness: p.primaryHarness,
        portfolio: p.portfolio,
        n: p.n,
        attempts: p.attempts ?? null,
        untilClean: p.untilClean === true,
        swarm: p.swarm === true,
        create: p.create === true,
        // Policy from the GUI composer / API client (applied, not just displayed).
        maxUsd: p.maxUsd ?? null,
        access: p.access,
        web: p.web ?? p.externalContextPolicy,
        externalContextPolicy: p.externalContextPolicy ?? p.web,
        model: p.model,
        effort: p.effort,
        tests: Array.isArray(p.tests) ? p.tests : undefined,
        specId: typeof p.specId === "string" ? p.specId : undefined,
        specHash: typeof p.specHash === "string" ? p.specHash : undefined,
        specPath: typeof p.specPath === "string" ? p.specPath : undefined,
        envProfile: typeof p.envProfile === "string" ? p.envProfile : undefined,
        inPlace,
        signal: ctx.signal,
        onRunStart,
      });
    },
  });

  await server.start();
  appendFileSync(logPath(), `[${new Date().toISOString()}] claudexord listening on ${socketPath}\n`);
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
    appendFileSync(logPath(), `[${new Date().toISOString()}] claudexor control-api listening on http://${controlAddr.host}:${controlAddr.port}\n`);
  } else {
    appendFileSync(logPath(), `[${new Date().toISOString()}] claudexor control-api disabled by CLAUDEXOR_NO_CONTROL_API=1\n`);
  }
  await server.waitForShutdown();
  await control?.stop();
  appendFileSync(logPath(), `[${new Date().toISOString()}] claudexord shut down\n`);
  process.exit(0);
}

// Run-start normalization has exactly one owner (control-api); the socket
// runner path delegates so scope/secret/absolute-root rules cannot drift.
const normalizeDaemonRunStart = (raw: unknown): ControlRunStartRequestDto => normalizeRunStartRequest(raw);

function projectRootFromScopedInput(p: Record<string, unknown>, purpose: string): string {
  if ("repoRoot" in p) throw new Error("legacy repoRoot field is not accepted; use scope.kind=project with scope.root");
  const scope = p["scope"];
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) throw new Error(`project scope is required for ${purpose}`);
  const s = scope as Record<string, unknown>;
  if (s["kind"] !== "project") throw new Error(`project scope is required for ${purpose}`);
  const root = typeof s["root"] === "string" ? s["root"].trim() : "";
  if (!root) throw new Error(`project scope root is required for ${purpose}`);
  if (!isAbsolute(root)) throw new Error("project root must be an absolute path");
  return root;
}

/** Merge camelCase per-harness patches into the snake_case GlobalConfig shape. */
function applyHarnessSettingsPatches(
  current: GlobalConfig["harnesses"],
  patches: ControlSettingsUpdateRequest["harnesses"],
): GlobalConfig["harnesses"] {
  if (!patches) return current;
  // FAIL LOUDLY on unknown harness ids: a typo ('codexx') must never be
  // silently persisted as a new config entry nothing will ever read.
  const knownIds = new Set(buildRegistry().keys());
  const next = { ...current };
  for (const [id, patch] of Object.entries(patches)) {
    if (!knownIds.has(id)) {
      throw Object.assign(new Error(`unknown harness id '${id}' (expected one of: ${[...knownIds].sort().join(", ")})`), { status: 400 });
    }
    const base = next[id] ?? GlobalConfig.shape.harnesses.removeDefault().valueSchema.parse({});
    next[id] = {
      ...base,
      enabled: patch.enabled ?? base.enabled,
      default_model: patch.defaultModel === undefined ? base.default_model : patch.defaultModel,
      effort: patch.effort === undefined ? base.effort : patch.effort,
      max_turns: patch.maxTurns === undefined ? base.max_turns : patch.maxTurns,
      max_rounds: patch.maxRounds === undefined ? base.max_rounds : patch.maxRounds,
      max_usd: patch.maxUsd === undefined ? base.max_usd : patch.maxUsd,
      tools_allow: patch.toolsAllow ?? base.tools_allow,
      tools_deny: patch.toolsDeny ?? base.tools_deny,
      fallback_model: patch.fallbackModel === undefined ? base.fallback_model : patch.fallbackModel,
      web: patch.web ?? base.web,
      auth_preference: patch.authPreference ?? base.auth_preference,
    };
  }
  return next;
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
    throw Object.assign(new Error("thread has no isolated worktree to apply (in-place threads write the project directly)"), { status: 400 });
  }
  const projectRoot = thread.repo.root;
  const base = ws.base_sha ?? "HEAD";
  const patch = await diffStaged(ws.worktree_path, base);
  if (!patch.trim()) return { applied: false, status: "empty", headMoved: false, detail: "no changes to apply" };
  if (containsSecretLikeToken(patch)) return { applied: false, status: "rejected", headMoved: false, detail: "patch contains a secret-like token; refusing apply" };
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
  const mode = (["apply", "branch", "commit", "pr"].includes(opts.mode) ? opts.mode : "apply") as "apply" | "branch" | "commit" | "pr";
  const delivered = await deliver(projectRoot, patch, { mode, branch: opts.branch, message: opts.message });
  if (delivered.applied) {
    // Re-base the thread on the new project state so the next apply diffs only new work.
    threads.setThreadWorktree(id, ws.worktree_path, await snapshotTree(ws.worktree_path));
  }
  const status = !delivered.applied ? "conflict" : mode === "branch" ? "branched" : mode === "commit" ? "committed" : mode === "pr" ? "pr_opened" : "applied";
  return { applied: delivered.applied, status, headMoved, detail: delivered.detail ?? null };
}

function controlServices(interactions: InteractionRegistry, threads: ThreadStore) {
  const secretStore = new SecretStore();
  const setupJobs = createSetupJobManager();
  mkdirSync(NO_PROJECT_ROOT, { recursive: true, mode: 0o700 });
  return {
    createThread: async (input: unknown) => threads.createThread((input ?? {}) as Parameters<ThreadStore["createThread"]>[0]),
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
    createThreadTurn: async (id: string, prompt: string, opts: { kind?: unknown; parentRunId?: string | null; planRunId?: string | null }) =>
      threads.createTurn(id, prompt, {
        kind: opts.kind as any,
        parentRunId: opts.parentRunId,
        planRunId: opts.planRunId,
      }),
    updateThread: async (id: string, patch: { title?: string; state?: string }) =>
      threads.updateThread(id, { title: patch.title, state: patch.state as any }),
    applyThread: async (id: string, opts: { mode: string; branch?: string; message?: string }) => applyThreadDiff(threads, id, opts),
    pendingInteractions: (runId: string) => interactions.pendingForRun(runId),
    answerInteraction: (runId: string, interactionId: string, answers: unknown) => interactions.answer(runId, interactionId, answers),
    harnesses: async () => ({ harnesses: await buildGateway({ includeFakes: false }).statusAll({ cwd: NO_PROJECT_ROOT }) }),
    setupHarness: async (input: unknown) => setupHarness(input),
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
          defaultModel: cfg.global.routing.default_model,
          envInheritance: cfg.global.routing.env_inheritance,
          authPreference: cfg.global.routing.auth_preference,
        },
        budget: {
          maxUsdPerRun: cfg.global.budget.max_usd_per_run,
          maxUsdPerDay: cfg.global.budget.max_usd_per_day,
        },
        harnesses: Object.fromEntries(Object.entries(cfg.global.harnesses).map(([id, h]) => [id, {
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
          nativeOptions: h.native_options,
          authPreference: h.auth_preference,
        }])),
      };
    },
    updateSettings: async (patch: unknown) => {
      // FAIL LOUDLY on malformed patches: a typo'd field name or bad enum must
      // surface as a 4xx, never be silently dropped.
      const p = ControlSettingsUpdateRequest.parse(patch ?? {});
      const nullableName = (value: string | null | undefined, current: string | null): string | null => {
        if (value === undefined) return current;
        if (value === null || value === "none" || value === "__none") return null;
        return value;
      };
      const updated = updateGlobalConfig((cfg) => ({
        ...cfg,
        default_portfolio: p.defaultPortfolio ?? cfg.default_portfolio,
        interaction_timeout_ms: p.interactionTimeoutMs ?? cfg.interaction_timeout_ms,
        routing: {
          ...cfg.routing,
          primary_harness: nullableName(p.primaryHarness, cfg.routing.primary_harness),
          default_model: nullableName(p.defaultModel, cfg.routing.default_model),
          default_policy: p.routingPolicy ?? cfg.routing.default_policy,
          env_inheritance: p.envInheritance ?? cfg.routing.env_inheritance,
          eligible_harnesses: p.eligibleHarnesses ?? cfg.routing.eligible_harnesses,
          auth_preference: p.authPreference ?? cfg.routing.auth_preference,
        },
        budget: {
          ...cfg.budget,
          max_usd_per_run: p.clearMaxUsdPerRun === true ? null : p.maxUsdPerRun ?? cfg.budget.max_usd_per_run,
          max_usd_per_day: p.clearMaxUsdPerDay === true ? null : p.maxUsdPerDay ?? cfg.budget.max_usd_per_day,
        },
        harnesses: applyHarnessSettingsPatches(cfg.harnesses, p.harnesses),
      }));
      // Routing/auth settings change harness readiness semantics: drop the
      // doctor TTL cache so the next /harnesses reflects the new truth.
      invalidateDoctorCache();
      return updated;
    },
    listSecrets: async () => ({ backend: secretStore.resolvedBackend(), secrets: secretStore.list() }),
    setSecret: async (input: unknown) => {
      const p = (input ?? {}) as Record<string, unknown>;
      const name = typeof p["name"] === "string" ? p["name"] : "";
      const value = typeof p["value"] === "string" ? p["value"] : "";
      if (!name || !value) throw new Error("name and value are required");
      const backend = secretStore.set(name, value);
      // A new key changes auth readiness immediately: drop the doctor TTL cache.
      invalidateDoctorCache();
      // Keychain->file degradation is disclosed, not silent (UI shows it).
      return { name, backend, stored: true, ...(secretStore.lastFallbackReason ? { warning: secretStore.lastFallbackReason } : {}) };
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
      const plan = await new Orchestrator({ registry: buildRegistry() }).run({
        repoRoot,
        prompt,
        mode: "plan",
        harnesses: Array.isArray(p["harnesses"]) ? p["harnesses"].filter((x): x is string => typeof x === "string") : undefined,
        access: "readonly",
      });
      const planText = readTextSafe(join(plan.runDir, "final", "plan.md")) ?? plan.summary;
      return { planRunId: plan.runId, planDir: plan.runDir, questions: extractQuestionsFromPlan(planText) };
    },
    specFreeze: async (input: unknown) => {
      const p = (input ?? {}) as Record<string, unknown>;
      const prompt = typeof p["prompt"] === "string" ? p["prompt"] : "";
      const planDir = typeof p["planDir"] === "string" ? p["planDir"] : "";
      const plan = typeof p["plan"] === "string" ? p["plan"] : readTextSafe(join(planDir, "final", "plan.md")) ?? "";
      if (!prompt.trim() || !plan.trim()) throw new Error("prompt and plan/planDir are required");
      const repoRoot = projectRootFromScopedInput(p, "spec freeze");
      const spec = await freezeSpecFromGrounding(prompt, plan, { answers: Array.isArray(p["answers"]) ? (p["answers"] as never[]) : [] });
      const persisted = persistSpec(repoRoot, spec, plan);
      return { specId: spec.id, specDir: persisted.specDir, specHash: persisted.specHash, changes: persisted.changes };
    },
  };
}

main().catch((err: unknown) => {
  process.stderr.write(`claudexord: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
