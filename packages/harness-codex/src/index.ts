import {
  CODEX_MODEL_INVENTORY,
  codexProcessingMethods,
  codexProcessingArgs,
  applyCodexRunProcessing,
} from "./processing-session.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
export { parseCodexRateLimitsResponse } from "./quota.js";
export { CodexRpcError, parseCodexRpcError, codexRpcErrorDetail } from "./rpc-error.js";
export { createCodexModelAdapter } from "./model.js";
export * from "./images.js";
export { describeCodexClientVersion } from "./http-client-version.js";
import { withCodexVendorFailure } from "./vendor-failure.js";
import { resolveSecret } from "@claudexor/secrets";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AccessProfile,
  type AuthSourceReadiness,
  type ConformanceReport,
  type CredentialProfile,
  type CredentialProfileStatus,
  type EffortHint,
  type HarnessEvent,
  type HarnessManifest,
  type HarnessRunSpec,
  ConformanceReport as ConformanceReportSchema,
  HarnessManifest as HarnessManifestSchema,
} from "@claudexor/schema";
import {
  CODEX_EFFORT_SNAPSHOT_VERIFIED_AGAINST,
  codexEffortFor,
  codexEffortsForEnv,
  probeCodexEfforts,
  unionEffortLevels,
  type CodexEffortCatalog,
  type CodexEffortProbe,
} from "./effort-probe.js";
import { codexRunEffortResolution } from "./effort-gate.js";
import { codexConfigHasNodeRepl, tomlBasicString } from "./toml.js";
import { CODEX_VENDOR_CLI_VERSION } from "./vendor-cli-version.js";
export { CODEX_EFFORT_SNAPSHOT, clearCodexEffortCache, unionEffortLevels } from "./effort-probe.js";
export { CODEX_VENDOR_CLI_VERSION, codexConfigHasNodeRepl };
import type { DoctorSpec, HarnessAdapter } from "@claudexor/core";
import {
  abortSignalFromSpec,
  throwIfEffortRejected,
  brokenInstallAdvisory,
  browserMcpCommand,
  providerScrubEnv,
  resolveHarnessBinary,
  runCliHarness,
  selectStrictAuthRoute,
  selectedAuthAvailable,
  selectedAuthReady,
  shouldVerifyApiKey,
} from "@claudexor/core";
import { CLAUDEXOR_VERSION, nowIso, redactSecrets } from "@claudexor/util";
import { parseCodexEvent, parseCodexStderrFailure, type CodexParseState } from "./parse.js";
// prettier-ignore
import { CODEX_ACCESS_PROFILES, probeCodexCredentialProfile, resolveCodexProfileRoute } from "./profile.js";
import { codexContinuity } from "./continuity.js";
import { smokeIsolatedApiKey } from "./smoke.js";
export { canonicalCodexProfileHome, codexAccountIdentity } from "./profile.js";
import { codexImageArgs } from "./attachments.js";
import {
  CodexAppServerController,
  runCodexAppServer,
  type CodexAppServerRunInput,
} from "./app-server-run.js";
import { decorateCodexEvent, type CodexEventDecoration } from "./event-decoration.js";

import {
  BIN,
  detectVersion,
  installedCliCheck,
  missingCliError,
  missingCliReport,
  probeEnv,
} from "./missing-cli.js";
export { BIN } from "./missing-cli.js";

export const selectCodexRunAuthRoute = selectStrictAuthRoute;

export {
  CODEX_FILE_AUTH_ARGS,
  CODEX_FILE_AUTH_OVERRIDE,
  redactCodexDoctorDetail,
  codexAuthModeAt,
  defaultNativeCodexHome,
  ensureCodexApiAuth,
  probeLogin,
} from "./auth.js";
import { CODEX_CAPABILITY_PROFILE, CODEX_TURN_INPUT_LIMIT } from "./capability-profile.js";
export { CODEX_MANAGED_LOGIN } from "./capability-profile.js";
import {
  CODEX_FILE_AUTH_ARGS,
  CODEX_PROJECT_DOC_FALLBACK_ARGS,
  codexNativeReadiness,
  redactCodexDoctorDetail,
  codexApiKey,
  codexAuthModeAt,
  defaultNativeCodexHome,
  ensureCodexApiAuth,
  hasApiKey,
  probeLogin,
  type CodexLoginProbe,
} from "./auth.js";

