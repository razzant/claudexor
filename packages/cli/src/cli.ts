#!/usr/bin/env node
import process from "node:process";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "@claudexor/orchestrator";
import { ArtifactStore } from "@claudexor/artifact-store";
import { DELIVER_MODES, type DeliverMode, checkPatch, deliver, validateApplyGate } from "@claudexor/delivery";
import { assertNoInlineSecretValues, CLAUDEXOR_VERSION, containsSecretLikeToken, ensureDir, newId, noProjectRepoRoot, readTextSafe, sha256, userConfigDir, writeJson } from "@claudexor/util";
import { checkName } from "./release.js";
import { DaemonClient, defaultSocketPath, logPath, readToken } from "@claudexor/daemon";
import { McpServer, defaultClaudexorTools } from "@claudexor/mcp-server";
import { AcpServer } from "@claudexor/acp-server";
import { initProjectConfig, loadConfig, updateGlobalConfig } from "@claudexor/config";
import { atRiskNodeAdvisory, harnessRuntimeEnv, validateModel } from "@claudexor/core";
import { SecretStore, type SecretBackend } from "@claudexor/secrets";
import {
  DecisionRecord,
  EffortHint,
  ExternalContextPolicy,
  type Attachment,
  ModeKind as ModeKindSchema,
  type OrchestrateAutonomy,
  Portfolio,
  type ModeKind,
  RunTelemetry,
  TaskContract,
  WorkProduct,
} from "@claudexor/schema";
import { commandAllowedFlagError, commandScopedFlagError, flagBool, flagStr, parseArgs, requiredStringFlagError, type ParsedArgs } from "./args.js";
import { followRun, formatRunEventLine, promptQuestionsOnTty } from "./live.js";
import { connectDaemonIfRunning, daemonOutcomeSummary, ensureDaemon, enqueueAndAwait, exitCodeForState, waitForDaemonReady } from "./daemon-run.js";
import { resolveDecisionBody } from "./decision.js";
import { PLUGIN_TARGETS, PLUGIN_VERBS, formatPluginResult, pluginCommandErrorResult, runPluginCommand, type PluginTarget, type PluginVerb } from "./plugins.js";
import { buildGateway, buildRegistry, harnessModels } from "./registry.js";
import {
  extractQuestionsFromPlan,
  freezeSpecFromGrounding,
  loadFrozenSpec,
  loadPreviousSpec,
  persistSpec,
  readAnswers,
  type SpecCommandResult,
} from "./spec.js";
import { parseReviewerEffortMap, parseReviewerModelMap } from "./reviewer-options.js";
import { parseAutonomy } from "./orchestrate-options.js";
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

// Single version SSOT: the generated CLAUDEXOR_VERSION constant (from the root
// package.json) so the banner / --version can never ship stale or drift.
const CLI_VERSION = CLAUDEXOR_VERSION;

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
  claudexor decision <run_id> <action>    Decide a blocked run: --accept-risk|--override|--revert|--accept-clean-patch [--apply-mode m]|--rerun --feedback "<text>"
  claudexor settings show|set             Show/update user defaults
  claudexor auth status|login             Inspect native harness auth
  claudexor secrets list|set|delete       Manage stored API-key refs (Keychain/0600 file)
  claudexor release check-name <name>     Naming gate (npm/pypi/crates/github)
  claudexor daemon start|status|stop|logs Optional local daemon (claudexord)
  claudexor mcp serve                     Expose Claudexor as an MCP server (stdio)
  claudexor acp serve                     Expose Claudexor as an ACP agent (stdio)
  claudexor plugin install <host|all>     Install host integration (cursor|claude|codex|opencode|all)
  claudexor plugin status <host|all>      Inspect host integration status
  claudexor plugin doctor <host|all>      Verify installed files/config and MCP startup
  claudexor plugin repair <host|all>      Reapply owned Claudexor host integration files/config
  claudexor plugin uninstall <host|all>   Remove owned Claudexor host integration files/config
  claudexor harness list [--all]          List real harnesses (--all includes fakes)
  claudexor models [--harness <id>] [--all]   List a harness's enumerable models (raw-api: OpenAI GET /v1/models; --all includes fakes)
  claudexor help                          Show this help

Options:
  --harness <id[,id...]>   Force harness(es)
  --mode <mode>            ask | plan | audit | agent | orchestrate (strategies are flags, not modes)
  --n <N>                  Race width (agent): N isolated candidates + cross-review
  --synthesis <mode>       Best-of-N synthesis: auto (default, only n>=3)|always|never
  --attempts <N>           Convergence cap (agent): repair loop up to N attempts
  --until-clean            Convergence (agent): iterate until the review/gates are clean
  --swarm                  Research swarm (audit): bounded read-only explorer fan-out
  --create                 Create-from-scratch intent (agent)
  --autonomy <level>       Orchestrate: how much the brain may act without confirmation:
                           suggest (default, read-only plan) | auto_safe | auto_full
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
  --in-place               Run write turns against the live project tree (single-candidate
                           in-place; race candidates stay isolated and the winner is adopted)
                           instead of a throwaway envelope
  --answers <file>         Answers JSON for claudexor spec (batch mode)
  --previous <spec.json>   Previous SpecPack JSON for section-level diff
  --spec <spec.json>       Frozen SpecPack context for run/race/create/convergence
  --attach <path[,path...]> Attach file(s) to ask/run/race/plan/audit
  --image <path[,path...]>  Attach image file(s) (alias for --attach with image kind)
  --backend <store>        Secrets store: auto (default)|keychain|file (file = sandbox-safe, no Keychain)
  --json                   Machine-readable JSON output
  --dry-run                Plugin: show lifecycle actions; apply: check patch without mutating
  --force                  Reapply verified Claudexor-owned plugin drift; never overwrites unowned files
  --help                   Show this help
  --version                Print the CLI version
