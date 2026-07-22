import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { codexTranscriptModel, codexTranscriptRateLimits } from "./transcript.js";
import { resolveSecret } from "@claudexor/secrets";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AccessProfile,
  AuthSourceReadiness,
  ConformanceReport,
  CredentialProfile,
  CredentialProfileStatus,
  EffortHint,
  HarnessEvent,
  HarnessManifest,
  HarnessRunSpec,
} from "@claudexor/schema";
import {
  ConformanceReport as ConformanceReportSchema,
  HarnessManifest as HarnessManifestSchema,
} from "@claudexor/schema";
import type { DoctorSpec, HarnessAdapter } from "@claudexor/core";
import {
  abortSignalFromSpec,
  brokenInstallAdvisory,
  browserMcpCommand,
  normalizeEffort,
  providerScrubEnv,
  resolveHarnessBinary,
  runCliHarness,
  selectStrictAuthRoute,
  selectedAuthAvailable,
  selectedAuthReady,
  shouldVerifyApiKey,
} from "@claudexor/core";
import { CLAUDEXOR_VERSION, nowIso, redactSecrets } from "@claudexor/util";
import { parseCodexEvent, type CodexParseState } from "./parse.js";
import { probeCodexCredentialProfile, resolveCodexProfileRoute } from "./profile.js";
import { smokeIsolatedApiKey } from "./smoke.js";
export { canonicalCodexProfileHome, codexAccountIdentity } from "./profile.js";
import { estimateCodexCostUsd } from "./pricing.js";
import { codexImageArgs } from "./attachments.js";

import { BIN, detectVersion, missingCliError, missingCliReport, probeEnv } from "./missing-cli.js";
export { BIN } from "./missing-cli.js";

/**
 * Ordered (weakest→strongest) reasoning-effort levels codex's
 * `model_reasoning_effort` config accepts. SINGLE source: the manifest's
 * `effort_levels` and the run-time normalizer both read this. The cross-harness
 * `max` hint clamps to `xhigh` (the ceiling) via the shared normalizer.
 */
const CODEX_EFFORT_LEVELS: readonly EffortHint[] = ["low", "medium", "high", "xhigh"];

/** Exported for focused route-policy tests; runtime uses this exact selector. */
export const selectCodexRunAuthRoute = selectStrictAuthRoute;

export {
  CODEX_FILE_AUTH_ARGS,
  CODEX_FILE_AUTH_OVERRIDE,
  codexApiKey,
  codexAuthModeAt,
  defaultNativeCodexHome,
  ensureCodexApiAuth,
  probeLogin,
} from "./auth.js";
import {
  CODEX_FILE_AUTH_ARGS,
  codexApiKey,
  codexAuthModeAt,
  defaultNativeCodexHome,
  ensureCodexApiAuth,
  hasApiKey,
  probeLogin,
  type CodexLoginProbe,
} from "./auth.js";

/**
 * A TOML basic-string literal for a `-c key=value` override. `developer_instructions`
 * is a documented additive Codex config key (layered as a developer block BEFORE
 * AGENTS.md, not a replacement); passing per-invocation `-c` keeps it isolated
 * to this run (never a shared-config mutation). Instructions may contain quotes
 * and newlines, so they are TOML-escaped.
 */