function sandboxMode(access: AccessProfile): string | null {
  switch (access) {
    case "readonly":
      return "read-only";
    case "workspace_write":
      return "workspace-write";
    case "full":
      return "danger-full-access";
    case "inherit_native":
      return null;
  }
}

function sandboxArgs(access: AccessProfile): string[] {
  const mode = sandboxMode(access);
  return mode ? ["--sandbox", mode] : [];
}

export function codexNativeEnv(
  base?: Record<string, string | null | undefined>,
  codexHome?: string,
): Record<string, string | null | undefined> {
  return {
    ...(base ?? {}),
    ...providerScrubEnv(),
    CODEX_HOME: codexHome ?? defaultNativeCodexHome(base),
  };
}

/**
 * Inject the Playwright browser MCP as stateless `-c mcp_servers.browser.*`
 * config overrides (live-verified: codex accepts array-valued `-c` overrides and
 * surfaces the tools as `mcp_tool_call` events the parser already maps). Stateless
 * means NO scoped config.toml write — the user's `~/.codex/config.toml` is never
 * touched. Empty when no browser this run, and ALWAYS empty under
 * `external_context_policy: off` (adapter-level defense-in-depth mirroring the
 * claude adapter; the orchestrator already nulls the browser under off).
 */
export function codexBrowserArgs(
  browser: HarnessRunSpec["browser"],
  externalContextPolicy?: HarnessRunSpec["external_context_policy"],
  extraMcpServers: HarnessRunSpec["extra_mcp_servers"] = [],
): string[] {
  const args: string[] = [];
  // The browser is live egress and rides `external_context_policy` (dropped
  // under `off`); it is stateless `-c` overrides — the user's config.toml is
  // never touched.
  if (browser && externalContextPolicy !== "off") {
    const mcp = browserMcpCommand(browser);
    args.push(
      "-c",
      `mcp_servers.browser.command=${JSON.stringify(mcp.command)}`,
      "-c",
      `mcp_servers.browser.args=${JSON.stringify(mcp.args)}`,
      "-c",
      "mcp_servers.browser.startup_timeout_sec=90",
      "-c",
      "mcp_servers.browser.tool_timeout_sec=120",
    );
  }
  // Extra engine-owned MCP servers (the delegation belt, etc.) are local
  // processes, not web egress, so they inject regardless of web policy. Same
  // stateless `-c` override transport as the browser.
  for (const server of extraMcpServers) {
    args.push(
      "-c",
      `mcp_servers.${server.name}.command=${JSON.stringify(server.command)}`,
      "-c",
      `mcp_servers.${server.name}.args=${JSON.stringify(server.args)}`,
      "-c",
      `mcp_servers.${server.name}.startup_timeout_sec=90`,
      "-c",
      `mcp_servers.${server.name}.tool_timeout_sec=120`,
    );
    if (server.required) {
      args.push("-c", `mcp_servers.${server.name}.required=true`);
    }
    // Env rides as PER-KEY dotted `-c` overrides, one flag per entry. codex's
    // `-c` parser wants a TOML value; a single `env=${JSON.stringify(map)}`
    // hands it a whole JSON-object STRING, which it rejects ("invalid type:
    // string ... expected a map in mcp_servers.<name>.env") and the codex
    // process dies at startup. Per-key `env.<KEY>=<toml-string-value>` sets each
    // entry into the map the parser expects. JSON.stringify on the value yields
    // a double-quoted, TOML-valid string literal.
    for (const [envKey, envValue] of Object.entries(server.env)) {
      args.push("-c", `mcp_servers.${server.name}.env.${envKey}=${JSON.stringify(envValue)}`);
    }
  }
  return args;
}