`;

const MODES = new Set<ModeKind>(["ask", "plan", "audit", "agent", "orchestrate"]);

/** Canonical mode ids are single words; trim and validate against the schema. */
function normalizeMode(s: string): ModeKind {
  const trimmed = s.trim();
  const parsed = ModeKindSchema.safeParse(trimmed);
  if (!parsed.success) return trimmed as ModeKind;
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

function synthesisMode(args: ParsedArgs): "auto" | "always" | "never" | undefined {
  const v = flagStr(args, "synthesis");
  if (v === undefined) return undefined;
  if (v !== "auto" && v !== "always" && v !== "never") {
    throw new Error(`invalid --synthesis '${v}' (expected auto|always|never)`);
  }
  return v;
}

function webPolicy(args: ParsedArgs): "off" | "auto" | "cached" | "live" | undefined {
  const v = flagStr(args, "web");
  if (v === undefined) return undefined;
  const parsed = ExternalContextPolicy.safeParse(v);
  if (!parsed.success) throw new Error(`invalid --web '${v}' (expected off|auto|cached|live)`);
  return parsed.data;
}

function attachmentPaths(args: ParsedArgs): { path: string; forceImage: boolean }[] {
  const values: { path: string; forceImage: boolean }[] = [];
  for (const [key, forceImage] of [["attach", false], ["image", true]] as const) {
    const raw = flagStr(args, key);
    if (!raw) continue;
    for (const piece of raw.split(",")) {
      const path = piece.trim();
      if (path) values.push({ path, forceImage });
    }
  }
  return values;
}

function imageMimeFor(path: string): string | null {
  switch (extname(path).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    default: return null;
  }
}

function attachmentInputs(args: ParsedArgs): { kind: "image" | "file"; mime: string; name: string; path: string }[] | undefined {
  const out = attachmentPaths(args).map(({ path, forceImage }) => {
    const resolved = resolve(path);
    if (!existsSync(resolved)) throw new Error(`attachment not found: ${path}`);
    const imageMime = imageMimeFor(resolved);
    const kind = forceImage || imageMime ? "image" as const : "file" as const;
    return {
      kind,
      mime: imageMime ?? "application/octet-stream",
      name: basename(resolved),
      path: resolved,
    };
  });
  return out.length > 0 ? out : undefined;
}

function attachmentsFromInputs(inputs: ReturnType<typeof attachmentInputs>): Attachment[] | undefined {
  return inputs?.map((a) => ({
    id: newId("att"),
    kind: a.kind,
    mime: a.mime,
    name: a.name,
    path: a.path,
  }));
}

/** Per-family reviewer model map from `--reviewer-model "openai=gpt-4o-mini,anthropic=claude-haiku"`. Fails loudly on malformed input. */
function reviewerModels(args: ParsedArgs): Record<string, string> | undefined {
  return parseReviewerModelMap(flagStr(args, "reviewer-model"));
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
  let loadedSpec: ReturnType<typeof loadFrozenSpec> | null = null;
  try {
    loadedSpec = specPath ? loadFrozenSpec(specPath) : null;
  } catch (err) {
    return printUsageError(json, `claudexor: ${err instanceof Error ? err.message : String(err)}`);
  }
  const prompt = loadedSpec
    ? [
        rawPrompt || loadedSpec.spec.intent.raw,
        "",
        "Use this frozen Claudexor SpecPack as the contract. Do not re-litigate settled choices; implement against the acceptance criteria and tests.",
        "",
        `Spec id: ${loadedSpec.spec.id} v${loadedSpec.spec.version}`,
        `Spec hash: ${loadedSpec.specHash}`,
        "",
        "## Summary",
        loadedSpec.spec.summary || "(none)",
        "",
        "## Acceptance Criteria",
        ...(loadedSpec.spec.success_criteria.length ? loadedSpec.spec.success_criteria.map((c) => `- [${c.id}] ${c.behavior}`) : ["- (none)"]),
        "",
        "## Non-goals",
        ...(loadedSpec.spec.non_goals.length ? loadedSpec.spec.non_goals.map((x) => `- ${x}`) : ["- (none)"]),
        "",
        "## Forbidden approaches",
        ...(loadedSpec.spec.forbidden_approaches.length ? loadedSpec.spec.forbidden_approaches.map((x) => `- ${x}`) : ["- (none)"]),
      ].join("\n")
    : rawPrompt;
  const spec = loadedSpec?.spec ?? null;
  if (!prompt && mode !== "audit") {
    return printUsageError(json, "claudexor: missing prompt");
  }
  const portfolioRaw = flagStr(args, "portfolio");
  const portfolio = portfolioRaw !== undefined ? Portfolio.safeParse(portfolioRaw) : null;
  if (portfolioRaw !== undefined && !portfolio?.success) {
    return printUsageError(json, `claudexor: unknown --portfolio '${portfolioRaw}'`);
  }
  let reviewerEffortOverrides: Partial<Record<"anthropic", EffortHint>> | undefined;
  let resolvedReviewerModels: Record<string, string> | undefined;
  let resolvedWebPolicy: ReturnType<typeof webPolicy> = undefined;
  let resolvedAccess: ReturnType<typeof accessProfile> = undefined;
  let resolvedEffort: EffortHint | undefined;
  let maxUsd: number | undefined;
  let nFlag: number | undefined;
  let attemptsFlag: number | undefined;
  let autonomy: OrchestrateAutonomy | undefined;
  let resolvedSynthesis: ReturnType<typeof synthesisMode> = undefined;
  let attachments: Attachment[] | undefined;
  let attachmentRequest: ReturnType<typeof attachmentInputs> | undefined;
  try {
    reviewerEffortOverrides = reviewerEfforts(args);
    resolvedReviewerModels = reviewerModels(args);
    resolvedWebPolicy = webPolicy(args);
    resolvedAccess = accessProfile(args);
    resolvedEffort = effortHint(args);
    maxUsd = floatFlag(args, "max-usd");
    nFlag = intFlag(args, "n");
    attemptsFlag = intFlag(args, "attempts");
    autonomy = parseAutonomy(flagStr(args, "autonomy"));
    resolvedSynthesis = synthesisMode(args);
    attachmentRequest = attachmentInputs(args);
    attachments = attachmentsFromInputs(attachmentRequest);
  } catch (err) {
    return printUsageError(json, `claudexor: ${err instanceof Error ? err.message : String(err)}`);
  }
  let tests: string[] | undefined;
  try {
    tests = testCommands(args) ?? spec?.tests.map((t) => t.command);
    assertNoInlineSecretValues({ tests }, "$", "CLI run params");
  } catch (err) {
    return printUsageError(json, `claudexor: ${err instanceof Error ? err.message : String(err)}`);
  }

  // `--autonomy` only governs the orchestrate brain's executor; on any other
  // mode it would silently do nothing, so reject it loudly (a misplaced flag is
  // an error, not a no-op).
  if (autonomy !== undefined && mode !== "orchestrate") {
    return printUsageError(json, `claudexor: --autonomy only applies to 'orchestrate' (got mode '${mode}')`);
  }

  // The mutating run paths are DAEMON-TRACKED: they enqueue via the daemon
  // (auto-started if needed) so the control-api can see/unblock them and a
  // blocked run is unblockable through `claudexor decision`. This covers `agent`
  // and an `orchestrate` run that actually ACTS (auto_safe/auto_full execute the
  // plan against the tree). Read-only routes (ask/plan/audit and orchestrate in
  // the default `suggest` autonomy, where the plan IS the work product) have
  // nothing to apply or unblock, so they stay in-process.
  const orchestrateExecutes = mode === "orchestrate" && autonomy !== undefined && autonomy !== "suggest";
  if (mode === "agent" || orchestrateExecutes) {
    return daemonAgentRun(args, json, {
      mode,
      autonomy,
      prompt,
      tests,
      portfolio: portfolio?.success ? portfolio.data : undefined,
      maxUsd,
      reviewerModels: resolvedReviewerModels,
      reviewerEfforts: reviewerEffortOverrides,
      resolvedWebPolicy,
      resolvedAccess,
      resolvedEffort,
      resolvedSynthesis,
      nFlag,
      attemptsFlag,
      specId: spec?.id,
      specHash: loadedSpec?.specHash,
      specPath: loadedSpec?.specPath,
      attachmentRequest,
      forced,
    });
  }

  const orch = new Orchestrator({
    registry: buildRegistry(),
    portfolio: portfolio?.success ? portfolio.data : undefined,
    maxUsd: maxUsd ?? null,
    reviewerModels: resolvedReviewerModels,
    reviewerEfforts: reviewerEffortOverrides,
  });
  try {
    const res = await orch.run({
      repoRoot: process.cwd(),
      prompt: prompt || "audit this repository",
      attachments,
      mode,
      // Only `suggest` (or unset) reaches the in-process path; auto_safe/auto_full
      // are routed to the daemon above. Forward it so an explicit --autonomy
      // suggest is honoured rather than silently dropped.
      ...(autonomy ? { autonomy } : {}),
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
      synthesis: resolvedSynthesis,
      specId: spec?.id,
      specHash: loadedSpec?.specHash,
      specPath: loadedSpec?.specPath,
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
      // One machine surface: on a non-success terminal, ADD a top-level `error`
      // (mirroring the daemon path's `error`) so a JSON consumer reads the reason
      // the same way regardless of which run path produced it. Add-only: the full
      // result (runId/runDir/status/mode/winner/summary/candidates) is preserved.
      printJson(res.status === "success" ? res : { ...res, error: res.summary });
    } else {
      print(`run ${res.runId} [${res.status}] mode=${res.mode} winner=${res.winner ?? "none"}`);
      print(`  artifacts: ${res.runDir}`);
      for (const c of res.candidates) print(`  - ${c.attemptId} ${c.harnessId} [${c.status}]`);
      print("");
      print(res.summary);
    }
    return res.status === "success" ? 0 : 1;
  } catch (err) {
    if (json) printJson({ ok: false, exitCode: 1, error: `claudexor: ${err instanceof Error ? err.message : String(err)}` });
    else process.stderr.write(`claudexor: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

