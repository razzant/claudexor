#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DaemonClient, DaemonServer, daemonDir, defaultSocketPath, ensureToken, logPath } from "@claudexor/daemon";
import { DaemonControlApiServer, normalizeRunStartRequest } from "@claudexor/control-api";
import { Orchestrator } from "@claudexor/orchestrator";
import { loadConfig, updateGlobalConfig } from "@claudexor/config";
import { SecretStore } from "@claudexor/secrets";
import { appendLine, noProjectRepoRoot, readJsonSafe, readTextSafe, redactSecrets } from "@claudexor/util";
import { type ControlRunStartRequest as ControlRunStartRequestDto, ControlSettingsUpdateRequest, ControlSetupJob as ControlSetupJobSchema, type ControlSetupJob, GlobalConfig } from "@claudexor/schema";
import { buildGateway, buildRegistry } from "./registry.js";
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
      return orchestrator.run({
        repoRoot,
        prompt: String(p.prompt ?? ""),
        mode: p.mode,
        contextMode: noProjectAsk ? "off" : p.scope.kind === "project" ? p.scope.context : undefined,
        harnesses: p.harnesses,
        primaryHarness: p.primaryHarness,
        portfolio: p.portfolio,
        n: p.n,
        attempts: p.attempts ?? null,
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
        inPlace: p.execution.isolation === "live",
        signal: ctx.signal,
        onRunStart: ctx.onRunStart,
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
          services: controlServices(),
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
    };
  }
  return next;
}