export function codexExecArgs(
  spec: Pick<
    HarnessRunSpec,
    | "access"
    | "model_hint"
    | "effort_hint"
    | "external_context_policy"
    | "prompt"
    | "instructions"
    | "attachments"
    | "browser"
    | "processing"
    | "processing_preference"
    | "processing_allow_paid"
  > & {
    resume_session_id?: string | null;
    extra_mcp_servers?: HarnessRunSpec["extra_mcp_servers"];
  },
  opts: {
    suppressNodeRepl?: boolean;
    outputSchemaPath?: string | null;
    /** The account's advertised effort catalog; the snapshot by default. */
    effortCatalog?: CodexEffortCatalog;
    /** The run's ONE effort receipt (`submitted`); resolved from the catalog when absent. */
    effort?: EffortHint | null;
  } = {},
): string[] {
  // Codex.app's inherited `node_repl` MCP (its in-app-browser controller) can't
  // run in headless `codex exec` and fails every call → it used to flip an
  // otherwise-clean run to "errored". Disable it — but ONLY when it is actually
  // present in the loaded config (codexConfigHasNodeRepl), never unconditionally
  // (that is what created the invalid partial entry above).
  const nodeReplArgs = opts.suppressNodeRepl ? ["-c", "mcp_servers.node_repl.enabled=false"] : [];
  // Resume a native codex session as a follow-up turn (`codex exec resume <id>`),
  // so a thread's later moves continue the same conversation instead of restarting.
  // LIVE-VERIFIED (codex 0.137): the resume subcommand does NOT accept --sandbox;
  // sandboxing must ride as `-c sandbox_mode="..."` config overrides there.
  // Effort is resolved against what THIS MODEL advertises, not a harness-wide
  // ladder: gpt-5.6-sol takes `ultra`, gpt-5.4 stops at `xhigh`.
  const processingArgs = codexProcessingArgs(spec, opts.effortCatalog);
  const effort =
    opts.effort === undefined
      ? codexEffortFor(opts.effortCatalog, spec.model_hint, spec.effort_hint)
      : opts.effort;
  if (spec.resume_session_id) {
    const args = [
      "exec",
      "resume",
      spec.resume_session_id,
      "--json",
      ...processingArgs,
      ...CODEX_FILE_AUTH_ARGS,
      ...CODEX_PROJECT_DOC_FALLBACK_ARGS,
      ...sandboxConfigArgs(spec.access),
      "--skip-git-repo-check",
    ];
    if (opts.outputSchemaPath) args.push("--output-schema", opts.outputSchemaPath);
    if (spec.model_hint) args.push("-m", spec.model_hint);
    if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
    if (spec.instructions && spec.instructions.trim())
      args.push("-c", `developer_instructions=${tomlBasicString(spec.instructions)}`);
    args.push(...codexWebArgs(spec.external_context_policy ?? "auto"));
    // ALL `-c` config overrides go BEFORE `-i` so the variadic `-i/--image
    // <FILE>...` can't swallow them as image paths.
    args.push(
      ...codexBrowserArgs(spec.browser, spec.external_context_policy, spec.extra_mcp_servers),
    );
    args.push(...nodeReplArgs);
    const imageArgs = codexImageArgs(spec.attachments);
    args.push(...imageArgs);
    // `codex exec -i/--image <FILE>...` is VARIADIC, so terminate it before the
    // documented `-` stdin-prompt operand. Prompt bytes never ride argv (large
    // agent-first packets otherwise fail at spawn with E2BIG).
    if (imageArgs.length > 0) args.push("--");
    args.push("-");
    return args;
  }
  const args = [
    "exec",
    "--json",
    ...processingArgs,
    ...CODEX_FILE_AUTH_ARGS,
    ...CODEX_PROJECT_DOC_FALLBACK_ARGS,
  ];
  args.push(...sandboxArgs(spec.access), "--skip-git-repo-check");
  if (opts.outputSchemaPath) args.push("--output-schema", opts.outputSchemaPath);
  if (spec.model_hint) args.push("-m", spec.model_hint);
  if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
  if (spec.instructions && spec.instructions.trim())
    args.push("-c", `developer_instructions=${tomlBasicString(spec.instructions)}`);
  args.push(...codexWebArgs(spec.external_context_policy ?? "auto"));
  // ALL `-c` config overrides BEFORE `-i` (variadic) so they can't be eaten as
  // image paths; then images, then `--`, then the `-` stdin-prompt operand.
  // See resume branch.
  args.push(
    ...codexBrowserArgs(spec.browser, spec.external_context_policy, spec.extra_mcp_servers),
  );
  args.push(...nodeReplArgs);
  const imageArgs = codexImageArgs(spec.attachments);
  args.push(...imageArgs);
  if (imageArgs.length > 0) args.push("--");
  args.push("-");
  return args;
}

/** Sandbox as `-c sandbox_mode=...` config (the only spelling `exec resume` accepts). */
function sandboxConfigArgs(access: AccessProfile): string[] {
  const mode = sandboxMode(access);
  return mode ? ["-c", `sandbox_mode="${mode}"`] : [];
}