interface DaemonRunParams {
  /** The daemon-tracked mode: "agent" (write turn) or "orchestrate" (executing brain). */
  mode: ModeKind;
  /** Orchestrate executor autonomy; only meaningful (and only sent) for mode=orchestrate. */
  autonomy: OrchestrateAutonomy | undefined;
  prompt: string;
  tests: string[] | undefined;
  portfolio: ReturnType<typeof Portfolio.parse> | undefined;
  maxUsd: number | undefined;
  reviewerModels: Record<string, string> | undefined;
  reviewerEfforts: Partial<Record<"anthropic", EffortHint>> | undefined;
  resolvedWebPolicy: ReturnType<typeof webPolicy>;
  resolvedAccess: ReturnType<typeof accessProfile>;
  resolvedEffort: EffortHint | undefined;
  resolvedSynthesis: ReturnType<typeof synthesisMode>;
  nFlag: number | undefined;
  attemptsFlag: number | undefined;
  specId: string | undefined;
  specHash: string | undefined;
  specPath: string | undefined;
  attachmentRequest: ReturnType<typeof attachmentInputs> | undefined;
  forced: { swarm?: boolean; create?: boolean; race?: boolean };
}

/**
 * DAEMON-TRACKED mutating run (the unified `run`/`race`/`create` path, and an
 * `orchestrate` brain running with auto_safe/auto_full autonomy). Auto-starts
 * the daemon if needed, enqueues via the control API (so the run is registered
 * and the control-api can see/unblock it), streams its events to the TTY (text
 * mode) and resolves the runDir from the daemon (the run lives under the daemon
 * dir, not project-local) so apply/decision/inspect can find it. `--json` prints
 * exactly one object `{ runId, runDir, status }` — the SWE/TB benchmark runner
 * parses this to read <runDir>/final/patch.diff.
 */
