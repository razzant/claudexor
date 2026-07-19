#!/usr/bin/env node
import process from "node:process";
import { createReadStream, existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ArtifactStore } from "@claudexor/artifact-store";
import { CLAUDEXOR_VERSION, noProjectRepoRoot, readTextSafe, userConfigDir } from "@claudexor/util";
import { checkName } from "./release.js";
import { serveAcpBridge, serveBeltBridge, serveMcpBridge } from "./bridge-serve.js";
import { initProjectConfig } from "@claudexor/config";
import {
  DecisionRecord,
  EffortHint,
  ExternalContextPolicy,
  type ProtectedPathApproval,
  type ControlReviewerPanelEntry,
  ModeKind as ModeKindSchema,
  type PaidBudget,
  RoutingGoal,
  type ModeKind,
  type ProviderFamily,
  ControlThreadListResponse,
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
import { print, printJson, printJsonLine, printUsageError, statusGlyph } from "./cli-io.js";
import { pickResumableThread } from "./thread-select.js";
import {
  KNOWN_FLAGS,
  VALUE_FLAGS,
  commandFlagScopeError,
  helpJson,
  renderHelp,
} from "./command-registry.js";
import { buildAgentCapabilityCatalog } from "./capabilities.js";
import { dispatchOpsCommand } from "./ops-commands.js";
import { reviewCommand } from "./review-command.js";
import { controlApiFetch, followRun } from "./live.js";
import { retryCommand, runAgainCommand } from "./retry-command.js";
import { assertCliRunParamsHaveNoInlineSecrets } from "./run-secret-scan.js";
import {
  openLocalAttachment,
  resolveLocalAttachment,
  type LocalAttachment,
} from "./local-attachment.js";
import {
  connectDaemonIfRunning,
  daemonOutcomeSummary,
  ensureDaemon,
  enqueueAndAwait,
  exitCodeForState,
  fetchApplyEligibility,
  fetchCouncil,
  fetchPlanReadiness,
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
import { buildRegistry } from "./registry.js";
import { settingsCommand } from "./settings-command.js";
import { quotaCommand } from "./quota-command.js";
import { trustCommand } from "./trust-command.js";
import { projectCommand } from "./project-command.js";
import { runRepl } from "./repl.js";
import {
  parseProtectedPathApprovalFlags,
  parseTestCommandFlags,
  parseReviewerEffortFlags,
  parseReviewerModelFlags,
  parseReviewerPanelFlags,
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

/**
 * Per-run system instructions from `--instructions "<text>"` or
 * `--instructions-file <path>` (mutually exclusive; the file form avoids
 * ARG_MAX and keeps long instructions out of the process argv / `ps`).
 */
function resolveInstructions(args: ParsedArgs): string | undefined {
  const inline = flagStr(args, "instructions");
  const file = flagStr(args, "instructions-file");
  if (inline !== undefined && file !== undefined) {
    throw new Error("pass either --instructions or --instructions-file, not both");
  }
  if (file !== undefined) {
    try {
      return readFileSync(file, "utf8");
    } catch (err) {
      throw new Error(
        `could not read --instructions-file ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return inline;
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
  "readonly" | "workspace_write" | "full" | "external_sandbox_full" | "inherit_native" | undefined {
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

function attachmentInputs(args: ParsedArgs): LocalAttachment[] | undefined {
  const out = attachmentPaths(args).map(({ path, forceImage }) =>
    resolveLocalAttachment(path, forceImage),
  );
  return out.length > 0 ? out : undefined;
}

async function uploadLocalAttachment(
  addr: Awaited<ReturnType<typeof ensureDaemon>>["addr"],
  attachment: LocalAttachment,
): Promise<ResourceAttachmentRef> {
  const created = (await controlJson(addr, "/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: attachment.kind,
      mime: attachment.mime,
      name: attachment.name,
      sizeBytes: attachment.sizeBytes,
    }),
  })) as { uploadId: string };
  try {
    const source = createReadStream(attachment.path, {
      fd: openLocalAttachment(attachment),
      autoClose: true,
    });
    const hash = createHash("sha256");
    const hashingStream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    source.pipe(hashingStream);
    const response = await controlApiFetch(
      addr,
      `/uploads/${encodeURIComponent(created.uploadId)}/bytes`,
      {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: Readable.toWeb(hashingStream) as unknown as RequestInit["body"],
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    );
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      throw new Error(String(detail["message"] ?? detail["error"] ?? `HTTP ${response.status}`));
    }
    const expectedSha256 = `sha256:${hash.digest("hex")}`;
    const resource = (await controlJson(
      addr,
      `/uploads/${encodeURIComponent(created.uploadId)}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedSha256 }),
      },
    )) as { resourceId: string };
    return { resourceId: resource.resourceId };
  } catch (error) {
    await controlApiFetch(addr, `/uploads/${encodeURIComponent(created.uploadId)}`, {
      method: "DELETE",
    }).catch(() => undefined);
    throw error;
  }
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
  forced: { deepScan?: boolean; create?: boolean; race?: boolean } = {},
): Promise<number> {
  let rawPrompt = args._.slice(1).join(" ").trim();
  // Headless prompt sources (W13): `-` reads the prompt from stdin; a file
  // beats retyping. Exactly ONE source — ambiguity is a usage error, never a
  // silent pick.
  const promptFile = flagStr(args, "prompt-file");
  if (promptFile !== undefined) {
    if (rawPrompt && rawPrompt !== "-") {
      return printUsageError(
        json,
        "claudexor: pass either an inline prompt or --prompt-file, not both",
      );
    }
    try {
      rawPrompt = readFileSync(promptFile, "utf8").trim();
    } catch (err) {
      return printUsageError(
        json,
        `claudexor: --prompt-file: cannot read ${promptFile}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (rawPrompt === "-") {
    rawPrompt = readFileSync(0, "utf8").trim();
    if (!rawPrompt) {
      return printUsageError(json, "claudexor: stdin prompt (`-`) was empty");
    }
  }
  const prompt = rawPrompt;
  if (!prompt) {
    return printUsageError(json, "claudexor: missing prompt");
  }
  const portfolioRaw = flagStr(args, "portfolio");
  if (portfolioRaw !== undefined) {
    return printUsageError(
      json,
      "claudexor: --portfolio was removed in v2; use --routing-goal auto|quality|economy",
    );
  }
  const credentialProfileId = flagStr(args, "profile");
  const routingGoalRaw = flagStr(args, "routing-goal");
  const routingGoal = routingGoalRaw !== undefined ? RoutingGoal.safeParse(routingGoalRaw) : null;
  if (routingGoalRaw !== undefined && !routingGoal?.success) {
    return printUsageError(json, `claudexor: unknown --routing-goal '${routingGoalRaw}'`);
  }
  let reviewerEffortOverrides: Partial<Record<ProviderFamily, EffortHint>> | undefined;
  let resolvedReviewerModels: Partial<Record<ProviderFamily, string>> | undefined;
  let resolvedReviewerPanel: ControlReviewerPanelEntry[] | undefined;
  let resolvedWebPolicy: ReturnType<typeof webPolicy> = undefined;
  let resolvedAccess: ReturnType<typeof accessProfile> = undefined;
  let resolvedEffort: EffortHint | undefined;
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
    resolvedWebPolicy = webPolicy(args);
    resolvedAccess = accessProfile(args);
    resolvedEffort = effortHint(args);
    resolvedHarnesses = harnessList(args);
    resolvedPrimaryHarness = flagStr(args, "primary-harness");
    resolvedModel = flagStr(args, "model");
    const maxUsd = floatFlag(args, "max-usd");
    paidBudget = maxUsd === undefined ? undefined : { kind: "finite", maxUsd };
    nFlag = intFlag(args, "n");
    attemptsFlag = intFlag(args, "attempts");
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
    return printUsageError(json, `claudexor: ${err instanceof Error ? err.message : String(err)}`);
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
    return printUsageError(json, `claudexor: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (delegate && mode !== "agent") {
    return printUsageError(json, `claudexor: --delegate is an agent strategy (got mode '${mode}')`);
  }
  if (council && mode !== "plan") {
    return printUsageError(json, `claudexor: --council is a plan strategy (got mode '${mode}')`);
  }
  return daemonRun(args, json, {
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
    reviewerPanel: resolvedReviewerPanel,
    reviewerModels: resolvedReviewerModels,
    reviewerEfforts: reviewerEffortOverrides,
    protectedPathApprovals: resolvedProtectedPathApprovals,
    resolvedWebPolicy,
    resolvedAccess,
    resolvedEffort,
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
  reviewerPanel: ControlReviewerPanelEntry[] | undefined;
  reviewerModels: Partial<Record<ProviderFamily, string>> | undefined;
  reviewerEfforts: Partial<Record<ProviderFamily, EffortHint>> | undefined;
  protectedPathApprovals: ProtectedPathApproval[] | undefined;
  resolvedWebPolicy: ReturnType<typeof webPolicy>;
  resolvedAccess: ReturnType<typeof accessProfile>;
  resolvedEffort: EffortHint | undefined;
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
async function daemonRun(args: ParsedArgs, json: boolean, p: DaemonRunParams): Promise<number> {
  const inPlace = flagBool(args, "in-place");
  const jsonStream = flagBool(args, "json-stream");
  if (json && jsonStream) {
    return printUsageError(
      json,
      "claudexor: --json prints exactly one object and --json-stream prints NDJSON; pass one, not both",
    );
  }
  let client: Awaited<ReturnType<typeof ensureDaemon>>["client"];
  let addr: Awaited<ReturnType<typeof ensureDaemon>>["addr"];
  try {
    ({ client, addr } = await ensureDaemon());
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
      const newest = pickResumableThread(list.threads);
      if (!newest) {
        // Stay valid on the active output surface: NDJSON stream keeps compact
        // lines; --json prints its one object; text goes to stderr.
        const message = "claudexor: --resume found no threads to continue";
        if (jsonStream) printJsonLine({ ok: false, exitCode: 1, error: message });
        else if (json) printJson({ ok: false, exitCode: 1, error: message });
        else process.stderr.write(`${message}\n`);
        return 1;
      }
      threadId = newest.id;
    } catch (err) {
      const message = `claudexor: --resume could not list threads: ${err instanceof Error ? err.message : String(err)}`;
      if (jsonStream) printJsonLine({ ok: false, exitCode: 1, error: message });
      else if (json) printJson({ ok: false, exitCode: 1, error: message });
      else process.stderr.write(`${message}\n`);
      return 1;
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
    if (json)
      printJson({
        ok: false,
        exitCode: 1,
        error: `claudexor: attachment upload failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    else
      process.stderr.write(
        `claudexor: attachment upload failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    return 1;
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
    execution: { isolation: inPlace ? "live" : "envelope" },
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
    ...(p.reviewerPanel ? { reviewerPanel: p.reviewerPanel } : {}),
    ...(p.reviewerModels ? { reviewerModels: p.reviewerModels } : {}),
    ...(p.reviewerEfforts ? { reviewerEfforts: p.reviewerEfforts } : {}),
  };

  try {
    if (jsonStream) {
      // NDJSON machine surface (W13): an EARLY runId frame first, every run
      // event as its own line (the shared follow pipeline in json mode), and
      // the same terminal object --json prints as the LAST line. --json keeps
      // its exactly-one-object contract untouched.
      const started = await enqueueAndAwait(client, addr, body, { waitForTerminal: false });
      if (!started.runId) {
        // Even the early-failure path stays valid NDJSON (compact, one line).
        printJsonLine({
          frame: "run.terminal",
          runId: "",
          runDir: started.runDir,
          status: started.status,
          jobId: started.jobId,
          mode: p.mode,
          ...(started.error ? { error: started.error } : {}),
        });
        return exitCodeForState(started.status);
      }
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
      const status = final?.state ?? started.status;
      const out = {
        runId: started.runId,
        runDir: final?.runDir ?? started.runDir,
        status: status,
        jobId: started.jobId,
        error: final?.error ?? started.error,
      };
      const reason = daemonOutcomeSummary({ ...started, status, error: out.error });
      const applyEligibility = await fetchApplyEligibility(addr, started.runId);
      printJsonLine({
        frame: "run.terminal",
        runId: out.runId,
        runDir: out.runDir,
        status: out.status,
        jobId: out.jobId,
        mode: p.mode,
        ...(out.error ? { error: out.error } : {}),
        ...(reason ? { summary: reason } : {}),
        ...(applyEligibility ? { applyEligibility } : {}),
      });
      return exitCodeForState(status);
    }
    if (json) {
      // Pure machine surface: await the terminal outcome and print one JSON object.
      const out = await enqueueAndAwait(client, addr, body, { waitForTerminal: true });
      // Preserve bench keys while adding mode and honest non-success detail.
      const reason = daemonOutcomeSummary(out);
      // ADD-ONLY key (bench contract keeps {runId,runDir,status}): the derived
      // apply-gate verdict, so machine callers act on truth instead of
      // re-implying eligibility from status.
      const applyEligibility = await fetchApplyEligibility(addr, out.runId);
      printJson({
        runId: out.runId,
        runDir: out.runDir,
        status: out.status,
        jobId: out.jobId,
        mode: p.mode,
        ...(out.error ? { error: out.error } : {}),
        ...(reason ? { summary: reason } : {}),
        ...(applyEligibility ? { applyEligibility } : {}),
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
    const publicStatus = status;
    print("");
    print(`run ${started.runId} [${publicStatus}]`);
    print(`  artifacts: ${final?.runDir ?? started.runDir}`);
    // A succeeded lifecycle exits 0 — INCLUDING a "Done · needs review" run
    // (review blocked / checks failed). The apply-eligibility verdict (state
    // needs_review) is the ONE source for the unblock guidance (D8).
    if (exitCodeForState(status) === 0) {
      // Plan runs surface their derived readiness (D17): the server's ONE
      // derivation over final/questions.json, never a client re-parse.
      if (p.mode === "plan") {
        // Council disclosure (INV-031): membership + merge, projected by the
        // server (never a client re-derivation).
        if (p.council) {
          const council = await fetchCouncil(addr, started.runId);
          if (council) {
            print(
              `  council: merged by ${council.mergedBy ?? "(none)"} from ${council.drafted} of ${council.requested} member(s)${council.degraded ? " (degraded)" : ""}`,
            );
            const failed = council.members.filter((m) => m.status === "failed");
            if (failed.length > 0) {
              print(`  council failures: ${failed.map((m) => m.harnessId).join(", ")}`);
            }
          }
        }
        const readiness = await fetchPlanReadiness(addr, started.runId);
        if (readiness?.state === "needs_answers") {
          print(
            `  plan needs answers: ${readiness.questionCount} open question(s) — answer in a follow-up plan turn, then implement`,
          );
        } else if (readiness?.state === "unverified") {
          print(`  plan questions unverified: the planner emitted no tagged Open Questions block`);
        } else if (readiness?.state === "ready") {
          print(`  plan ready: no open questions`);
        }
      }
      // Offer apply only after a positive gate; otherwise print inspect/unblock guidance.
      const eligibility = await fetchApplyEligibility(addr, started.runId);
      if (eligibility?.eligible) {
        print(`  apply with: claudexor apply ${started.runId}`);
      } else if (eligibility?.state === "needs_review") {
        print(
          `  needs review: unblock with \`claudexor decision ${started.runId} --accept-risk\` or rerun with \`claudexor decision ${started.runId} --rerun --feedback "..."\``,
        );
      } else if (eligibility?.requiredAction) {
        print(`  not applyable yet: ${eligibility.requiredAction}`);
      } else {
        print(`  inspect with: claudexor inspect ${started.runId}`);
      }
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
    const res = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}/decision`, {
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
 *   2. the user store (~/.claudexor/v3/runs) used by no-project Ask runs;
 *   3. a daemon-tracked run that started in ANOTHER project — agent/race/create
 *      runs live under that project's external runtime namespace, so we ask
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

async function controlJson(
  addr: Awaited<ReturnType<typeof ensureDaemon>>["addr"],
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await controlApiFetch(addr, path, init);
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : {};
  if (response.ok) return body;
  const detail = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  throw new Error(String(detail["message"] ?? detail["error"] ?? `HTTP ${response.status}`));
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

// KNOWN_FLAGS / VALUE_FLAGS (imported above) and the per-command scope check
// are projections of the command registry. Unknown flags FAIL LOUDLY: `--harnes
// codex` must never silently run all harnesses.

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
  // Registry-enforced per-command flag scope: a KNOWN flag outside the
  // command's declared set (e.g. `plan --create`, `ask --force`) fails loudly
  // instead of being silently ignored. Data-driven from CLI_COMMANDS for
  // every verb (this replaced the old hand-listed plugin/--force special cases).
  const scopeError = commandFlagScopeError(cmd, Object.keys(args.flags));
  if (scopeError) return printPreflightError(args, json, scopeError);
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

    case "agent": {
      const modeStr = flagStr(args, "mode");
      if (modeStr !== undefined) {
        const mode = normalizeMode(modeStr);
        if (!MODES.has(mode)) {
          return printUsageError(
            json,
            `claudexor: unknown --mode '${modeStr}'. valid: ${[...MODES].join(", ")}`,
          );
        }
        return orchestrate(args, mode, json);
      }
      return orchestrate(args, "agent", json);
    }

    case "ask":
      return orchestrate(args, "ask", json);

    case "best-of":
      return orchestrate(args, "agent", json, { race: true });

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
        json,
        `claudexor: the '${cmd}' verb was retired; use ${replacement}`,
      );
    }

    case "plan":
      return orchestrate(args, "plan", json);

    case "create":
      return orchestrate(args, "agent", json, { create: true });

    case "settings":
      return settingsCommand(args, json);

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
      if (args._[1] === "serve") return serveAcpBridge();
      return printUsageError(json, "usage: claudexor acp serve");
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
        if (json) printJson({ runId, error: `unsupported apply mode: ${rawMode}` });
        else print(`unsupported apply mode: ${rawMode}`);
        return 2;
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
        print(result["ok"] === true ? "patch applies cleanly" : "patch does not apply");
      else
        print(
          `${String(result["mode"] ?? rawMode)}: applied=${String(result["applied"] ?? false)}` +
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

    case "capabilities": {
      // The derived AgentCapabilityCatalog — same composer as the daemon's
      // GET /agent-capabilities and the MCP claudexor_capabilities tool.
      const catalog = await buildAgentCapabilityCatalog();
      if (json) printJson(catalog);
      else {
        print(`claudexor ${catalog.version} — capability catalog`);
        print(`modes: ${catalog.modes.join(", ")}`);
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

    case "help":
      // `help --json` is the machine-readable command catalog (agents parse
      // it instead of scraping the text help).
      if (json) printJson(helpJson(CLI_VERSION));
      else print(HELP);
      return 0;

    default:
      // Unknown command is an ERROR (exit 2), not a silent help print with
      // exit 0 — scripts must not mistake a typo'd verb for success. --json
      // callers get the machine envelope on stdout (stdout purity contract).
      if (json) {
        printJson({
          ok: false,
          exitCode: 2,
          error: `claudexor: unknown command '${cmd}' (see \`claudexor help --json\`)`,
        });
        return 2;
      }
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
