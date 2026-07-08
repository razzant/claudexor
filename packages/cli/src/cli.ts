#!/usr/bin/env node
import process from "node:process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { Orchestrator } from "@claudexor/orchestrator";
import { ArtifactStore } from "@claudexor/artifact-store";
import {
  DELIVER_MODES,
  type DeliverMode,
  checkPatch,
  deliver,
  validateApplyGate,
} from "@claudexor/delivery";
import {
  CLAUDEXOR_VERSION,
  containsSecretLikeToken,
  ensureDir,
  newId,
  noProjectRepoRoot,
  readTextSafe,
  sha256,
  userConfigDir,
  writeJson,
} from "@claudexor/util";
import { checkName } from "./release.js";
import { defaultClaudexorTools, serveClaudexorMcp } from "@claudexor/mcp-server";
import { AcpServer } from "@claudexor/acp-server";
import { initProjectConfig, loadConfig, updateGlobalConfig } from "@claudexor/config";
import { atRiskNodeAdvisory, validateModel } from "@claudexor/core";
import {
  DecisionRecord,
  EffortHint,
  ExternalContextPolicy,
  GlobalConfig,
  type ProtectedPathApproval,
  type ControlReviewerPanelEntry,
  type Attachment,
  ControlSettingsSnapshot,
  ModeKind as ModeKindSchema,
  type OrchestrateAutonomy,
  Portfolio,
  type ModeKind,
  type ProviderFamily,
  RunTelemetry,
  TaskContract,
  WorkProduct,
} from "@claudexor/schema";
import {
  commandAllowedFlagError,
  commandScopedFlagError,
  flagBool,
  flagStr,
  flagStringList,
  flagValues,
  parseArgs,
  requiredStringFlagError,
  type ParsedArgs,
} from "./args.js";
import { authSourceAvailability, checksSummary, print, printJson, printUsageError, statusGlyph } from "./cli-io.js";
import { authCommand, daemonCommand, modelsCommand, secretsCommand } from "./ops-commands.js";
import { reviewCommand } from "./review-command.js";
import { followRun, formatRunEventLine, promptQuestionsOnTty } from "./live.js";
import { assertCliRunParamsHaveNoInlineSecrets } from "./run-secret-scan.js";
import {
  connectDaemonIfRunning,
  daemonOutcomeSummary,
  ensureDaemon,
  enqueueAndAwait,
  exitCodeForState,
} from "./daemon-run.js";
import { resolveDecisionBody } from "./decision.js";
import { primaryOutputForCli } from "./primary-output.js";
import {
  PLUGIN_TARGETS,
  PLUGIN_VERBS,
  formatPluginResult,
  pluginCommandErrorResult,
  runPluginCommand,
  type PluginTarget,
  type PluginVerb,
} from "./plugins.js";
import { buildGateway, buildRegistry, harnessModels } from "./registry.js";
import { mcpSurfaceRunner, orchestratorRunner } from "./mcp-runner.js";
import { settingsCommand } from "./settings-command.js";
import { trustCommand } from "./trust-command.js";
import {
  extractQuestionsFromPlan,
  freezeSpecFromGrounding,
  loadFrozenSpec,
  loadPreviousSpec,
  persistSpec,
  readAnswers,
  resolveRunTestCommands,
  type SpecCommandResult,
} from "./spec.js";
import { parseAutonomy } from "./orchestrate-options.js";
import { runRepl } from "./repl.js";
import {
  parseProtectedPathApprovalFlags,
  parseTestCommandFlags,
  parseReviewerEffortFlags,
  parseReviewerModelFlags,
  parseReviewerPanelFlags,
} from "./run-options.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

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
  claudexor review --diff <file>          Reviewer-panel review of a diff file (per-commit gate)
  claudexor inspect <run_id>              Inspect a run's decision + artifacts
  claudexor follow <run_id> [--json]      Live-tail a daemon run (replay + push; answer questions in the TTY)
  claudexor apply <run_id> [--mode ...]   Apply a run's WorkProduct (apply|commit|branch|pr|--dry-run)
  claudexor decision <run_id> <action>    Decide a blocked run: --accept-risk|--override|--revert|--accept-clean-patch [--apply-mode m]|--rerun --feedback "<text>"
  claudexor settings show|set             Show/update user defaults
  claudexor trust                         Show/update this repo's user-local trust
    --allow-full-access                   Permit access=full (unsandboxed) for this repo
    --revoke-full-access                  Revoke the full-access allow
    --access-default <profile>            readonly|workspace_write default for write modes
  claudexor auth status|login             Inspect native harness auth
  claudexor secrets list|set|delete       Manage stored API-key refs (Keychain/0600 file)
  claudexor release check-name <name>     Naming gate (npm/pypi/crates/github)
  claudexor daemon start|status|stop|logs|rotate-token Optional local daemon (claudexord)
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
  --test "<cmd>"           Deterministic gate command(s); repeat flag or separate with ';;'
  --allow-protected-path <glob[,glob...]>  Explicitly approve protected gate/test path changes for this run
  --max-usd <amount>       Hard per-run spend cap (USD)
  --max-tool-calls <n>     Orchestrate executor: cap on plan tool calls
  --diff <file>            Diff file for the review verb (per-commit gate)
  --intent "<text>"        Review intent context for the review verb
  --tests "<evidence>"     Test evidence text for the review verb
  --reviewer-panel <list>  Explicit reviewers, e.g. "claude=claude-opus-4-8:max,cursor=gemini-3.1-pro,cursor=gemini-3.5-flash,cursor=gpt-5.5-extra-high"
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
  const values = flagStringList(args, "harness");
  return values.length > 0 ? values : undefined;
}

