#!/usr/bin/env node
import process from "node:process";
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "@claudex/orchestrator";
import {
  SWE_BENCH_EVAL_INSTRUCTIONS,
  loadTasksFromJsonl,
  runBenchmark,
  writePredictions,
} from "@claudex/benchmark";
import { ArtifactStore } from "@claudex/artifact-store";
import { type DeliverMode, checkPatch, deliver } from "@claudex/delivery";
import { containsSecretLikeToken, ensureDir, hashJson, readTextSafe, sha256, writeJson } from "@claudex/util";
import { checkName } from "./release.js";
import { DaemonClient, defaultSocketPath, logPath, readToken } from "@claudex/daemon";
import { McpServer, defaultClaudexTools } from "@claudex/mcp-server";
import { AcpServer } from "@claudex/acp-server";
import { initProjectConfig, loadConfig, updateGlobalConfig } from "@claudex/config";
import { SecretStore } from "@claudex/secrets";
import {
  DecisionRecord,
  ModeKind as ModeKindSchema,
  Portfolio,
  type ModeKind,
  SpecPack as SpecPackSchema,
  TaskContract,
  WorkProduct,
} from "@claudex/schema";
import { flagBool, flagStr, parseArgs, type ParsedArgs } from "./args.js";
import { type PluginHost, installPlugin } from "./plugins.js";
import { buildGateway, buildRegistry } from "./registry.js";
import {
  extractQuestionsFromPlan,
  freezeSpecFromGrounding,
  loadPreviousSpec,
  persistSpec,
  readAnswers,
  type SpecCommandResult,
} from "./spec.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
function orchestratorRunner() {
  const orch = new Orchestrator({ registry: buildRegistry() });
  return async (p: any) => {
    if (p?.mode === "__status") return { harnesses: [...buildRegistry().keys()] };
    return orch.run({
      repoRoot: process.cwd(),
      prompt: String(p?.prompt ?? ""),
      mode: p?.mode ?? "agent",
      harnesses: p?.harness ? [String(p.harness)] : undefined,
      primaryHarness: p?.primaryHarness ? String(p.primaryHarness) : undefined,
      model: p?.model ? String(p.model) : undefined,
      n: typeof p?.n === "number" ? p.n : undefined,
    });
  };
}

const HELP = `claudex — harness-agnostic AI coding control plane (v0.3.0)

Usage:
  claudex init                          Scaffold repo-local config (.claudex/config.yaml)
  claudex doctor [--harness <id>] [--all]   Detect + conformance-test harnesses
  claudex ask "<question>" [opts]       Read-only answer/explanation route
  claudex run "<prompt>" [opts]         Run a task (default mode: agent)
  claudex race "<prompt>" [--n N]       Best-of-N tournament with cross-family review
  claudex plan "<prompt>"               Read-only planning report
  claudex spec "<prompt>" [--answers file]  Multi-harness plan grounding -> quiz -> frozen SpecPack
  claudex create "<prompt>" [--target]  Create-from-scratch (new repo)
  claudex audit | map                   Read-only repo audit / map
  claudex inspect <run_id>              Inspect a run's decision + artifacts
  claudex apply <run_id> [--mode ...]   Apply a run's WorkProduct (apply|commit|branch|pr|--dry-run)
  claudex settings show|set             Show/update user defaults
  claudex auth status|login             Inspect native harness auth
  claudex secrets list|set|delete       Manage stored API-key refs (Keychain/0600 file)
  claudex release check-name <name>     Naming gate (npm/pypi/crates/github)
  claudex daemon start|status|stop|logs Optional local daemon (claudexd)
  claudex mcp serve                     Expose Claudex as an MCP server (stdio)
  claudex acp serve                     Expose Claudex as an ACP agent (stdio)
  claudex plugin install <host>         Install thin host plugin (cursor|claude|codex|opencode)
  claudex bench list|instructions|run   SWE-bench Verified (+ scaffolds)
  claudex harness list                  List registered harnesses
  claudex help                          Show this help

Options:
  --harness <id[,id...]>   Force harness(es)
  --mode <mode>            ask | agent | best_of_n | max_attempts | until_clean | plan | create | readonly_audit | benchmark
  --n <N>                  Candidates for Best-of-N
  --attempts <N>           Max attempts (max_attempts mode)
  --test "<cmd>"           Deterministic gate command(s); multiple via ';;' separator
  --max-usd <amount>       Hard per-run spend cap (USD)
  --reviewer-model <map>   Per-family reviewer model, e.g. "openai=gpt-4o-mini,anthropic=claude-haiku"
  --access <profile>       Access profile: readonly|workspace_write|full|inherit_native
  --model <id>             Model hint forwarded to the selected harness route
  --primary-harness <id>   Bias single-route modes and first candidate choice
  --portfolio <id>         Budget/routing portfolio (default: subscription-first)
  --in-place               Convergence runs against the live cwd (no git worktree);
                           for stateful benchmark containers (e.g. Terminal-Bench /app)
  --answers <file>         Answers JSON for claudex spec (batch mode)
  --previous <spec.json>   Previous SpecPack JSON for section-level diff
  --spec <spec.json>       Frozen SpecPack context for run/race/create/convergence
  --json                   Machine-readable JSON output
`;

