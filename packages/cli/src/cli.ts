#!/usr/bin/env node
import process from "node:process";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "@claudexor/orchestrator";
import { ArtifactStore } from "@claudexor/artifact-store";
import { DELIVER_MODES, type DeliverMode, checkPatch, deliver, validateApplyGate } from "@claudexor/delivery";
import { assertNoInlineSecretValues, containsSecretLikeToken, ensureDir, hashJson, noProjectRepoRoot, readTextSafe, sha256, userConfigDir, writeJson } from "@claudexor/util";
import { checkName } from "./release.js";
import { DaemonClient, defaultSocketPath, logPath, readToken } from "@claudexor/daemon";
import { McpServer, defaultClaudexorTools } from "@claudexor/mcp-server";
import { AcpServer } from "@claudexor/acp-server";
import { initProjectConfig, loadConfig, updateGlobalConfig } from "@claudexor/config";
import { SecretStore } from "@claudexor/secrets";
import {
  DecisionRecord,
  EffortHint,
  ExternalContextPolicy,
  ModeKind as ModeKindSchema,
  Portfolio,
  type ModeKind,
  SpecPack as SpecPackSchema,
  RunTelemetry,
  TaskContract,
  WorkProduct,
} from "@claudexor/schema";
import { flagBool, flagStr, parseArgs, type ParsedArgs } from "./args.js";
import { followRun, formatRunEventLine, promptQuestionsOnTty } from "./live.js";
import { PLUGIN_HOSTS, type PluginHost, installPlugin } from "./plugins.js";
import { buildGateway, buildRegistry } from "./registry.js";
import {
  extractQuestionsFromPlan,
  freezeSpecFromGrounding,
  loadPreviousSpec,
  persistSpec,
  readAnswers,
  type SpecCommandResult,
} from "./spec.js";
import { parseReviewerEffortMap } from "./reviewer-options.js";
import { runRepl } from "./repl.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
function orchestratorRunner() {
  const orch = new Orchestrator({ registry: buildRegistry() });
  return async (p: any, hooks?: { onEvent?: (event: any) => void; onInteraction?: (ctx: any) => Promise<any | null>; signal?: AbortSignal }) => {
    if (p?.mode === "__status") {
      // Doctor-backed truth (probe-cheap): fakes and unavailable harnesses are
      // never presented as available tools to an MCP host.
      const statuses = await buildGateway({ includeFakes: false }).statusAll({ cwd: process.cwd() });
      return {
        harnesses: statuses.map((s) => ({ id: s.id, status: s.status, intents: s.enabledIntents })),
        available: statuses.filter((s) => s.status === "ok").map((s) => s.id),
      };
    }
    return orch.run({
      repoRoot: typeof p?.repoPath === "string" && p.repoPath.trim() ? p.repoPath : process.cwd(),
      prompt: String(p?.prompt ?? ""),
      mode: p?.mode ?? "agent",
      harnesses: p?.harness ? [String(p.harness)] : undefined,
      primaryHarness: p?.primaryHarness ? String(p.primaryHarness) : undefined,
      web: p?.web ? ExternalContextPolicy.parse(String(p.web)) : undefined,
      externalContextPolicy: p?.externalContextPolicy ? ExternalContextPolicy.parse(String(p.externalContextPolicy)) : undefined,
      model: p?.model ? String(p.model) : undefined,
      effort: p?.effort ? EffortHint.parse(String(p.effort)) : undefined,
      n: typeof p?.n === "number" ? p.n : p?.race === true ? 2 : undefined,
      untilClean: p?.untilClean === true,
      swarm: p?.swarm === true,
      create: p?.create === true,
      onEvent: hooks?.onEvent,
      onInteraction: hooks?.onInteraction,
      signal: hooks?.signal,
    });
  };
}

// Version is read from the package manifest so the banner can never ship stale.
const CLI_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "dev";
  } catch {
    return "dev";
  }
})();

