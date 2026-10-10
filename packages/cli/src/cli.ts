#!/usr/bin/env node
import process from "node:process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ArtifactStore } from "@claudexor/artifact-store";
import { CLAUDEXOR_VERSION, noProjectRepoRoot, readTextSafe, userConfigDir } from "@claudexor/util";
import { resolveInstructions } from "./run-options.js";
import { releaseCommand } from "./release-command.js";
import { serveBeltBridge, serveMcpBridge } from "./bridge-serve.js";
import { dispatchAcpCommand } from "./acp-auth-command.js";
import { initProjectConfig } from "@claudexor/config";
import {
  DecisionRecord,
  AccessProfile,
  EFFORT_HINT_HELP,
  EffortHint,
  ProcessingPreference,
  RunExecution,
  ExternalContextPolicy,
  type ProtectedPathApproval,
  type ControlReviewerPanelEntry,
  ModeKind as ModeKindSchema,
  type PaidBudget,
  RoutingGoal,
  type ModeKind,
  type ProviderFamily,
  ControlThreadListResponse,
  RunFailure,
  RunTelemetry,
  StructuredOutputConformance,
  TaskContract,
  type TestCommandInvocation,
  type ResourceAttachmentRef,
  runOutcomeLabel,
} from "@claudexor/schema";
import {
  flagBool,
  flagStr,
  flagStringList,
  flagValues,
  parseArgs,
  requiredStringFlagError,
  type ParsedArgs,
} from "./args.js";
import { exitAfterOutputFlush } from "./cli-io.js";
import { print, printJson, printJsonLine, printUsageError, statusGlyph } from "./cli-io.js";
import { controlProblemError, minIntError, renderCliFailure, usageError } from "./cli-error.js";
import {
  cliOutputMode,
  type CliOutputMode,
  outputModeIsMachine,
  outputModeIsStream,
  renderOutputFailure,
  renderOutputUsageFailure,
} from "./output-mode.js";
import { handleHelpRequest } from "./command-help.js";
import { pickResumableThread } from "./thread-select.js";
import { KNOWN_FLAGS, VALUE_FLAGS, helpJson, renderHelp } from "./command-registry.js";
import {
  commandFlagScopeError,
  commandPositionalError,
  runModeFlagScopeError,
} from "./command-scope.js";
import { buildAgentCapabilityCatalog } from "./capabilities.js";
import { aboutJson, renderAbout } from "./about-command.js";
import { dispatchOpsCommand } from "./ops-commands.js";
import { reviewCommand } from "./review-command.js";
import { controlApiFetch, followRun } from "./live.js";
import { retryCommand, runAgainCommand } from "./retry-command.js";
import { assertCliRunParamsHaveNoInlineSecrets } from "./run-secret-scan.js";
import { resolveLocalAttachment, type LocalAttachment } from "./local-attachment.js";
import { uploadLocalAttachment } from "./attachment-upload.js";
import {
  connectDaemonIfRunning,
  daemonOutcomeSummary,
  ensureDaemon,
  enqueueAndAwait,
  exitCodeForState,
  fetchApplyEligibility,
  fetchCouncil,
  fetchRunDetail,
  fetchRunOutcomeFacts,
  projectOutcomeBanner,
  projectRunOutcomeFacts,
  mergeDaemonRunOutcome,
} from "./daemon-run.js";
import {
  inspectDelegationLines,
  projectDelegation,
  terminalDelegationLines,
} from "./delegation-output.js";
import { readRunFactsArtifact } from "./run-facts-projection.js";
import { projectTerminalRunOutput, terminalRunRequiredActionLines } from "./terminal-run-output.js";
import { runPlanQuestionLoop } from "./plan-question-loop.js";
import { resolveDecisionBody } from "./decision.js";
import { primaryOutputForCli } from "./primary-output.js";
import { pluginCommandErrorResult } from "./plugins.js";
import { pluginCommand } from "./plugin-cli.js";
import { settingsCommand } from "./settings-command.js";
import { accountResetCommand } from "./account-reset-command.js";
import { quotaCommand } from "./quota-command.js";
import { trustCommand } from "./trust-command.js";
import { projectCommand } from "./project-command.js";
import { remoteCommand } from "./remote-command.js";
import { setupCommand } from "./setup-attach-command.js";
import { harnessCommand } from "./harness-command.js";
import { runRepl } from "./repl.js";
import {
  stringFlagValues,
  parseProtectedPathApprovalFlags,
  parseTestCommandFlags,
  parseReviewerEffortFlags,
  parseReviewerModelFlags,
  parseReviewerPanelFlags,
  parseReviewFlags,
} from "./run-options.js";

const CLI_VERSION = CLAUDEXOR_VERSION;

const HELP = renderHelp(CLI_VERSION);

const MODES = new Set<ModeKind>(["ask", "plan", "agent"]);

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

/** Deterministic typed-argv gates from repeated `--test '["program","arg"]'`. */
function testCommands(args: ParsedArgs): TestCommandInvocation[] | undefined {
  return parseTestCommandFlags(flagValues(args, "test"));
}

/** Typed approval for protected gate/test path changes; never inferred from prompt text. */
function protectedPathApprovals(args: ParsedArgs): ProtectedPathApproval[] | undefined {
  return parseProtectedPathApprovalFlags(flagValues(args, "allow-protected-path"));
}

/** Access profile from `--access`. Invalid profiles FAIL LOUDLY (a typo must never silently run with the default write profile). */
function accessProfile(args: ParsedArgs): AccessProfile | undefined {
  const v = flagStr(args, "access");
  if (v === undefined) return undefined;
  if (!AccessProfile.options.includes(v as AccessProfile)) {
    throw new Error(`invalid --access '${v}' (expected ${AccessProfile.options.join("|")})`);
  }
  return AccessProfile.parse(v);
}