async function daemonAgentRun(args: ParsedArgs, json: boolean, p: DaemonRunParams): Promise<number> {
  // The run is always project-scoped (the cwd is its repo); execution is
  // live in-place only under the explicit --in-place convergence path.
  const inPlace = flagBool(args, "in-place");
  const body: Record<string, unknown> = {
    prompt: p.prompt,
    ...(p.attachmentRequest ? { attachments: p.attachmentRequest } : {}),
    mode: p.mode,
    // Autonomy only governs the orchestrate executor; send it only for that mode.
    ...(p.mode === "orchestrate" && p.autonomy ? { autonomy: p.autonomy } : {}),
    scope: { kind: "project", root: process.cwd() },
    execution: { isolation: inPlace ? "live" : "envelope" },
    ...(harnessList(args) ? { harnesses: harnessList(args) } : {}),
    ...(flagStr(args, "primary-harness") ? { primaryHarness: flagStr(args, "primary-harness") } : {}),
    ...(p.portfolio ? { portfolio: p.portfolio } : {}),
    ...(p.forced.race === true ? { n: p.nFlag ?? 2 } : p.nFlag !== undefined ? { n: p.nFlag } : {}),
    ...(p.attemptsFlag !== undefined ? { attempts: p.attemptsFlag } : {}),
    ...(flagBool(args, "until-clean") ? { untilClean: true } : {}),
    ...(p.forced.swarm === true || flagBool(args, "swarm") ? { swarm: true } : {}),
    ...(p.forced.create === true || flagBool(args, "create") ? { create: true } : {}),
    ...(p.resolvedSynthesis ? { synthesis: p.resolvedSynthesis } : {}),
    ...(p.tests ? { tests: p.tests } : {}),
    ...(p.maxUsd !== undefined ? { maxUsd: p.maxUsd } : {}),
    ...(p.resolvedAccess ? { access: p.resolvedAccess } : {}),
    ...(p.resolvedWebPolicy ? { web: p.resolvedWebPolicy } : {}),
    ...(flagStr(args, "model") ? { model: flagStr(args, "model") } : {}),
    ...(p.resolvedEffort ? { effort: p.resolvedEffort } : {}),
    ...(p.reviewerModels ? { reviewerModels: p.reviewerModels } : {}),
    ...(p.reviewerEfforts ? { reviewerEfforts: p.reviewerEfforts } : {}),
    ...(p.specId ? { specId: p.specId } : {}),
    ...(p.specHash ? { specHash: p.specHash } : {}),
    ...(p.specPath ? { specPath: p.specPath } : {}),
  };

  try {
    const { client, addr } = await ensureDaemon();
    if (json) {
      // Pure machine surface: enqueue, wait for the terminal outcome, print
      // exactly one JSON object. No event printer, no TTY prompts.
      const out = await enqueueAndAwait(client, addr, body, { waitForTerminal: true });
      // Keep the documented bench-parser keys {runId,runDir,status}; ADD `mode`,
      // `error` (only for real errors), and `summary` (a machine-readable reason
      // for EVERY non-success terminal incl. `blocked`, which carries no error)
      // so this path matches the in-process one (P2: one machine surface).
      const reason = daemonOutcomeSummary(out);
      printJson({ runId: out.runId, runDir: out.runDir, status: out.status, jobId: out.jobId, mode: p.mode, ...(out.error ? { error: out.error } : {}), ...(reason ? { summary: reason } : {}) });
      return exitCodeForState(out.status);
    }
    // Text mode: enqueue, then live-stream the run through the shared follow
    // pipeline (replay + push + interactive TTY question answering), then print
    // the honest terminal line + artifacts dir resolved from the daemon.
    const started = await enqueueAndAwait(client, addr, body, { waitForTerminal: false });
    if (!started.runId) {
      print(`run did not start: ${started.status}${started.error ? ` — ${started.error}` : ""}`);
      return exitCodeForState(started.status);
    }
    await followRun(started.runId, false);
    const final = started.jobId ? await client.status(started.jobId) : null;
    const status = final?.state ?? started.status;
    print("");
    print(`run ${started.runId} [${status}]`);
    print(`  artifacts: ${final?.runDir ?? started.runDir}`);
    if (status === "blocked") {
      print(`  blocked (needs human): unblock with \`claudexor decision ${started.runId} --accept-risk\` or rerun with \`claudexor decision ${started.runId} --rerun --feedback "..."\``);
    } else if (exitCodeForState(status) === 0) {
      print(`  apply with: claudexor apply ${started.runId}`);
    }
    return exitCodeForState(status);
  } catch (err) {
    if (json) printJson({ ok: false, exitCode: 1, error: `claudexor: ${err instanceof Error ? err.message : String(err)}` });
    else process.stderr.write(`claudexor: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

/**
 * `claudexor decision <runId> ...` — the CLI safety net that unblocks a
 * daemon-tracked blocked run (the surface that closes the un-unblockable gap).
 * Maps the flag to a typed RunDecisionAction and POSTs to /runs/:id/decision via
 * the daemon control API, printing the response honestly.
 */
async function decisionCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const runId = args._[1];
  if (!runId) {
    print("usage: claudexor decision <run_id> --accept-risk | --override | --revert | --accept-clean-patch [--apply-mode <m>] | --rerun [--feedback \"<text>\"]");
    return 2;
  }
  const resolved = resolveDecisionBody(args);
  if (!resolved.ok) {
    process.stderr.write(`claudexor decision: ${resolved.message}\n`);
    return 2;
  }
  const { action, body } = resolved;

  try {
    const { addr } = await ensureDaemon();
    const res = await fetch(`${addr.baseUrl}/runs/${encodeURIComponent(runId)}/decision`, {
      method: "POST",
      headers: { Authorization: `Bearer ${addr.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      // A typed decision rejection (e.g. revert refused: tree diverged) carries
      // its reason in `message`; transport/gate failures use `error`. Surface
      // whichever is present so the concrete reason is never lost behind "HTTP 409".
      const msg =
        typeof data["error"] === "string"
          ? (data["error"] as string)
          : typeof data["message"] === "string"
            ? (data["message"] as string)
            : `decision failed (HTTP ${res.status})`;
      if (json) printJson({ accepted: false, status: "rejected", message: msg });
      else process.stderr.write(`claudexor decision: ${msg}\n`);
      return 1;
    }
    if (json) {
      printJson(data);
    } else {
      const accepted = data["accepted"] === true;
      print(`decision ${action} on ${runId}: ${accepted ? "accepted" : "rejected"} [${String(data["status"] ?? "?")}]`);
      if (typeof data["newRunId"] === "string") print(`  new run: ${data["newRunId"]}`);
      if (typeof data["message"] === "string") print(`  ${data["message"]}`);
    }
    return data["accepted"] === true ? 0 : 1;
  } catch (err) {
    process.stderr.write(`claudexor decision: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

/**
 * Resolve the ArtifactStore that owns a given run, regardless of the cwd the
 * CLI is invoked from. Order:
 *   1. the project store rooted at the current cwd (the common case);
 *   2. the user-level store (~/.claudexor/runs) used by no-project Ask runs;
 *   3. a daemon-tracked run that started in ANOTHER project — agent/race/create
 *      runs live under `<thatProjectRoot>/.claudexor/runs/<runId>`, so we ask
 *      the daemon for the run's absolute runDir (GET /runs/:id ->
 *      summary.runDir) and rebuild a store whose runPaths(runId).root matches.
 * Returns null when no store can be located (the run does not exist anywhere
 * reachable). Never throws on daemon unavailability — it falls through.
 */
async function resolveRunStore(runId: string): Promise<{ store: ArtifactStore; root: string } | null> {
  // 1. project cwd store
  const cwdStore = new ArtifactStore(process.cwd());
  if (existsSync(cwdStore.runPaths(runId).root)) return { store: cwdStore, root: cwdStore.runPaths(runId).root };
  // 2. user-level (no-project Ask) store
  const userStore = new ArtifactStore(noProjectRepoRoot(), { claudexorDir: userConfigDir() });
  if (existsSync(userStore.runPaths(runId).root)) return { store: userStore, root: userStore.runPaths(runId).root };
  // 3. daemon-tracked run in another project: ask the daemon for its runDir.
  //    Connect ONLY to an already-running daemon — never auto-spawn one for a
  //    read-only lookup (a typo'd id must report "no such run", not silently
  //    launch a background daemon). Acting paths (decision/enqueue) still use
  //    ensureDaemon().
  try {
    const conn = await connectDaemonIfRunning();
    if (!conn) return null;
    const { addr } = conn;
    const resp = await fetch(`${addr.baseUrl}/runs/${encodeURIComponent(runId)}`, {
      headers: { Authorization: `Bearer ${addr.token}` },
    });
    if (resp.ok) {
      const detail = (await resp.json()) as { summary?: { runDir?: string } };
      const runDir = detail.summary?.runDir;
      if (runDir && existsSync(runDir)) {
        // runDir = <repoRoot>/.claudexor/runs/<runId>; reconstruct a store whose
        // runPaths(runId).root === runDir: runId -> runs -> .claudexor.
        const claudexorDir = resolve(runDir, "..", "..");
        const ds = new ArtifactStore(dirname(claudexorDir), { claudexorDir });
        if (existsSync(ds.runPaths(runId).root)) return { store: ds, root: ds.runPaths(runId).root };
      }
    }
  } catch {
    /* daemon unavailable: fall through */
  }
  return null;
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

function printUsageError(json: boolean, error: string): number {
  if (json) printJson({ ok: false, exitCode: 2, error });
  else process.stderr.write(`${error}\n`);
  return 2;
}

function printPreflightError(args: ParsedArgs, json: boolean, error: string): number {
  if (json && (args._[0] ?? "help") === "plugin") {
    printJson(pluginCommandErrorResult(args._[1], args._[2], flagBool(args, "dry-run"), 2, error));
    return 2;
  }
  return printUsageError(json, error);
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
    const child = spawn(process.execPath, [daemonScript], { detached: true, stdio: "ignore", env: harnessRuntimeEnv() });
    child.unref();
    // Block until the daemon (socket + control API) is actually ready, so a
    // follow-up `status`/run can't race the spawn. Fail loudly (exit 1) if it
    // never comes up. (If a daemon was already running, this connects to it.)
    const ready = await waitForDaemonReady(15_000);
    if (json) {
      printJson({ pid: child.pid ?? null, socket: defaultSocketPath(), ready: ready !== null });
    } else if (ready) {
      print(`claudexord ready (pid ${child.pid}); socket ${defaultSocketPath()}`);
    } else {
      print(`claudexord started (pid ${child.pid}) but did not become ready within 15s; check \`claudexor daemon logs\``);
    }
    return ready ? 0 : 1;
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
      print(`interaction_timeout_ms: ${cfg.global.interaction_timeout_ms}`);
      print(`runtime.reviewer_timeout_ms: ${cfg.global.runtime.reviewer_timeout_ms}`);
      print(`runtime.transient_retry.max_retries: ${cfg.global.runtime.transient_retry.max_retries}`);
      print(`runtime.transient_retry.initial_delay_ms: ${cfg.global.runtime.transient_retry.initial_delay_ms}`);
      print(`runtime.transient_retry.max_delay_ms: ${cfg.global.runtime.transient_retry.max_delay_ms}`);
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
      print("usage: claudexor settings set default_portfolio|primary_harness|eligible_harnesses|default_model|env_inheritance|routing_policy|budget_max_usd_per_run|interaction_timeout_ms <value>");
      return 2;
    }
    try {
      const res = updateGlobalConfig((cfg) => {
        if (key === "default_portfolio") {
          const p = Portfolio.parse(value);
          return { ...cfg, default_portfolio: p };
        }
        if (key === "primary_harness") {
          if (value !== "none" && !isKnownHarness(value)) throw new Error(`unknown harness '${value}' (run \`claudexor harness list --all\`)`);
          return { ...cfg, routing: { ...cfg.routing, primary_harness: value === "none" ? null : value } };
        }
        if (key === "eligible_harnesses") {
          const list = value === "none" ? [] : value.split(",").map((s) => s.trim()).filter(Boolean);
          const unknown = list.filter((h) => !isKnownHarness(h));
          if (unknown.length) throw new Error(`unknown harness(es): ${unknown.join(", ")} (run \`claudexor harness list --all\`)`);
          return { ...cfg, routing: { ...cfg.routing, eligible_harnesses: list } };
        }
        if (key === "default_model") {
          return { ...cfg, routing: { ...cfg.routing, default_model: value === "none" ? null : value } };
        }
        if (key === "env_inheritance") {
          if (!["mirror_native", "clean"].includes(value)) throw new Error("env_inheritance must be mirror_native|clean");
          return { ...cfg, routing: { ...cfg.routing, env_inheritance: value as never } };
        }
        if (key === "routing_policy") {
          if (!["auto", "primary", "portfolio"].includes(value)) throw new Error("routing_policy must be auto|primary|portfolio");
          return { ...cfg, routing: { ...cfg.routing, default_policy: value as never } };
        }
        if (key === "budget_max_usd_per_run") {
          // Number() parses the WHOLE string ('1abc' -> NaN), unlike parseFloat.
          const parsed = value === "none" ? null : Number(value.trim());
          if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0 || value.trim() === "")) throw new Error(`${key} must be a non-negative number or none`);
          return { ...cfg, budget: { ...cfg.budget, max_usd_per_run: parsed } };
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

/**
 * The real CONSUMER (ADP4) of the adapter models() producer: list a harness's
 * enumerable models. With --harness it queries that one; otherwise it tries
 * every non-unavailable harness and shows which can honestly enumerate.
 */
async function modelsCommand(args: ParsedArgs, json: boolean): Promise<number> {
  // `--all` includes fakes (they honestly report source:"none"); honoring it here
  // mirrors doctor/auth/harness-list instead of silently ignoring the flag (P15).
  const includeFakes = flagBool(args, "all");
  const only = flagStr(args, "harness");
  let ids: string[];
  if (only) {
    ids = only.split(",").map((s) => s.trim()).filter(Boolean);
    // An explicit --harness typo fails loudly (consistent with doctor/auth), not a
    // silent source:"none" exit 0.
    const known = new Set(buildRegistry({ includeFakes: true }).keys());
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) return printUsageError(json, `claudexor: unknown harness(es): ${unknown.join(", ")} (run \`claudexor harness list --all\`)`);
  } else {
    // Default to harnesses that doctor considers usable (not unavailable);
    // each harnessModels() reports source "none" when it cannot enumerate.
    const statuses = await buildGateway({ includeFakes }).statusAll({ cwd: process.cwd() });
    ids = statuses.filter((s) => s.status !== "unavailable").map((s) => s.id);
  }
  const results = await Promise.all(ids.map((id) => harnessModels(id, process.cwd(), includeFakes)));
  if (json) {
    printJson({ harnesses: results });
    return 0;
  }
  for (const r of results) {
    if (r.source === "none") {
      print(`${r.harnessId}: no model enumeration (adapter cannot list models)`);
      continue;
    }
    print(`${r.harnessId}: ${r.models.length} model(s) [source=${r.source}]`);
    for (const m of r.models) {
      const ctx = m.context_window ? ` (${m.context_window} ctx)` : "";
      const label = m.label && m.label !== m.id ? ` — ${m.label}` : "";
      print(`    ${m.id}${label}${ctx}`);
    }
  }
  return 0;
}

async function authCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const sub = args._[1] ?? "status";
  const harness = args._[2];
  if (sub === "status") {
    const gateway = buildGateway({ includeFakes: flagBool(args, "all") });
    // Scope discovery to the requested harness (P14) instead of probe-all-then-filter.
    const statuses = await gateway.statusAll({ cwd: process.cwd() }, harness ? [harness] : undefined);
    // An explicit unknown harness must FAIL LOUDLY, not silently succeed over empty.
    if (harness && !statuses.some((s) => s.id === harness)) {
      return printUsageError(json, `claudexor: unknown harness '${harness}' (run \`claudexor harness list --all\`)`);
    }
    const filtered = statuses;
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
  // `--backend file` (or env CLAUDEXOR_SECRETS_BACKEND=file) keeps secret I/O in
  // the 0600 file store — sandbox/CI safe (never touches the real login Keychain).
  const backendFlag = flagStr(args, "backend");
  if (backendFlag !== undefined && backendFlag !== "auto" && backendFlag !== "keychain" && backendFlag !== "file") {
    if (json) printJson({ error: "--backend must be auto|keychain|file" });
    else print("--backend must be auto|keychain|file");
    return 2;
  }
  let store: SecretStore;
  try {
    store = new SecretStore((backendFlag as SecretBackend | undefined) ?? "auto");
    // Surface an invalid CLAUDEXOR_SECRETS_BACKEND now, honoring --json, instead of
    // letting the throw escape to the plain-text top-level catch.
    store.resolvedBackend();
  } catch (err) {
    const msg = `claudexor secrets: ${err instanceof Error ? err.message : String(err)}`;
    if (json) printJson({ error: msg });
    else process.stderr.write(`${msg}\n`);
    return 1;
  }
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
      print("secret name must be openai, anthropic, openrouter, cursor, opencode, or raw");
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
      print("secret name must be openai, anthropic, openrouter, cursor, opencode, or raw");
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

const MANAGED_SECRET_NAMES = new Set(["openai", "anthropic", "openrouter", "cursor", "opencode", "raw"]);

function isManagedSecretName(name: string): boolean {
  return MANAGED_SECRET_NAMES.has(name);
}

/**
 * A REAL harness id (fakes excluded), for `settings set` validation. A persistent
 * routing default is not an explicit per-run selection, so a `fake-*` fixture must
 * never be accepted as primary/eligible (it could route ordinary runs to a fake).
 */
function isKnownHarness(id: string): boolean {
  return buildRegistry({ includeFakes: false }).has(id);
}

/** Every flag any command accepts. Unknown flags FAIL LOUDLY: `--harnes codex` must never silently run all harnesses. */
const KNOWN_FLAGS = new Set([
  "harness", "mode", "n", "attempts", "until-clean", "swarm", "create", "synthesis",
  "test", "max-usd", "reviewer-model", "reviewer-effort",
  "access", "web", "model", "effort", "primary-harness", "portfolio", "in-place", "autonomy",
  "answers", "previous", "spec", "attach", "image", "json", "all", "dry-run", "force", "from-env", "backend",
  // `decision` command action/option flags (subcommand-scoped).
  "accept-risk", "override", "revert", "accept-clean-patch", "apply-mode", "rerun", "feedback",
  "help", "version",
]);

const VALUE_FLAGS = [
  "harness", "mode", "n", "attempts", "synthesis", "test", "max-usd",
  "reviewer-model", "reviewer-effort", "access", "web", "model", "effort",
  "primary-harness", "portfolio", "autonomy", "answers", "previous", "spec", "attach", "image",
  "from-env", "backend", "apply-mode", "feedback",
];

const PLUGIN_FLAGS = ["json", "dry-run", "force", "help", "version"];

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
  const json = flagBool(args, "json");
  const cmd = args._[0] ?? "help";
  const unknownFlags = Object.keys(args.flags).filter((f) => !KNOWN_FLAGS.has(f));
  if (unknownFlags.length > 0) {
    const error = `claudexor: unknown flag(s): ${unknownFlags.map((f) => `--${f}`).join(", ")} (see \`claudexor help\`)`;
    return printPreflightError(args, json, error);
  }
  const valueFlagError = requiredStringFlagError(args, VALUE_FLAGS);
  if (valueFlagError) return printPreflightError(args, json, valueFlagError);
  const scopedFlagError = commandScopedFlagError(args);
  if (scopedFlagError) return printPreflightError(args, json, scopedFlagError);
  const pluginFlagError = commandAllowedFlagError(args, "plugin", PLUGIN_FLAGS);
  if (pluginFlagError) return printPreflightError(args, json, pluginFlagError);
  // No arguments at all = the interactive REPL: a thread of turns over the
  // current project with native session continuity (chat is the normal loop).
  if (args._.length === 0 && process.stdin.isTTY) {
    return runRepl(process.cwd());
  }
  const cwd = process.cwd();

  switch (cmd) {
    case "init": {
      const res = initProjectConfig(cwd);
      if (json) printJson(res);
      else print(res.created ? `Created ${res.configPath}` : `Config already exists: ${res.configPath}`);
      return 0;
    }

    case "doctor": {
      const cfg = loadConfig(cwd);
      const only = flagStr(args, "harness");
      const onlyList = only ? only.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      const gateway = buildGateway({ includeFakes: flagBool(args, "all") });
      // Scope discovery to the requested harness(es) (P14): a single-harness
      // query no longer probes every adapter (incl. paid smokes) just to filter.
      const statuses = await gateway.statusAll({ cwd }, onlyList);
      // An explicit --harness typo must FAIL LOUDLY, not silently succeed over an
      // empty list (the scoped probe returns nothing for an unknown id).
      if (onlyList) {
        const got = new Set(statuses.map((s) => s.id));
        const unknown = onlyList.filter((id) => !got.has(id));
        if (unknown.length) return printUsageError(json, `claudexor: unknown harness(es): ${unknown.join(", ")} (run \`claudexor harness list --all\`)`);
      }
      const filtered = statuses;
      // B2: a configured default model that the harness does not recognize must
      // not be silently masked by a smoke that ran a DIFFERENT model. Validate
      // each harness's configured default against its declared known_models and
      // surface it honestly (warn for non-authoritative, INVALID for authoritative).
      const modelNote = (s: (typeof statuses)[number]): string | null => {
        const configured = cfg.global.harnesses[s.id]?.default_model ?? cfg.global.routing.default_model ?? null;
        const caps = s.manifest?.capabilities;
        if (!configured || !caps) return null;
        const check = validateModel(configured, caps.known_models, caps.models_authoritative);
        if (check.status === "ok") return null;
        return `    model: ${check.status === "rejected" ? "INVALID" : "unverified"} — ${check.message}`;
      };
      if (json) {
        printJson({
          harnesses: filtered.map((s) => {
            const configured = cfg.global.harnesses[s.id]?.default_model ?? cfg.global.routing.default_model ?? null;
            const caps = s.manifest?.capabilities;
            return { ...s, configured_model: configured, configured_model_check: configured && caps ? validateModel(configured, caps.known_models, caps.models_authoritative) : null };
          }),
          node_advisory: atRiskNodeAdvisory(),
        });
        return 0;
      }
      for (const s of filtered) {
        const ver = s.manifest?.version ? ` ${s.manifest.version}` : "";
        print(`${statusGlyph(s.status)} ${s.id}${ver}`);
        if (s.enabledIntents.length) print(`    intents: ${s.enabledIntents.join(", ")}`);
        print(`    auth sources: ${authSourceAvailability(s)}`);
        print(`    checks: ${checksSummary(s)}`);
        if (s.reasons.length) print(`    reasons: ${s.reasons.join(", ")}`);
        const mn = modelNote(s);
        if (mn) print(mn);
      }
      const advisory = atRiskNodeAdvisory();
      if (advisory) print(`advisory: ${advisory}`);
      return 0;
    }

    case "run": {
      const specStrategyError = "claudexor: --spec requires a gated strategy; use 'claudexor race --spec <file>' or 'claudexor run --attempts N --spec <file>'";
      const modeStr = flagStr(args, "mode");
      if (modeStr !== undefined) {
        const mode = normalizeMode(modeStr);
        if (!MODES.has(mode)) {
          return printUsageError(json, `claudexor: unknown --mode '${modeStr}'. valid: ${[...MODES].join(", ")}`);
        }
        if ((mode === "ask" || mode === "audit") && flagStr(args, "spec")) {
          return printUsageError(json, specStrategyError);
        }
        return orchestrate(args, mode, json);
      }
      if (flagStr(args, "spec") && !flagBool(args, "until-clean")) {
        let hasGatedStrategy = false;
        try {
          hasGatedStrategy = intFlag(args, "attempts") !== undefined || intFlag(args, "n") !== undefined;
        } catch (err) {
          return printUsageError(json, `claudexor: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!hasGatedStrategy) return printUsageError(json, specStrategyError);
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

    case "models":
      return modelsCommand(args, json);

    case "secrets":
      return secretsCommand(args, json);

    case "mcp": {
      if (args._[1] === "serve") {
        await new McpServer({
          version: CLAUDEXOR_VERSION,
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
          version: CLAUDEXOR_VERSION,
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
      // Resolve the owning store from any cwd: project store, user-level Ask
      // store, or a daemon-tracked run that started in another project.
      const resolved = await resolveRunStore(runId);
      if (!resolved) {
        if (json) printJson({ runId, error: `no such run ${runId}` });
        else print(`no such run ${runId}`);
        return 1;
      }
      const store = resolved.store;
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
        ? telemetry.attempts.flatMap((a) => a.tool_errors.filter((e) => !e.recovered && e.kind === "web").map((e) => ({ attemptId: a.attempt_id, tool: e.tool, target: e.target ?? undefined, summary: e.summary })))
        : [];
      const toolWarnings = telemetry
        ? telemetry.attempts.flatMap((a) =>
            a.tool_errors
              .filter((e) => !e.recovered && e.kind !== "web")
              .map((e) => ({ attemptId: a.attempt_id, tool: e.tool, target: e.target ?? undefined, summary: e.summary })),
          )
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
        printJson({ runId, runDir: paths.root, outputReadyState, contract: contract.success ? contract.data : null, telemetry, toolErrors, toolWarnings, primaryOutput: primary, decision, work_product: workProduct, artifacts });
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
        const vb = parsedDecision.data.verification_basis;
        print(`decision: ${parsedDecision.data.status} outcome=${parsedDecision.data.outcome} apply=${parsedDecision.data.apply_recommendation}${vb !== "none" ? ` verified_by=${vb}` : ""}`);
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
      if (toolWarnings.length) {
        print("tool warnings (non-blocking):");
        for (const err of toolWarnings.slice(-8)) print(`  - ${err.attemptId} ${err.tool}: ${err.summary}${err.target ? ` (${err.target})` : ""}`);
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
      // Resolve the owning store from any cwd (project / user Ask / daemon-tracked
      // run in another project) before reading the patch artifact.
      const resolved = await resolveRunStore(runId);
      if (!resolved) {
        if (json) printJson({ runId, error: `no such run ${runId}` });
        else print(`no such run ${runId}`);
        return 1;
      }
      const store = resolved.store;
      const paths = store.runPaths(runId);
      const patch = readTextSafe(join(paths.finalDir, "patch.diff"));
      if (!patch || patch.trim().length === 0) {
        if (json) printJson({ runId, error: `no patch found for run ${runId}` });
        else print(`no patch found for run ${runId}`);
        return 1;
      }
      if (containsSecretLikeToken(patch)) {
        if (json) printJson({ runId, error: "patch contains secret-like token; refusing apply" });
        else print("patch contains secret-like token; refusing apply");
        return 1;
      }
      // Apply policy has ONE owner (delivery.validateApplyGate) shared with the
      // Control API; the CLI only adapts artifact reads into it. No duplicated
      // pre-checks here: a NEEDS_HUMAN run unblocked through the typed decision
      // endpoint (arbitration/operator_decision.yaml, hash-bound) must apply
      // identically from BOTH surfaces.
      const applyDecision = DecisionRecord.safeParse(store.readYaml(join(paths.arbitrationDir, "decision.yaml")));
      const workProduct = WorkProduct.safeParse(store.readYaml(join(paths.finalDir, "work_product.yaml")));
      const contract = TaskContract.safeParse(store.readYaml(join(paths.contextDir, "task.yaml")));
      const operatorDecisionRaw = store.readYaml(join(paths.arbitrationDir, "operator_decision.yaml")) as Record<string, unknown> | null;
      const operatorDecision =
        operatorDecisionRaw && typeof operatorDecisionRaw["action"] === "string"
          ? {
              action: operatorDecisionRaw["action"] as string,
              patch_sha256: typeof operatorDecisionRaw["patch_sha256"] === "string" ? (operatorDecisionRaw["patch_sha256"] as string) : undefined,
            }
          : null;
      // The default apply target is the run's ORIGINAL project (from its contract),
      // not the current working directory — so a daemon-tracked run resolved via
      // the registry applies correctly from any cwd (CLI1 namespace unification).
      // Fall back to cwd only for a legacy run with no readable contract.
      const applyRoot = contract.success ? contract.data.repo.root : process.cwd();
      // Artifact-only path: the live daemon job state is unavailable, but the
      // orchestrator records the terminal run status in work_product.meta.status.
      // Feed it (mapped to daemon-state vocab) into the shared gate so the CLI
      // enforces the SAME terminal-state bar the Control API does — e.g. a
      // convergence run that persists decision.status=success but terminal
      // not_converged (stale diff after a D2 review) is refused identically.
      const recordedStatus = workProduct.success ? (workProduct.data.meta?.["status"] as string | undefined) : undefined;
      const recordedState = recordedStatus ? (recordedStatus === "success" ? "succeeded" : recordedStatus) : null;
      const gateError = validateApplyGate({
        state: recordedState,
        decision: applyDecision.success ? applyDecision.data : null,
        workProduct: workProduct.success ? workProduct.data : null,
        patch,
        originalRepoRoot: contract.success ? contract.data.repo.root : null,
        targetRepoRoot: applyRoot,
        operatorDecision,
      });
      if (gateError) {
        if (json) printJson({ runId, error: gateError });
        else print(gateError);
        return 1;
      }
      if (flagBool(args, "dry-run")) {
        const r = await checkPatch(applyRoot, patch);
        if (json) printJson({ runId, dryRun: true, applies: r.ok, ...(r.ok ? {} : { error: r.stderr.trim() }) });
        else print(r.ok ? "patch applies cleanly" : `patch does not apply: ${r.stderr.trim()}`);
        return r.ok ? 0 : 1;
      }
      const rawMode = flagStr(args, "mode") ?? "apply";
      if (!DELIVER_MODES.has(rawMode as DeliverMode)) {
        if (json) printJson({ runId, error: `unsupported apply mode: ${rawMode}` });
        else print(`unsupported apply mode: ${rawMode}`);
        return 2;
      }
      // `apply` mutates the tree; `artifact_only` produces no mutation and the
      // patch artifact was already emitted by the run — reject it here (it stays
      // valid on the control-api for clients that want a dry materialization).
      if (rawMode === "artifact_only") {
        const msg = "apply --mode artifact_only is a no-op (the patch artifact already exists at <runDir>/final/patch.diff); use apply|branch|commit|pr to mutate, or read the artifact directly";
        if (json) printJson({ runId, error: msg });
        else print(msg);
        return 2;
      }
      const mode = rawMode as DeliverMode;
      const res = await deliver(applyRoot, patch, { mode, message: `claudexor: apply ${runId}` });
      if (json) printJson(res);
      else
        print(
          `${res.mode}: applied=${res.applied}` +
            (res.commit ? ` commit=${res.commit.slice(0, 8)}` : "") +
            (res.branch ? ` branch=${res.branch}` : "") +
            (res.detail ? ` (${res.detail})` : ""),
        );
      return res.applied ? 0 : 1;
    }

    case "decision":
      return decisionCommand(args, json);

    case "release": {
      if (args._[1] === "check-name") {
        const name = args._[2] ?? "claudexor";
        const checks = await checkName(name);
        if (json) printJson({ name, checks });
        else {
          print(`naming gate for "${name}":`);
          for (const c of checks) {
            const tag = c.availability === "free" ? "[free]   " : c.availability === "taken" ? "[taken]  " : "[unknown]";
            print(`  ${tag} ${c.registry}: ${c.detail}`);
          }
        }
        return 0;
      }
      print("usage: claudexor release check-name <name>");
      return 2;
    }

    case "plugin": {
      const sub = args._[1];
      const target = args._[2];
      const dryRun = flagBool(args, "dry-run");
      if (!sub || !PLUGIN_VERBS.includes(sub as PluginVerb)) {
        const error = "usage: claudexor plugin <install|status|doctor|repair|uninstall> <cursor|claude|codex|opencode|all> [--dry-run] [--force] [--json]";
        if (json) printJson(pluginCommandErrorResult(sub, target, dryRun, 2, error));
        else print(error);
        return 2;
      }
      if (!target || !PLUGIN_TARGETS.includes(target as PluginTarget)) {
        const error = `claudexor: unknown plugin target '${target ?? ""}' (expected ${PLUGIN_TARGETS.join("|")})`;
        if (json) printJson(pluginCommandErrorResult(sub, target, dryRun, 2, error));
        else process.stderr.write(`${error}\n`);
        return 2;
      }
      if (args._.length > 3) {
        const error = `claudexor: unexpected plugin argument(s): ${args._.slice(3).join(" ")}`;
        if (json) printJson(pluginCommandErrorResult(sub, target, dryRun, 2, error));
        else process.stderr.write(`${error}\n`);
        return 2;
      }
      try {
        const r = await runPluginCommand(sub as PluginVerb, target as PluginTarget, {
          dryRun,
          force: flagBool(args, "force"),
          json,
        });
        if (json) printJson(r);
        else print(formatPluginResult(r));
        return r.exitCode;
      } catch (err) {
        if (json) {
          printJson(pluginCommandErrorResult(sub, target, dryRun, 1, err instanceof Error ? err.message : String(err)));
          return 1;
        }
        throw err;
      }
    }

    case "harness": {
      const sub = args._[1];
      if (sub === "list") {
        // Fakes are test fixtures, not real harnesses; `--all` reveals them.
        const includeFakes = flagBool(args, "all");
        const ids = [...buildRegistry({ includeFakes }).keys()];
        if (json) printJson({ harnesses: ids });
        else ids.forEach((id) => print(id));
        return 0;
      }
      print("usage: claudexor harness list [--all]");
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