const HELP = `claudexor — harness-agnostic AI coding control plane (v${CLI_VERSION})

Usage:
  claudexor init                          Scaffold repo-local config (.claudexor/config.yaml)
  claudexor doctor [--harness <id>] [--all]   Detect + conformance-test harnesses
  claudexor ask "<question>" [opts]       Read-only answer/explanation route
  claudexor run "<prompt>" [opts]         Run a task (default mode: agent)
  claudexor race "<prompt>" [--n N]       Best-of-N race (agent --n) with cross-family review
  claudexor plan "<prompt>"               Read-only planning report
  claudexor orchestrate "<goal>"          Brain: typed orchestration plan over the tool belt
  claudexor spec "<prompt>" [--answers file]  Multi-harness plan grounding -> quiz -> frozen SpecPack
  claudexor create "<prompt>"             Create-from-scratch (agent --create)
  claudexor audit | map                   Read-only repo audit / map
  claudexor explore "<question>"          Read-only research swarm (audit --swarm)
  claudexor inspect <run_id>              Inspect a run's decision + artifacts
  claudexor follow <run_id> [--json]      Live-tail a daemon run (replay + push; answer questions in the TTY)
  claudexor apply <run_id> [--mode ...]   Apply a run's WorkProduct (apply|commit|branch|pr|--dry-run)
  claudexor settings show|set             Show/update user defaults
  claudexor auth status|login             Inspect native harness auth
  claudexor secrets list|set|delete       Manage stored API-key refs (Keychain/0600 file)
  claudexor release check-name <name>     Naming gate (npm/pypi/crates/github)
  claudexor daemon start|status|stop|logs Optional local daemon (claudexord)
  claudexor mcp serve                     Expose Claudexor as an MCP server (stdio)
  claudexor acp serve                     Expose Claudexor as an ACP agent (stdio)
  claudexor plugin install <host>         Install thin host plugin (cursor|claude|codex|opencode)
  claudexor harness list                  List registered harnesses
  claudexor help                          Show this help

Options:
  --harness <id[,id...]>   Force harness(es)
  --mode <mode>            ask | plan | audit | agent | orchestrate (strategies are flags, not modes)
  --n <N>                  Race width (agent): N isolated candidates + cross-review
  --attempts <N>           Convergence cap (agent): repair loop up to N attempts
  --until-clean            Convergence (agent): iterate until the review/gates are clean
  --swarm                  Research swarm (audit): bounded read-only explorer fan-out
  --create                 Create-from-scratch intent (agent)
  --test "<cmd>"           Deterministic gate command(s); multiple via ';;' separator
  --max-usd <amount>       Hard per-run spend cap (USD)
  --reviewer-model <map>   Per-family reviewer model, e.g. "openai=gpt-4o-mini,anthropic=claude-haiku"
  --reviewer-effort <map>  Per-family reviewer effort, e.g. "anthropic=max"
  --access <profile>       Access profile: readonly|workspace_write|full|external_sandbox_full|inherit_native
  --web <mode>             External web/search policy: off|auto|cached|live
  --model <id>             Model hint forwarded to the selected harness route
  --effort <level>         Reasoning effort hint: low|medium|high|xhigh|max
  --primary-harness <id>   Bias single-route modes and first candidate choice
  --portfolio <id>         Budget/routing portfolio (default: subscription-first)
  --in-place               Explicit stateful adapter path for convergence only
                           (for example Terminal-Bench live containers)
  --answers <file>         Answers JSON for claudexor spec (batch mode)
  --previous <spec.json>   Previous SpecPack JSON for section-level diff
  --spec <spec.json>       Frozen SpecPack context for run/race/create/convergence
  --json                   Machine-readable JSON output
`;

const MODES = new Set<ModeKind>(["ask", "plan", "audit", "agent", "orchestrate"]);

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

/** Invalid numeric flag values FAIL LOUDLY: `--n abc` must never silently run with the default. */
function intFlag(args: ParsedArgs, key: string): number | undefined {
  const v = flagStr(args, key);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || String(n) !== v.trim()) throw new Error(`invalid --${key} '${v}' (expected an integer)`);
  return n;
}

function floatFlag(args: ParsedArgs, key: string): number | undefined {
  const v = flagStr(args, key);
  if (v === undefined) return undefined;
  // Number() parses the WHOLE string ('1abc' -> NaN), unlike parseFloat.
  const n = Number(v.trim());
  if (!Number.isFinite(n) || n < 0 || v.trim() === "") throw new Error(`invalid --${key} '${v}' (expected a non-negative number)`);
  return n;
}

/** Deterministic gate commands from `--test "<cmd>"`; multiple via `;;` separator. */
function testCommands(args: ParsedArgs): string[] | undefined {
  const v = flagStr(args, "test");
  if (v === undefined) return undefined;
  return v.split(";;").map((s) => s.trim()).filter(Boolean);
}