function codexWebArgs(policy: HarnessRunSpec["external_context_policy"]): string[] {
  switch (policy) {
    case "off":
      return ["-c", 'web_search="disabled"'];
    case "live":
      return ["-c", 'web_search="live"'];
    case "cached":
    case "auto":
      return ["-c", 'web_search="cached"'];
  }
}

/** The runtime surface the profile module needs (test-stubbable). */
export type CodexProfileRuntimeDeps = Pick<CodexRuntimeDeps, "probeLogin" | "resolveProfileSecret">;

type CodexRuntimeDeps = {
  detectVersion: typeof detectVersion;
  brokenInstallAdvisory: typeof brokenInstallAdvisory;
  probeLogin: typeof probeLogin;
  hasApiKey: typeof hasApiKey;
  codexApiKey: typeof codexApiKey;
  /** Profile-scoped secret resolution (INV-135): reads exactly the profile's
   * namespaced ref, never the engine-default ladder. */
  resolveProfileSecret: (ref: string) => string | null;
  smokeIsolatedApiKey: typeof smokeIsolatedApiKey;
  runCliHarness: typeof runCliHarness;
  /** Production lifecycle transport; undefined only for legacy exec-focused unit tests. */
  runAppServer?: (input: CodexAppServerRunInput) => AsyncGenerator<HarnessEvent>;
  /** Live per-model effort discovery; null on any failure (caller falls back). */
  probeEfforts: CodexEffortProbe;
  nowMs: () => number;
};