function tomlBasicString(value: string): string {
  // TOML basic-string escapes, built by code point so the SOURCE carries no
  // literal control characters: a backslash and quote are escaped, a literal
  // newline/tab/CR become their escapes (a raw newline is invalid in a basic
  // string), other control chars become \uXXXX, and everything else is literal.
  let out = '"';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (code === 10) out += "\\n";
    else if (code === 13) out += "\\r";
    else if (code === 9) out += "\\t";
    else if (code < 32 || code === 127) out += "\\u" + code.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

function sandboxArgs(access: AccessProfile): string[] {
  switch (access) {
    case "readonly":
      return ["--sandbox", "read-only"];
    case "workspace_write":
      return ["--sandbox", "workspace-write"];
    case "full":
    case "external_sandbox_full":
      return ["--sandbox", "danger-full-access"];
    case "inherit_native":
      return [];
  }
}

export function redactCodexDoctorDetail(text: string): string {
  return redactSecrets(text).slice(0, 500);
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

function codexNativeReadiness(login: CodexLoginProbe): AuthSourceReadiness {
  if (login.probeError) {
    return {
      source: "native_session",
      availability: "unknown",
      verification: "not_run",
      detail: `login-status probe failed: ${redactCodexDoctorDetail(login.probeError)}`,
    };
  }
  if (login.method === "chatgpt") {
    return {
      source: "native_session",
      availability: "available",
      verification: "passed",
      detail: "vendor status confirmed a native ChatGPT session in the exact run environment",
    };
  }
  if (login.authed) {
    return {
      source: "native_session",
      availability: "available",
      verification: "failed",
      detail: `Codex is authenticated via ${login.method}, not ChatGPT subscription auth`,
    };
  }
  return {
    source: "native_session",
    availability: "unavailable",
    verification: "not_run",
    detail: "native Codex session is not logged in",
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

/**
 * True only when the config codex WILL load (the scoped `CODEX_HOME` if set,
 * else `~/.codex`) actually defines `[mcp_servers.node_repl]`. We only ever
 * disable node_repl when it already exists — a `-c mcp_servers.node_repl.*`
 * override against a config that has NO node_repl creates a partial entry with
 * no transport and codex refuses to load it ("invalid transport in
 * mcp_servers.node_repl"), which broke every scoped-home / api_key / MCP run.
 */
export function codexConfigHasNodeRepl(codexHome: string | null | undefined): boolean {
  const cfg = join(codexHome || defaultNativeCodexHome(), "config.toml");
  try {
    return existsSync(cfg) && readFileSync(cfg, "utf8").includes("[mcp_servers.node_repl]");
  } catch {
    return false;
  }
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
  > & {
    resume_session_id?: string | null;
    extra_mcp_servers?: HarnessRunSpec["extra_mcp_servers"];
  },
  opts: { suppressNodeRepl?: boolean; outputSchemaPath?: string | null } = {},
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
  // Clamp the requested effort onto codex's supported ladder via the shared
  // normalizer (single source: CODEX_EFFORT_LEVELS). Null = not requested OR
  // effort not tunable -> pass no flag.
  const effort = normalizeEffort(spec.effort_hint, CODEX_EFFORT_LEVELS);
  if (spec.resume_session_id) {
    const args = [
      "exec",
      "resume",
      spec.resume_session_id,
      "--json",
      ...CODEX_FILE_AUTH_ARGS,
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
    // `codex exec -i/--image <FILE>...` is VARIADIC, so a positional prompt placed
    // right after it is swallowed as another "image" — the model then receives no
    // prompt and never sees the attachment (the v0.13 "I don't see the image" bug).
    // LIVE-VERIFIED on codex 0.142: `-i <path> -- "<prompt>"` => image IS described.
    if (imageArgs.length > 0) args.push("--");
    args.push(spec.prompt);
    return args;
  }
  const args = ["exec", "--json", ...CODEX_FILE_AUTH_ARGS];
  args.push(...sandboxArgs(spec.access), "--skip-git-repo-check");
  if (opts.outputSchemaPath) args.push("--output-schema", opts.outputSchemaPath);
  if (spec.model_hint) args.push("-m", spec.model_hint);
  if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
  if (spec.instructions && spec.instructions.trim())
    args.push("-c", `developer_instructions=${tomlBasicString(spec.instructions)}`);
  args.push(...codexWebArgs(spec.external_context_policy ?? "auto"));
  // ALL `-c` config overrides BEFORE `-i` (variadic) so they can't be eaten as
  // image paths; then images, then `--`, then the prompt. See resume branch.
  args.push(
    ...codexBrowserArgs(spec.browser, spec.external_context_policy, spec.extra_mcp_servers),
  );
  args.push(...nodeReplArgs);
  const imageArgs = codexImageArgs(spec.attachments);
  args.push(...imageArgs);
  if (imageArgs.length > 0) args.push("--");
  args.push(spec.prompt);
  return args;
}

/** Sandbox as `-c sandbox_mode=...` config (the only spelling `exec resume` accepts). */
function sandboxConfigArgs(access: AccessProfile): string[] {
  switch (access) {
    case "readonly":
      return ["-c", 'sandbox_mode="read-only"'];
    case "workspace_write":
      return ["-c", 'sandbox_mode="workspace-write"'];
    case "full":
    case "external_sandbox_full":
      return ["-c", 'sandbox_mode="danger-full-access"'];
    case "inherit_native":
      return [];
  }
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
};

export function createCodexAdapter(deps: Partial<CodexRuntimeDeps> = {}): HarnessAdapter {
  const runtime: CodexRuntimeDeps = {
    detectVersion,
    brokenInstallAdvisory,
    probeLogin,
    hasApiKey,
    codexApiKey,
    resolveProfileSecret: (ref) => resolveSecret(ref),
    smokeIsolatedApiKey,
    runCliHarness,
    ...deps,
  };
  return {
    id: "codex",

    async discover(): Promise<HarnessManifest> {
      const version = await runtime.detectVersion();
      if (version === null) throw missingCliError(runtime.brokenInstallAdvisory(BIN));
      const apiKey = runtime.hasApiKey();
      const login = await runtime.probeLogin(BIN, { env: codexNativeEnv() });
      const nativeSessionAvailable = login.method === "chatgpt";
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
          plan: true,
          implement: true,
          create_from_scratch: true,
          review: true,
          verify: true,
          synthesize: true,
          read_files: true,
          // mcp_servers.browser.*` overrides (live-verified) — gated on web policy.
          browser_tool: true,
          // LIVE-VERIFIED (codex 0.137): `codex exec --output-schema <FILE>`.
          json_schema_output: true,
          web_policy: "native",
          // codex model_reasoning_effort accepts low|medium|high|xhigh (max clamps
          // to xhigh). Single source for the manifest AND the run-time normalizer.
          effort_levels: [...CODEX_EFFORT_LEVELS],
          // Manifest model truth source (strict model-truth validation: an explicit model outside
          // this list is refused, never forwarded to die as a native error).
          // Current + still-API-available ids per the vendor Codex models page,
          // verified against the installed CLI recorded below.
          known_models: [
            "gpt-5.6",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gpt-5.6-luna",
            "gpt-5.5",
            "gpt-5.4",
            "gpt-5.4-mini",
            "gpt-5.3-codex-spark",
          ],
          known_models_verified_against: "0.144.1",
        },
        capability_profile: {
          auth: {
            supported_sources: ["native_session", "provider_auth_file"],
            preferred_source: nativeSessionAvailable
              ? "native_session"
              : apiKey
                ? "provider_auth_file"
                : null,
            credential_transports: [
              { source: "native_session", kind: "config_file", relocatable_by: ["CONFIG_DIR"] },
              { source: "provider_auth_file", kind: "config_file", relocatable_by: ["CONFIG_DIR"] },
            ],
          },
          access_control: { readonly_mechanism: "fs_sandbox" },
          isolation: { supported_containment: ["host_user_context", "env_or_file_injection"] },
          mcp_injection: true,
          // Codex's workspace-write seatbelt cancels the belt's daemon-crossing
          // MCP call in headless exec; only danger-full-access (full) lets it
          // through — same constraint the browser MCP already rides.
          mcp_injection_requires_full_access: true,
          attachment_inputs: [
            {
              kind: "image",
              mime_types: ["image/png", "image/jpeg", "image/gif", "image/webp"],
              max_bytes: 20 * 1024 * 1024,
              max_count: 20,
              transport: "file_path",
            },
          ],
        },
        auth_modes: authModes,
        access_profiles_supported: ["readonly", "workspace_write", "full", "inherit_native"],
      });
    },

    async doctor(_spec: DoctorSpec): Promise<ConformanceReport> {
      // The scoped env drives BOTH the version probe and the advisory, so the
      // diagnosis always describes the exact env the probe failed in.
      const version = await runtime.detectVersion(_spec.abortSignal, _spec.env);
      if (version === null) {
        return missingCliReport(runtime.brokenInstallAdvisory(BIN, probeEnv(_spec.env)));
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
      const binPath = resolveHarnessBinary(BIN);
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
          {
            id: "installed",
            status: "pass",
            detail: binPath ? `${version} at ${binPath}` : version,
          },
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
      return runCodex(spec, runtime);
    },

    review(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runCodex(spec, runtime);
    },

    probeCredentialProfile(
      profile: CredentialProfile,
      abortSignal?: AbortSignal,
    ): Promise<CredentialProfileStatus> {
      return probeCodexCredentialProfile(profile, runtime, abortSignal);
    },
  };
}

async function* runCodex(
  spec: HarnessRunSpec,
  runtime: CodexRuntimeDeps,
): AsyncIterable<HarnessEvent> {
  const profile = spec.credential_profile;
  const authPreference = spec.auth_preference ?? "auto";
  let nativeEnv = codexNativeEnv(spec.env);
  let key: string | undefined;
  let tempCodexHome: string | null = null;
  let authRoute: "subscription" | "api_key" | null;

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
    const nativeSessionReady = nativeLogin.method === "chatgpt" && nativeLogin.probeError === null;
    const trySubscription = (): boolean => nativeSessionReady;
    const tryApiKey = (): boolean => {
      key ??= runtime.codexApiKey();
      if (!key) return false;
      tempCodexHome = mkdtempSync(join(tmpdir(), "claudexor-codex-auth-"));
      ensureCodexApiAuth({ CODEX_HOME: tempCodexHome });
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
  let outputSchemaPath: string | null = null;
  let tempSchemaDir: string | null = null;
  if (spec.output_schema !== undefined && spec.output_schema !== null) {
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
  const args = codexExecArgs(spec, {
    suppressNodeRepl: codexConfigHasNodeRepl(env["CODEX_HOME"]),
    outputSchemaPath,
  });
  // Route evidence: the auth mode this child ACTUALLY runs under, read from
  // the same auth.json codex loads (typed `auth_mode` field — chatgpt vs
  // apikey). Disclosed on the started event; quota attribution consumes it.
  const credentialRoute =
    authRoute === "subscription" ? ("vendor_native" as const) : ("managed_api_key" as const);
  const credentialSource =
    authRoute === "subscription" ? ("native_session" as const) : ("api_key_env" as const);
  // Codex reports tokens but no $cost; estimate it from the (hint/configured)
  // model so the budget ledger does not see every codex run as free.
  const model = spec.model_hint ?? process.env.CLAUDEXOR_CODEX_MODEL ?? null;
  // capture the native thread id (thread.started) so we can read the model
  // codex recorded in its own rollout transcript; cache that one read.
  let codexThreadId: string | undefined;
  let transcriptModel: string | undefined;
  const parseState: CodexParseState = {}; // per-run finality (see CodexParseState)

  try {
    yield* runtime.runCliHarness({
      bin: BIN,
      args,
      spec,
      env,
      label: "codex",
      redact: redactSecrets,
      parseEvent: (obj, sessionId) => {
        // Bind the rollout transcript to THIS run via the native thread id.
        const raw = obj as { type?: unknown; thread_id?: unknown };
        if (raw?.type === "thread.started" && typeof raw.thread_id === "string")
          codexThreadId = raw.thread_id;
        const out = parseCodexEvent(obj, sessionId, parseState);
        if (out === null) return null;
        for (const ev of out) {
          // Do NOT fabricate observed_model from the request hint: route proof
          // exists to catch silent fallback, so an unobserved model must stay
          // unobserved. Record the requested model for diagnostics only.
          if (ev.type === "started" && spec.model_hint && !ev.observed_model) {
            ev.payload = {
              ...(ev.payload ?? {}),
              requested_model: spec.model_hint,
              observed_model_source: "unobserved",
            };
          }
          // The route is fixed before spawn; attach it to every event so a
          // later usage/quota record remains independently attributable.
          ev.credential_route = credentialRoute;
          ev.credential_source = credentialSource;
          if (profile) ev.credential_profile_id = profile.profile_id;
          // codex's --json stream never carries the model, but the CLI
          // records it in its own session rollout. Try to recover it as soon as
          // the rollout's turn_context appears, then attach the transcript-sourced
          // observation to the next normalized event. This keeps route proof from
          // depending on reaching the final usage event under slow reviewer runs.
          if (!ev.observed_model && spec.evidence_policy !== "stream_only") {
            transcriptModel ??= codexTranscriptModel(env["CODEX_HOME"], codexThreadId) ?? undefined;
            if (transcriptModel) {
              ev.observed_model = transcriptModel;
              ev.payload = { ...(ev.payload ?? {}), observed_model_source: "transcript" };
            }
          }
          // an api_key run uses a TEMPORARY CODEX_HOME that this process
          // deletes on exit, so the native session it created is gone next turn.
          // Strip its id from the event so it never poisons the thread resume map
          // (a later `codex exec resume <ghost>` would deterministically fail).
          if (
            ev.type === "started" &&
            tempCodexHome &&
            ev.payload &&
            "native_session_id" in ev.payload
          ) {
            const { native_session_id: _dropped, ...rest } = ev.payload as Record<string, unknown>;
            ev.payload = { ...rest, resume_disabled: "ephemeral_codex_home" };
          }
          if (ev.type === "usage" && ev.usage && ev.usage.cost_usd === undefined) {
            const est = estimateCodexCostUsd(model, ev.usage);
            if (est !== undefined) {
              ev.usage.cost_usd = est;
              ev.usage.estimated = true;
            }
          }
          // Quota headroom: attach codex's own rate-window record to the usage event
          // (fresh read per usage — the rollout accretes as the turn ends).
          if (ev.type === "usage" && !ev.quota && spec.evidence_policy !== "stream_only") {
            const rl = codexTranscriptRateLimits(env["CODEX_HOME"], codexThreadId);
            if (rl) ev.quota = rl;
          }
          if (ev.quota && profile && ev.quota.subject_id == null) {
            ev.quota = { ...ev.quota, subject_id: profile.profile_id };
          }
          // A profiled run's quota windows belong to THE PROFILE's account
          // (round-17 #2): the rollout record carries no subject, and an
          // unstamped null would register as the engine-default subject.
        }
        return out;
      },
    });
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