const ACCESS_PROFILES = new Set(["readonly", "workspace_write", "full", "external_sandbox_full", "inherit_native"]);

/** Access profile from `--access`. Invalid profiles FAIL LOUDLY (a typo must never silently run with the default write profile). */
function accessProfile(args: ParsedArgs): "readonly" | "workspace_write" | "full" | "external_sandbox_full" | "inherit_native" | undefined {
  const v = flagStr(args, "access");
  if (v === undefined) return undefined;
  if (!ACCESS_PROFILES.has(v)) {
    throw new Error(`invalid --access '${v}' (expected readonly|workspace_write|full|external_sandbox_full|inherit_native)`);
  }
  return v as never;
}

function effortHint(args: ParsedArgs): EffortHint | undefined {
  const v = flagStr(args, "effort");
  if (v === undefined) return undefined;
  const parsed = EffortHint.safeParse(v);
  if (!parsed.success) throw new Error(`invalid --effort '${v}' (expected low|medium|high|xhigh|max)`);
  return parsed.data;
}

function webPolicy(args: ParsedArgs): "off" | "auto" | "cached" | "live" | undefined {
  const v = flagStr(args, "web");
  if (v === undefined) return undefined;
  const parsed = ExternalContextPolicy.safeParse(v);
  if (!parsed.success) throw new Error(`invalid --web '${v}' (expected off|auto|cached|live)`);
  return parsed.data;
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

/** Per-family reviewer effort map from `--reviewer-effort "openai=xhigh,anthropic=high"`. */
function reviewerEfforts(args: ParsedArgs): Record<string, EffortHint> | undefined {
  return parseReviewerEffortMap(flagStr(args, "reviewer-effort"));
}

async function orchestrate(
  args: ParsedArgs,
  mode: ModeKind,
  json: boolean,
  forced: { swarm?: boolean; create?: boolean; race?: boolean } = {},
): Promise<number> {
  const rawPrompt = args._.slice(1).join(" ").trim();
  const specPath = flagStr(args, "spec");
  const spec = specPath ? SpecPackSchema.parse(JSON.parse(readFileSync(specPath, "utf8"))) : null;
  const prompt = spec
    ? [
        rawPrompt || spec.intent.raw,
        "",
        "Use this frozen Claudexor SpecPack as the contract. Do not re-litigate settled choices; implement against the acceptance criteria and tests.",
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
  if (!prompt && mode !== "audit") {
    process.stderr.write('claudexor: missing prompt\n');
    return 2;
  }
  const portfolioRaw = flagStr(args, "portfolio");
  const portfolio = portfolioRaw !== undefined ? Portfolio.safeParse(portfolioRaw) : null;
  if (portfolioRaw !== undefined && !portfolio?.success) {
    process.stderr.write(`claudexor: unknown --portfolio '${portfolioRaw}'\n`);
    return 2;
  }
  let reviewerEffortOverrides: Partial<Record<"anthropic", EffortHint>> | undefined;
  let resolvedWebPolicy: ReturnType<typeof webPolicy> = undefined;
  let resolvedAccess: ReturnType<typeof accessProfile> = undefined;
  let resolvedEffort: EffortHint | undefined;
  let maxUsd: number | undefined;
  let nFlag: number | undefined;
  let attemptsFlag: number | undefined;
  try {
    reviewerEffortOverrides = reviewerEfforts(args);
    resolvedWebPolicy = webPolicy(args);
    resolvedAccess = accessProfile(args);
    resolvedEffort = effortHint(args);
    maxUsd = floatFlag(args, "max-usd");
    nFlag = intFlag(args, "n");
    attemptsFlag = intFlag(args, "attempts");
  } catch (err) {
    process.stderr.write(`claudexor: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const orch = new Orchestrator({
    registry: buildRegistry(),
    portfolio: portfolio?.success ? portfolio.data : undefined,
    maxUsd: maxUsd ?? null,
    reviewerModels: reviewerModels(args),
    reviewerEfforts: reviewerEffortOverrides,
  });
  try {
    const tests = testCommands(args) ?? spec?.tests.map((t) => t.command);
    assertNoInlineSecretValues({ tests }, "$", "CLI run params");
    const res = await orch.run({
      repoRoot: process.cwd(),
      prompt: prompt || "audit this repository",
      mode,
      harnesses: harnessList(args),
      primaryHarness: flagStr(args, "primary-harness"),
      portfolio: portfolio?.success ? portfolio.data : undefined,
      n: forced.race === true ? (nFlag ?? 2) : nFlag,
      attempts: attemptsFlag ?? null,
      untilClean: flagBool(args, "until-clean"),
      swarm: forced.swarm === true || flagBool(args, "swarm"),
      create: forced.create === true || flagBool(args, "create"),
      tests,
      maxUsd: maxUsd ?? null,
      access: resolvedAccess,
      web: resolvedWebPolicy,
      externalContextPolicy: resolvedWebPolicy,
      model: flagStr(args, "model"),
      effort: resolvedEffort,
      specId: spec?.id,
      specHash: spec ? hashJson(spec) : undefined,
      specPath: specPath ? realpathSync(specPath) : undefined,
      inPlace: flagBool(args, "in-place"),
      // Live progress + interactive answers on a TTY; --json stays a pure
      // machine surface (no printer, no prompts — questions decline benignly).
      ...(json
        ? {}
        : {
            onEvent: (ev) => {
              const line = formatRunEventLine(ev as unknown as Record<string, unknown>);
              if (line) print(line);
            },
            onInteraction: (ctx) => promptQuestionsOnTty(ctx.request.interaction_id, ctx.request.questions, ctx.timeoutAt),
          }),
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
    process.stderr.write(`claudexor: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function specCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const prompt = args._.slice(1).join(" ").trim();
  if (!prompt) {
    process.stderr.write("claudexor: missing spec prompt\n");
    return 2;
  }
  if (containsSecretLikeToken(prompt)) {
    process.stderr.write("claudexor spec: prompt contains a secret-like token; specs are durable artifacts, so store secrets by ref and retry with a sanitized prompt\n");
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
        reviewerEfforts: reviewerEfforts(args),
      });
      const plan = await orch.run({
        repoRoot: process.cwd(),
        prompt,
        mode: "plan",
        harnesses: harnessList(args),
        n: intFlag(args, "n"),
        access: "readonly",
        web: webPolicy(args),
      });
      planRunId = plan.runId;
      planDir = plan.runDir;
      planText = readTextSafe(join(plan.runDir, "final", "plan.md")) ?? plan.summary;
    }

    const questions = extractQuestionsFromPlan(planText);

    if (!answersPath) {
      const draftDir = join(process.cwd(), ".claudexor", "specs", "drafts", planRunId);
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
        print(`answer with: claudexor spec ${JSON.stringify(prompt)} --answers ${questionsPath}${harnessList(args) ? ` --harness ${(harnessList(args) ?? []).join(",")}` : ""}`);
      }
      return 0;
    }

    const spec = await freezeSpecFromGrounding(prompt, planText, answers ?? readAnswers(answersPath));
    const persisted = persistSpec(process.cwd(), spec, planText, loadPreviousSpec(flagStr(args, "previous")));
    const specJsonPath = join(persisted.specDir, "spec.json");
    const runHint = `claudexor race --spec ${JSON.stringify(specJsonPath)}`;
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
    process.stderr.write(`claudexor spec: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

function print(s: string): void {
  process.stdout.write(s + "\n");
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function primaryOutputForCli(root: string, mode?: ModeKind): { kind: string; path: string; text: string } | null {
  const candidates =
    mode === "ask"
      ? [{ kind: "answer", path: "final/answer.md" }]
      : mode === "plan"
        ? [{ kind: "plan", path: "final/plan.md" }]
        : mode === "audit"
          ? [{ kind: "report", path: "final/report.md" }, { kind: "report", path: "final/explore.md" }, { kind: "summary", path: "final/summary.md" }]
          : mode === "orchestrate"
            ? [{ kind: "report", path: "final/orchestration.md" }, { kind: "summary", path: "final/summary.md" }]
            : [{ kind: "summary", path: "final/summary.md" }, { kind: "patch", path: "final/patch.diff" }];
  for (const candidate of candidates) {
    const text = readTextSafe(join(root, candidate.path));
    if (text?.trim()) return { ...candidate, text };
  }
  const failure = readTextSafe(join(root, "final/failure.yaml"));
  return failure?.trim() ? { kind: "diagnostic", path: "final/failure.yaml", text: failure } : null;
}

function listCliArtifacts(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = relative(root, abs).split(sep).join("/");
      const st = lstatSync(abs);
      out.push(st.isDirectory() ? `${rel}/` : rel);
      if (st.isDirectory()) walk(abs);
    }
  };
  walk(root);
  return out.sort();
}

function statusGlyph(status: string): string {
  return status === "ok" ? "[ok]" : status === "degraded" ? "[degraded]" : "[unavailable]";
}

function authSourceAvailability(status: {
  manifest?: {
    auth_modes?: string[];
    capability_profile?: { auth?: { supported_sources?: string[]; preferred_source?: string | null } };
  } | null;
}): string {
  const auth = status.manifest?.capability_profile?.auth;
  const present = status.manifest?.auth_modes?.length ? status.manifest.auth_modes.join(",") : "unknown";
  const supported = auth?.supported_sources?.length ? auth.supported_sources.join(",") : "unknown";
  const preferred = auth?.preferred_source ? ` preferred=${auth.preferred_source}` : "";
  return `present=${present} supported=${supported}${preferred}`;
}

function checksSummary(status: { checks?: { id: string; status: string; detail?: string }[] }): string {
  const checks = status.checks ?? [];
  if (checks.length === 0) return "none";
  return checks.map((c) => `${c.id}:${c.status}`).join(", ");
}

async function daemonCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const sub = args._[1] ?? "status";
  if (sub === "start") {
    const daemonScript = fileURLToPath(new URL("./claudexord.js", import.meta.url));
    const child = spawn(process.execPath, [daemonScript], { detached: true, stdio: "ignore" });
    child.unref();
    print(`claudexord starting (pid ${child.pid}); socket ${defaultSocketPath()}`);
    return 0;
  }
  const token = readToken();
  if (!token) {
    print("daemon not initialized — run: claudexor daemon start");
    return 1;
  }
  const client = new DaemonClient(defaultSocketPath(), token);
  try {
    if (sub === "status") {
      const health = await client.health();
      if (json) printJson(health);
      else print(`claudexord: ${JSON.stringify(health)}`);
      return 0;
    }
    if (sub === "stop") {
      await client.shutdown();
      print("claudexord shutting down");
      return 0;
    }
    if (sub === "logs") {
      print(readFileSync(logPath(), "utf8").split("\n").slice(-40).join("\n"));
      return 0;
    }
    print("usage: claudexor daemon start|status|stop|logs");
    return 2;
  } catch (err) {
    print(`claudexord not reachable (${err instanceof Error ? err.message : String(err)})`);
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
      print(`interaction_timeout_ms: ${cfg.global.interaction_timeout_ms}`);
      const harnessIds = Object.keys(cfg.global.harnesses);
      if (harnessIds.length) {
        print("harnesses:");
        for (const id of harnessIds) {
          const h = cfg.global.harnesses[id]!;
          print(`  ${id}: enabled=${h.enabled} model=${h.default_model ?? "(native)"} effort=${h.effort ?? "(native)"} web=${h.web} max_turns=${h.max_turns ?? "(none)"} max_usd=${h.max_usd ?? "(none)"}`);
        }
      }
    }
    return 0;
  }
  if (sub === "set") {
    const key = args._[2];
    const value = args._[3];
    if (!key || value === undefined) {
      print("usage: claudexor settings set default_portfolio|primary_harness|eligible_harnesses|default_model|env_inheritance|routing_policy|budget_max_usd_per_run|budget_max_usd_per_day|interaction_timeout_ms <value>");
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
          // Number() parses the WHOLE string ('1abc' -> NaN), unlike parseFloat.
          const parsed = value === "none" ? null : Number(value.trim());
          if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0 || value.trim() === "")) throw new Error(`${key} must be a non-negative number or none`);
          return {
            ...cfg,
            budget: {
              ...cfg.budget,
              [key === "budget_max_usd_per_run" ? "max_usd_per_run" : "max_usd_per_day"]: parsed,
            },
          };
        }
        if (key === "interaction_timeout_ms") {
          const parsed = Number(value.trim());
          if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("interaction_timeout_ms must be a positive integer (milliseconds)");
          return { ...cfg, interaction_timeout_ms: parsed };
        }
        throw new Error(`unknown setting: ${key}`);
      });
      if (json) printJson(res);
      else print(`updated ${key} in ${res.path}`);
      return 0;
    } catch (err) {
      process.stderr.write(`claudexor settings: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  print("usage: claudexor settings show|set");
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
      print(`${statusGlyph(s.status)} ${s.id} ready=${s.status} sources=${authSourceAvailability(s)}`);
      print(`    checks: ${checksSummary(s)}`);
      if (s.reasons.length) print(`    reasons: ${s.reasons.join(", ")}`);
    }
    return 0;
  }
  if (sub === "login") {
    if (!harness) {
      print("usage: claudexor auth login <codex|claude|cursor|opencode>");
      return 2;
    }
    const hints: Record<string, string> = {
      codex: "Run the native Codex login flow, or store an API key ref with: claudexor secrets set openai --from-env OPENAI_API_KEY",
      claude: "Run the native Claude Code login flow, or store an API key ref with: claudexor secrets set anthropic --from-env ANTHROPIC_API_KEY",
      cursor: "Sign in through Cursor, then let Claudexor mirror the native session.",
      opencode: "Run the native OpenCode auth flow, or store the provider key as a secret ref.",
    };
    print(hints[harness] ?? `Run the native ${harness} auth flow, then retry: claudexor auth status ${harness}`);
    return 0;
  }
  print("usage: claudexor auth status|login");
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
      print("usage: claudexor secrets set <name> --from-env <ENV_VAR>  # or pipe value on stdin");
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
    const backend = store.set(name, value);
    const warning = store.lastFallbackReason;
    if (json) printJson({ name, backend, stored: true, ...(warning ? { warning } : {}) });
    else {
      print(`stored ${name} in ${backend}`);
      if (warning) print(`warning: ${warning}`);
    }
    return 0;
  }
  if (sub === "delete" || sub === "rm") {
    const name = args._[2];
    if (!name) {
      print("usage: claudexor secrets delete <name>");
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
  print("usage: claudexor secrets list|set|delete");
  return 2;
}

const MANAGED_SECRET_NAMES = new Set(["openai", "anthropic", "cursor", "opencode", "raw"]);

function isManagedSecretName(name: string): boolean {
  return MANAGED_SECRET_NAMES.has(name);
}

/** Every flag any command accepts. Unknown flags FAIL LOUDLY: `--harnes codex` must never silently run all harnesses. */
const KNOWN_FLAGS = new Set([
  "harness", "mode", "n", "attempts", "until-clean", "swarm", "create",
  "test", "max-usd", "reviewer-model", "reviewer-effort",
  "access", "web", "model", "effort", "primary-harness", "portfolio", "in-place",
  "answers", "previous", "spec", "json", "all", "dry-run", "from-env",
  "help", "version",
]);

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  // --version / --help are standard CLI affordances, not unknown flags.
  if (flagBool(args, "version")) {
    process.stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }
  if (flagBool(args, "help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const unknownFlags = Object.keys(args.flags).filter((f) => !KNOWN_FLAGS.has(f));
  if (unknownFlags.length > 0) {
    process.stderr.write(`claudexor: unknown flag(s): ${unknownFlags.map((f) => `--${f}`).join(", ")} (see \`claudexor help\`)\n`);
    return 2;
  }
  const json = flagBool(args, "json");
  // No arguments at all = the interactive REPL: a thread of turns over the
  // current project with native session continuity (chat is the normal loop).
  if (args._.length === 0 && process.stdin.isTTY) {
    return runRepl(process.cwd());
  }
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
        print(`    auth sources: ${authSourceAvailability(s)}`);
        print(`    checks: ${checksSummary(s)}`);
        if (s.reasons.length) print(`    reasons: ${s.reasons.join(", ")}`);
      }
      return 0;
    }

    case "run": {
      const modeStr = flagStr(args, "mode");
      if (modeStr !== undefined) {
        const mode = normalizeMode(modeStr);
        if (!MODES.has(mode)) {
          process.stderr.write(`claudexor: unknown --mode '${modeStr}'. valid: ${[...MODES].join(", ")}\n`);
          return 2;
        }
        if ((mode === "ask" || mode === "audit") && flagStr(args, "spec")) {
          process.stderr.write("claudexor: --spec requires a gated strategy; use 'claudexor race --spec <file>' or 'claudexor run --attempts N --spec <file>'\n");
          return 2;
        }
        return orchestrate(args, mode, json);
      }
      if (flagStr(args, "spec") && !flagBool(args, "until-clean") && intFlag(args, "attempts") === undefined && intFlag(args, "n") === undefined) {
        process.stderr.write("claudexor: --spec requires a gated strategy; use 'claudexor race --spec <file>' or 'claudexor run --attempts N --spec <file>'\n");
        return 2;
      }
      return orchestrate(args, "agent", json);
    }

    case "ask":
      return orchestrate(args, "ask", json);

    case "explore":
      return orchestrate(args, "audit", json, { swarm: true });

    case "race":
      return orchestrate(args, "agent", json, { race: true });

    case "orchestrate":
      return orchestrate(args, "orchestrate", json);

    case "plan":
      return orchestrate(args, "plan", json);

    case "spec":
      return specCommand(args, json);

    case "create":
      return orchestrate(args, "agent", json, { create: true });

    case "audit":
    case "map":
      return orchestrate(args, "audit", json);

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
          tools: defaultClaudexorTools(orchestratorRunner()),
          transport: { read: process.stdin, write: process.stdout },
        }).serve();
        return 0;
      }
      print("usage: claudexor mcp serve");
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
      print("usage: claudexor acp serve");
      return 2;
    }

    case "follow": {
      const runId = args._[1];
      if (!runId) {
        print("usage: claudexor follow <run_id>");
        return 2;
      }
      return followRun(runId, json);
    }

    case "inspect": {
      const runId = args._[1];
      if (!runId) {
        print("usage: claudexor inspect <run_id>");
        return 2;
      }
      // Project store first; no-project Ask runs live in the USER-LEVEL store
      // (~/.claudexor/runs) and must be inspectable from any cwd.
      let store = new ArtifactStore(process.cwd());
      if (!existsSync(store.runPaths(runId).root)) {
        const userStore = new ArtifactStore(noProjectRepoRoot(), { claudexorDir: userConfigDir() });
        if (existsSync(userStore.runPaths(runId).root)) store = userStore;
      }
      const paths = store.runPaths(runId);
      const decision = store.readYaml(join(paths.arbitrationDir, "decision.yaml"));
      const workProduct = store.readYaml(join(paths.finalDir, "work_product.yaml"));
      const contract = TaskContract.safeParse(store.readYaml(join(paths.contextDir, "task.yaml")));
      const primary = primaryOutputForCli(paths.root, contract.success ? contract.data.mode.kind : undefined);
      // The CLI projects the orchestrator-owned telemetry artifact and NEVER
      // recomputes evidence from raw events (single-owner rule); a missing
      // artifact (legacy run) renders "telemetry unavailable".
      const parsedTelemetry = RunTelemetry.safeParse(store.readYaml(join(paths.finalDir, "telemetry.yaml")));
      const telemetry = parsedTelemetry.success ? parsedTelemetry.data : null;
      const toolErrors = telemetry
        ? telemetry.attempts.flatMap((a) => a.tool_errors.filter((e) => !e.recovered).map((e) => ({ attemptId: a.attempt_id, tool: e.tool, target: e.target ?? undefined, summary: e.summary })))
        : [];
      const artifacts = listCliArtifacts(paths.root).filter((p) => !p.endsWith("/"));
      const outputReadyState = primary?.kind === "diagnostic"
        ? "diagnostic"
        : primary?.text.trim()
          ? "ready"
          : readTextSafe(join(paths.finalDir, "failure.yaml"))
            ? "diagnostic"
            : "finalizing";
      const parsedDecision = DecisionRecord.safeParse(decision);
      const summary = readTextSafe(join(paths.finalDir, "summary.md"));
      if (json) {
        printJson({ runId, runDir: paths.root, outputReadyState, contract: contract.success ? contract.data : null, telemetry, toolErrors, primaryOutput: primary, decision, work_product: workProduct, artifacts });
        // exit-code parity with the text mode: read-only runs have no decision record
        return summary || primary ? 0 : 1;
      }
      print(`run ${runId} @ ${paths.root}`);
      if (contract.success) {
        print(`mode: ${contract.data.mode.kind}`);
        print(`access: requested=${contract.data.access.requested_profile} effective=${contract.data.access.effective_profile}`);
      }
      if (telemetry) {
        print(`web: policy=${telemetry.external_context_policy} effective=${telemetry.effective_web_mode} required=${telemetry.web_required} evidence=${telemetry.web.status}`);
      } else if (contract.success) {
        print(`web: policy=${contract.data.external_context.policy} required=${contract.data.external_context.web_required} evidence=unavailable (no telemetry.yaml)`);
      }
      print(`output: ${outputReadyState}${primary ? ` ${primary.path}` : ""}`);
      if (parsedDecision.success) {
        print(`decision: ${parsedDecision.data.status} outcome=${parsedDecision.data.outcome} apply=${parsedDecision.data.apply_recommendation}`);
        const budget = parsedDecision.data.budget_summary;
        print(`budget: spend=${budget.spend_usd ?? "unknown"}${budget.estimated ? " estimated" : ""}`);
      }
      if (telemetry && (telemetry.web.attempted || telemetry.web.required)) {
        print(`web evidence: status=${telemetry.web.status} tool=${telemetry.web.tool ?? "none"} target=${telemetry.web.target ?? "none"}${telemetry.web.error_summary ? ` error=${telemetry.web.error_summary}` : ""}`);
      }
      if (toolErrors.length) {
        print("tool errors (unrecovered):");
        for (const err of toolErrors.slice(-8)) print(`  - ${err.attemptId} ${err.tool}: ${err.summary}${err.target ? ` (${err.target})` : ""}`);
      }
      if (primary?.text.trim()) {
        print("");
        print(primary.text.trim());
      } else {
        print(summary ?? "(no summary — run may not exist)");
      }
      if (artifacts.length) {
        print("");
        print("artifacts:");
        for (const a of artifacts.slice(0, 40)) print(`  - ${a}`);
      }
      return summary || primary ? 0 : 1;
    }

    case "apply": {
      const runId = args._[1];
      if (!runId) {
        print("usage: claudexor apply <run_id> [--mode apply|commit|branch|pr] [--dry-run]");
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
      // Apply policy has ONE owner (delivery.validateApplyGate) shared with the
      // Control API; the CLI only adapts artifact reads into it.
      const applyDecision = DecisionRecord.safeParse(store.readYaml(join(paths.arbitrationDir, "decision.yaml")));
      const workProduct = WorkProduct.safeParse(store.readYaml(join(paths.finalDir, "work_product.yaml")));
      const contract = TaskContract.safeParse(store.readYaml(join(paths.contextDir, "task.yaml")));
      const gateError = validateApplyGate({
        state: null, // artifact-only path: daemon job state is not available here
        decision: applyDecision.success ? applyDecision.data : null,
        workProduct: workProduct.success ? workProduct.data : null,
        patch,
        originalRepoRoot: contract.success ? contract.data.repo.root : null,
        targetRepoRoot: process.cwd(),
      });
      if (gateError) {
        print(gateError);
        return 1;
      }
      if (flagBool(args, "dry-run")) {
        const r = await checkPatch(process.cwd(), patch);
        print(r.ok ? "patch applies cleanly" : `patch does not apply: ${r.stderr.trim()}`);
        return r.ok ? 0 : 1;
      }
      const rawMode = flagStr(args, "mode") ?? "apply";
      if (!DELIVER_MODES.has(rawMode as DeliverMode)) {
        print(`unsupported apply mode: ${rawMode}`);
        return 2;
      }
      const mode = rawMode as DeliverMode;
      const res = await deliver(process.cwd(), patch, { mode, message: `claudexor: apply ${runId}` });
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
        const name = args._[2] ?? "claudexor";
        const checks = await checkName(name);
        if (json) printJson({ name, checks });
        else {
          print(`naming gate for "${name}":`);
          for (const c of checks) print(`  ${c.available ? "[free] " : "[taken]"} ${c.registry}: ${c.detail}`);
        }
        return 0;
      }
      print("usage: claudexor release check-name <name>");
      return 2;
    }

    case "plugin": {
      const sub = args._[1];
      const host = args._[2];
      if (sub === "install" && host && !PLUGIN_HOSTS.includes(host as PluginHost)) {
        process.stderr.write(`claudexor: unknown plugin host '${host}' (expected ${PLUGIN_HOSTS.join("|")})\n`);
        return 2;
      }
      if (sub === "install" && host) {
        const r = installPlugin(host as PluginHost);
        if (json) printJson(r);
        else {
          print(`installed claudexor plugin for ${host}: ${r.path}`);
          print(`  ${r.note}`);
        }
        return 0;
      }
      print("usage: claudexor plugin install <cursor|claude|codex|opencode>");
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
      print("usage: claudexor harness list");
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
    process.stderr.write(`claudexor: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