export function createCodexAdapter(deps: Partial<CodexRuntimeDeps> = {}): HarnessAdapter {
  const controllers = new Map<string, CodexAppServerController>();
  const runtime: CodexRuntimeDeps = {
    detectVersion,
    brokenInstallAdvisory,
    probeLogin,
    hasApiKey,
    codexApiKey,
    resolveProfileSecret: (ref) => resolveSecret(ref),
    smokeIsolatedApiKey,
    runCliHarness,
    runAppServer: deps.runCliHarness && !deps.runAppServer ? undefined : runCodexAppServer,
    probeEfforts: (bin, env) => probeCodexEfforts(bin, env ? { env } : {}),
    nowMs: () => Date.now(),
    ...deps,
  };
  return {
    id: "codex",
    effortParameter: "model_reasoning_effort",
    capabilityProfile: CODEX_CAPABILITY_PROFILE,
    ...codexProcessingMethods(runtime, codexNativeEnv),

    async discover(): Promise<HarnessManifest> {
      const version = await runtime.detectVersion();
      if (version === null) {
        const advisory = runtime.brokenInstallAdvisory(BIN);
        throw missingCliError(advisory && redactCodexDoctorDetail(advisory));
      }
      const apiKey = runtime.hasApiKey();
      const login = await runtime.probeLogin(BIN, { env: codexNativeEnv() });
      const nativeSessionAvailable = login.method === "chatgpt";
      // Per-model effort vocabulary from the vendor, probed in the SAME native env
      // the login probe used (the catalog belongs to that CODEX_HOME's account). A
      // failed probe falls back to the snapshot and stamps the version it came from.
      const efforts = await codexEffortsForEnv(runtime, codexNativeEnv());
      const authModes = [
        ...(nativeSessionAvailable ? ["local_session"] : []),
        ...(apiKey ? ["api_key"] : []),
      ];
      return HarnessManifestSchema.parse({
        id: "codex",
        display_name: "Codex CLI",
        kind: "local_cli",
        version,
        adapter_version: CLAUDEXOR_VERSION,
        provider_family: "openai",
        capabilities: {
          processing_preferences: ["standard", "fast", "economy"],
          ...CODEX_MODEL_INVENTORY,
          plan: true,
          implement: true,
          create_from_scratch: true,
          review: true,
          verify: true,
          synthesize: true,
          read_files: true,
          // mcp_servers.browser.*` overrides (live-verified) — gated on web policy.
          browser_tool: true,
          json_schema_output: true,
          work_report_transport: "constrained",
          structured_output_channel: "final_message",
          web_policy: "native",
          // Effort is per MODEL (`model/list` → supportedReasoningEfforts): the harness-wide
          // list is the UNION; `model_effort_levels` holds the truth a model is held to.
          effort_levels: unionEffortLevels(efforts.catalog.models),
          model_effort_levels: efforts.catalog.models,
          effort_levels_verified_against: efforts.live
            ? version
            : CODEX_EFFORT_SNAPSHOT_VERIFIED_AGAINST,
          // Manifest truth for routes the live probe does not answer; no hidden models.
          known_models: [
            "gpt-6-astra",
            "gpt-6-sol",
            "gpt-6-luna",
            "gpt-5.6",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gpt-5.6-luna",
            "gpt-5.5",
            "gpt-5.4",
            "gpt-5.4-mini",
            "gpt-5.3-codex-spark",
            "gpt-5.2",
          ],
          known_models_verified_against: CODEX_VENDOR_CLI_VERSION,
        },
        capability_profile: {
          ...CODEX_CAPABILITY_PROFILE,
          ...(version === CODEX_TURN_INPUT_LIMIT.verified_against
            ? { input_limits: [CODEX_TURN_INPUT_LIMIT] }
            : {}),
          auth: {
            ...CODEX_CAPABILITY_PROFILE.auth,
            preferred_source: nativeSessionAvailable
              ? "native_session"
              : apiKey
                ? "provider_auth_file"
                : null,
          },
        },
        auth_modes: authModes,
        access_profiles_supported: CODEX_ACCESS_PROFILES,
      });
    },

    async doctor(_spec: DoctorSpec): Promise<ConformanceReport> {
      // The scoped env drives BOTH the version probe and the advisory, so the
      // diagnosis always describes the exact env the probe failed in.
      const version = await runtime.detectVersion(_spec.abortSignal, _spec.env);
      if (version === null) {
        const advisory = runtime.brokenInstallAdvisory(BIN, probeEnv(_spec.env));
        return missingCliReport(advisory && redactCodexDoctorDetail(advisory));
      }
      const requestedSource = _spec.authSource;
      const probeNative = requestedSource === undefined || requestedSource === "native_session";
      const probeApi = requestedSource === undefined || requestedSource === "provider_auth_file";
      const login: CodexLoginProbe = probeNative
        ? await runtime.probeLogin(BIN, {
            env: codexNativeEnv(_spec.env),
            abortSignal: _spec.abortSignal,
          })
        : { authed: false, method: "logged_out", probeError: null };
      const nativeSource = codexNativeReadiness(login);
      const nativeReady = nativeSource.verification === "passed";
      const apiKey = probeApi && runtime.hasApiKey();
      const preference =
        requestedSource === "native_session"
          ? "subscription"
          : requestedSource === "provider_auth_file"
            ? "api_key"
            : (_spec.authPreference ?? "auto");
      const shouldSmokeKey =
        probeApi && shouldVerifyApiKey({ preference, apiKeyAvailable: apiKey, nativeReady });
      const smoke = shouldSmokeKey
        ? await runtime.smokeIsolatedApiKey(_spec.abortSignal)
        : {
            ok: false,
            detail: apiKey
              ? "verification not run for the unselected API-key route"
              : "no API key fallback available",
          };
      const ok = selectedAuthReady({ preference, nativeReady, apiKeyReady: smoke.ok });
      const selectedAvailable = selectedAuthAvailable({
        preference,
        nativeAvailable: nativeSource.availability === "available",
        apiKeyAvailable: apiKey,
      });
      const probeUnknown = preference !== "api_key" && nativeSource.availability === "unknown";
      const allIntents = [
        "plan",
        "spec",
        "implement",
        "repair",
        "create_from_scratch",
        "review",
        "verify",
        "synthesize",
        "explain",
        "audit",
      ];
      const binPath = resolveHarnessBinary(BIN, probeEnv(_spec.env));
      const installAdvisory = runtime.brokenInstallAdvisory(BIN, probeEnv(_spec.env));
      const apiSource: AuthSourceReadiness = {
        source: "provider_auth_file",
        availability: apiKey ? "available" : "unavailable",
        verification: smoke.ok ? "passed" : shouldSmokeKey ? "failed" : "not_run",
        detail: smoke.detail,
      };
      const authSources: AuthSourceReadiness[] =
        requestedSource === "native_session"
          ? [nativeSource]
          : requestedSource === "provider_auth_file"
            ? [apiSource]
            : requestedSource !== undefined
              ? [
                  {
                    source: requestedSource,
                    availability: "unavailable",
                    verification: "not_run",
                    detail: `Codex does not support ${requestedSource}`,
                  },
                ]
              : [nativeSource, apiSource];
      return ConformanceReportSchema.parse({
        harness_id: "codex",
        status: ok ? "ok" : selectedAvailable || probeUnknown ? "degraded" : "unavailable",
        checks: [
          installedCliCheck(
            version,
            binPath,
            installAdvisory && redactCodexDoctorDetail(installAdvisory),
          ),
          ...(probeNative
            ? [
                {
                  id: "native_session",
                  status: nativeReady ? "pass" : "fail",
                  detail: nativeReady
                    ? "vendor status confirmed native ChatGPT auth in the exact run environment"
                    : login.probeError
                      ? `login-status probe failed (NOT an auth verdict): ${redactCodexDoctorDetail(login.probeError)}`
                      : login.authed
                        ? `logged in via ${login.method}, not ChatGPT subscription auth`
                        : "not logged in (run `claudexor auth login codex`)",
                },
              ]
            : []),
          ...(probeApi
            ? [
                {
                  id: "stored_key",
                  status: apiKey ? "pass" : "fail",
                  detail: apiKey
                    ? "openai secret/env available (API-key fallback)"
                    : "no openai key fallback",
                },
                {
                  id: "isolated_api_smoke",
                  status: smoke.ok ? "pass" : shouldSmokeKey ? "fail" : "skip",
                  detail: smoke.detail,
                },
              ]
            : []),
        ],
        auth_sources: authSources,
        enabled_intents: ok ? allIntents : [],
        disabled_intents: ok ? [] : allIntents,
        reasons: ok
          ? []
          : preference === "subscription"
            ? [
                login.probeError
                  ? `Codex native-session probe failed: ${redactCodexDoctorDetail(login.probeError)}`
                  : login.authed
                    ? `Codex is authenticated via ${login.method}, not a ChatGPT subscription session`
                    : "Codex subscription route is not ready (run `claudexor auth login codex`)",
              ]
            : preference === "api_key"
              ? [
                  apiKey
                    ? `isolated Codex API-key smoke failed: ${smoke.detail}`
                    : "Codex API-key route is not configured",
                ]
              : apiKey
                ? [`isolated Codex API-key smoke failed: ${smoke.detail}`]
                : [
                    "not authenticated (run `claudexor auth login codex` for native/subscription use, or store an openai API key fallback)",
                  ],
      });
    },

    run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return controlledRun(spec);
    },

    review(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return controlledRun(spec);
    },
    continuity: codexContinuity,
    async cancel(sessionId: string): Promise<void> {
      await controllers.get(sessionId)?.cancel();
    },

    // Live input rides the app-server controller of the session (turn/steer);
    // a session without one (legacy exec path, unknown id) has no channel.
    async message(sessionId: string, input: { messageId: string; text: string }) {
      const controller = controllers.get(sessionId);
      return controller
        ? controller.steer(input)
        : { outcome: "unsupported" as const, reason: "no_live_session" as const };
    },
    probeCredentialProfile(
      profile: CredentialProfile,
      abortSignal?: AbortSignal,
    ): Promise<CredentialProfileStatus> {
      return probeCodexCredentialProfile(profile, runtime, abortSignal);
    },
  };

  async function* controlledRun(spec: HarnessRunSpec): AsyncGenerator<HarnessEvent> {
    const controller = new CodexAppServerController();
    controllers.set(spec.session_id, controller);
    try {
      yield* runCodex(spec, runtime, controller);
    } finally {
      if (controllers.get(spec.session_id) === controller) controllers.delete(spec.session_id);
    }
  }
}

