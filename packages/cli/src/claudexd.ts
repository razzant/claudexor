#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DaemonClient, DaemonServer, daemonDir, defaultSocketPath, ensureToken, logPath } from "@claudex/daemon";
import { DaemonControlApiServer } from "@claudex/control-api";
import { Orchestrator } from "@claudex/orchestrator";
import { loadConfig, updateGlobalConfig } from "@claudex/config";
import { SecretStore } from "@claudex/secrets";
import { readTextSafe } from "@claudex/util";
import { buildGateway, buildRegistry } from "./registry.js";
import { extractQuestionsFromPlan, freezeSpecFromGrounding, persistSpec } from "./spec.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

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
      const p = (params ?? {}) as any;
      const orchestrator = new Orchestrator({
        registry: buildRegistry(),
        portfolio: p.portfolio,
        reviewerModels: p.reviewerModels && typeof p.reviewerModels === "object" ? p.reviewerModels : undefined,
      });
      return orchestrator.run({
        repoRoot: p.repoRoot ?? process.cwd(),
        prompt: String(p.prompt ?? ""),
        mode: p.mode,
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

function controlServices() {
  const secretStore = new SecretStore();
  return {
    harnesses: async () => ({ harnesses: await buildGateway({ includeFakes: false }).statusAll({ cwd: process.cwd() }) }),
    settings: async () => {
      const cfg = loadConfig(process.cwd());
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
    auth: async () => ({ harnesses: await buildGateway({ includeFakes: false }).statusAll({ cwd: process.cwd() }) }),
    listSecrets: async () => ({ backend: secretStore.resolvedBackend(), secrets: secretStore.list() }),
    setSecret: async (input: unknown) => {
      const p = (input ?? {}) as Record<string, unknown>;
      const name = typeof p["name"] === "string" ? p["name"] : "";
      const value = typeof p["value"] === "string" ? p["value"] : "";
      if (!name || !value) throw new Error("name and value are required");
      secretStore.set(name, value);
      return { name, backend: secretStore.resolvedBackend(), stored: true };
    },
    deleteSecret: async (name: string) => {
      secretStore.delete(name);
      return { name, deleted: true };
    },
    specQuestions: async (input: unknown) => {
      const p = (input ?? {}) as Record<string, unknown>;
      const prompt = typeof p["prompt"] === "string" ? p["prompt"] : "";
      if (!prompt.trim()) throw new Error("prompt is required");
      const plan = await new Orchestrator({ registry: buildRegistry() }).run({
        repoRoot: typeof p["repoRoot"] === "string" ? p["repoRoot"] : process.cwd(),
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
      const spec = await freezeSpecFromGrounding(prompt, plan, { answers: Array.isArray(p["answers"]) ? (p["answers"] as never[]) : [] });
      const persisted = persistSpec(typeof p["repoRoot"] === "string" ? p["repoRoot"] : process.cwd(), spec, plan);
      return { specId: spec.id, specDir: persisted.specDir, specHash: persisted.specHash, changes: persisted.changes };
    },
  };
}

main().catch((err: unknown) => {
  process.stderr.write(`claudexd: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