function controlServices() {
  const secretStore = new SecretStore();
  const setupJobs = createSetupJobManager();
  mkdirSync(NO_PROJECT_ROOT, { recursive: true, mode: 0o700 });
  return {
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
        routing: {
          defaultPolicy: cfg.global.routing.default_policy,
          primaryHarness: cfg.global.routing.primary_harness,
          eligibleHarnesses: cfg.global.routing.eligible_harnesses,
          defaultModel: cfg.global.routing.default_model,
          envInheritance: cfg.global.routing.env_inheritance,
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
      return updateGlobalConfig((cfg) => ({
        ...cfg,
        default_portfolio: p.defaultPortfolio ?? cfg.default_portfolio,
        routing: {
          ...cfg.routing,
          primary_harness: nullableName(p.primaryHarness, cfg.routing.primary_harness),
          default_model: nullableName(p.defaultModel, cfg.routing.default_model),
          default_policy: p.routingPolicy ?? cfg.routing.default_policy,
          env_inheritance: p.envInheritance ?? cfg.routing.env_inheritance,
          eligible_harnesses: p.eligibleHarnesses ?? cfg.routing.eligible_harnesses,
        },
        budget: {
          ...cfg.budget,
          max_usd_per_run: p.clearMaxUsdPerRun === true ? null : p.maxUsdPerRun ?? cfg.budget.max_usd_per_run,
          max_usd_per_day: p.clearMaxUsdPerDay === true ? null : p.maxUsdPerDay ?? cfg.budget.max_usd_per_day,
        },
        harnesses: applyHarnessSettingsPatches(cfg.harnesses, p.harnesses),
      }));
    },
    listSecrets: async () => ({ backend: secretStore.resolvedBackend(), secrets: secretStore.list() }),
    setSecret: async (input: unknown) => {
      const p = (input ?? {}) as Record<string, unknown>;
      const name = typeof p["name"] === "string" ? p["name"] : "";
      const value = typeof p["value"] === "string" ? p["value"] : "";
      if (!name || !value) throw new Error("name and value are required");
      const backend = secretStore.set(name, value);
      // Keychain->file degradation is disclosed, not silent (UI shows it).
      return { name, backend, stored: true, ...(secretStore.lastFallbackReason ? { warning: secretStore.lastFallbackReason } : {}) };
    },
    deleteSecret: async (name: string) => {
      secretStore.delete(name);
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

const SETUP_LOG = join(daemonDir(), "setup.log");

type SetupProfile = {
  guideUrl: string;
  installCommand: string | null;
  loginCommand: string | null;
  doctorCommand: string;
  note: string;
  installRiskFlags: string[];
};

const SETUP_PROFILES: Record<string, SetupProfile> = {
  codex: {
    guideUrl: "https://developers.openai.com/codex",
    installCommand: "npm install -g @openai/codex",
    loginCommand: "codex login",
    doctorCommand: "claudexor doctor --harness codex",
    note: "Codex native login seeds the local CLI session; API-key fallback can be stored as the openai secret ref.",
    installRiskFlags: ["network_download", "global_npm_install"],
  },
  claude: {
    guideUrl: "https://docs.anthropic.com/en/docs/claude-code",
    installCommand: "npm install -g @anthropic-ai/claude-code",
    loginCommand: "claude /login",
    doctorCommand: "claudexor doctor --harness claude",
    note: "Claude Code native login is preferred; Anthropic API-key fallback can be stored as the anthropic secret ref.",
    installRiskFlags: ["network_download", "global_npm_install"],
  },
  cursor: {
    guideUrl: "https://docs.cursor.com/cli",
    installCommand: "curl https://cursor.com/install -fsS | bash",
    loginCommand: "cursor-agent login",
    doctorCommand: "claudexor doctor --harness cursor",
    note: "Cursor native CLI login is reused when available.",
    installRiskFlags: ["network_download", "shell_pipe", "no_static_sha256", "may_prompt_for_privilege"],
  },
  opencode: {
    guideUrl: "https://opencode.ai/docs",
    installCommand: "curl -fsSL https://opencode.ai/install | bash",
    loginCommand: "opencode auth login",
    doctorCommand: "claudexor doctor --harness opencode",
    note: "OpenCode native auth is reused when available.",
    installRiskFlags: ["network_download", "shell_pipe", "no_static_sha256", "may_prompt_for_privilege"],
  },
  raw: {
    guideUrl: "https://platform.openai.com/docs",
    installCommand: null,
    loginCommand: null,
    doctorCommand: "claudexor doctor --all",
    note: "Raw API routes use stored secret refs instead of a native CLI login.",
    installRiskFlags: [],
  },
};

function setupHarness(input: unknown) {
  const p = (input ?? {}) as Record<string, unknown>;
  const harness = typeof p["harness"] === "string" ? p["harness"] : "";
  const action = typeof p["action"] === "string" ? p["action"] : "login";
  const profile = SETUP_PROFILES[harness];
  if (!profile) throw new Error("unknown harness");

  let command: string | null = null;
  let message = profile.note;
  let status: "prepared" | "not_supported" = "prepared";
  if (action === "login") {
    if (profile.loginCommand) {
      command = `${profile.loginCommand} && ${profile.doctorCommand}`;
      message = `Prepared allowlisted ${harness} native login command. Run it in Terminal, then recheck Harness Doctor.`;
    } else {
      status = "not_supported";
      message = `${harness} has no native login command; store API-key fallback refs in Settings.`;
    }
  } else if (action === "doctor") {
    command = profile.doctorCommand;
    message = `Prepared allowlisted ${harness} doctor command.`;
  } else if (action === "install") {
    if (profile.installCommand) {
      command = `${profile.installCommand} && ${profile.doctorCommand}`;
      message = `Prepared allowlisted ${harness} install command. Start a setup job to execute it with confirmation and logs.`;
    } else {
      status = "not_supported";
      message = `${harness} has no native installer; store API-key fallback refs in Settings.`;
    }
  } else if (action === "install_guide") {
    message = `Prepared official ${harness} install/login guide URL.`;
  } else {
    throw new Error(`unsupported setup action: ${action}`);
  }

  appendLine(SETUP_LOG, `[${new Date().toISOString()}] setup ${harness} ${action}: ${message}`);
  return {
    harness,
    action,
    status,
    command,
    guideUrl: profile.guideUrl,
    logPath: SETUP_LOG,
    message,
  };
}

const SETUP_JOBS_DIR = join(daemonDir(), "setup-jobs");
const SETUP_JOBS_REGISTRY = join(SETUP_JOBS_DIR, "jobs.json");
/** A hung installer must reach a visible terminal state, not run forever. */
const SETUP_JOB_TIMEOUT_MS = 15 * 60_000;

function createSetupJobManager() {
  const jobs = new Map<string, ControlSetupJob>();
  const children = new Map<string, ChildProcess>();
  const timeouts = new Map<string, NodeJS.Timeout>();

  // Durable registry: a daemon restart must not erase job history. Jobs that
  // were mid-flight when the daemon died are marked failed (honest terminal),
  // except Terminal logins, which legitimately outlive the daemon process.
  mkdirSync(SETUP_JOBS_DIR, { recursive: true, mode: 0o700 });
  const persisted = readJsonSafe<unknown[]>(SETUP_JOBS_REGISTRY);
  if (Array.isArray(persisted)) {
    for (const raw of persisted) {
      const parsed = ControlSetupJobSchema.safeParse(raw);
      if (!parsed.success) continue;
      const job = parsed.data;
      if (job.state === "running" || job.state === "queued") {
        jobs.set(job.jobId, {
          ...job,
          state: "failed",
          finishedAt: new Date().toISOString(),
          message: `${job.harness} ${job.action} job was interrupted by a daemon restart.`,
        });
      } else {
        jobs.set(job.jobId, job);
      }
    }
  }

  const persist = (): void => {
    try {
      writeFileSync(SETUP_JOBS_REGISTRY, JSON.stringify([...jobs.values()], null, 2) + "\n", { mode: 0o600 });
    } catch {
      /* registry persistence is best-effort; state stays authoritative in memory */
    }
  };

  const save = (job: ControlSetupJob): ControlSetupJob => {
    jobs.set(job.jobId, job);
    persist();
    return job;
  };

  const update = (jobId: string, patch: Partial<ControlSetupJob>): ControlSetupJob => {
    const prev = jobs.get(jobId);
    if (!prev) throw Object.assign(new Error("setup job not found"), { status: 404 });
    return save({ ...prev, ...patch });
  };

  const writeJobLog = (job: ControlSetupJob, line: string): void => {
    if (!job.logPath) return;
    appendLine(job.logPath, `[${new Date().toISOString()}] ${redactSecrets(line)}`);
  };

  const noteJobOutput = (jobId: string): void => {
    const current = jobs.get(jobId);
    if (!current || current.state !== "running") return;
    const now = nowForDto();
    update(jobId, {
      firstOutputAt: current.firstOutputAt ?? now,
      lastOutputAt: now,
      message: current.firstOutputAt
        ? `Running allowlisted ${current.harness} ${current.action} job. Latest output at ${now}.`
        : `Running allowlisted ${current.harness} ${current.action} job. First output received.`,
    });
  };

  const startShellJob = (job: ControlSetupJob, command: string): ControlSetupJob => {
    const started = update(job.jobId, { state: "running", startedAt: nowForDto(), message: `Running allowlisted ${job.harness} ${job.action} job.` });
    writeJobLog(started, `$ ${command}`);
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd: NO_PROJECT_ROOT,
      env: setupJobEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.set(job.jobId, child);
    // Watchdog: a wedged install/doctor must surface as a failed terminal state.
    const watchdog = setTimeout(() => {
      const current = jobs.get(job.jobId);
      if (!current || current.state !== "running") return;
      writeJobLog(current, `watchdog: job exceeded ${SETUP_JOB_TIMEOUT_MS / 60000} minutes; terminating`);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      const failed = update(job.jobId, {
        state: "failed",
        finishedAt: nowForDto(),
        message: `${job.harness} ${job.action} job timed out after ${SETUP_JOB_TIMEOUT_MS / 60000} minutes and was terminated.`,
      });
      writeJobLog(failed, failed.message);
    }, SETUP_JOB_TIMEOUT_MS);
    watchdog.unref();
    timeouts.set(job.jobId, watchdog);
    child.stdout.on("data", (chunk) => { noteJobOutput(job.jobId); writeJobLog(jobs.get(job.jobId) ?? started, String(chunk)); });
    child.stderr.on("data", (chunk) => { noteJobOutput(job.jobId); writeJobLog(jobs.get(job.jobId) ?? started, String(chunk)); });
    child.on("error", (err) => {
      children.delete(job.jobId);
      clearTimeout(timeouts.get(job.jobId));
      timeouts.delete(job.jobId);
      const failed = update(job.jobId, { state: "failed", finishedAt: nowForDto(), message: `Setup job failed to start: ${err.message}` });
      writeJobLog(failed, failed.message);
    });
    child.on("exit", (code, signal) => {
      children.delete(job.jobId);
      clearTimeout(timeouts.get(job.jobId));
      timeouts.delete(job.jobId);
      const current = jobs.get(job.jobId);
      if (!current || current.state === "cancelled" || current.state === "failed") return;
      const ok = code === 0;
      const message = ok
        ? `${job.harness} ${job.action} job finished. Post-action doctor command was included when supported.`
        : `${job.harness} ${job.action} job failed with ${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`}.`;
      const done = update(job.jobId, { state: ok ? "succeeded" : "failed", finishedAt: nowForDto(), message });
      writeJobLog(done, message);
    });
    return started;
  };

  const startTerminalLoginJob = (job: ControlSetupJob, command: string): ControlSetupJob => {
    const scriptPath = join(SETUP_JOBS_DIR, `${job.jobId}.command`);
    const script = `#!/usr/bin/env bash
set -euo pipefail
${command}
printf '\\nClaudexor setup command finished. Press Return to close this window. '
IFS= read -r _
`;
    writeFileSync(scriptPath, script, { mode: 0o700 });
    chmodSync(scriptPath, 0o700);
    writeJobLog(job, `Terminal script: ${scriptPath}`);
    const child = spawn("/usr/bin/open", ["-a", "Terminal", scriptPath], { detached: true, stdio: "ignore" });
    child.unref();
    const waiting = update(job.jobId, {
      state: "waiting_for_input",
      startedAt: nowForDto(),
      message: `Opened allowlisted ${job.harness} login in Terminal. Complete native auth there, then recheck Harness Doctor.`,
    });
    return waiting;
  };

  return {
    create(input: unknown): ControlSetupJob {
      mkdirSync(SETUP_JOBS_DIR, { recursive: true, mode: 0o700 });
      const p = (input ?? {}) as Record<string, unknown>;
      const harness = typeof p["harness"] === "string" ? p["harness"] : "";
      const action = typeof p["action"] === "string" ? p["action"] : "";
      const profile = SETUP_PROFILES[harness];
      if (!profile) throw new Error("unknown harness");
      if (action !== "install" && action !== "login" && action !== "doctor" && action !== "store_key") throw new Error("unsupported setup job action");

      const jobId = `setup-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      const logPath = join(SETUP_JOBS_DIR, `${jobId}.log`);
      // Honest retry accounting: a new job for the same harness+action after a
      // failed one IS the user retrying.
      const priorFailures = [...jobs.values()].filter(
        (j) => j.harness === harness && j.action === action && (j.state === "failed" || j.state === "cancelled"),
      ).length;
      const base: ControlSetupJob = {
        jobId,
        harness: harness as ControlSetupJob["harness"],
        action,
        state: "queued",
        command: null,
        guideUrl: profile.guideUrl,
        logPath,
        message: profile.note,
        riskFlags: action === "install" ? profile.installRiskFlags : [],
        requiresConfirmation: false,
        createdAt: nowForDto(),
        startedAt: null,
        firstOutputAt: null,
        lastOutputAt: null,
        finishedAt: null,
        retryCount: priorFailures,
      };
      writeJobLog(base, `created ${harness} ${action}${priorFailures > 0 ? ` (retry #${priorFailures})` : ""}`);

      if (action === "login") {
        if (!profile.loginCommand) {
          return save({
            ...base,
            state: "not_supported",
            finishedAt: nowForDto(),
            message: `${harness} has no native login command; store API-key fallback refs in Settings.`,
          });
        }
        const job = save({ ...base, command: `${profile.loginCommand} && ${profile.doctorCommand}` });
        return startTerminalLoginJob(job, job.command ?? "");
      }

      if (action === "doctor") {
        const job = save({ ...base, command: profile.doctorCommand });
        return startShellJob(job, profile.doctorCommand);
      }

      if (action === "store_key") {
        // Honest message: this job only verifies via doctor. The key itself is
        // stored by the separate Settings store-secret call, never by this job.
        const job = save({
          ...base,
          command: profile.doctorCommand,
          message: `Running post-store doctor for ${harness}. (The key itself is saved via Settings > secrets, not by this job.)`,
        });
        return startShellJob(job, profile.doctorCommand);
      }

      if (!profile.installCommand) {
        return save({
          ...base,
          state: "not_supported",
          finishedAt: nowForDto(),
          message: `${harness} has no native installer; use stored API-key fallback refs instead.`,
        });
      }
      const command = `${profile.installCommand} && ${profile.doctorCommand}`;
      return save({
        ...base,
        state: "waiting_for_input",
        command,
        requiresConfirmation: true,
        message: `Confirm to run allowlisted ${harness} installer. Risks: ${profile.installRiskFlags.join(", ") || "standard process execution"}.`,
      });
    },

    confirm(input: unknown): ControlSetupJob {
      const p = (input ?? {}) as Record<string, unknown>;
      const jobId = typeof p["jobId"] === "string" ? p["jobId"] : "";
      const confirmed = p["confirmed"] !== false;
      const job = jobs.get(jobId);
      if (!job) throw Object.assign(new Error("setup job not found"), { status: 404 });
      if (!confirmed) return job;
      if (!job.requiresConfirmation || job.action !== "install" || !job.command) {
        throw new Error("setup job does not require confirmation");
      }
      if (job.state !== "waiting_for_input") {
        throw new Error(`setup job cannot be confirmed while ${job.state}`);
      }
      const ready = save({ ...job, requiresConfirmation: false });
      return startShellJob(ready, ready.command ?? "");
    },

    list(): ControlSetupJob[] {
      return [...jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    status(input: unknown): ControlSetupJob {
      const p = (input ?? {}) as Record<string, unknown>;
      const jobId = typeof p["jobId"] === "string" ? p["jobId"] : "";
      const job = jobs.get(jobId);
      if (!job) throw Object.assign(new Error("setup job not found"), { status: 404 });
      return job;
    },

    cancel(input: unknown): ControlSetupJob {
      const p = (input ?? {}) as Record<string, unknown>;
      const jobId = typeof p["jobId"] === "string" ? p["jobId"] : "";
      const job = jobs.get(jobId);
      if (!job) throw Object.assign(new Error("setup job not found"), { status: 404 });
      const child = children.get(jobId);
      if (child) {
        child.kill("SIGTERM");
        children.delete(jobId);
      }
      clearTimeout(timeouts.get(jobId));
      timeouts.delete(jobId);
      const cancelled = update(jobId, { state: "cancelled", finishedAt: nowForDto(), message: `Cancelled ${job.harness} ${job.action} setup job.` });
      writeJobLog(cancelled, cancelled.message);
      return cancelled;
    },
  };
}

function setupJobEnv(): NodeJS.ProcessEnv {
  const home = process.env.HOME ?? "";
  const path = [
    join(home, ".local", "bin"),
    join(home, ".claudexor", "node", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter(Boolean).join(":");
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: path,
    SHELL: process.env.SHELL ?? "/bin/bash",
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
  };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return env;
}

function nowForDto(): string {
  return new Date().toISOString();
}

main().catch((err: unknown) => {
  process.stderr.write(`claudexord: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