function effortHint(args: ParsedArgs): EffortHint | undefined {
  const v = flagStr(args, "effort");
  if (v === undefined) return undefined;
  const parsed = EffortHint.safeParse(v);
  if (!parsed.success) throw new Error(`invalid --effort '${v}' (expected a ${EFFORT_HINT_HELP})`);
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

function attachmentInputs(args: ParsedArgs): LocalAttachment[] | undefined {
  const out = attachmentPaths(args).map(({ path, forceImage }) =>
    resolveLocalAttachment(path, forceImage),
  );
  return out.length > 0 ? out : undefined;
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
  // prettier-ignore
  return parseReviewerPanelFlags(flagValues(args, "reviewer-panel"), flagValues(args, "reviewer-panel-json"));
}

async function orchestrate(
  args: ParsedArgs,
  mode: ModeKind,
  outputMode: CliOutputMode,
  forced: { deepScan?: boolean; create?: boolean; race?: boolean } = {},
): Promise<number> {
  let rawPrompt = args._.slice(1).join(" ").trim();
  // Headless prompt sources (W13): `-` reads the prompt from stdin; a file
  // beats retyping. Exactly ONE source — ambiguity is a usage error, never a
  // silent pick.
  const promptFile = flagStr(args, "prompt-file");
  if (promptFile !== undefined) {
    if (rawPrompt && rawPrompt !== "-") {
      return renderOutputUsageFailure(
        outputMode,
        "claudexor: pass either an inline prompt or --prompt-file, not both",
      );
    }
    try {
      rawPrompt = readFileSync(promptFile, "utf8").trim();
    } catch (err) {
      return renderOutputUsageFailure(
        outputMode,
        `claudexor: --prompt-file: cannot read ${promptFile}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (rawPrompt === "-") {
    rawPrompt = readFileSync(0, "utf8").trim();
    if (!rawPrompt) {
      return renderOutputUsageFailure(outputMode, "claudexor: stdin prompt (`-`) was empty");
    }
  }
  const prompt = rawPrompt;
  if (!prompt) {
    return renderOutputUsageFailure(outputMode, "claudexor: missing prompt");
  }
  const portfolioRaw = flagStr(args, "portfolio");
  if (portfolioRaw !== undefined) {
    return renderOutputUsageFailure(
      outputMode,
      "claudexor: --portfolio was removed in v2; use --routing-goal auto|quality|economy",
    );
  }
  const credentialProfileId = flagStr(args, "profile");
  const routingGoalRaw = flagStr(args, "routing-goal");
  const routingGoal = routingGoalRaw !== undefined ? RoutingGoal.safeParse(routingGoalRaw) : null;
  if (routingGoalRaw !== undefined && !routingGoal?.success) {
    return renderOutputUsageFailure(
      outputMode,
      `claudexor: unknown --routing-goal '${routingGoalRaw}'`,
    );
  }
  let reviewerEffortOverrides: Partial<Record<ProviderFamily, EffortHint>> | undefined;
  let resolvedReviewerModels: Partial<Record<ProviderFamily, string>> | undefined;
  let resolvedReviewerPanel: ControlReviewerPanelEntry[] | undefined;
  let review: boolean | undefined;
  let resolvedWebPolicy: ReturnType<typeof webPolicy> = undefined;
  let resolvedAccess: ReturnType<typeof accessProfile> = undefined;
  let resolvedEffort: EffortHint | undefined;
  let processingPreference: ProcessingPreference | undefined;
  let execution: RunExecution;
  let paidBudget: PaidBudget | undefined;
  let nFlag: number | undefined;
  let attemptsFlag: number | undefined;
  let delegate: boolean | undefined;
  let council: boolean | undefined;
  let resolvedSynthesis: ReturnType<typeof synthesisMode> = undefined;
  let resolvedHarnesses: string[] | undefined;
  let resolvedPrimaryHarness: string | undefined;
  let resolvedModel: string | undefined;
  let attachmentRequest: ReturnType<typeof attachmentInputs> | undefined;
  let resolvedProtectedPathApprovals: ProtectedPathApproval[] | undefined;
  let resolvedInstructions: string | undefined;
  let resolvedMaxSeconds: number | undefined;
  let resolvedMaxTurns: number | undefined;
  let resolvedDenyPaths: string[] | undefined;
  let resolvedOutputSchema: Record<string, unknown> | undefined;
  try {
    reviewerEffortOverrides = reviewerEfforts(args);
    resolvedReviewerModels = reviewerModels(args);
    resolvedReviewerPanel = reviewerPanel(args);
    review = parseReviewFlags(
      flagValues(args, "review"),
      flagValues(args, "no-review"),
      forced.race === true,
    );
    resolvedWebPolicy = webPolicy(args);
    resolvedAccess = accessProfile(args);
    resolvedEffort = effortHint(args);
    const processing = flagStr(args, "processing");
    processingPreference =
      processing === undefined ? undefined : ProcessingPreference.parse(processing);
    const scopePaths = stringFlagValues(flagValues(args, "scope-path"), "scope-path");
    execution = RunExecution.parse({
      isolation: flagBool(args, "in-place") ? "live" : "envelope",
      workspaceKind: flagStr(args, "workspace-kind"),
      ...(scopePaths.length ? { scopePaths } : {}),
    });
    resolvedHarnesses = harnessList(args);
    resolvedPrimaryHarness = flagStr(args, "primary-harness");
    resolvedModel = flagStr(args, "model");
    const maxUsd = floatFlag(args, "max-usd");
    paidBudget = maxUsd === undefined ? undefined : { kind: "finite", maxUsd };
    nFlag = intFlag(args, "n");
    // Structured min-value validation (GH #28): `--n 0` is a usage field error, not a Zod dump.
    if (nFlag !== undefined && nFlag < 1) throw minIntError("n", 1);
    attemptsFlag = intFlag(args, "attempts");
    if (attemptsFlag !== undefined && attemptsFlag < 1) throw minIntError("attempts", 1);
    delegate = flagBool(args, "delegate") ? true : undefined;
    council = flagBool(args, "council") ? true : undefined;
    resolvedSynthesis = synthesisMode(args);
    attachmentRequest = attachmentInputs(args);
    resolvedProtectedPathApprovals = protectedPathApprovals(args);
    resolvedInstructions = resolveInstructions(args);
    resolvedMaxSeconds = intFlag(args, "max-seconds");
    resolvedMaxTurns = intFlag(args, "max-turns");
    const denyPathFlags = flagStringList(args, "deny-path");
    resolvedDenyPaths = denyPathFlags.length > 0 ? denyPathFlags : undefined;
    const outputSchemaPath = flagStr(args, "output-schema");
    if (outputSchemaPath !== undefined) {
      let raw: string;
      try {
        raw = readFileSync(outputSchemaPath, "utf8");
      } catch (err) {
        throw new Error(
          `--output-schema: cannot read ${outputSchemaPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      let parsedSchema: unknown;
      try {
        parsedSchema = JSON.parse(raw);
      } catch {
        throw new Error(`--output-schema: ${outputSchemaPath} is not valid JSON`);
      }
      if (!parsedSchema || typeof parsedSchema !== "object" || Array.isArray(parsedSchema)) {
        throw new Error(`--output-schema: ${outputSchemaPath} must contain a JSON Schema object`);
      }
      resolvedOutputSchema = parsedSchema as Record<string, unknown>;
    }
  } catch (err) {
    // Projector: typed field errors / domain codes survive; a plain flag-parse Error is usage (exit 2).
    return renderOutputFailure(outputMode, err, {
      defaultCategory: "usage",
      messagePrefix: "claudexor:",
    });
  }
  let tests: TestCommandInvocation[] | undefined;
  try {
    const cliTests = testCommands(args) ?? [];
    tests = cliTests.length > 0 ? cliTests : undefined;
    assertCliRunParamsHaveNoInlineSecrets({
      prompt,
      instructions: resolvedInstructions,
      attachments: attachmentRequest,
      mode,
      harnesses: resolvedHarnesses,
      primaryHarness: resolvedPrimaryHarness,
      model: resolvedModel,
      effort: resolvedEffort,
      processingPreference,
      review,
      reviewerPanel: resolvedReviewerPanel,
      reviewerModels: resolvedReviewerModels,
      reviewerEfforts: reviewerEffortOverrides,
      tests,
      protectedPathApprovals: resolvedProtectedPathApprovals,
      paidBudget,
      access: resolvedAccess,
      web: resolvedWebPolicy,
      externalContextPolicy: resolvedWebPolicy,
      synthesis: resolvedSynthesis,
    });
  } catch (err) {
    // Preserves the typed `inline_secret_rejected` code (never echoing the token).
    return renderOutputFailure(outputMode, err, {
      defaultCategory: "usage",
      messagePrefix: "claudexor:",
    });
  }

  if (delegate && mode !== "agent") {
    return renderOutputUsageFailure(
      outputMode,
      `claudexor: --delegate is an agent strategy (got mode '${mode}')`,
    );
  }
  if (council && mode !== "plan") {
    return renderOutputUsageFailure(
      outputMode,
      `claudexor: --council is a plan strategy (got mode '${mode}')`,
    );
  }
  return daemonRun(args, outputMode, {
    mode,
    delegate,
    council,
    prompt: prompt || "audit this repository",
    instructions: resolvedInstructions,
    maxSeconds: resolvedMaxSeconds,
    maxTurns: resolvedMaxTurns,
    denyPaths: resolvedDenyPaths,
    outputSchema: resolvedOutputSchema,
    tests,
    paidBudget,
    routingGoal: routingGoal?.success ? routingGoal.data : undefined,
    credentialProfileId,
    review,
    reviewerPanel: resolvedReviewerPanel,
    reviewerModels: resolvedReviewerModels,
    reviewerEfforts: reviewerEffortOverrides,
    protectedPathApprovals: resolvedProtectedPathApprovals,
    resolvedWebPolicy,
    resolvedAccess,
    resolvedEffort,
    processingPreference,
    execution,
    resolvedSynthesis,
    resolvedHarnesses,
    resolvedPrimaryHarness,
    resolvedModel,
    nFlag,
    attemptsFlag,
    attachmentRequest,
    forced,
  });
}

interface DaemonRunParams {
  mode: ModeKind;
  delegate: boolean | undefined;
  council: boolean | undefined;
  prompt: string;
  instructions: string | undefined;
  maxSeconds: number | undefined;
  maxTurns: number | undefined;
  denyPaths: string[] | undefined;
  outputSchema: Record<string, unknown> | undefined;
  tests: TestCommandInvocation[] | undefined;
  paidBudget: PaidBudget | undefined;
  routingGoal: ReturnType<typeof RoutingGoal.parse> | undefined;
  credentialProfileId: string | undefined;
  review: boolean | undefined;
  reviewerPanel: ControlReviewerPanelEntry[] | undefined;
  reviewerModels: Partial<Record<ProviderFamily, string>> | undefined;
  reviewerEfforts: Partial<Record<ProviderFamily, EffortHint>> | undefined;
  protectedPathApprovals: ProtectedPathApproval[] | undefined;
  resolvedWebPolicy: ReturnType<typeof webPolicy>;
  resolvedAccess: ReturnType<typeof accessProfile>;
  resolvedEffort: EffortHint | undefined;
  processingPreference: ProcessingPreference | undefined;
  execution: RunExecution;
  resolvedSynthesis: ReturnType<typeof synthesisMode>;
  resolvedHarnesses: string[] | undefined;
  resolvedPrimaryHarness: string | undefined;
  resolvedModel: string | undefined;
  nFlag: number | undefined;
  attemptsFlag: number | undefined;
  attachmentRequest: ReturnType<typeof attachmentInputs> | undefined;
  forced: { deepScan?: boolean; create?: boolean; race?: boolean };
}

/**
 * All five product modes enter through the managed daemon and control API.
 * `--json` prints one stable `{ runId, runDir, status }` machine envelope.
 */
async function daemonRun(
  args: ParsedArgs,
  outputMode: CliOutputMode,
  p: DaemonRunParams,
): Promise<number> {
  const json = outputModeIsMachine(outputMode);
  const jsonStream = outputModeIsStream(outputMode);
  let client: Awaited<ReturnType<typeof ensureDaemon>>["client"];
  let addr: Awaited<ReturnType<typeof ensureDaemon>>["addr"];
  try {
    ({ client, addr } = await ensureDaemon());
  } catch (err) {
    // D-7 projector: one failure envelope with message/code (never a legacy
    // partial {ok,exitCode,error}). --json-stream stays valid NDJSON via the
    // compact-line stream option.
    return renderCliFailure(json || jsonStream, err, {
      messagePrefix: "claudexor:",
      stream: jsonStream,
    });
  }
  // Thread continuation (W13/D10): --thread <id> targets a thread explicitly;
  // --resume picks the most recently updated one. When a threadId is present
  // the run is enqueued through POST /threads/:id/turns (enqueueAndAwait routes
  // it there) — the ONE turn-creation path that owns scope, lineage, and the
  // continuation packet. POST /runs itself now refuses threadId.
  let threadId = flagStr(args, "thread");
  if (threadId === undefined && flagBool(args, "resume")) {
    try {
      const res = await controlApiFetch(addr, "/threads", {
        headers: { Authorization: `Bearer ${addr.token}` },
      });
      if (!res.ok) throw new Error(`GET /threads failed: ${res.status}`);
      // Parse through the typed DTO — the field is camelCase `updatedAt`, and a
      // hand-rolled `updated_at` read silently sorts undefined and throws.
      const list = ControlThreadListResponse.parse(await res.json());
      // Scope to the current project (D28): --resume must never cross into
      // another project's threads.
      const newest = pickResumableThread(list.threads, process.cwd());
      if (!newest) {
        // D-7 projector on the active surface: NDJSON stream keeps compact
        // lines; --json prints its one object; text goes to stderr.
        return renderCliFailure(
          json || jsonStream,
          new Error("--resume found no threads to continue in this project"),
          { messagePrefix: "claudexor:", stream: jsonStream },
        );
      }
      threadId = newest.id;
    } catch (err) {
      // Flatten any cause (transport error, a malformed-threads Zod parse) into a
      // single operational message so the exit code stays 1 and no raw Zod field
      // dump leaks; the projector owns the envelope on every surface.
      return renderCliFailure(
        json || jsonStream,
        new Error(
          `--resume could not list threads: ${err instanceof Error ? err.message : String(err)}`,
        ),
        { messagePrefix: "claudexor:", stream: jsonStream },
      );
    }
  }
  let attachmentRefs: ResourceAttachmentRef[] | undefined;
  try {
    attachmentRefs = p.attachmentRequest
      ? await Promise.all(
          p.attachmentRequest.map((attachment) => uploadLocalAttachment(addr, attachment)),
        )
      : undefined;
  } catch (err) {
    // D-7 projector: message/code envelope, NDJSON-safe. (Previously this branch
    // ignored --json-stream and fell through to a stderr line.)
    return renderCliFailure(
      json || jsonStream,
      new Error(`attachment upload failed: ${err instanceof Error ? err.message : String(err)}`),
      { messagePrefix: "claudexor:", stream: jsonStream },
    );
  }
  const body: Record<string, unknown> = {
    prompt: p.prompt,
    ...(p.instructions ? { instructions: p.instructions } : {}),
    ...(p.maxSeconds !== undefined ? { maxSeconds: p.maxSeconds } : {}),
    ...(p.maxTurns !== undefined ? { maxTurns: p.maxTurns } : {}),
    ...(p.denyPaths?.length ? { denyPaths: p.denyPaths } : {}),
    ...(p.outputSchema !== undefined ? { outputSchema: p.outputSchema } : {}),
    ...(attachmentRefs ? { attachments: attachmentRefs } : {}),
    mode: p.mode,
    ...(threadId ? { threadId } : {}),
    ...(p.delegate ? { delegate: true } : {}),
    ...(p.council ? { council: true } : {}),
    scope: { kind: "project", root: process.cwd() },
    execution: p.execution,
    ...(p.resolvedHarnesses ? { harnesses: p.resolvedHarnesses } : {}),
    ...(p.resolvedPrimaryHarness ? { primaryHarness: p.resolvedPrimaryHarness } : {}),
    ...(p.routingGoal ? { routingGoal: p.routingGoal } : {}),
    ...(p.credentialProfileId ? { credentialProfileId: p.credentialProfileId } : {}),
    ...(p.forced.race === true ? { n: p.nFlag ?? 2 } : p.nFlag !== undefined ? { n: p.nFlag } : {}),
    ...(p.attemptsFlag !== undefined ? { attempts: p.attemptsFlag } : {}),
    ...(flagBool(args, "until-clean") ? { untilClean: true } : {}),
    ...(p.forced.deepScan === true || flagBool(args, "deep-scan") ? { deepScan: true } : {}),
    ...(p.forced.create === true || flagBool(args, "create") ? { create: true } : {}),
    ...(p.resolvedSynthesis ? { synthesis: p.resolvedSynthesis } : {}),
    ...(p.tests ? { tests: p.tests } : {}),
    ...(p.protectedPathApprovals ? { protectedPathApprovals: p.protectedPathApprovals } : {}),
    ...(p.paidBudget !== undefined ? { paidBudget: p.paidBudget } : {}),
    ...(p.resolvedAccess ? { access: p.resolvedAccess } : {}),
    ...(p.resolvedWebPolicy ? { web: p.resolvedWebPolicy } : {}),
    ...(p.resolvedModel ? { model: p.resolvedModel } : {}),
    ...(p.resolvedEffort ? { effort: p.resolvedEffort } : {}),
    ...(p.processingPreference ? { processingPreference: p.processingPreference } : {}),
    ...(p.review !== undefined ? { review: p.review } : {}),
    ...(p.reviewerPanel ? { reviewerPanel: p.reviewerPanel } : {}),
    ...(p.reviewerModels ? { reviewerModels: p.reviewerModels } : {}),
    ...(p.reviewerEfforts ? { reviewerEfforts: p.reviewerEfforts } : {}),
  };

  // The last run id this command bound, threaded into the failure envelope as
  // a per-command extra: a run that DID start (or finish) must keep its handle
  // even when a post-terminal read raises (e.g. 500 run_facts_invalid).
  let terminalRunId = "";
  try {
    if (jsonStream) {
      // NDJSON machine surface (W13): an EARLY runId frame first, every run
      // event as its own line (the shared follow pipeline in json mode), and
      // the same terminal object --json prints as the LAST line. --json keeps
      // its exactly-one-object contract untouched.
      const started = await enqueueAndAwait(client, addr, body, { waitForTerminal: false });
      if (!started.runId) {
        // Even the early-failure path stays valid NDJSON (compact, one line).
        printJsonLine(projectTerminalRunOutput(started, p.mode, null, { frame: "run.terminal" }));
        return exitCodeForState(started.status);
      }
      terminalRunId = started.runId;
      printJsonLine({
        frame: "run.started",
        runId: started.runId,
        runDir: started.runDir,
        jobId: started.jobId,
        mode: p.mode,
      });
      // Per-event lines: followRun(json=true) already writes one COMPACT object
      // per event via print(JSON.stringify(ev)).
      await followRun(started.runId, true);
      const final = started.jobId ? await client.status(started.jobId) : null;
      const out = mergeDaemonRunOutcome(started, final);
      const status = out.status;
      const detail = await fetchRunDetail(addr, out.runId);
      const facts = projectRunOutcomeFacts(detail);
      const reason = daemonOutcomeSummary({ ...out, outcomeFacts: facts ?? undefined });
      printJsonLine(
        projectTerminalRunOutput(out, p.mode, detail, {
          frame: "run.terminal",
          summary: reason,
        }),
      );
      return exitCodeForState(status, projectRunOutcomeFacts(detail));
    }
    if (json) {
      // Pure machine surface: await the terminal outcome and print one JSON object.
      const out = await enqueueAndAwait(client, addr, body, { waitForTerminal: true });
      terminalRunId = out.runId;
      // ADD-ONLY key (bench contract keeps {runId,runDir,status}): the derived
      // apply-gate verdict, so machine callers act on truth instead of
      // re-implying eligibility from status. ONE GET /runs/:id feeds all three
      // terminal projections (INV-120/122).
      const detail = await fetchRunDetail(addr, out.runId);
      // Preserve bench keys while deriving the human summary from the same
      // canonical receipt that feeds the machine terminal fields.
      const reason = daemonOutcomeSummary({
        ...out,
        outcomeFacts: projectRunOutcomeFacts(detail) ?? undefined,
      });
      printJson(projectTerminalRunOutput(out, p.mode, detail, { summary: reason }));
      return exitCodeForState(out.status, projectRunOutcomeFacts(detail));
    }
    // Text mode: enqueue, then live-stream the run through the shared follow
    // pipeline (replay + push + interactive TTY question answering), then print
    // the honest terminal line + artifacts dir resolved from the daemon.
    const started = await enqueueAndAwait(client, addr, body, { waitForTerminal: false });
    if (!started.runId) {
      print(`run did not start: ${started.status}${started.error ? ` — ${started.error}` : ""}`);
      for (const line of terminalRunRequiredActionLines(started)) print(line);
      return exitCodeForState(started.status);
    }
    terminalRunId = started.runId;
    await followRun(started.runId, false);
    const final = started.jobId ? await client.status(started.jobId) : null;
    const out = mergeDaemonRunOutcome(started, final);
    const status = out.status;
    const publicStatus = status;
    print("");
    print(`run ${started.runId} [${publicStatus}]`);
    // Server-owned outcome headline (D18), printed verbatim above any output.
    const terminalDetail = await fetchRunDetail(addr, started.runId);
    const terminalBanner = projectOutcomeBanner(terminalDetail);
    if (terminalBanner) print(`  ${terminalBanner}`);
    for (const line of terminalDelegationLines(projectDelegation(terminalDetail))) print(line);
    print(`  artifacts: ${out.runDir}`);
    if (out.error) print(`  error: ${out.error}`);
    for (const line of terminalRunRequiredActionLines(out)) print(line);
    // A succeeded lifecycle exits 0 — INCLUDING a "Done · needs review" run
    // (review blocked / checks failed). The apply-eligibility verdict (state
    // needs_review) is the ONE source for the unblock guidance (D8).
    // The plan question loop advances this past each answered follow-up turn.
    let effectiveRunId = started.runId;
    if (exitCodeForState(status) === 0) {
      // Plan runs: server-derived readiness (D17) + interactive answer loop.
      if (p.mode === "plan") {
        if (p.council) {
          const council = await fetchCouncil(addr, started.runId);
          if (council) {
            print(
              `  council: merged by ${council.mergedBy ?? "(none)"}; ${council.drafted} of ${council.requested} contract-accepted draft(s)${council.degraded ? " (degraded)" : ""}`,
            );
            const failed = council.members.filter((m) => m.status === "failed");
            if (failed.length > 0) {
              print(
                `  council failures: ${failed.map((m) => `${m.harnessId}: ${m.error ?? "draft failed"}`).join("; ")}`,
              );
            }
          }
        }
        effectiveRunId = await runPlanQuestionLoop({
          client,
          addr,
          threadId,
          runId: started.runId,
          interactive: !json && !jsonStream, // TTY plan turns answer inline
        });
        terminalRunId = effectiveRunId;
      }
      // Offer apply only after a positive gate; otherwise print inspect/unblock guidance.
      const eligibility = await fetchApplyEligibility(addr, effectiveRunId);
      if (eligibility?.eligible) {
        print(`  apply with: claudexor apply ${effectiveRunId}`);
      } else if (eligibility?.state === "needs_review") {
        print(
          `  needs review: unblock with \`claudexor decision ${effectiveRunId} --accept-risk\` or rerun with \`claudexor decision ${effectiveRunId} --rerun --feedback "..."\``,
        );
      } else if (eligibility?.requiredAction) {
        print(`  not applyable yet: ${eligibility.requiredAction}`);
      } else {
        print(`  inspect with: claudexor inspect ${effectiveRunId}`);
      }
    }
    return exitCodeForState(status, await fetchRunOutcomeFacts(addr, effectiveRunId));
  } catch (err) {
    // D-7 projector: a typed control problem (code/retryable/context) survives
    // intact; --json-stream stays valid NDJSON via the compact-line stream option.
    // A run that already started keeps its handle in the envelope (extras).
    return renderCliFailure(json || jsonStream, err, {
      messagePrefix: "claudexor:",
      stream: jsonStream,
      ...(terminalRunId ? { extras: { runId: terminalRunId } } : {}),
    });
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
    const res = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}/decision`, {
      method: "POST",
      headers: { Authorization: `Bearer ${addr.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      // A typed decision rejection (revert_refused: tree diverged) rides through
      // the projector with its code/retryable/bounded git-stderr context intact.
      return renderCliFailure(
        json,
        controlProblemError(res.status, data, `decision failed (HTTP ${res.status})`),
        { messagePrefix: "claudexor decision:" },
      );
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
    return renderCliFailure(json, err, { messagePrefix: "claudexor decision:" });
  }
}

/**
 * Resolve the ArtifactStore that owns a given run, regardless of the cwd the
 * CLI is invoked from. Order:
 *   1. the project store rooted at the current cwd (the common case);
 *   2. the user store (~/.claudexor/v3/runs) used by no-project Ask runs;
 *   3. a daemon-tracked run that started in ANOTHER project — agent/race/create
 *      runs live under that project's external runtime namespace, so we ask
 *      the daemon for the run's absolute runDir (GET /runs/:id ->
 *      summary.runDir) and rebuild a store whose runPaths(runId).root matches.
 * Returns null when no store can be located (the run does not exist anywhere
 * reachable). Daemon absence falls through; a typed refusal (#93) propagates.
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
  const conn = await connectDaemonIfRunning(); // typed refusal (#93) propagates
  if (!conn) return null;
  const { addr } = conn;
  try {
    const resp = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}`, {
      headers: { Authorization: `Bearer ${addr.token}` },
    });
    if (resp.ok) {
      const detail = (await resp.json()) as { summary?: { runDir?: string } };
      const runDir = detail.summary?.runDir;
      if (runDir && existsSync(runDir)) {
        // Reconstruct a store from the daemon-authoritative absolute runDir:
        // runId -> runs -> owned runtime root.
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

function printPreflightError(args: ParsedArgs, outputMode: CliOutputMode, error: string): number {
  if (outputMode === "json" && (args._[0] ?? "help") === "plugin") {
    printJson(pluginCommandErrorResult(args._[1], args._[2], flagBool(args, "dry-run"), 2, error));
    return 2;
  }
  return renderOutputUsageFailure(outputMode, error);
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

// KNOWN_FLAGS / VALUE_FLAGS (imported above) and the per-command scope check
// are projections of the command registry. Unknown flags FAIL LOUDLY: `--harnes
// codex` must never silently run all harnesses.

async function dispatch(args: ParsedArgs, outputMode: CliOutputMode): Promise<number> {
  const cmd = args._[0] ?? "help";
  if (outputMode === "conflict") {
    return renderOutputUsageFailure(
      outputMode,
      "claudexor: --json prints exactly one object and --json-stream prints NDJSON; pass one, not both",
    );
  }
  const json = outputModeIsMachine(outputMode);
  // `--help` resolves the COMMAND first (QA-057): scoped usage for a known verb,
  // global help for a bare/`help` verb, a usage error (exit 2) for a typo.
  if (flagBool(args, "help")) return handleHelpRequest(cmd, args._.length, json, CLI_VERSION);
  const unknownFlags = Object.keys(args.flags).filter((f) => !KNOWN_FLAGS.has(f));
  if (unknownFlags.length > 0) {
    const error = `claudexor: unknown flag(s): ${unknownFlags.map((f) => `--${f}`).join(", ")} (see \`claudexor help\`)`;
    return printPreflightError(args, outputMode, error);
  }
  const valueFlagError = requiredStringFlagError(args, VALUE_FLAGS);
  if (valueFlagError) return printPreflightError(args, outputMode, valueFlagError);
  // Registry-enforced per-command flag scope: a KNOWN flag outside the
  // command's declared set (e.g. `plan --create`, `ask --force`) fails loudly
  // instead of being silently ignored. Data-driven from CLI_COMMANDS for
  // every verb (this replaced the old hand-listed plugin/--force special cases).
  const scopeError = commandFlagScopeError(cmd, Object.keys(args.flags));
  if (scopeError) return printPreflightError(args, outputMode, scopeError);
  const positionalError = commandPositionalError(cmd, args._.slice(1));
  if (positionalError) return printPreflightError(args, outputMode, positionalError);
  // No arguments at all = the interactive REPL: a thread of turns over the
  // current project with native session continuity (chat is the normal loop).
  if (args._.length === 0 && process.stdin.isTTY) {
    return runRepl(process.cwd());
  }
  const cwd = process.cwd();
  const opsCommand = dispatchOpsCommand(cmd, args, json);
  if (opsCommand) return opsCommand;

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

    case "project":
      return projectCommand(args, json);

    case "remote":
      return remoteCommand(args, json);

    case "setup":
      return setupCommand(args, json);

    case "agent": {
      const modeStr = flagStr(args, "mode");
      if (modeStr !== undefined) {
        const mode = normalizeMode(modeStr);
        if (!MODES.has(mode)) {
          return renderOutputUsageFailure(
            outputMode,
            `claudexor: unknown --mode '${modeStr}'. valid: ${[...MODES].join(", ")}`,
          );
        }
        const modeScopeError = runModeFlagScopeError(mode, Object.keys(args.flags));
        if (modeScopeError) return printPreflightError(args, outputMode, modeScopeError);
        return orchestrate(args, mode, outputMode);
      }
      return orchestrate(args, "agent", outputMode);
    }

    case "ask":
      return orchestrate(args, "ask", outputMode);

    case "best-of":
      return orchestrate(args, "agent", outputMode, { race: true });

    // RETIRED verb spellings hard-error with the new spelling — no silent
    // aliases (same doctrine as retired mode ids: stale scripts fail loudly).
    case "run":
    case "race":
    case "audit":
    case "map":
    case "explore":
    case "orchestrate":
    case "spec": {
      const replacement =
        cmd === "run"
          ? "claudexor agent (same flags)"
          : cmd === "race"
            ? "claudexor best-of (same flags)"
            : cmd === "orchestrate"
              ? "claudexor agent --delegate <prompt> (the harness spawns bounded isolated sub-runs; suggest-only planning is ordinary claudexor plan)"
              : cmd === "spec"
                ? "claudexor plan <prompt> then Implement (the plan lifecycle surfaces open questions and freezes the plan on implement)"
                : "claudexor ask --deep-scan <prompt>";
      return printPreflightError(
        args,
        outputMode,
        `claudexor: the '${cmd}' verb was retired; use ${replacement}`,
      );
    }

    case "plan":
      return orchestrate(args, "plan", outputMode);

    case "create":
      return orchestrate(args, "agent", outputMode, { create: true });

    case "settings":
      return settingsCommand(args, json);

    case "account-reset":
      return accountResetCommand(args, json);
    case "quota":
      return quotaCommand(args, json);

    case "trust":
      return trustCommand(args, json);

    case "mcp": {
      if (args._[1] === "serve") return serveMcpBridge();
      // Internal: the scoped delegation belt injected into a delegate agent
      // run's sandbox (D32). Not a user-facing verb.
      if (args._[1] === "serve-belt") return serveBeltBridge();
      return printUsageError(json, "usage: claudexor mcp serve");
    }

    case "acp": {
      return dispatchAcpCommand(args, json);
    }

    case "follow": {
      const runId = args._[1];
      if (!runId) {
        return printUsageError(json, "usage: claudexor follow <run_id>");
      }
      return followRun(runId, json);
    }

    case "retry":
      return retryCommand(args, json);

    case "run-again":
      return runAgainCommand(args, json);

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
        // D-7 projector: canonical envelope, run id as a per-command extra.
        return renderCliFailure(json, new Error(`no such run ${runId}`), { extras: { runId } });
      }
      const store = resolved.store;
      const paths = store.runPaths(runId);
      const decision = store.readYaml(join(paths.arbitrationDir, "decision.yaml"));
      const workProduct = store.readYaml(join(paths.finalDir, "work_product.yaml"));
      const contract = TaskContract.safeParse(store.readYaml(join(paths.contextDir, "task.yaml")));
      const parsedFailure = RunFailure.safeParse(
        store.readYaml(join(paths.finalDir, "failure.yaml")),
      );
      const failure = parsedFailure.success ? parsedFailure.data : null;
      // The CLI projects the orchestrator-owned telemetry artifact and NEVER
      // recomputes evidence from raw events (single-owner rule); a missing
      // artifact (legacy run) renders "telemetry unavailable".
      const parsedTelemetry = RunTelemetry.safeParse(
        store.readYaml(join(paths.finalDir, "telemetry.yaml")),
      );
      const telemetry = parsedTelemetry.success ? parsedTelemetry.data : null;
      // GH #29: inspect reads the same immutable receipt as GET and terminal JSON.
      const runFacts = readRunFactsArtifact(store, paths.finalDir, {
        runId,
        ...(contract.success ? { taskId: contract.data.task_id } : {}),
      });
      const primary = primaryOutputForCli(
        paths.root,
        contract.success ? contract.data.mode.kind : undefined,
        {
          failure,
          lifecycle: runFacts?.outcome.lifecycle,
          ...(runFacts?.presentation ? { presentation: runFacts.presentation } : {}),
        },
      );
      const inspectToolRecords = telemetry
        ? telemetry.attempts.flatMap((a) =>
            a.tool_errors
              .filter((e) => !e.recovered)
              .map((e) => ({
                blocking:
                  (a.outcome.status === "blocked" || a.outcome.status === "failed") &&
                  !(e.kind === "web" && !a.web.required),
                attemptId: a.attempt_id,
                tool: e.tool,
                target: e.target ?? undefined,
                summary: e.summary,
              })),
          )
        : [];
      const toolErrors = inspectToolRecords
        .filter((record) => record.blocking)
        .map(({ attemptId, tool, target, summary }) => ({ attemptId, tool, target, summary }));
      const toolWarnings = inspectToolRecords
        .filter((record) => !record.blocking)
        .map(({ attemptId, tool, target, summary }) => ({ attemptId, tool, target, summary }));
      const artifacts = listCliArtifacts(paths.root).filter((p) => !p.endsWith("/"));
      const outputReadyState =
        runFacts?.presentation?.state ??
        (primary?.kind === "diagnostic"
          ? "diagnostic"
          : primary?.text.trim()
            ? "ready"
            : (failure ?? readTextSafe(join(paths.finalDir, "failure.yaml")))
              ? "diagnostic"
              : "finalizing");
      const parsedDecision = DecisionRecord.safeParse(decision);
      const summary = readTextSafe(join(paths.finalDir, "summary.md"));
      if (json) {
        printJson({
          runId,
          runDir: paths.root,
          lifecycle: runFacts?.outcome.lifecycle ?? null,
          outputReadyState,
          contract: contract.success ? contract.data : null,
          telemetry,
          runFacts,
          failure,
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
      if (runFacts) print(`lifecycle: ${runFacts.outcome.lifecycle}`);
      if (contract.success) {
        print(`mode: ${contract.data.mode.kind}`);
        print(
          `access: requested=${contract.data.access.requested_profile} effective=${contract.data.access.effective_profile}`,
        );
      }
      for (const line of inspectDelegationLines(telemetry?.delegation ?? null)) print(line);
      if (telemetry) {
        print(
          `web: policy=${telemetry.external_context_policy} effective=${telemetry.effective_web_mode} required=${telemetry.web_required} evidence=${telemetry.web.status}`,
        );
        for (const requirement of telemetry.request_requirements.filter((item) => item.requested)) {
          print(
            `${requirement.capability}: harness=${requirement.harness_id} requested=true effective=${requirement.effective} reason=${requirement.reason}`,
          );
        }
      } else if (contract.success) {
        print(
          `web: policy=${contract.data.external_context.policy} required=${contract.data.external_context.web_required} evidence=unavailable (no telemetry.yaml)`,
        );
      }
      print(`output: ${outputReadyState}${primary ? ` ${primary.path}` : ""}`);
      if (failure) {
        print(
          `failure: ${failure.category}${failure.code ? `/${failure.code}` : ""} phase=${failure.phase}${failure.harnessId ? ` harness=${failure.harnessId}` : ""}${failure.vendorFailure?.code ? ` vendor_code=${failure.vendorFailure.code} (${failure.vendorFailure.source})` : ""}`,
        );
        print(`failure message: ${failure.safeMessage}`);
        for (const action of failure.nextActions) print(`next action: ${action}`);
      }
      {
        // Structured-output contract receipt (only present when the run was
        // started with --output-schema); projected, never re-validated here.
        const conformance = StructuredOutputConformance.safeParse(
          store.readYaml(join(paths.finalDir, "structured_output.yaml")),
        );
        if (conformance.success) {
          print(
            `structured output: ${conformance.data.status}${conformance.data.output_path ? ` ${conformance.data.output_path}` : ""}${conformance.data.reason ? ` (${conformance.data.reason})` : ""}`,
          );
        }
      }
      if (parsedDecision.success) {
        const vb = parsedDecision.data.verification_basis;
        const f = parsedDecision.data.facts;
        print(
          `decision: ${runOutcomeLabel(f)} (lifecycle=${f.lifecycle} checks=${f.checks} review=${f.review}${f.reason ? ` reason=${f.reason}` : ""}) apply=${parsedDecision.data.apply_recommendation}${vb !== "none" ? ` verified_by=${vb}` : ""}`,
        );
        const budget = parsedDecision.data.budget_summary;
        print(
          `budget: spend=${budget.spend_usd ?? "unknown"}${budget.estimated ? " estimated" : ""}`,
        );
      }
      if (telemetry) {
        const u = telemetry.usage_totals;
        if (u.input_tokens !== null || u.output_tokens !== null || u.cached_input_tokens !== null) {
          print(
            `tokens: in=${u.input_tokens ?? "n/a"} out=${u.output_tokens ?? "n/a"} cached=${u.cached_input_tokens ?? "n/a"}`,
          );
        }
        // Route receipt (INV-061 disclosure), projected verbatim from telemetry.
        const route = telemetry.auth_route;
        if (route) {
          print(
            `auth route: requested=${route.requested} effective=${route.effective ?? "undisclosed"} source=${route.source ?? "undisclosed"} reason=${route.reason}${route.harness_id ? ` (${route.harness_id}/${route.attempt_id ?? "?"})` : ""}`,
          );
          if (route.model_mismatch) {
            print(
              `model mismatch: requested=${route.model_mismatch.requested} observed=${route.model_mismatch.observed}`,
            );
          }
        }
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
        return printUsageError(
          json,
          "usage: claudexor apply <run_id> [--mode apply|commit|branch|pr] [--dry-run]",
        );
      }
      const rawMode = flagStr(args, "mode") ?? "apply";
      if (!["apply", "commit", "branch", "pr"].includes(rawMode)) {
        // D-7 projector: a usage failure (exit 2) with the run id as extra.
        return renderCliFailure(json, usageError(`unsupported apply mode: ${rawMode}`), {
          extras: { runId },
        });
      }
      const { addr } = await ensureDaemon();
      const dryRun = flagBool(args, "dry-run");
      const response = await controlApiFetch(
        addr,
        `/runs/${encodeURIComponent(runId)}/apply${dryRun ? "/check" : ""}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            dryRun
              ? { target: { kind: "original_project" } }
              : {
                  target: { kind: "original_project" },
                  mode: rawMode,
                  message: `claudexor: apply ${runId}`,
                },
          ),
        },
      );
      const text = await response.text();
      const result = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      if (json) printJson({ runId, ...(dryRun ? { dryRun: true } : {}), ...result });
      else if (!response.ok) print(String(result["message"] ?? result["error"] ?? text));
      else if (dryRun)
        print(
          result["alreadyApplied"] === true
            ? "already applied; nothing would change"
            : result["ok"] === true
              ? "patch applies cleanly"
              : "patch does not apply",
        );
      else
        print(
          `${String(result["mode"] ?? rawMode)}: applied=${String(result["applied"] ?? false)}` +
            (result["alreadyApplied"] === true ? " (already applied; no files changed)" : "") +
            (typeof result["commit"] === "string"
              ? ` commit=${result["commit"].slice(0, 8)}`
              : "") +
            (typeof result["branch"] === "string" ? ` branch=${result["branch"]}` : "") +
            (typeof result["detail"] === "string" ? ` (${result["detail"]})` : ""),
        );
      return response.ok && (dryRun ? result["ok"] === true : result["applied"] === true) ? 0 : 1;
    }

    case "decision":
      return decisionCommand(args, json);

    case "release":
      return releaseCommand(args, json);

    case "plugin":
      return pluginCommand(args, json);

    case "harness":
      return harnessCommand(args, json);

    case "capabilities": {
      // The derived AgentCapabilityCatalog — same composer as the daemon's
      // GET /agent-capabilities and the MCP claudexor_capabilities tool.
      const catalog = await buildAgentCapabilityCatalog();
      if (json) printJson(catalog);
      else {
        print(`claudexor ${catalog.version} — capability catalog`);
        print(`modes: ${catalog.modes.join(", ")}`);
        print(
          `git: ${catalog.git.status}${catalog.git.version ? ` (${catalog.git.version})` : ""}${catalog.git.remediation ? ` — ${catalog.git.remediation}` : ""}`,
        );
        print(`available harnesses: ${catalog.availableHarnesses.join(", ") || "(none)"}`);
        for (const h of catalog.harnesses) {
          const model = h.configuredModel
            ? ` model=${h.configuredModel}${h.configuredModelValid === false ? " (REJECTED)" : ""}`
            : "";
          print(
            `  ${statusGlyph(h.status)} ${h.id}: ${h.status}; intents=${h.enabledIntents.join(",") || "-"}; models=${h.models.count} (${h.models.source})${model}`,
          );
        }
        print(`mcp tools: ${catalog.mcpTools.join(", ")}`);
        print(`run-control keys: ${catalog.runControlKeys.join(", ")}`);
        print(
          `full JSON: claudexor capabilities --json (or GET /agent-capabilities on the daemon)`,
        );
      }
      return 0;
    }

    case "about":
      // Product identity (version + author + license + owner links, D-11).
      // `--json` is a small stable envelope; the Swift About panel and the
      // packed npm-manifest assertion consume the same facts.
      if (json) printJson(aboutJson(CLI_VERSION));
      else print(renderAbout(CLI_VERSION));
      return 0;

    case "help":
      // `help --json` is the machine-readable command catalog (agents parse
      // it instead of scraping the text help).
      if (json) printJson(helpJson(CLI_VERSION));
      else print(HELP);
      return 0;

    default:
      // Unknown command is an ERROR (exit 2), not a silent help print with
      // exit 0 — scripts must not mistake a typo'd verb for success. --json
      // callers get the ONE projector envelope (with message/code shape, no
      // longer a partial {ok,exitCode,error}); text mode prints the full help.
      if (json) {
        return renderOutputFailure(
          outputMode,
          usageError(`claudexor: unknown command '${cmd}' (see \`claudexor help --json\`)`),
          {},
        );
      }
      process.stderr.write(`claudexor: unknown command '${cmd}'\n\n${HELP}\n`);
      return 2;
  }
}

// The ONE top-level result/error projector (D-7, GH #28): render any command throw
// as one JSON envelope or stderr line via the central category->exit-code table.
// Commands that already print and return a code are unaffected.
async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (flagBool(args, "version")) {
    process.stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }
  const outputMode = cliOutputMode(args);
  try {
    return await dispatch(args, outputMode);
  } catch (err) {
    return renderOutputFailure(outputMode, err);
  }
}

main()
  .then(exitAfterOutputFlush)
  .catch((err: unknown) => {
    // Last-resort projector: infer the complete mode even if parsing itself threw.
    const json = process.argv.includes("--json");
    const stream = process.argv.includes("--json-stream");
    const outputMode: CliOutputMode = json
      ? stream
        ? "conflict"
        : "json"
      : stream
        ? "json-stream"
        : "human";
    exitAfterOutputFlush(renderOutputFailure(outputMode, err));
  });