const MODES = new Set<ModeKind>([
  "ask",
  "agent",
  "best_of_n",
  "max_attempts",
  "until_clean",
  "plan",
  "create",
  "readonly_audit",
  "benchmark",
]);

/** Accept hyphenated spellings for canonical ids (until-clean, max-attempts). */
function normalizeMode(s: string): ModeKind {
  const normalized = s.trim().replace(/-/g, "_");
  const parsed = ModeKindSchema.safeParse(normalized);
  if (!parsed.success) return normalized as ModeKind;
  return parsed.data;
}

function harnessList(args: ParsedArgs): string[] | undefined {
  const h = flagStr(args, "harness");
  return h ? h.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
}

function intFlag(args: ParsedArgs, key: string): number | undefined {
  const v = flagStr(args, key);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function floatFlag(args: ParsedArgs, key: string): number | undefined {
  const v = flagStr(args, key);
  if (v === undefined) return undefined;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Deterministic gate commands from `--test "<cmd>"`; multiple via `;;` separator. */
function testCommands(args: ParsedArgs): string[] | undefined {
  const v = flagStr(args, "test");
  if (v === undefined) return undefined;
  return v.split(";;").map((s) => s.trim()).filter(Boolean);
}

const ACCESS_PROFILES = new Set(["readonly", "workspace_write", "full", "external_sandbox_full", "inherit_native"]);

/** Access profile from `--access`; ignored (undefined) if not a known profile. */
function accessProfile(args: ParsedArgs): "readonly" | "workspace_write" | "full" | "external_sandbox_full" | "inherit_native" | undefined {
  const v = flagStr(args, "access");
  return v && ACCESS_PROFILES.has(v) ? (v as never) : undefined;
}

/** Per-family reviewer model map from `--reviewer-model "openai=gpt-4o-mini,anthropic=claude-haiku"`. */
function reviewerModels(args: ParsedArgs): Record<string, string> | undefined {
  const v = flagStr(args, "reviewer-model");
  if (v === undefined) return undefined;
  const map: Record<string, string> = {};
  for (const pair of v.split(",")) {
    const [family, model] = pair.split("=").map((s) => s.trim());
    if (family && model) map[family] = model;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

async function orchestrate(args: ParsedArgs, mode: ModeKind, json: boolean): Promise<number> {
  const rawPrompt = args._.slice(1).join(" ").trim();
  const specPath = flagStr(args, "spec");
  const spec = specPath ? SpecPackSchema.parse(JSON.parse(readFileSync(specPath, "utf8"))) : null;
  const prompt = spec
    ? [
        rawPrompt || spec.intent.raw,
        "",
        "Use this frozen Claudex SpecPack as the contract. Do not re-litigate settled choices; implement against the acceptance criteria and tests.",
        "",
        `Spec id: ${spec.id} v${spec.version}`,
        `Spec hash: ${hashJson(spec)}`,
        "",
        "## Summary",
        spec.summary || "(none)",
        "",
        "## Acceptance Criteria",
        ...(spec.success_criteria.length ? spec.success_criteria.map((c) => `- [${c.id}] ${c.behavior}`) : ["- (none)"]),
        "",
        "## Non-goals",
        ...(spec.non_goals.length ? spec.non_goals.map((x) => `- ${x}`) : ["- (none)"]),
        "",
        "## Forbidden approaches",
        ...(spec.forbidden_approaches.length ? spec.forbidden_approaches.map((x) => `- ${x}`) : ["- (none)"]),
      ].join("\n")
    : rawPrompt;
  if (!prompt && mode !== "readonly_audit") {
    process.stderr.write('claudex: missing prompt\n');
    return 2;
  }
  const maxUsdRaw = floatFlag(args, "max-usd");
  const maxUsd = maxUsdRaw !== undefined && maxUsdRaw >= 0 ? maxUsdRaw : undefined;
  const portfolioRaw = flagStr(args, "portfolio");
  const portfolio = portfolioRaw !== undefined ? Portfolio.safeParse(portfolioRaw) : null;
  if (portfolioRaw !== undefined && !portfolio?.success) {
    process.stderr.write(`claudex: unknown --portfolio '${portfolioRaw}'\n`);
    return 2;
  }
  const orch = new Orchestrator({
    registry: buildRegistry(),
    portfolio: portfolio?.success ? portfolio.data : undefined,
    maxUsd: maxUsd ?? null,
    reviewerModels: reviewerModels(args),
  });
  try {
    const res = await orch.run({
      repoRoot: process.cwd(),
      prompt: prompt || "audit this repository",
      mode,
      harnesses: harnessList(args),
      primaryHarness: flagStr(args, "primary-harness"),
      portfolio: portfolio?.success ? portfolio.data : undefined,
      n: intFlag(args, "n"),
      attempts: intFlag(args, "attempts") ?? null,
      tests: testCommands(args) ?? spec?.tests.map((t) => t.command),
      maxUsd: maxUsd ?? null,
      access: accessProfile(args),
      model: flagStr(args, "model"),
      inPlace: flagBool(args, "in-place"),
    });
    if (json) {
      printJson(res);
    } else {
      print(`run ${res.runId} [${res.status}] mode=${res.mode} winner=${res.winner ?? "none"}`);
      print(`  artifacts: ${res.runDir}`);
      for (const c of res.candidates) print(`  - ${c.attemptId} ${c.harnessId} [${c.status}]`);
      print("");
      print(res.summary);
    }
    return res.status === "success" ? 0 : 1;
  } catch (err) {
    process.stderr.write(`claudex: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function specCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const prompt = args._.slice(1).join(" ").trim();
  if (!prompt) {
    process.stderr.write("claudex: missing spec prompt\n");
    return 2;
  }
  const answersPath = flagStr(args, "answers");
  try {
    const answers = answersPath ? readAnswers(answersPath) : null;
    let planRunId = answers?.planRunId ?? "";
    let planDir = answers?.planDir ?? "";
    let planText = planDir ? (readTextSafe(join(planDir, "final", "plan.md")) ?? "") : "";

    if (!planText) {
      if (answersPath) {
        throw new Error("answers file does not contain a usable planDir/final/plan.md; re-run without --answers to generate a fresh questions file");
      }
      const orch = new Orchestrator({
        registry: buildRegistry(),
        reviewerModels: reviewerModels(args),
      });
      const plan = await orch.run({
        repoRoot: process.cwd(),
        prompt,
        mode: "plan",
        harnesses: harnessList(args),
        n: intFlag(args, "n"),
        access: "readonly",
      });
      planRunId = plan.runId;
      planDir = plan.runDir;
      planText = readTextSafe(join(plan.runDir, "final", "plan.md")) ?? plan.summary;
    }

    const questions = extractQuestionsFromPlan(planText);

    if (!answersPath) {
      const draftDir = join(process.cwd(), ".claudex", "specs", "drafts", planRunId);
      ensureDir(draftDir);
      const questionsPath = join(draftDir, "questions.json");
      writeJson(questionsPath, { prompt, planRunId, planDir, questions, answers: [] });
      const result: SpecCommandResult = {
        status: "questions",
        planRunId,
        planDir,
        questionsPath,
        questions,
      };
      if (json) printJson(result);
      else {
        print(`plan grounding run: ${planRunId}`);
        print(`questions: ${questionsPath}`);
        print(`answer with: claudex spec ${JSON.stringify(prompt)} --answers ${questionsPath}${harnessList(args) ? ` --harness ${(harnessList(args) ?? []).join(",")}` : ""}`);
      }
      return 0;
    }

    const spec = await freezeSpecFromGrounding(prompt, planText, answers ?? readAnswers(answersPath));
    const persisted = persistSpec(process.cwd(), spec, planText, loadPreviousSpec(flagStr(args, "previous")));
    const specJsonPath = join(persisted.specDir, "spec.json");
    const runHint = `claudex race --spec ${JSON.stringify(specJsonPath)}`;
    const result: SpecCommandResult = {
      status: "frozen",
      planRunId,
      planDir,
      specId: spec.id,
      specDir: persisted.specDir,
      specHash: persisted.specHash,
      runHint,
      questions,
      changes: persisted.changes,
    };
    if (json) printJson(result);
    else {
      print(`frozen SpecPack: ${spec.id} v${spec.version}`);
      print(`  dir: ${persisted.specDir}`);
      print(`  hash: ${persisted.specHash}`);
      print(`  native projection: ${join(persisted.specDir, "PLANS.md")}`);
      print(`run: ${runHint}`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`claudex spec: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

function print(s: string): void {
  process.stdout.write(s + "\n");
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function statusGlyph(status: string): string {
  return status === "ok" ? "[ok]" : status === "degraded" ? "[degraded]" : "[unavailable]";
}

async function daemonCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const sub = args._[1] ?? "status";
  if (sub === "start") {
    const daemonScript = fileURLToPath(new URL("./claudexd.js", import.meta.url));
    const child = spawn(process.execPath, [daemonScript], { detached: true, stdio: "ignore" });
    child.unref();
    print(`claudexd starting (pid ${child.pid}); socket ${defaultSocketPath()}`);
    return 0;
  }
  const token = readToken();
  if (!token) {
    print("daemon not initialized — run: claudex daemon start");
    return 1;
  }
  const client = new DaemonClient(defaultSocketPath(), token);
  try {
    if (sub === "status") {
      const health = await client.health();
      if (json) printJson(health);
      else print(`claudexd: ${JSON.stringify(health)}`);
      return 0;
    }
    if (sub === "stop") {
      await client.shutdown();
      print("claudexd shutting down");
      return 0;
    }
    if (sub === "logs") {
      print(readFileSync(logPath(), "utf8").split("\n").slice(-40).join("\n"));
      return 0;
    }
    print("usage: claudex daemon start|status|stop|logs");
    return 2;
  } catch (err) {
    print(`claudexd not reachable (${err instanceof Error ? err.message : String(err)})`);
    return 1;
  }
}

async function settingsCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const sub = args._[1] ?? "show";
  if (sub === "show") {
    const cfg = loadConfig(process.cwd());
    if (json) printJson(cfg);
    else {
      print(`sources: ${cfg.sources.length ? cfg.sources.join(", ") : "(defaults)"}`);
      print(`default_portfolio: ${cfg.global.default_portfolio}`);
      print(`routing.default_policy: ${cfg.global.routing.default_policy}`);
      print(`routing.primary_harness: ${cfg.global.routing.primary_harness ?? "(none)"}`);
      print(`routing.eligible_harnesses: ${cfg.global.routing.eligible_harnesses.length ? cfg.global.routing.eligible_harnesses.join(", ") : "(auto)"}`);
      print(`routing.default_model: ${cfg.global.routing.default_model ?? "(none)"}`);
      print(`routing.env_inheritance: ${cfg.global.routing.env_inheritance}`);
      print(`budget.max_usd_per_run: ${cfg.global.budget.max_usd_per_run ?? "(none)"}`);
      print(`budget.max_usd_per_day: ${cfg.global.budget.max_usd_per_day ?? "(none)"}`);
    }
    return 0;
  }
  if (sub === "set") {
    const key = args._[2];
    const value = args._[3];
    if (!key || value === undefined) {
      print("usage: claudex settings set default_portfolio|primary_harness|eligible_harnesses|default_model|env_inheritance|routing_policy|budget_max_usd_per_run|budget_max_usd_per_day <value>");
      return 2;
    }
    try {
      const res = updateGlobalConfig((cfg) => {
        if (key === "default_portfolio") {
          const p = Portfolio.parse(value);
          return { ...cfg, default_portfolio: p };
        }
        if (key === "primary_harness") {
          return { ...cfg, routing: { ...cfg.routing, primary_harness: value === "none" ? null : value } };
        }
        if (key === "eligible_harnesses") {
          const list = value === "none" ? [] : value.split(",").map((s) => s.trim()).filter(Boolean);
          return { ...cfg, routing: { ...cfg.routing, eligible_harnesses: list } };
        }
        if (key === "default_model") {
          return { ...cfg, routing: { ...cfg.routing, default_model: value === "none" ? null : value } };
        }
        if (key === "env_inheritance") {
          if (!["mirror_native", "clean", "profile_only"].includes(value)) throw new Error("env_inheritance must be mirror_native|clean|profile_only");
          return { ...cfg, routing: { ...cfg.routing, env_inheritance: value as never } };
        }
        if (key === "routing_policy") {
          if (!["auto", "primary", "portfolio"].includes(value)) throw new Error("routing_policy must be auto|primary|portfolio");
          return { ...cfg, routing: { ...cfg.routing, default_policy: value as never } };
        }
        if (key === "budget_max_usd_per_run" || key === "budget_max_usd_per_day") {
          const parsed = value === "none" ? null : Number.parseFloat(value);
          if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) throw new Error(`${key} must be a non-negative number or none`);
          return {
            ...cfg,
            budget: {
              ...cfg.budget,
              [key === "budget_max_usd_per_run" ? "max_usd_per_run" : "max_usd_per_day"]: parsed,
            },
          };
        }
        throw new Error(`unknown setting: ${key}`);
      });
      if (json) printJson(res);
      else print(`updated ${key} in ${res.path}`);
      return 0;
    } catch (err) {
      process.stderr.write(`claudex settings: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  print("usage: claudex settings show|set");
  return 2;
}

async function authCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const sub = args._[1] ?? "status";
  const harness = args._[2];
  if (sub === "status") {
    const gateway = buildGateway({ includeFakes: flagBool(args, "all") });
    const statuses = await gateway.statusAll({ cwd: process.cwd() });
    const filtered = harness ? statuses.filter((s) => s.id === harness) : statuses;
    if (json) {
      printJson({ harnesses: filtered });
      return 0;
    }
    for (const s of filtered) {
      const modes = s.manifest?.auth_modes?.join(", ") || "unknown";
      print(`${statusGlyph(s.status)} ${s.id} auth=${modes}`);
      if (s.reasons.length) print(`    reasons: ${s.reasons.join(", ")}`);
    }
    return 0;
  }
  if (sub === "login") {
    if (!harness) {
      print("usage: claudex auth login <codex|claude|cursor|opencode>");
      return 2;
    }
    const hints: Record<string, string> = {
      codex: "Run the native Codex login flow, or store an API key ref with: claudex secrets set openai --from-env OPENAI_API_KEY",
      claude: "Run the native Claude Code login flow, or store an API key ref with: claudex secrets set anthropic --from-env ANTHROPIC_API_KEY",
      cursor: "Sign in through Cursor, then let Claudex mirror the native session.",
      opencode: "Run the native OpenCode auth flow, or store the provider key as a secret ref.",
    };
    print(hints[harness] ?? `Run the native ${harness} auth flow, then retry: claudex auth status ${harness}`);
    return 0;
  }
  print("usage: claudex auth status|login");
  return 2;
}

async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function secretsCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const sub = args._[1] ?? "list";
  const store = new SecretStore();
  if (sub === "list") {
    const secrets = store.list();
    if (json) printJson({ backend: store.resolvedBackend(), secrets });
    else {
      if (secrets.length === 0) print(`no stored secrets (${store.resolvedBackend()})`);
      for (const s of secrets) print(`${s.name} [${s.backend}]`);
    }
    return 0;
  }
  if (sub === "set") {
    const name = args._[2];
    if (!name) {
      print("usage: claudex secrets set <name> --from-env <ENV_VAR>  # or pipe value on stdin");
      return 2;
    }
    if (!isManagedSecretName(name)) {
      print("secret name must be openai, anthropic, cursor, opencode, or raw");
      return 2;
    }
    const envVar = flagStr(args, "from-env");
    const value = envVar ? process.env[envVar] : process.stdin.isTTY ? "" : await stdinText();
    if (!value) {
      print("secret value required via --from-env or stdin; values are not accepted as positional args");
      return 2;
    }
    store.set(name, value);
    if (json) printJson({ name, backend: store.resolvedBackend(), stored: true });
    else print(`stored ${name} in ${store.resolvedBackend()}`);
    return 0;
  }
  if (sub === "delete" || sub === "rm") {
    const name = args._[2];
    if (!name) {
      print("usage: claudex secrets delete <name>");
      return 2;
    }
    if (!isManagedSecretName(name)) {
      print("secret name must be openai, anthropic, cursor, opencode, or raw");
      return 2;
    }
    store.delete(name);
    if (json) printJson({ name, deleted: true });
    else print(`deleted ${name}`);
    return 0;
  }
  print("usage: claudex secrets list|set|delete");
  return 2;
}

const MANAGED_SECRET_NAMES = new Set(["openai", "anthropic", "cursor", "opencode", "raw"]);

function isManagedSecretName(name: string): boolean {
  return MANAGED_SECRET_NAMES.has(name);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const json = flagBool(args, "json");
  const cmd = args._[0] ?? "help";
  const cwd = process.cwd();

  switch (cmd) {
    case "init": {
      const res = initProjectConfig(cwd);
      if (json) printJson(res);
      else print(res.created ? `Created ${res.configPath}` : `Config already exists: ${res.configPath}`);
      return 0;
    }

    case "doctor": {
      const gateway = buildGateway({ includeFakes: flagBool(args, "all") });
      const statuses = await gateway.statusAll({ cwd });
      const only = flagStr(args, "harness");
      const filtered = only ? statuses.filter((s) => s.id === only) : statuses;
      if (json) {
        printJson({ harnesses: filtered });
        return 0;
      }
      for (const s of filtered) {
        const ver = s.manifest?.version ? ` ${s.manifest.version}` : "";
        print(`${statusGlyph(s.status)} ${s.id}${ver}`);
        if (s.enabledIntents.length) print(`    intents: ${s.enabledIntents.join(", ")}`);
        if (s.reasons.length) print(`    reasons: ${s.reasons.join(", ")}`);
      }
      return 0;
    }

    case "run": {
      const modeStr = flagStr(args, "mode");
      if (modeStr !== undefined) {
        const mode = normalizeMode(modeStr);
        if (!MODES.has(mode)) {
          process.stderr.write(`claudex: unknown --mode '${modeStr}'. valid: ${[...MODES].join(", ")}\n`);
          return 2;
        }
        if ((mode === "agent" || mode === "ask") && flagStr(args, "spec")) {
          process.stderr.write("claudex: --spec requires a gated mode; use 'claudex race --spec <file>' or 'claudex run --mode max-attempts --spec <file>'\n");
          return 2;
        }
        return orchestrate(args, mode, json);
      }
      if (flagStr(args, "spec")) {
        process.stderr.write("claudex: --spec requires an explicit gated mode; use 'claudex race --spec <file>' or 'claudex run --mode max-attempts --spec <file>'\n");
        return 2;
      }
      return orchestrate(args, "agent", json);
    }

    case "ask":
      return orchestrate(args, "ask", json);

    case "race":
      return orchestrate(args, "best_of_n", json);

    case "plan":
      return orchestrate(args, "plan", json);

    case "spec":
      return specCommand(args, json);

    case "create":
      return orchestrate(args, "create", json);

    case "audit":
    case "map":
      return orchestrate(args, "readonly_audit", json);

    case "daemon":
      return daemonCommand(args, json);

    case "settings":
      return settingsCommand(args, json);

    case "auth":
      return authCommand(args, json);

    case "secrets":
      return secretsCommand(args, json);

    case "mcp": {
      if (args._[1] === "serve") {
        await new McpServer({
          tools: defaultClaudexTools(orchestratorRunner()),
          transport: { read: process.stdin, write: process.stdout },
        }).serve();
        return 0;
      }
      print("usage: claudex mcp serve");
      return 2;
    }

    case "acp": {
      if (args._[1] === "serve") {
        await new AcpServer({
          runner: orchestratorRunner(),
          transport: { read: process.stdin, write: process.stdout },
        }).serve();
        return 0;
      }
      print("usage: claudex acp serve");
      return 2;
    }

    case "bench": {
      const sub = args._[1];
      if (sub === "list") {
        print("swe-bench-verified [implemented]  (end-to-end: benchmarks/swe-bench/)");
        print("terminal-bench-2.1 [harbor]       (benchmarks/terminal_bench/ — Harbor suite)");
        print("osworld [scaffold]");
        print("programbench [scaffold]");
        return 0;
      }
      if (sub === "instructions") {
        print(SWE_BENCH_EVAL_INSTRUCTIONS);
        return 0;
      }
      if (sub === "run") {
        const name = args._[2] ?? "swe-bench";
        if (!name.startsWith("swe")) {
          print(`${name} is scaffolded; see 'claudex bench list'`);
          return 2;
        }
        const tasksFile = flagStr(args, "tasks");
        const out = flagStr(args, "predictions") ?? "predictions.json";
        const workdir = flagStr(args, "workdir");
        if (!tasksFile) {
          print("usage: claudex bench run swe-bench --tasks <tasks.jsonl> --predictions <out.json> [--workdir <dir>]");
          return 2;
        }
        const tasks = loadTasksFromJsonl(tasksFile);
        if (!workdir) {
          writePredictions(
            tasks.map((t) => ({ instance_id: t.instance_id, model_name_or_path: "claudex", model_patch: "" })),
            out,
          );
          print(`wrote ${tasks.length} skeleton predictions to ${out}`);
          print("(no --workdir: prepare per-instance repos at <workdir>/<instance_id> to actually solve.)");
          print(SWE_BENCH_EVAL_INSTRUCTIONS);
          return 0;
        }
        const benchMaxUsd = floatFlag(args, "max-usd");
        const orch = new Orchestrator({
          registry: buildRegistry(),
          portfolio: "benchmark",
          maxUsd: benchMaxUsd ?? null,
          reviewerModels: reviewerModels(args),
        });
        const res = await runBenchmark(
          tasks,
          async (t) => {
            const r = await orch.run({
              repoRoot: join(workdir, t.instance_id),
              prompt: t.problem_statement,
              mode: "benchmark",
              n: intFlag(args, "n") ?? 1,
              maxUsd: benchMaxUsd ?? null,
            });
            let patch = "";
            try {
              patch = readFileSync(join(r.runDir, "final", "patch.diff"), "utf8");
            } catch {
              patch = "";
            }
            return { patch };
          },
          { predictionsPath: out, modelName: "claudex" },
        );
        print(`wrote ${res.predictions.length} predictions to ${out}`);
        print(SWE_BENCH_EVAL_INSTRUCTIONS);
        return 0;
      }
      print("usage: claudex bench list|instructions|run");
      return 2;
    }

    case "inspect": {
      const runId = args._[1];
      if (!runId) {
        print("usage: claudex inspect <run_id>");
        return 2;
      }
      const store = new ArtifactStore(process.cwd());
      const paths = store.runPaths(runId);
      const decision = store.readYaml(join(paths.arbitrationDir, "decision.yaml"));
      const workProduct = store.readYaml(join(paths.finalDir, "work_product.yaml"));
      if (json) {
        printJson({ runId, runDir: paths.root, decision, work_product: workProduct });
        return decision || workProduct ? 0 : 1;
      }
      const summary = readTextSafe(join(paths.finalDir, "summary.md"));
      print(`run ${runId} @ ${paths.root}`);
      print(summary ?? "(no summary — run may not exist)");
      return summary ? 0 : 1;
    }

    case "apply": {
      const runId = args._[1];
      if (!runId) {
        print("usage: claudex apply <run_id> [--mode apply|commit|branch|pr] [--dry-run]");
        return 2;
      }
      const store = new ArtifactStore(process.cwd());
      const paths = store.runPaths(runId);
      const patch = readTextSafe(join(paths.finalDir, "patch.diff"));
      if (!patch || patch.trim().length === 0) {
        print(`no patch found for run ${runId}`);
        return 1;
      }
      if (containsSecretLikeToken(patch)) {
        print("patch contains secret-like token; refusing apply");
        return 1;
      }
      const decision = DecisionRecord.safeParse(store.readYaml(join(paths.arbitrationDir, "decision.yaml")));
      if (!decision.success) {
        print("decision record is required before apply");
        return 1;
      }
      if (decision.data.status !== "success") {
        print(`decision status is ${decision.data.status}; refusing apply`);
        return 1;
      }
      const workProduct = WorkProduct.safeParse(store.readYaml(join(paths.finalDir, "work_product.yaml")));
      if (!workProduct.success) {
        print("work product is required before apply");
        return 1;
      }
      if (workProduct.data.kind !== "patch") {
        print(`work product kind ${workProduct.data.kind} is not applyable as a patch`);
        return 1;
      }
      const recordedPatchHash = workProduct.data.meta["patch_sha256"];
      if (typeof recordedPatchHash !== "string" || recordedPatchHash.length === 0) {
        print("work product patch hash is required before apply");
        return 1;
      }
      if (recordedPatchHash !== sha256(patch)) {
        print("patch artifact hash does not match the reviewed work product");
        return 1;
      }
      const contract = TaskContract.safeParse(store.readYaml(join(paths.contextDir, "task.yaml")));
      if (!contract.success) {
        print("task contract is required before apply");
        return 1;
      }
      try {
        if (realpathSync(contract.data.repo.root) !== realpathSync(process.cwd())) {
          print("current repo does not match the run's original project; refusing apply");
          return 1;
        }
      } catch {
        print("run original project cannot be verified; refusing apply");
        return 1;
      }
      if (flagBool(args, "dry-run")) {
        const r = await checkPatch(process.cwd(), patch);
        print(r.ok ? "patch applies cleanly" : `patch does not apply: ${r.stderr.trim()}`);
        return r.ok ? 0 : 1;
      }
      const mode = (flagStr(args, "mode") ?? "apply") as DeliverMode;
      const res = await deliver(process.cwd(), patch, { mode, message: `claudex: apply ${runId}` });
      if (json) printJson(res);
      else
        print(
          `${res.mode}: applied=${res.applied}` +
            (res.commit ? ` commit=${res.commit.slice(0, 8)}` : "") +
            (res.branch ? ` branch=${res.branch}` : "") +
            (res.detail ? ` (${res.detail})` : ""),
        );
      return res.applied || res.mode === "artifact_only" ? 0 : 1;
    }

    case "release": {
      if (args._[1] === "check-name") {
        const name = args._[2] ?? "claudex";
        const checks = await checkName(name);
        if (json) printJson({ name, checks });
        else {
          print(`naming gate for "${name}":`);
          for (const c of checks) print(`  ${c.available ? "[free] " : "[taken]"} ${c.registry}: ${c.detail}`);
        }
        return 0;
      }
      print("usage: claudex release check-name <name>");
      return 2;
    }

    case "plugin": {
      const sub = args._[1];
      const host = args._[2] as PluginHost | undefined;
      if (sub === "install" && host) {
        const r = installPlugin(host);
        if (json) printJson(r);
        else {
          print(`installed claudex plugin for ${host}: ${r.path}`);
          print(`  ${r.note}`);
        }
        return 0;
      }
      print("usage: claudex plugin install <cursor|claude|codex|opencode>");
      return 2;
    }

    case "harness": {
      const sub = args._[1];
      if (sub === "list") {
        const ids = [...buildRegistry().keys()];
        if (json) printJson({ harnesses: ids });
        else ids.forEach((id) => print(id));
        return 0;
      }
      print("usage: claudex harness list");
      return 2;
    }

    case "help":
    default:
      print(HELP);
      return 0;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`claudex: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