/** Invalid numeric flag values FAIL LOUDLY: `--n abc` must never silently run with the default. */
function intFlag(args: ParsedArgs, key: string): number | undefined {
  const v = flagStr(args, key);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || String(n) !== v.trim())
    throw new Error(`invalid --${key} '${v}' (expected an integer)`);
  return n;
}

function floatFlag(args: ParsedArgs, key: string): number | undefined {
  const v = flagStr(args, key);
  if (v === undefined) return undefined;
  // Number() parses the WHOLE string ('1abc' -> NaN), unlike parseFloat.
  const n = Number(v.trim());
  if (!Number.isFinite(n) || n < 0 || v.trim() === "")
    throw new Error(`invalid --${key} '${v}' (expected a non-negative number)`);
  return n;
}

/** Deterministic gate commands from `--test "<cmd>"`; repeat flag or separate with `;;`. */
function testCommands(args: ParsedArgs): string[] | undefined {
  return parseTestCommandFlags(flagValues(args, "test"));
}

/** Typed approval for protected gate/test path changes; never inferred from prompt text. */
function protectedPathApprovals(args: ParsedArgs): ProtectedPathApproval[] | undefined {
  return parseProtectedPathApprovalFlags(flagValues(args, "allow-protected-path"));
}

const ACCESS_PROFILES = new Set([
  "readonly",
  "workspace_write",
  "full",
  "external_sandbox_full",
  "inherit_native",
]);

/** Access profile from `--access`. Invalid profiles FAIL LOUDLY (a typo must never silently run with the default write profile). */
function accessProfile(
  args: ParsedArgs,
):
  | "readonly"
  | "workspace_write"
  | "full"
  | "external_sandbox_full"
  | "inherit_native"
  | undefined {
  const v = flagStr(args, "access");
  if (v === undefined) return undefined;
  if (!ACCESS_PROFILES.has(v)) {
    throw new Error(
      `invalid --access '${v}' (expected readonly|workspace_write|full|external_sandbox_full|inherit_native)`,
    );
  }
  return v as never;
}

function effortHint(args: ParsedArgs): EffortHint | undefined {
  const v = flagStr(args, "effort");
  if (v === undefined) return undefined;
  const parsed = EffortHint.safeParse(v);
  if (!parsed.success)
    throw new Error(`invalid --effort '${v}' (expected low|medium|high|xhigh|max)`);
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
  for (const [key, forceImage] of [
    ["attach", false],
    ["image", true],
  ] as const) {
    for (const path of flagStringList(args, key)) values.push({ path, forceImage });
  }
  return values;
}

function imageMimeFor(path: string): string | null {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return null;
  }
}

function attachmentInputs(
  args: ParsedArgs,
): { kind: "image" | "file"; mime: string; name: string; path: string }[] | undefined {
  const out = attachmentPaths(args).map(({ path, forceImage }) => {
    const resolved = resolve(path);
    if (!existsSync(resolved) || !lstatSync(resolved).isFile())
      throw new Error(`attachment must be an existing file: ${path}`);
    const imageMime = imageMimeFor(resolved);
    const kind = forceImage || imageMime ? ("image" as const) : ("file" as const);
    return {
      kind,
      mime: imageMime ?? "application/octet-stream",
      name: basename(resolved),
      path: resolved,
    };
  });
  return out.length > 0 ? out : undefined;
}

function attachmentsFromInputs(
  inputs: ReturnType<typeof attachmentInputs>,
): Attachment[] | undefined {
  return inputs?.map((a) => ({
    id: newId("att"),
    kind: a.kind,
    mime: a.mime,
    name: a.name,
    path: a.path,
  }));
}

/** Per-family reviewer model map from `--reviewer-model "openai=gpt-4o-mini,anthropic=claude-haiku"`. Fails loudly on malformed input. */
function reviewerModels(args: ParsedArgs): Partial<Record<ProviderFamily, string>> | undefined {
  return parseReviewerModelFlags(flagValues(args, "reviewer-model"));
}

/** Per-family reviewer effort map from `--reviewer-effort "openai=xhigh,anthropic=high"`. */
function reviewerEfforts(
  args: ParsedArgs,
): Partial<Record<ProviderFamily, EffortHint>> | undefined {
  return parseReviewerEffortFlags(flagValues(args, "reviewer-effort"));
}

