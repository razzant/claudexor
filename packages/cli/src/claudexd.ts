#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DaemonClient, DaemonServer, daemonDir, defaultSocketPath, ensureToken, logPath } from "@claudex/daemon";
import { DaemonControlApiServer } from "@claudex/control-api";
import { Orchestrator } from "@claudex/orchestrator";
import { loadConfig, updateGlobalConfig } from "@claudex/config";
import { SecretStore } from "@claudex/secrets";
import { appendLine, assertNoInlineSecretValues, noProjectRepoRoot, readTextSafe } from "@claudex/util";
import { ControlRunStartRequest, type ControlRunStartRequest as ControlRunStartRequestDto } from "@claudex/schema";
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
      const explicitRepoRoot = p.repoRoot && p.repoRoot !== NO_PROJECT_ROOT ? p.repoRoot : null;
      const repoRoot = p.repoRoot;
      if (!repoRoot) throw new Error(`repoRoot is required for mode '${mode}'`);
      const noProjectAsk = mode === "ask" && (!explicitRepoRoot || (explicitRepoRoot === NO_PROJECT_ROOT && p.contextMode === "off"));
      if (noProjectAsk) mkdirSync(NO_PROJECT_ROOT, { recursive: true, mode: 0o700 });
      if (p.contextMode === "off" && !noProjectAsk) {
        throw new Error("contextMode 'off' is only supported for Ask without a repoRoot");
      }
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
        contextMode: noProjectAsk ? "off" : p.contextMode,
        harnesses: p.harnesses,
        primaryHarness: p.primaryHarness,
        portfolio: p.portfolio,
        n: p.n,
        attempts: p.attempts ?? null,
        // Policy from the GUI composer / API client (applied, not just displayed).
        maxUsd: p.maxUsd ?? null,
        access: p.access,
        model: p.model,
        tests: Array.isArray(p.tests) ? p.tests : undefined,
        specId: typeof p.specId === "string" ? p.specId : undefined,
        specHash: typeof p.specHash === "string" ? p.specHash : undefined,
        specPath: typeof p.specPath === "string" ? p.specPath : undefined,
        envProfile: typeof p.envProfile === "string" ? p.envProfile : undefined,
        inPlace: p.inPlace === true,
        signal: ctx.signal,
        onRunStart: ctx.onRunStart,
      });
    },
  });

  await server.start();
  appendFileSync(logPath(), `[${new Date().toISOString()}] claudexd listening on ${socketPath}\n`);
  const control =
    process.env.CLAUDEX_NO_CONTROL_API === "1"
      ? null
      : new DaemonControlApiServer({
          token,
          daemon: new DaemonClient(socketPath, token),
          port: Number(process.env.CLAUDEX_CONTROL_PORT ?? 0),
          services: controlServices(),
        });
  if (control) {
    const controlAddr = await control.start();
    writeFileSync(
      join(daemonDir(), "control-api.json"),
      JSON.stringify({ ...controlAddr, tokenPath: join(daemonDir(), "token") }, null, 2) + "\n",
      { mode: 0o600 },
    );
    appendFileSync(logPath(), `[${new Date().toISOString()}] claudex control-api listening on http://${controlAddr.host}:${controlAddr.port}\n`);
  } else {
    appendFileSync(logPath(), `[${new Date().toISOString()}] claudex control-api disabled by CLAUDEX_NO_CONTROL_API=1\n`);
  }
  await server.waitForShutdown();
  await control?.stop();
  appendFileSync(logPath(), `[${new Date().toISOString()}] claudexd shut down\n`);
  process.exit(0);
}

function normalizeDaemonRunStart(raw: unknown): ControlRunStartRequestDto {
  assertNoInlineSecretValues(raw);
  const parsed = ControlRunStartRequest.parse(raw ?? {});
  const mode = parsed.mode;
  const repoRoot = parsed.repoRoot?.trim();
  if (repoRoot) {
    if (!isAbsolute(repoRoot)) {
      throw Object.assign(new Error("repoRoot must be an absolute path"), { status: 400 });
    }
    if (parsed.contextMode === "off") {
      throw new Error("contextMode 'off' is only supported for Ask without a repoRoot");
    }
    return { ...parsed, repoRoot, contextMode: parsed.contextMode ?? "auto" };
  }
  if (mode === "ask") {
    mkdirSync(NO_PROJECT_ROOT, { recursive: true, mode: 0o700 });
    return { ...parsed, repoRoot: NO_PROJECT_ROOT, contextMode: "off" };
  }
  throw new Error(`repoRoot is required for mode '${mode}'`);
}

function controlServices() {
  const secretStore = new SecretStore();
  mkdirSync(NO_PROJECT_ROOT, { recursive: true, mode: 0o700 });
  return {
    harnesses: async () => ({ harnesses: await buildGateway({ includeFakes: false }).statusAll({ cwd: NO_PROJECT_ROOT }) }),
    setupHarness: async (input: unknown) => setupHarness(input),
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
      const repoRoot = typeof p["repoRoot"] === "string" && p["repoRoot"].trim() ? p["repoRoot"].trim() : "";
      if (!repoRoot) throw new Error("repoRoot is required for spec questions");
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
      const repoRoot = typeof p["repoRoot"] === "string" && p["repoRoot"].trim() ? p["repoRoot"].trim() : "";
      if (!repoRoot) throw new Error("repoRoot is required to freeze a spec");
      const spec = await freezeSpecFromGrounding(prompt, plan, { answers: Array.isArray(p["answers"]) ? (p["answers"] as never[]) : [] });
      const persisted = persistSpec(repoRoot, spec, plan);
      return { specId: spec.id, specDir: persisted.specDir, specHash: persisted.specHash, changes: persisted.changes };
    },
  };
}

const SETUP_LOG = join(daemonDir(), "setup.log");

const SETUP_PROFILES: Record<string, { guideUrl: string; loginCommand: string | null; doctorCommand: string; note: string }> = {
  codex: {
    guideUrl: "https://developers.openai.com/codex",
    loginCommand: "codex login",
    doctorCommand: "claudex doctor --harness codex",
    note: "Codex native login seeds the local CLI session; API-key fallback can be stored as the openai secret ref.",
  },
  claude: {
    guideUrl: "https://docs.anthropic.com/en/docs/claude-code",
    loginCommand: "claude /login",
    doctorCommand: "claudex doctor --harness claude",
    note: "Claude Code native login is preferred; Anthropic API-key fallback can be stored as the anthropic secret ref.",
  },
  cursor: {
    guideUrl: "https://docs.cursor.com/cli",
    loginCommand: "cursor-agent login",
    doctorCommand: "claudex doctor --harness cursor",
    note: "Cursor native CLI login is reused when available.",
  },
  opencode: {
    guideUrl: "https://opencode.ai/docs",
    loginCommand: "opencode auth login",
    doctorCommand: "claudex doctor --harness opencode",
    note: "OpenCode native auth is reused when available.",
  },
  raw: {
    guideUrl: "https://platform.openai.com/docs",
    loginCommand: null,
    doctorCommand: "claudex doctor --all",
    note: "Raw API routes use stored secret refs instead of a native CLI login.",
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

main().catch((err: unknown) => {
  process.stderr.write(`claudexd: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
