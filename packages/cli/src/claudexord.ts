#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DaemonClient, DaemonServer, daemonDir, defaultSocketPath, ensureToken, logPath } from "@claudexor/daemon";
import { DaemonControlApiServer } from "@claudexor/control-api";
import { Orchestrator } from "@claudexor/orchestrator";
import { loadConfig, updateGlobalConfig } from "@claudexor/config";
import { SecretStore } from "@claudexor/secrets";
import { appendLine, assertNoInlineSecretValues, noProjectRepoRoot, readTextSafe, redactSecrets } from "@claudexor/util";
import { ControlRunStartRequest, type ControlRunStartRequest as ControlRunStartRequestDto, type ControlSetupJob } from "@claudexor/schema";
import { buildGateway, buildRegistry } from "./registry.js";
import { extractQuestionsFromPlan, freezeSpecFromGrounding, persistSpec } from "./spec.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const NO_PROJECT_ROOT = noProjectRepoRoot();

async function main(): Promise<void> {
  mkdirSync(daemonDir(), { recursive: true });
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

function normalizeDaemonRunStart(raw: unknown): ControlRunStartRequestDto {
  assertNoInlineSecretValues(raw);
  const parsed = ControlRunStartRequest.parse(raw ?? {});
  const mode = parsed.mode;
  if (parsed.scope.kind === "project") {
    const repoRoot = parsed.scope.root.trim();
    if (!isAbsolute(repoRoot)) {
      throw Object.assign(new Error("project root must be an absolute path"), { status: 400 });
    }
    return { ...parsed, scope: { kind: "project", root: repoRoot, context: parsed.scope.context ?? "auto" } };
  }
  if (mode === "ask") {
    mkdirSync(NO_PROJECT_ROOT, { recursive: true, mode: 0o700 });
    return parsed;
  }
  throw new Error(`project scope is required for mode '${mode}'`);
}

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
      const p = (patch ?? {}) as Record<string, unknown>;
      return updateGlobalConfig((cfg) => ({
        ...cfg,
        default_portfolio: typeof p["defaultPortfolio"] === "string" ? (p["defaultPortfolio"] as never) : cfg.default_portfolio,
        routing: {
          ...cfg.routing,
          primary_harness:
            typeof p["primaryHarness"] === "string"
              ? p["primaryHarness"] === "none" || p["primaryHarness"] === "__none"
                ? null
                : p["primaryHarness"]
              : p["primaryHarness"] === null
                ? null
                : cfg.routing.primary_harness,
          default_model:
            typeof p["defaultModel"] === "string"
              ? p["defaultModel"] === "none" || p["defaultModel"] === "__none"
                ? null
                : p["defaultModel"]
              : p["defaultModel"] === null
                ? null
                : cfg.routing.default_model,
          default_policy:
            typeof p["routingPolicy"] === "string"
              ? (p["routingPolicy"] as never)
              : cfg.routing.default_policy,
          env_inheritance:
            typeof p["envInheritance"] === "string"
              ? (p["envInheritance"] as never)
              : cfg.routing.env_inheritance,
          eligible_harnesses: Array.isArray(p["eligibleHarnesses"])
            ? p["eligibleHarnesses"].filter((x): x is string => typeof x === "string")
            : cfg.routing.eligible_harnesses,
        },
        budget: {
          ...cfg.budget,
          max_usd_per_run:
            typeof p["maxUsdPerRun"] === "number"
              ? p["maxUsdPerRun"]
              : p["maxUsdPerRun"] === null || p["clearMaxUsdPerRun"] === true
                ? null
                : cfg.budget.max_usd_per_run,
          max_usd_per_day:
            typeof p["maxUsdPerDay"] === "number"
              ? p["maxUsdPerDay"]
              : p["maxUsdPerDay"] === null || p["clearMaxUsdPerDay"] === true
                ? null
                : cfg.budget.max_usd_per_day,
        },
      }));
    },
    auth: async () => ({ harnesses: await buildGateway({ includeFakes: false }).statusAll({ cwd: NO_PROJECT_ROOT }) }),
    listSecrets: async () => ({ backend: secretStore.resolvedBackend(), secrets: secretStore.list() }),
    setSecret: async (input: unknown) => {
      const p = (input ?? {}) as Record<string, unknown>;
      const name = typeof p["name"] === "string" ? p["name"] : "";
      const value = typeof p["value"] === "string" ? p["value"] : "";
      if (!name || !value) throw new Error("name and value are required");
      const backend = secretStore.set(name, value);
      return { name, backend, stored: true };
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

function createSetupJobManager() {
  const jobs = new Map<string, ControlSetupJob>();
  const children = new Map<string, ChildProcess>();

  const save = (job: ControlSetupJob): ControlSetupJob => {
    jobs.set(job.jobId, job);
    return job;
  };

  const update = (jobId: string, patch: Partial<ControlSetupJob>): ControlSetupJob => {
    const prev = jobs.get(jobId);
    if (!prev) throw new Error("setup job not found");
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
    child.stdout.on("data", (chunk) => { noteJobOutput(job.jobId); writeJobLog(jobs.get(job.jobId) ?? started, String(chunk)); });
    child.stderr.on("data", (chunk) => { noteJobOutput(job.jobId); writeJobLog(jobs.get(job.jobId) ?? started, String(chunk)); });
    child.on("error", (err) => {
      children.delete(job.jobId);
      const failed = update(job.jobId, { state: "failed", finishedAt: nowForDto(), message: `Setup job failed to start: ${err.message}` });
      writeJobLog(failed, failed.message);
    });
    child.on("exit", (code, signal) => {
      children.delete(job.jobId);
      const current = jobs.get(job.jobId);
      if (!current || current.state === "cancelled") return;
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
        retryCount: 0,
      };
      writeJobLog(base, `created ${harness} ${action}`);

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
        const job = save({
          ...base,
          command: profile.doctorCommand,
          message: `Stored fallback secret ref for ${harness}; running post-action doctor.`,
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
      if (!job) throw new Error("setup job not found");
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
      if (!job) throw new Error("setup job not found");
      return job;
    },

    cancel(input: unknown): ControlSetupJob {
      const p = (input ?? {}) as Record<string, unknown>;
      const jobId = typeof p["jobId"] === "string" ? p["jobId"] : "";
      const job = jobs.get(jobId);
      if (!job) throw new Error("setup job not found");
      const child = children.get(jobId);
      if (child) {
        child.kill("SIGTERM");
        children.delete(jobId);
      }
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