async function* runCodex(
  spec: HarnessRunSpec,
  runtime: CodexRuntimeDeps,
  controller?: CodexAppServerController,
): AsyncIterable<HarnessEvent> {
  const profile = spec.credential_profile;
  const authPreference = spec.auth_preference ?? "auto";
  let nativeEnv = codexNativeEnv(spec.env);
  let key: string | undefined;
  let tempCodexHome: string | null = null;
  let authRoute: "subscription" | "api_key" | null;
  let outputSchemaPath: string | null = null;
  let tempSchemaDir: string | null = null;
  try {
    if (profile) {
      const resolved = await resolveCodexProfileRoute(
        profile,
        spec.env,
        runtime,
        abortSignalFromSpec(spec),
      );
      if (resolved.refusal !== null) {
        yield { type: "error", session_id: spec.session_id, ts: nowIso(), error: resolved.refusal };
        yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
        return;
      }
      ({ nativeEnv, tempCodexHome } = resolved);
      key = resolved.key ?? undefined;
      authRoute = resolved.route;
    } else {
      const nativeLogin: CodexLoginProbe =
        authPreference === "api_key"
          ? { authed: false, method: "logged_out", probeError: null }
          : await runtime.probeLogin(BIN, {
              env: nativeEnv,
              abortSignal: abortSignalFromSpec(spec),
            });
      const nativeSessionReady =
        nativeLogin.method === "chatgpt" && nativeLogin.probeError === null;
      const trySubscription = (): boolean => nativeSessionReady;
      const tryApiKey = (): boolean => {
        key ??= runtime.codexApiKey();
        if (!key) return false;
        tempCodexHome = mkdtempSync(join(tmpdir(), "claudexor-codex-auth-"));
        ensureCodexApiAuth({ CODEX_HOME: tempCodexHome }, true, key);
        if (codexAuthModeAt(tempCodexHome, spec.env) === "api_key") return true;
        rmSync(tempCodexHome, { recursive: true, force: true });
        tempCodexHome = null;
        return false;
      };
      authRoute = selectCodexRunAuthRoute(authPreference, trySubscription, tryApiKey);
      if (authRoute === null) {
        const error =
          authPreference === "subscription"
            ? "Codex subscription auth was explicitly requested but vendor status did not confirm a native ChatGPT session (run `claudexor auth login codex`)"
            : authPreference === "api_key"
              ? "Codex API-key auth was explicitly requested but no usable OpenAI API key route is ready"
              : "no usable Codex auth: native ChatGPT session is not ready and no OpenAI API key fallback is ready";
        yield { type: "error", session_id: spec.session_id, ts: nowIso(), error };
        yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
        return;
      }
    }

    // Auto is subscription-first. Selecting its API-key fallback is a paid-route
    // switch and must remain typed/visible; explicit routes never fall back.
    if (!profile && authPreference === "auto" && authRoute === "api_key") {
      yield {
        type: "message",
        session_id: spec.session_id,
        ts: nowIso(),
        text: "[auth] native subscription route unavailable; auto selected api_key",
        payload: {
          auth_switched: true,
          from_auth_mode: "local_session",
          to_auth_mode: "api_key",
          reason: "readiness_preferred",
        },
      };
    }

    // Native auth uses the vendor-owned CODEX_HOME (which may resolve credentials
    // through a config file or OS keychain); API auth uses an isolated generated
    // auth file. Neither route inherits provider env credentials or redirects.
    const env: Record<string, string | null | undefined> =
      authRoute === "subscription" ? nativeEnv : { ...spec.env, ...providerScrubEnv() };

    // Non-envelope API-key routes use a private CODEX_HOME because Codex ignores
    // OPENAI_API_KEY against its normal auth store. `tryApiKey` created and
    // verified this file before route selection returned api_key.
    if (authRoute === "api_key" && tempCodexHome) {
      env["CODEX_HOME"] = tempCodexHome;
    }

    // Disable Codex.app's headless-incompatible node_repl MCP, but ONLY when the
    // config codex will actually load (the resolved CODEX_HOME, else ~/.codex)
    // already defines it — never create a transport-less partial entry on a scoped
    // home (that broke codex startup, the "invalid transport" regression).
    // Structured output: codex takes a FILE path. API routes may use their
    // isolated CODEX_HOME; native routes must never write helper files into the
    // vendor-owned native home, so they use a private temp directory.
    if (!runtime.runAppServer && spec.output_schema !== undefined && spec.output_schema !== null) {
      try {
        let dir = authRoute === "subscription" ? undefined : env["CODEX_HOME"];
        if (!dir) {
          tempSchemaDir = mkdtempSync(join(tmpdir(), "claudexor-codex-schema-"));
          dir = tempSchemaDir;
        }
        outputSchemaPath = join(dir, `claudexor-output-schema-${spec.session_id}.json`);
        writeFileSync(outputSchemaPath, JSON.stringify(spec.output_schema));
      } catch (err) {
        // FAIL-CLOSED (Quiz-6a): output_schema is a contract — running the
        // child UNCONSTRAINED because a local schema file failed to write would
        // silently drop it. Fail loudly; the caller retries or reroutes.
        throw new Error(
          `codex output-schema file could not be written (${err instanceof Error ? err.message : String(err)}); refusing to run unconstrained`,
        );
      }
    }
    // Probed in THIS run's resolved env, so a credential profile or API-key route
    // gets its OWN account's catalog, not whichever one landed in the cache first.
    // INV-105 on the RUN: version-gate snapshot-fallback trust, then ONE result —
    // the receipt recorded here is the level both arg builders send and the
    // DROP/CLAMP disclosure describes (preflight only saw the DEFAULT account).
    const effort = await codexRunEffortResolution(spec, runtime, env, abortSignalFromSpec(spec));
    yield effort.event;
    throwIfEffortRejected(effort.resolution);
    spec = applyCodexRunProcessing(
      spec,
      effort.catalog,
      env["CODEX_HOME"],
      authRoute === "subscription",
    );
    const suppressNodeRepl = codexConfigHasNodeRepl(env["CODEX_HOME"]);
    const args = runtime.runAppServer
      ? [
          ...CODEX_FILE_AUTH_ARGS,
          ...CODEX_PROJECT_DOC_FALLBACK_ARGS,
          ...(suppressNodeRepl ? ["-c", "mcp_servers.node_repl.enabled=false"] : []),
        ]
      : codexExecArgs(spec, {
          suppressNodeRepl,
          outputSchemaPath,
          effortCatalog: effort.catalog,
          effort: effort.resolution.submitted,
        });
    // Route evidence: the auth mode this child ACTUALLY runs under, read from
    // the same auth.json codex loads (typed `auth_mode` field — chatgpt vs
    // apikey). Disclosed on the started event; quota attribution consumes it.
    const credentialRoute =
      authRoute === "subscription" ? ("vendor_native" as const) : ("managed_api_key" as const);
    const credentialSource =
      authRoute === "subscription" ? ("native_session" as const) : ("api_key_env" as const);
    // Codex reports tokens, not cash; only explicit rates may supply an estimate.
    const model = spec.model_hint ?? process.env.CLAUDEXOR_CODEX_MODEL ?? null;
    const parseState: CodexParseState = {
      envelopeActive: !!spec.output_schema,
      requiredMcpServers: (spec.extra_mcp_servers ?? [])
        .filter((server) => server.required)
        .map((server) => server.name),
    }; // finality + #19816 + required MCP startup proof
    const decoration: CodexEventDecoration = {
      spec,
      env,
      credentialRoute,
      credentialSource,
      tempCodexHome,
      model,
    };
    const decorate = (event: HarnessEvent): HarnessEvent => decorateCodexEvent(event, decoration);

    if (runtime.runAppServer) {
      const native = runtime.runAppServer({
        bin: BIN,
        args,
        spec,
        env,
        controller,
        effort: effort.resolution.submitted,
      });
      const decorated = (async function* (): AsyncGenerator<HarnessEvent> {
        for await (const event of native) yield decorate(event);
      })();
      yield* withCodexVendorFailure(decorated, spec, env, () => decoration.nativeThreadId);
      return;
    }
    const stream = runtime.runCliHarness({
      bin: BIN,
      args,
      spec,
      input: spec.prompt,
      env,
      label: "codex",
      redact: redactSecrets,
      parseEvent: (obj, sessionId) => {
        // Bind the rollout transcript to THIS run via the native thread id.
        const raw = obj as { type?: unknown; thread_id?: unknown };
        if (raw?.type === "thread.started" && typeof raw.thread_id === "string")
          decoration.nativeThreadId = raw.thread_id;
        const out = parseCodexEvent(obj, sessionId, parseState);
        if (out === null) return null;
        for (const ev of out) decorate(ev);
        return out;
      },
      parseStderrFailure: (message, sessionId) => {
        const event = parseCodexStderrFailure(message, sessionId, parseState);
        if (event) {
          event.credential_route = credentialRoute;
          event.credential_source = credentialSource;
          if (profile) event.credential_profile_id = profile.profile_id;
        }
        return event;
      },
    });
    yield* withCodexVendorFailure(stream, spec, env, () => decoration.nativeThreadId);
  } finally {
    if (tempCodexHome) {
      try {
        rmSync(tempCodexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        /* best-effort: OS tmp reaper owns the leftovers */
      }
    }
    if (tempSchemaDir) {
      try {
        rmSync(tempSchemaDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        /* best-effort: OS tmp reaper owns the leftovers */
      }
    }
  }
}