/** Ordered explicit reviewer panel from `--reviewer-panel "claude=claude-opus-4-8:max,cursor=gpt-5.5-extra-high"`. */
function reviewerPanel(args: ParsedArgs): ControlReviewerPanelEntry[] | undefined {
  return parseReviewerPanelFlags(flagValues(args, "reviewer-panel"));
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
        ...(loadedSpec.spec.success_criteria.length
          ? loadedSpec.spec.success_criteria.map((c) => `- [${c.id}] ${c.behavior}`)
          : ["- (none)"]),
        "",
        "## Non-goals",
        ...(loadedSpec.spec.non_goals.length
          ? loadedSpec.spec.non_goals.map((x) => `- ${x}`)
          : ["- (none)"]),
        "",
        "## Forbidden approaches",
        ...(loadedSpec.spec.forbidden_approaches.length
          ? loadedSpec.spec.forbidden_approaches.map((x) => `- ${x}`)
          : ["- (none)"]),
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
  let reviewerEffortOverrides: Partial<Record<ProviderFamily, EffortHint>> | undefined;
  let resolvedReviewerModels: Partial<Record<ProviderFamily, string>> | undefined;
  let resolvedReviewerPanel: ControlReviewerPanelEntry[] | undefined;
  let resolvedWebPolicy: ReturnType<typeof webPolicy> = undefined;
  let resolvedAccess: ReturnType<typeof accessProfile> = undefined;
  let resolvedEffort: EffortHint | undefined;
  let maxUsd: number | undefined;
  let maxToolCalls: number | undefined;
  let nFlag: number | undefined;
  let attemptsFlag: number | undefined;
  let autonomy: OrchestrateAutonomy | undefined;
  let resolvedSynthesis: ReturnType<typeof synthesisMode> = undefined;
  let resolvedHarnesses: string[] | undefined;
  let resolvedPrimaryHarness: string | undefined;
  let resolvedModel: string | undefined;
  let attachments: Attachment[] | undefined;
  let attachmentRequest: ReturnType<typeof attachmentInputs> | undefined;
  let resolvedProtectedPathApprovals: ProtectedPathApproval[] | undefined;
  try {
    reviewerEffortOverrides = reviewerEfforts(args);
    resolvedReviewerModels = reviewerModels(args);
    resolvedReviewerPanel = reviewerPanel(args);
    resolvedWebPolicy = webPolicy(args);
    resolvedAccess = accessProfile(args);
    resolvedEffort = effortHint(args);
    resolvedHarnesses = harnessList(args);
    resolvedPrimaryHarness = flagStr(args, "primary-harness");
    resolvedModel = flagStr(args, "model");
    maxUsd = floatFlag(args, "max-usd");
    maxToolCalls = intFlag(args, "max-tool-calls");
    nFlag = intFlag(args, "n");
    attemptsFlag = intFlag(args, "attempts");
    autonomy = parseAutonomy(flagStr(args, "autonomy"));
    resolvedSynthesis = synthesisMode(args);
    attachmentRequest = attachmentInputs(args);
    attachments = attachmentsFromInputs(attachmentRequest);
    resolvedProtectedPathApprovals = protectedPathApprovals(args);
  } catch (err) {
    return printUsageError(json, `claudexor: ${err instanceof Error ? err.message : String(err)}`);
  }
  let tests: string[] | undefined;
  try {
    const cliTests = testCommands(args) ?? [];
    tests = resolveRunTestCommands(cliTests, spec);
    assertCliRunParamsHaveNoInlineSecrets({
      prompt,
      attachments: attachmentRequest,
      mode,
      harnesses: resolvedHarnesses,
      primaryHarness: resolvedPrimaryHarness,
      model: resolvedModel,
      effort: resolvedEffort,
      reviewerPanel: resolvedReviewerPanel,
      reviewerModels: resolvedReviewerModels,
      reviewerEfforts: reviewerEffortOverrides,
      tests,
      protectedPathApprovals: resolvedProtectedPathApprovals,
      maxUsd,
      access: resolvedAccess,
      web: resolvedWebPolicy,
      externalContextPolicy: resolvedWebPolicy,
      synthesis: resolvedSynthesis,
      autonomy,
      specId: spec?.id,
      specHash: loadedSpec?.specHash,
      specPath: loadedSpec?.specPath,
    });
  } catch (err) {
    return printUsageError(json, `claudexor: ${err instanceof Error ? err.message : String(err)}`);
  }

  // `--autonomy` only governs the orchestrate brain's executor; on any other
  // mode it would silently do nothing, so reject it loudly (a misplaced flag is
  // an error, not a no-op).
  if (autonomy !== undefined && mode !== "orchestrate") {
    return printUsageError(
      json,
      `claudexor: --autonomy only applies to 'orchestrate' (got mode '${mode}')`,
    );
  }

  // The mutating run paths are DAEMON-TRACKED: they enqueue via the daemon
  // (auto-started if needed) so the control-api can see/unblock them and a
  // blocked run is unblockable through `claudexor decision`. This covers `agent`
  // and an `orchestrate` run that actually ACTS (auto_safe/auto_full execute the
  // plan against the tree). Read-only routes (ask/plan/audit and orchestrate in
  // the default `suggest` autonomy, where the plan IS the work product) have
  // nothing to apply or unblock, so they stay in-process.
  const orchestrateExecutes =
    mode === "orchestrate" && autonomy !== undefined && autonomy !== "suggest";
  // --max-tool-calls caps the orchestrate EXECUTOR's plan steps; on any other
  // mode it would be a silent no-op knob (INV-023) — refuse loudly.
  if (maxToolCalls !== undefined && mode !== "orchestrate") {
    return printUsageError(json, "claudexor: --max-tool-calls only applies to orchestrate runs");
  }
  if (mode === "agent" || orchestrateExecutes) {
    return daemonAgentRun(args, json, {
      mode,
      autonomy,
      prompt,
      tests,
      portfolio: portfolio?.success ? portfolio.data : undefined,
      maxUsd,
      maxToolCalls,
      reviewerPanel: resolvedReviewerPanel,
      reviewerModels: resolvedReviewerModels,
      reviewerEfforts: reviewerEffortOverrides,
      protectedPathApprovals: resolvedProtectedPathApprovals,
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
    reviewerPanel: resolvedReviewerPanel,
    reviewerModels: resolvedReviewerModels,
    reviewerEfforts: reviewerEffortOverrides,
  });
  // Ctrl-C on a direct (in-process) run cancels GRACEFULLY: abort the run
  // signal so harness children die via the process-group kill plumbing, gates
  // are skipped, and the run ends with a typed cancelled terminal — instead
  // of the node process dying and orphaning children + a terminal-less
  // events.jsonl (T3.1#8). A second Ctrl-C force-exits.
  const cancelController = new AbortController();
  let sigints = 0;
  const onSigint = (): void => {
    sigints += 1;
    if (sigints >= 2) process.exit(130);
    process.stderr.write("\ncancelling run (Ctrl-C again to force-quit)...\n");
    cancelController.abort();
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigint);
  try {
    const res = await orch.run({
      repoRoot: process.cwd(),
      prompt: prompt || "audit this repository",
      attachments,
      mode,
      signal: cancelController.signal,
      // Only `suggest` (or unset) reaches the in-process path; auto_safe/auto_full
      // are routed to the daemon above. Forward it so an explicit --autonomy
      // suggest is honoured rather than silently dropped.
      ...(autonomy ? { autonomy } : {}),
      harnesses: resolvedHarnesses,
      primaryHarness: resolvedPrimaryHarness,
      portfolio: portfolio?.success ? portfolio.data : undefined,
      n: forced.race === true ? (nFlag ?? 2) : nFlag,
      attempts: attemptsFlag ?? null,
      untilClean: flagBool(args, "until-clean"),
      swarm: forced.swarm === true || flagBool(args, "swarm"),
      create: forced.create === true || flagBool(args, "create"),
      tests,
      protectedPathApprovals: resolvedProtectedPathApprovals,
      maxUsd: maxUsd ?? null,
      maxToolCalls: maxToolCalls ?? null,
      access: resolvedAccess,
      web: resolvedWebPolicy,
      externalContextPolicy: resolvedWebPolicy,
      model: resolvedModel,
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
            onInteraction: (ctx) =>
              promptQuestionsOnTty(
                ctx.request.interaction_id,
                ctx.request.questions,
                ctx.timeoutAt,
              ),
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
    if (json)
      printJson({
        ok: false,
        exitCode: 1,
        error: `claudexor: ${err instanceof Error ? err.message : String(err)}`,
      });
    else process.stderr.write(`claudexor: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigint);
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
  maxToolCalls?: number;
  reviewerPanel: ControlReviewerPanelEntry[] | undefined;
  reviewerModels: Partial<Record<ProviderFamily, string>> | undefined;
  reviewerEfforts: Partial<Record<ProviderFamily, EffortHint>> | undefined;
  protectedPathApprovals: ProtectedPathApproval[] | undefined;
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
async function daemonAgentRun(
  args: ParsedArgs,
  json: boolean,
  p: DaemonRunParams,
): Promise<number> {
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
    ...(flagStr(args, "primary-harness")
      ? { primaryHarness: flagStr(args, "primary-harness") }
      : {}),
    ...(p.portfolio ? { portfolio: p.portfolio } : {}),
    ...(p.forced.race === true ? { n: p.nFlag ?? 2 } : p.nFlag !== undefined ? { n: p.nFlag } : {}),
    ...(p.attemptsFlag !== undefined ? { attempts: p.attemptsFlag } : {}),
    ...(flagBool(args, "until-clean") ? { untilClean: true } : {}),
    ...(p.forced.swarm === true || flagBool(args, "swarm") ? { swarm: true } : {}),
    ...(p.forced.create === true || flagBool(args, "create") ? { create: true } : {}),
    ...(p.resolvedSynthesis ? { synthesis: p.resolvedSynthesis } : {}),
    ...(p.tests ? { tests: p.tests } : {}),
    ...(p.protectedPathApprovals ? { protectedPathApprovals: p.protectedPathApprovals } : {}),
    ...(p.maxUsd !== undefined ? { maxUsd: p.maxUsd } : {}),
    ...(p.mode === "orchestrate" && p.maxToolCalls !== undefined ? { maxToolCalls: p.maxToolCalls } : {}),
    ...(p.resolvedAccess ? { access: p.resolvedAccess } : {}),
    ...(p.resolvedWebPolicy ? { web: p.resolvedWebPolicy } : {}),
    ...(flagStr(args, "model") ? { model: flagStr(args, "model") } : {}),
    ...(p.resolvedEffort ? { effort: p.resolvedEffort } : {}),
    ...(p.reviewerPanel ? { reviewerPanel: p.reviewerPanel } : {}),
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
      printJson({
        runId: out.runId,
        runDir: out.runDir,
        status: out.status,
        jobId: out.jobId,
        mode: p.mode,
        ...(out.error ? { error: out.error } : {}),
        ...(reason ? { summary: reason } : {}),
      });
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
      print(
        `  blocked (needs human): unblock with \`claudexor decision ${started.runId} --accept-risk\` or rerun with \`claudexor decision ${started.runId} --rerun --feedback "..."\``,
      );
    } else if (exitCodeForState(status) === 0) {
      print(`  apply with: claudexor apply ${started.runId}`);
    }
    return exitCodeForState(status);
  } catch (err) {
    if (json)
      printJson({
        ok: false,
        exitCode: 1,
        error: `claudexor: ${err instanceof Error ? err.message : String(err)}`,
      });
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
    return printUsageError(
      json,
      'usage: claudexor decision <run_id> --accept-risk | --override | --revert | --accept-clean-patch [--apply-mode <m>] | --rerun --feedback "<text>"',
    );
  }
  const resolved = resolveDecisionBody(args);
  if (!resolved.ok) {
    return printUsageError(json, `claudexor decision: ${resolved.message}`);
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
      print(
        `decision ${action} on ${runId}: ${accepted ? "accepted" : "rejected"} [${String(data["status"] ?? "?")}]`,
      );
      if (typeof data["newRunId"] === "string") print(`  new run: ${data["newRunId"]}`);
      if (typeof data["message"] === "string") print(`  ${data["message"]}`);
    }
    return data["accepted"] === true ? 0 : 1;
  } catch (err) {
    process.stderr.write(
      `claudexor decision: ${err instanceof Error ? err.message : String(err)}\n`,
    );
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
async function resolveRunStore(
  runId: string,
): Promise<{ store: ArtifactStore; root: string } | null> {
  // An id that fails the store's shape fence (separators, `..`) can never
  // name a run: report it as "no such run" through the normal typed path —
  // the fence must not turn a typo'd id into a raw crash that breaks --json
  // purity on inspect/apply/follow.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) return null;
  // 1. project cwd store
  const cwdStore = new ArtifactStore(process.cwd());
  if (existsSync(cwdStore.runPaths(runId).root))
    return { store: cwdStore, root: cwdStore.runPaths(runId).root };
  // 2. user-level (no-project Ask) store
  const userStore = new ArtifactStore(noProjectRepoRoot(), { claudexorDir: userConfigDir() });
  if (existsSync(userStore.runPaths(runId).root))
    return { store: userStore, root: userStore.runPaths(runId).root };
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
        if (existsSync(ds.runPaths(runId).root))
          return { store: ds, root: ds.runPaths(runId).root };
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
    return printUsageError(json, "claudexor: missing spec prompt");
  }
  if (containsSecretLikeToken(prompt)) {
    return printUsageError(
      json,
      "claudexor spec: prompt contains a secret-like token; specs are durable artifacts, so store secrets by ref and retry with a sanitized prompt",
    );
  }
  const answersPath = flagStr(args, "answers");
  try {
    const answers = answersPath ? readAnswers(answersPath) : null;
    let planRunId = answers?.planRunId ?? "";
    let planDir = answers?.planDir ?? "";
    let planText = planDir ? (readTextSafe(join(planDir, "final", "plan.md")) ?? "") : "";

    if (!planText) {
      if (answersPath) {
        throw new Error(
          "answers file does not contain a usable planDir/final/plan.md; re-run without --answers to generate a fresh questions file",
        );
      }
      const orch = new Orchestrator({
        registry: buildRegistry(),
        reviewerPanel: reviewerPanel(args),
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
        print(
          `answer with: claudexor spec ${JSON.stringify(prompt)} --answers ${questionsPath}${harnessList(args) ? ` --harness ${(harnessList(args) ?? []).join(",")}` : ""}`,
        );
      }
      return 0;
    }

    const spec = await freezeSpecFromGrounding(
      prompt,
      planText,
      answers ?? readAnswers(answersPath),
    );
    const persisted = persistSpec(
      process.cwd(),
      spec,
      planText,
      loadPreviousSpec(flagStr(args, "previous")),
    );
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

function printPreflightError(args: ParsedArgs, json: boolean, error: string): number {
  if (json && (args._[0] ?? "help") === "plugin") {
    printJson(pluginCommandErrorResult(args._[1], args._[2], flagBool(args, "dry-run"), 2, error));
    return 2;
  }
  return printUsageError(json, error);
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



/** Every flag any command accepts. Unknown flags FAIL LOUDLY: `--harnes codex` must never silently run all harnesses. */
const KNOWN_FLAGS = new Set([
  "harness",
  "allow-full-access",
  "revoke-full-access",
  "access-default",
  "mode",
  "n",
  "attempts",
  "until-clean",
  "swarm",
  "create",
  "synthesis",
  "test",
  "allow-protected-path",
  "max-usd",
  "max-tool-calls",
  "reviewer-panel",
  "reviewer-model",
  "reviewer-effort",
  "access",
  "web",
  "model",
  "effort",
  "primary-harness",
  "portfolio",
  "in-place",
  "autonomy",
  "answers",
  "previous",
  "spec",
  "attach",
  "image",
  "json",
  "all",
  "dry-run",
  "force",
  "from-env",
  "backend",
  // `decision` command action/option flags (subcommand-scoped).
  "accept-risk",
  "override",
  "revert",
  "accept-clean-patch",
  "apply-mode",
  "rerun",
  "feedback",
  "help",
  "version",
  // review verb (D18 per-commit gate)
  "diff",
  "intent",
  "tests",
]);

const VALUE_FLAGS = [
  "harness",
  "mode",
  "n",
  "attempts",
  "synthesis",
  "test",
  "allow-protected-path",
  "max-usd",
  "max-tool-calls",
  "reviewer-panel",
  "reviewer-model",
  "reviewer-effort",
  "access",
  "web",
  "model",
  "effort",
  "primary-harness",
  "portfolio",
  "autonomy",
  "answers",
  "previous",
  "spec",
  "attach",
  "image",
  "from-env",
  "backend",
  "apply-mode",
  "feedback",
  // review verb (D18 per-commit gate)
  "diff",
  "intent",
  "tests",
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
      else
        print(
          res.created ? `Created ${res.configPath}` : `Config already exists: ${res.configPath}`,
        );
      return 0;
    }

    case "doctor": {
      const cfg = loadConfig(cwd);
      const only = flagStr(args, "harness");
      const onlyList = only
        ? only
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      const gateway = buildGateway({ includeFakes: flagBool(args, "all") });
      // Scope discovery to the requested harness(es) (P14): a single-harness
      // query no longer probes every adapter (incl. paid smokes) just to filter.
      const statuses = await gateway.statusAll({ cwd }, onlyList);
      // An explicit --harness typo must FAIL LOUDLY, not silently succeed over an
      // empty list (the scoped probe returns nothing for an unknown id).
      if (onlyList) {
        const got = new Set(statuses.map((s) => s.id));
        const unknown = onlyList.filter((id) => !got.has(id));
        if (unknown.length)
          return printUsageError(
            json,
            `claudexor: unknown harness(es): ${unknown.join(", ")} (run \`claudexor harness list --all\`)`,
          );
      }
      const filtered = statuses;
      // B2: a configured default model that the harness does not recognize must
      // not be silently masked by a smoke that ran a DIFFERENT model. Validate
      // each harness's configured default against its model truth source (live
      // inventory or manifest hints via the shared harnessModels SSOT) and
      // surface a violation honestly as INVALID (strict D3 — no "unverified").
      const configuredChecks = new Map<
        string,
        { configured: string; check: ReturnType<typeof validateModel> }
      >();
      await Promise.all(
        filtered.map(async (s) => {
          const configured = cfg.global.harnesses[s.id]?.default_model ?? null;
          if (!configured) return;
          const truth = await harnessModels(s.id, process.cwd(), true);
          const check = validateModel(
            configured,
            truth.models.map((m) => m.id),
            truth.source === "api" ? "api" : "manifest",
          );
          configuredChecks.set(s.id, { configured, check });
        }),
      );
      const modelNote = (s: (typeof statuses)[number]): string | null => {
        const entry = configuredChecks.get(s.id);
        if (!entry || entry.check.status === "ok") return null;
        return `    model: INVALID — ${entry.check.message}`;
      };
      if (json) {
        printJson({
          harnesses: filtered.map((s) => ({
            ...s,
            configured_model: configuredChecks.get(s.id)?.configured ?? null,
            configured_model_check: configuredChecks.get(s.id)?.check ?? null,
          })),
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
      const specStrategyError =
        "claudexor: --spec requires a gated strategy; use 'claudexor race --spec <file>' or 'claudexor run --attempts N --spec <file>'";
      // ONE gate for both spellings: `run --spec` and `run --mode agent --spec`
      // must enforce the same gated-strategy requirement (a flag spelling must
      // never bypass a policy the bare verb enforces).
      const agentSpecGateError = (): string | null => {
        if (!flagStr(args, "spec") || flagBool(args, "until-clean")) return null;
        try {
          const hasGatedStrategy =
            intFlag(args, "attempts") !== undefined || intFlag(args, "n") !== undefined;
          return hasGatedStrategy ? null : specStrategyError;
        } catch (err) {
          return `claudexor: ${err instanceof Error ? err.message : String(err)}`;
        }
      };
      const modeStr = flagStr(args, "mode");
      if (modeStr !== undefined) {
        const mode = normalizeMode(modeStr);
        if (!MODES.has(mode)) {
          return printUsageError(
            json,
            `claudexor: unknown --mode '${modeStr}'. valid: ${[...MODES].join(", ")}`,
          );
        }
        if ((mode === "ask" || mode === "audit") && flagStr(args, "spec")) {
          return printUsageError(json, specStrategyError);
        }
        if (mode === "agent") {
          const gateError = agentSpecGateError();
          if (gateError) return printUsageError(json, gateError);
        }
        return orchestrate(args, mode, json);
      }
      const gateError = agentSpecGateError();
      if (gateError) return printUsageError(json, gateError);
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

    case "trust":
      return trustCommand(args, json);

    case "auth":
      return authCommand(args, json);

    case "models":
      return modelsCommand(args, json);

    case "secrets":
      return secretsCommand(args, json);

    case "mcp": {
      if (args._[1] === "serve") {
        // SDK-owned protocol core; mutating verbs are daemon-tracked, so a
        // run started from an MCP host is visible/unblockable like a CLI run.
        serveClaudexorMcp({
          version: CLAUDEXOR_VERSION,
          tools: defaultClaudexorTools(mcpSurfaceRunner()),
          transport: { read: process.stdin, write: process.stdout },
        });
        // Serve until stdin closes (the SDK handle owns the transport).
        await new Promise<void>((resolve) => process.stdin.once("close", resolve));
        return 0;
      }
      return printUsageError(json, "usage: claudexor mcp serve");
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
      return printUsageError(json, "usage: claudexor acp serve");
    }

    case "follow": {
      const runId = args._[1];
      if (!runId) {
        return printUsageError(json, "usage: claudexor follow <run_id>");
      }
      return followRun(runId, json);
    }

    case "review":
      return reviewCommand(args, json);

    case "inspect": {
      const runId = args._[1];
      if (!runId) {
        return printUsageError(json, "usage: claudexor inspect <run_id>");
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
      const primary = primaryOutputForCli(
        paths.root,
        contract.success ? contract.data.mode.kind : undefined,
      );
      // The CLI projects the orchestrator-owned telemetry artifact and NEVER
      // recomputes evidence from raw events (single-owner rule); a missing
      // artifact (legacy run) renders "telemetry unavailable".
      const parsedTelemetry = RunTelemetry.safeParse(
        store.readYaml(join(paths.finalDir, "telemetry.yaml")),
      );
      const telemetry = parsedTelemetry.success ? parsedTelemetry.data : null;
      const toolErrors = telemetry
        ? telemetry.attempts.flatMap((a) =>
            a.tool_errors
              .filter((e) => !e.recovered && e.kind === "web")
              .map((e) => ({
                attemptId: a.attempt_id,
                tool: e.tool,
                target: e.target ?? undefined,
                summary: e.summary,
              })),
          )
        : [];
      const toolWarnings = telemetry
        ? telemetry.attempts.flatMap((a) =>
            a.tool_errors
              .filter((e) => !e.recovered && e.kind !== "web")
              .map((e) => ({
                attemptId: a.attempt_id,
                tool: e.tool,
                target: e.target ?? undefined,
                summary: e.summary,
              })),
          )
        : [];
      const artifacts = listCliArtifacts(paths.root).filter((p) => !p.endsWith("/"));
      const outputReadyState =
        primary?.kind === "diagnostic"
          ? "diagnostic"
          : primary?.text.trim()
            ? "ready"
            : readTextSafe(join(paths.finalDir, "failure.yaml"))
              ? "diagnostic"
              : "finalizing";
      const parsedDecision = DecisionRecord.safeParse(decision);
      const summary = readTextSafe(join(paths.finalDir, "summary.md"));
      if (json) {
        printJson({
          runId,
          runDir: paths.root,
          outputReadyState,
          contract: contract.success ? contract.data : null,
          telemetry,
          toolErrors,
          toolWarnings,
          primaryOutput: primary,
          decision,
          work_product: workProduct,
          artifacts,
        });
        // exit-code parity with the text mode: read-only runs have no decision record
        return summary || primary ? 0 : 1;
      }
      print(`run ${runId} @ ${paths.root}`);
      if (contract.success) {
        print(`mode: ${contract.data.mode.kind}`);
        print(
          `access: requested=${contract.data.access.requested_profile} effective=${contract.data.access.effective_profile}`,
        );
      }
      if (telemetry) {
        print(
          `web: policy=${telemetry.external_context_policy} effective=${telemetry.effective_web_mode} required=${telemetry.web_required} evidence=${telemetry.web.status}`,
        );
      } else if (contract.success) {
        print(
          `web: policy=${contract.data.external_context.policy} required=${contract.data.external_context.web_required} evidence=unavailable (no telemetry.yaml)`,
        );
      }
      print(`output: ${outputReadyState}${primary ? ` ${primary.path}` : ""}`);
      if (parsedDecision.success) {
        const vb = parsedDecision.data.verification_basis;
        print(
          `decision: ${parsedDecision.data.status} outcome=${parsedDecision.data.outcome} apply=${parsedDecision.data.apply_recommendation}${vb !== "none" ? ` verified_by=${vb}` : ""}`,
        );
        const budget = parsedDecision.data.budget_summary;
        print(
          `budget: spend=${budget.spend_usd ?? "unknown"}${budget.estimated ? " estimated" : ""}`,
        );
      }
      if (telemetry && (telemetry.web.attempted || telemetry.web.required)) {
        print(
          `web evidence: status=${telemetry.web.status} tool=${telemetry.web.tool ?? "none"} target=${telemetry.web.target ?? "none"}${telemetry.web.error_summary ? ` error=${telemetry.web.error_summary}` : ""}`,
        );
      }
      if (toolErrors.length) {
        print("tool errors (unrecovered):");
        for (const err of toolErrors.slice(-8))
          print(
            `  - ${err.attemptId} ${err.tool}: ${err.summary}${err.target ? ` (${err.target})` : ""}`,
          );
      }
      if (toolWarnings.length) {
        print("tool warnings (non-blocking):");
        for (const err of toolWarnings.slice(-8))
          print(
            `  - ${err.attemptId} ${err.tool}: ${err.summary}${err.target ? ` (${err.target})` : ""}`,
          );
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
        return printUsageError(json, "usage: claudexor apply <run_id> [--mode apply|commit|branch|pr] [--dry-run]");
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
      const applyDecision = DecisionRecord.safeParse(
        store.readYaml(join(paths.arbitrationDir, "decision.yaml")),
      );
      const workProduct = WorkProduct.safeParse(
        store.readYaml(join(paths.finalDir, "work_product.yaml")),
      );
      const contract = TaskContract.safeParse(store.readYaml(join(paths.contextDir, "task.yaml")));
      const operatorDecisionRaw = store.readYaml(
        join(paths.arbitrationDir, "operator_decision.yaml"),
      ) as Record<string, unknown> | null;
      const operatorDecision =
        operatorDecisionRaw && typeof operatorDecisionRaw["action"] === "string"
          ? {
              action: operatorDecisionRaw["action"] as string,
              patch_sha256:
                typeof operatorDecisionRaw["patch_sha256"] === "string"
                  ? (operatorDecisionRaw["patch_sha256"] as string)
                  : undefined,
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
      const recordedStatus = workProduct.success
        ? (workProduct.data.meta?.["status"] as string | undefined)
        : undefined;
      const recordedState = recordedStatus
        ? recordedStatus === "success"
          ? "succeeded"
          : recordedStatus
        : null;
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
        if (json)
          printJson({
            runId,
            dryRun: true,
            applies: r.ok,
            ...(r.ok ? {} : { error: r.stderr.trim() }),
          });
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
        const msg =
          "apply --mode artifact_only is a no-op (the patch artifact already exists at <runDir>/final/patch.diff); use apply|branch|commit|pr to mutate, or read the artifact directly";
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
            const tag =
              c.availability === "free"
                ? "[free]   "
                : c.availability === "taken"
                  ? "[taken]  "
                  : "[unknown]";
            print(`  ${tag} ${c.registry}: ${c.detail}`);
          }
        }
        return 0;
      }
      return printUsageError(json, "usage: claudexor release check-name <name>");
    }

    case "plugin": {
      const sub = args._[1];
      const target = args._[2];
      const dryRun = flagBool(args, "dry-run");
      if (!sub || !PLUGIN_VERBS.includes(sub as PluginVerb)) {
        const error =
          "usage: claudexor plugin <install|status|doctor|repair|uninstall> <cursor|claude|codex|opencode|all> [--dry-run] [--force] [--json]";
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
          printJson(
            pluginCommandErrorResult(
              sub,
              target,
              dryRun,
              1,
              err instanceof Error ? err.message : String(err),
            ),
          );
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
      return printUsageError(json, "usage: claudexor harness list [--all]");
    }

    case "help":
      print(HELP);
      return 0;

    default:
      // Unknown command is an ERROR (exit 2), not a silent help print with
      // exit 0 — scripts must not mistake a typo'd verb for success.
      process.stderr.write(`claudexor: unknown command '${cmd}'\n\n${HELP}\n`);
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`claudexor: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
