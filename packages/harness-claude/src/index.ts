import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AccessProfile,
  AuthSourceReadiness,
  ConformanceReport,
  CredentialProfile,
  CredentialProfileStatus,
  EffortHint,
  HarnessCapabilityProfile,
  HarnessEvent,
  HarnessManifest,
  HarnessRunSpec,
} from "@claudexor/schema";
import {
  ConformanceReport as ConformanceReportSchema,
  HarnessCapabilityProfile as HarnessCapabilityProfileSchema,
  HarnessManifest as HarnessManifestSchema,
} from "@claudexor/schema";
import type { DoctorSpec, HarnessAdapter, InteractionChannel } from "@claudexor/core";
import {
  abortSignalFromSpec,
  browserMcpCommand,
  HarnessUnavailableError,
  interactionChannelFromSpec,
  labelStreams,
  normalizeEffort,
  providerScrubEnv,
  resolveHarnessBinary,
  runCapture,
  runCliHarness,
  PROVIDER_SECRET_ENV,
  selectStrictAuthRoute,
  selectedAuthAvailable,
  selectedAuthReady,
  shouldVerifyApiKey,
} from "@claudexor/core";
import { resolveSecret } from "@claudexor/secrets";
import { CLAUDEXOR_VERSION, nowIso, redactSecrets } from "@claudexor/util";
import { createClaudeParser } from "./parse.js";
import { probeClaudeCredentialProfile, resolveClaudeProfileRoute } from "./profile.js";
export { canonicalProfileConfigDir } from "./profile.js";
import { smokeIsolatedApiKey, smokeIsolatedOAuthToken } from "./smoke.js";
import {
  claudeAttachmentBlocks,
  handleControlRequestFrame,
  initialSessionFrames,
  isControlRequestFrame,
  isResultFrame,
} from "./interactive.js";

export const BIN = process.env.CLAUDEXOR_CLAUDE_BIN || "claude";
export const CLAUDE_PROVIDER_ENV_DENYLIST = PROVIDER_SECRET_ENV.filter(
  (k) => k !== "ANTHROPIC_API_KEY",
);

const CLAUDE_CAPABILITY_PROFILE: HarnessCapabilityProfile = HarnessCapabilityProfileSchema.parse({
  auth: {
    supported_sources: ["native_session", "oauth_token_env", "api_key_env"],
    preferred_source: null,
    credential_transports: [
      { source: "native_session", kind: "config_file", relocatable_by: ["CONFIG_DIR"] },
      { source: "native_session", kind: "os_keychain", relocatable_by: [] },
      { source: "oauth_token_env", kind: "oauth_token_env", relocatable_by: ["ENV"] },
      { source: "api_key_env", kind: "env_var", relocatable_by: ["ENV"] },
    ],
  },
  access_control: { readonly_mechanism: "tool_allowlist" },
  isolation: { supported_containment: ["host_user_context", "env_or_file_injection"] },
  attachment_inputs: [
    {
      kind: "image",
      mime_types: ["image/png", "image/jpeg", "image/gif", "image/webp"],
      max_bytes: 5 * 1024 * 1024,
      max_count: 20,
      transport: "base64_stream",
    },
    {
      kind: "file",
      mime_types: ["text/plain", "text/markdown", "application/json"],
      max_bytes: 1024 * 1024,
      max_count: 10,
      transport: "text_inline",
    },
  ],
});

/**
 * Ordered (weakest→strongest) reasoning-effort levels `claude --effort` accepts.
 * Verified against the installed CLI (`claude --help`, v2.1.165): the full
 * ladder is low|medium|high|max. SINGLE source for the manifest's
 * `effort_levels` and the run-time normalizer (which now clamps nothing away).
 */
const CLAUDE_EFFORT_LEVELS: readonly EffortHint[] = ["low", "medium", "high", "max"];

/** Exported for focused route-policy tests; runtime uses this exact selector. */
export const selectClaudeRunAuthRoute = selectStrictAuthRoute;

function permissionArgs(access: AccessProfile): string[] {
  switch (access) {
    case "readonly":
      // Defense in depth: plan mode rejects mutation requests, setting sources
      // prevent user/project policy from widening the route, strict MCP ignores
      // project servers, and slash commands/Chrome are independent tool ingress.
      return [
        "--permission-mode",
        "plan",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-chrome",
      ];
    case "workspace_write":
      return ["--permission-mode", "acceptEdits"];
    case "full":
    case "external_sandbox_full":
      return ["--permission-mode", "bypassPermissions"];
    case "inherit_native":
      return [];
  }
}

export interface ClaudeReadonlyProfileProbe {
  supported: boolean;
  missingFlags: string[];
  detail: string;
}

const CLAUDE_READONLY_REQUIRED_FLAGS = [
  "--tools",
  "--setting-sources",
  "--strict-mcp-config",
  "--permission-mode",
  "--disable-slash-commands",
  "--no-chrome",
] as const;

let readonlyProbePromise: Promise<ClaudeReadonlyProfileProbe> | null = null;

export function probeClaudeReadonlyProfile(
  abortSignal?: AbortSignal,
): Promise<ClaudeReadonlyProfileProbe> {
  if (readonlyProbePromise) return readonlyProbePromise;
  readonlyProbePromise = (async () => {
    try {
      const result = await runCapture(BIN, ["--help"], {
        timeoutMs: 10_000,
        abortSignal,
        cancelSignal: "SIGTERM",
        cancelKillDelayMs: 0,
      });
      const help = `${result.stdout}\n${result.stderr}`;
      const missingFlags: string[] = CLAUDE_READONLY_REQUIRED_FLAGS.filter(
        (flag) => !help.includes(flag),
      );
      const hasPlanMode =
        help.includes('"plan"') || help.includes("plan,") || help.includes(", plan");
      if (!hasPlanMode) missingFlags.push("--permission-mode=plan");
      return {
        supported: result.code === 0 && missingFlags.length === 0,
        missingFlags,
        detail:
          result.code === 0 && missingFlags.length === 0
            ? "installed Claude CLI exposes the complete restrictive readonly flag set"
            : `readonly enforcement unavailable; missing ${missingFlags.join(", ") || `help exited ${result.code}`}`,
      };
    } catch (error) {
      return {
        supported: false,
        missingFlags: [...CLAUDE_READONLY_REQUIRED_FLAGS],
        detail: `readonly enforcement probe failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
      };
    }
  })();
  return readonlyProbePromise;
}

async function detectVersion(abortSignal?: AbortSignal): Promise<string | null> {
  try {
    const r = await runCapture(BIN, ["--version"], {
      timeoutMs: 10_000,
      abortSignal,
      cancelSignal: "SIGTERM",
      cancelKillDelayMs: 0,
    });
    return r.stdout.trim() || `${BIN} (version unknown)`;
  } catch {
    return null;
  }
}

/**
 * Native-session probe with a distinct PROBE-FAILURE state (same contract as
 * the codex adapter's probeLogin). `claude auth status` prints a typed JSON
 * verdict `{loggedIn, authMethod, ...}` on stdout; the exit code alone is NOT
 * the auth verdict. When the JSON is present we trust its `loggedIn` field;
 * a probe that produces no parseable verdict is a probe error, never a silent
 * "not logged in".
 */
export interface ClaudeAuthStatusProbe {
  loggedIn: boolean;
  authed: boolean;
  authMethod: string | null;
  probeError: string | null;
}

export interface ClaudeAuthStatusProbeOptions {
  env?: Record<string, string | null | undefined>;
  abortSignal?: AbortSignal;
  runCapture?: typeof runCapture;
}

export function claudeNativeEnv(
  base?: Record<string, string | null | undefined>,
  configDir?: string,
): Record<string, string | null | undefined> {
  return {
    ...(base ?? {}),
    ...providerScrubEnv(),
    CLAUDE_CONFIG_DIR: configDir ?? defaultNativeClaudeConfigDir(),
  };
}

export async function probeAuthStatus(
  bin: string = BIN,
  options: ClaudeAuthStatusProbeOptions = {},
): Promise<ClaudeAuthStatusProbe> {
  try {
    const env = claudeNativeEnv(options.env);
    const r = await (options.runCapture ?? runCapture)(bin, ["auth", "status"], {
      env,
      timeoutMs: 10_000,
      abortSignal: options.abortSignal,
      cancelSignal: "SIGTERM",
      cancelKillDelayMs: 0,
    });
    try {
      const verdict = JSON.parse(r.stdout.trim()) as { loggedIn?: unknown; authMethod?: unknown };
      if (typeof verdict.loggedIn === "boolean" && typeof verdict.authMethod === "string") {
        return {
          loggedIn: verdict.loggedIn,
          authed: verdict.loggedIn && verdict.authMethod === "claude.ai",
          authMethod: verdict.authMethod,
          probeError: null,
        };
      }
    } catch {
      /* no typed JSON verdict: fall through to probe-error disclosure */
    }
    const detail =
      labelStreams(r.stderr, r.stdout, { transform: redactSecrets }) ??
      `claude auth status exited with ${r.code ?? r.signal ?? "unknown result"}`;
    return { loggedIn: false, authed: false, authMethod: null, probeError: detail };
  } catch (err) {
    return {
      loggedIn: false,
      authed: false,
      authMethod: null,
      probeError: [...redactSecrets(err instanceof Error ? err.message : String(err))]
        .slice(0, 300)
        .join(""),
    };
  }
}

export function anthropicApiKey(): string | null {
  return (
    process.env.CLAUDEXOR_ANTHROPIC_API_KEY ||
    resolveSecret("anthropic") ||
    process.env.ANTHROPIC_API_KEY ||
    null
  );
}

/** A stored/long-lived Claude Code OAuth (`claude setup-token`) for headless
 * subscription auth. The hermetic kill switch is honored inside resolveSecret
 * (single owner), so this reads env-only under CLAUDEXOR_DISABLE_STORED_SECRETS. */
function claudeOAuthToken(): string | null {
  return resolveSecret("claude_oauth") || process.env.CLAUDE_CODE_OAUTH_TOKEN || null;
}

/** The user's real Claude config dir (native subscription session lives here). */
export function defaultNativeClaudeConfigDir(): string {
  const override = process.env.CLAUDEXOR_CLAUDE_NATIVE_DIR;
  if (override && override.trim()) return override;
  return join(homedir(), ".claude");
}

export function claudeAuthSourceReadiness(input: {
  native: ClaudeAuthStatusProbe;
  oauthAvailable: boolean;
  oauthVerification: "passed" | "failed" | "not_run";
  oauthDetail: string;
  apiKeyAvailable: boolean;
  apiKeyVerification: "passed" | "failed" | "not_run";
  apiKeyDetail: string;
}): AuthSourceReadiness[] {
  const nativeReady = input.native.authed && input.native.probeError === null;
  const nativeAvailability = input.native.probeError
    ? "unknown"
    : input.native.loggedIn
      ? "available"
      : "unavailable";
  const nativeVerification = nativeReady
    ? "passed"
    : input.native.probeError || !input.native.loggedIn
      ? "not_run"
      : "failed";
  return [
    {
      source: "native_session",
      availability: nativeAvailability,
      verification: nativeVerification,
      detail: nativeReady
        ? "vendor status confirmed authMethod=claude.ai in the exact run environment"
        : input.native.probeError
          ? `auth-status probe failed: ${redactClaudeDoctorDetail(input.native.probeError)}`
          : input.native.loggedIn
            ? `Claude is logged in via ${input.native.authMethod ?? "unknown"}, not claude.ai`
            : "official native Claude session is not logged in",
    },
    {
      source: "oauth_token_env",
      availability: input.oauthAvailable ? "available" : "unavailable",
      verification: input.oauthVerification,
      detail: input.oauthDetail,
    },
    {
      source: "api_key_env",
      availability: input.apiKeyAvailable ? "available" : "unavailable",
      verification: input.apiKeyVerification,
      detail: input.apiKeyDetail,
    },
  ];
}

export function redactClaudeDoctorDetail(text: string): string {
  return redactSecrets(text).slice(0, 500);
}

/** The runtime surface the profile module needs (test-stubbable). */
export type ClaudeProfileRuntimeDeps = Pick<
  ClaudeRuntimeDeps,
  "probeAuthStatus" | "resolveProfileSecret"
>;

type ClaudeRuntimeDeps = {
  detectVersion: typeof detectVersion;
  probeAuthStatus: typeof probeAuthStatus;
  anthropicApiKey: typeof anthropicApiKey;
  claudeOAuthToken: typeof claudeOAuthToken;
  /** Profile-scoped secret resolution (INV-135): reads exactly the profile's
   * namespaced ref, never the engine-default ladder. */
  resolveProfileSecret: (ref: string) => string | null;
  smokeIsolatedApiKey: typeof smokeIsolatedApiKey;
  smokeIsolatedOAuthToken: typeof smokeIsolatedOAuthToken;
  probeReadonlyProfile: typeof probeClaudeReadonlyProfile;
  runCliHarness: typeof runCliHarness;
};

export function createClaudeAdapter(deps: Partial<ClaudeRuntimeDeps> = {}): HarnessAdapter {
  const runtime: ClaudeRuntimeDeps = {
    detectVersion,
    probeAuthStatus,
    anthropicApiKey,
    claudeOAuthToken,
    resolveProfileSecret: (ref) => resolveSecret(ref),
    smokeIsolatedApiKey,
    smokeIsolatedOAuthToken,
    probeReadonlyProfile: probeClaudeReadonlyProfile,
    runCliHarness,
    ...deps,
  };
  return {
    id: "claude",

    async discover(): Promise<HarnessManifest> {
      const version = await runtime.detectVersion();
      if (version === null) {
        throw new HarnessUnavailableError(
          "claude CLI not found on PATH (set CLAUDEXOR_CLAUDE_BIN to override)",
        );
      }
      const apiKey = runtime.anthropicApiKey() !== null;
      const readonlyProfile = await runtime.probeReadonlyProfile();
      const native = await runtime.probeAuthStatus(BIN, { env: claudeNativeEnv() });
      const authed = native.authed;
      const oauthTokenAvailable = runtime.claudeOAuthToken() !== null;
      const authModes = [
        ...(authed || oauthTokenAvailable ? ["local_session"] : []),
        ...(apiKey ? ["api_key"] : []),
      ];
      return HarnessManifestSchema.parse({
        id: "claude",
        display_name: "Claude Code",
        kind: "local_cli",
        version,
        adapter_version: CLAUDEXOR_VERSION,
        provider_family: "anthropic",
        capabilities: {
          plan: true,
          implement: true,
          create_from_scratch: true,
          review: true,
          verify: true,
          synthesize: true,
          read_files: true,
          // inline JSON (no disk write) — gated on web policy.
          browser_tool: true,
          // LIVE-VERIFIED (claude 2.1.165): `--json-schema <schema>` (inline JSON).
          json_schema_output: true,
          web_policy: "tools",
          max_turns: true,
          tool_lists: true,
          interactive: true,
          orchestrate: true,
          // claude --effort accepts low|medium|high|xhigh|max (verified against
          // the installed CLI's --help). Single source for the run-time normalizer.
          effort_levels: [...CLAUDE_EFFORT_LEVELS],
          // Manifest model truth source (strict model-truth validation: an explicit model outside
          // this list is refused, never forwarded to die as a native error).
          // Stable aliases plus current full ids; verified against the vendor
          // model-config docs and the installed CLI recorded below.
          known_models: [
            "sonnet",
            "opus",
            "haiku",
            "fable",
            "best",
            "claude-fable-5",
            "claude-sonnet-5",
            "claude-opus-4-8",
            "claude-opus-4-7",
            "claude-opus-4-6",
            "claude-sonnet-4-6",
            "claude-sonnet-4-5",
            "claude-haiku-4-5",
          ],
          known_models_verified_against: "2.1.165",
        },
        capability_profile: {
          ...CLAUDE_CAPABILITY_PROFILE,
          access_control: {
            readonly_mechanism: readonlyProfile.supported ? "tool_allowlist" : "none",
          },
          auth: {
            ...CLAUDE_CAPABILITY_PROFILE.auth,
            preferred_source: authed
              ? "native_session"
              : oauthTokenAvailable
                ? "oauth_token_env"
                : apiKey
                  ? "api_key_env"
                  : null,
          },
        },
        auth_modes: authModes,
        access_profiles_supported: [
          ...(readonlyProfile.supported ? ["readonly" as const] : []),
          "workspace_write",
          "full",
          "inherit_native",
        ],
      });
    },

    async doctor(_spec: DoctorSpec): Promise<ConformanceReport> {
      const version = await runtime.detectVersion(_spec.abortSignal);
      if (version === null) {
        return ConformanceReportSchema.parse({
          harness_id: "claude",
          status: "unavailable",
          checks: [{ id: "installed", status: "fail", detail: "claude not found on PATH" }],
          reasons: ["claude CLI not found (install Claude Code or set CLAUDEXOR_CLAUDE_BIN)"],
        });
      }
      const readonlyProfile = await runtime.probeReadonlyProfile(_spec.abortSignal);
      const requestedSource = _spec.authSource;
      const probeNative = requestedSource === undefined || requestedSource === "native_session";
      const probeOAuth = requestedSource === undefined || requestedSource === "oauth_token_env";
      const probeApi = requestedSource === undefined || requestedSource === "api_key_env";
      const login: ClaudeAuthStatusProbe = probeNative
        ? await runtime.probeAuthStatus(BIN, {
            env: claudeNativeEnv(_spec.env),
            abortSignal: _spec.abortSignal,
          })
        : { loggedIn: false, authed: false, authMethod: null, probeError: null };
      const nativeCliReady = login.authed;
      // Official native-session proof and stored setup-token proof are separate
      // sources. A targeted native probe resolves neither stored source.
      const oauthToken = probeOAuth ? runtime.claudeOAuthToken() : null;
      const oauthTokenAvailable = oauthToken !== null;
      const apiKey = probeApi && runtime.anthropicApiKey() !== null;
      const preference =
        requestedSource === "native_session" || requestedSource === "oauth_token_env"
          ? "subscription"
          : requestedSource === "api_key_env"
            ? "api_key"
            : (_spec.authPreference ?? "auto");
      const shouldSmokeOAuth =
        probeOAuth && oauthToken !== null && !nativeCliReady && preference !== "api_key";
      const oauthSmoke =
        shouldSmokeOAuth && oauthToken
          ? await runtime.smokeIsolatedOAuthToken(oauthToken, _spec.abortSignal)
          : {
              ok: false,
              detail: oauthTokenAvailable
                ? "verification not run for the unselected setup-token route"
                : "no Claude setup-token available",
            };
      const nativeAvailable = login.loggedIn || oauthTokenAvailable;
      const subscriptionReady = nativeCliReady || oauthSmoke.ok;
      const shouldSmokeKey =
        probeApi &&
        shouldVerifyApiKey({ preference, apiKeyAvailable: apiKey, nativeReady: subscriptionReady });
      const apiSmoke = shouldSmokeKey
        ? await runtime.smokeIsolatedApiKey(_spec.abortSignal)
        : {
            ok: false,
            detail: apiKey
              ? "verification not run for the unselected API-key route"
              : "no API key fallback available",
          };
      const ok = selectedAuthReady({
        preference,
        nativeReady: subscriptionReady,
        apiKeyReady: apiSmoke.ok,
      });
      const selectedAvailable = selectedAuthAvailable({
        preference,
        nativeAvailable,
        apiKeyAvailable: apiKey,
      });
      const probeUnknown =
        preference !== "api_key" && login.probeError !== null && !oauthTokenAvailable;
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
        "orchestrate",
      ];
      const binPath = resolveHarnessBinary(BIN);
      const producedSources = claudeAuthSourceReadiness({
        native: login,
        oauthAvailable: oauthTokenAvailable,
        oauthVerification: oauthSmoke.ok ? "passed" : shouldSmokeOAuth ? "failed" : "not_run",
        oauthDetail: oauthSmoke.detail,
        apiKeyAvailable: apiKey,
        apiKeyVerification: apiSmoke.ok ? "passed" : shouldSmokeKey ? "failed" : "not_run",
        apiKeyDetail: apiSmoke.detail,
      });
      const authSources: AuthSourceReadiness[] =
        requestedSource === undefined
          ? producedSources
          : producedSources.filter((source) => source.source === requestedSource);
      if (requestedSource !== undefined && authSources.length === 0) {
        authSources.push({
          source: requestedSource,
          availability: "unavailable",
          verification: "not_run",
          detail: `Claude does not support ${requestedSource}`,
        });
      }
      const authReasons = ok
        ? []
        : preference === "subscription"
          ? [
              login.probeError && !oauthTokenAvailable
                ? `Claude native-session probe failed: ${redactClaudeDoctorDetail(login.probeError)}`
                : oauthTokenAvailable
                  ? `Claude setup-token verification failed: ${oauthSmoke.detail}`
                  : "Claude subscription route is not ready (run `claude auth login --claudeai`)",
            ]
          : preference === "api_key"
            ? [
                apiKey
                  ? `isolated Claude API-key smoke failed: ${apiSmoke.detail}`
                  : "Claude API-key route is not configured",
              ]
            : apiKey
              ? [`isolated Claude API-key smoke failed: ${apiSmoke.detail}`]
              : [
                  "not authenticated (run `claude auth login --claudeai` for native/subscription use, or store an anthropic API key fallback)",
                ];
      return ConformanceReportSchema.parse({
        harness_id: "claude",
        status: ok
          ? readonlyProfile.supported
            ? "ok"
            : "degraded"
          : selectedAvailable || probeUnknown
            ? "degraded"
            : "unavailable",
        checks: [
          {
            id: "installed",
            status: "pass",
            detail: binPath ? `${version} at ${binPath}` : version,
          },
          {
            id: "readonly_enforcement",
            status: readonlyProfile.supported ? "pass" : "fail",
            detail: readonlyProfile.detail,
          },
          ...(probeNative
            ? [
                {
                  id: "native_session",
                  status: nativeCliReady ? "pass" : "fail",
                  detail: nativeCliReady
                    ? "vendor status confirmed authMethod=claude.ai in the exact run environment"
                    : login.probeError
                      ? `auth-status probe failed (NOT an auth verdict): ${redactClaudeDoctorDetail(login.probeError)}`
                      : login.loggedIn
                        ? `logged in via ${login.authMethod ?? "unknown"}, not claude.ai`
                        : "not logged in (run `claude auth login --claudeai`)",
                },
              ]
            : []),
          ...(probeOAuth
            ? [
                {
                  id: "oauth_setup_token",
                  status: oauthSmoke.ok ? "pass" : shouldSmokeOAuth ? "fail" : "skip",
                  detail: oauthSmoke.detail,
                },
              ]
            : []),
          ...(probeApi
            ? [
                {
                  id: "stored_key",
                  status: apiKey ? "pass" : "fail",
                  detail: apiKey
                    ? "anthropic secret/env available (API-key fallback)"
                    : "no anthropic key fallback",
                },
                {
                  id: "isolated_api_smoke",
                  status: apiSmoke.ok ? "pass" : shouldSmokeKey ? "fail" : "skip",
                  detail: apiSmoke.detail,
                },
              ]
            : []),
        ],
        auth_sources: authSources,
        enabled_intents: ok ? allIntents : [],
        disabled_intents: ok ? [] : allIntents,
        reasons: [...authReasons, ...(readonlyProfile.supported ? [] : [readonlyProfile.detail])],
      });
    },

    run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runClaude(spec, runtime);
    },

    review(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runClaude(spec, runtime);
    },

    probeCredentialProfile(
      profile: CredentialProfile,
      abortSignal?: AbortSignal,
    ): Promise<CredentialProfileStatus> {
      return probeClaudeCredentialProfile(profile, runtime, abortSignal);
    },
  };
}

/** Claude's native names for web-permissioned tools. This knowledge lives ONLY in the adapter. */
const CLAUDE_WEB_TOOLS = ["WebSearch", "WebFetch"];
const CLAUDE_READONLY_ALLOWED_TOOLS = ["Read", "Glob", "Grep"];
const CLAUDE_READONLY_BUILTIN_TOOLS = [...CLAUDE_READONLY_ALLOWED_TOOLS, ...CLAUDE_WEB_TOOLS];
const CLAUDE_READONLY_DENIED_TOOLS = [
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Agent",
  "Skill",
];

export function claudeArgsForSpec(
  spec: HarnessRunSpec,
  interactive = false,
  suppressBare = false,
): string[] {
  // Interactive sessions deliver the prompt as a stream-json user message on
  // stdin (the control protocol's transport); one-shot runs keep the prompt arg.
  // `--permission-prompt-tool stdio` is the live-verified switch that routes
  // permission prompts (AskUserQuestion included) onto the control channel as
  // control_request frames instead of headless auto-denial.
  const args = interactive
    ? [
        "-p",
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--verbose",
        "--permission-prompt-tool",
        "stdio",
        ...permissionArgs(spec.access),
      ]
    : [
        "-p",
        spec.prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        ...permissionArgs(spec.access),
      ];
  if (spec.model_hint) args.push("--model", spec.model_hint);
  // W-C4 live deltas (engine-gated to single-candidate lanes; parser tags payload.delta).
  if (spec.stream_deltas) args.push("--include-partial-messages");
  // Clamp onto claude's declared effort ladder; null = not
  // requested OR not tunable -> pass no flag. Never sends an invalid level.
  const eff = normalizeEffort(spec.effort_hint, CLAUDE_EFFORT_LEVELS);
  if (eff) args.push("--effort", eff);
  if (spec.max_turns !== null && spec.max_turns > 0)
    args.push("--max-turns", String(spec.max_turns));
  // Per-run caller instructions APPEND to (never replace) the default system
  // prompt, current-invocation-only. The engine withholds them from synthesis,
  // reviewers, and the auth smoke.
  if (spec.instructions && spec.instructions.trim())
    args.push("--append-system-prompt", spec.instructions);
  // Structured output: constrain the FINAL message to the caller's JSON
  // Schema. LIVE-VERIFIED (2.1.165): `--json-schema <inline JSON>` with
  // --output-format stream-json. Passed only when the engine set it (the
  // engine gates on the json_schema_output capability).
  if (spec.output_schema !== undefined && spec.output_schema !== null) {
    args.push("--json-schema", JSON.stringify(spec.output_schema));
  }
  // Resume a native Claude session as a follow-up turn of the same conversation.
  if (spec.resume_session_id) args.push("--resume", spec.resume_session_id);
  args.push(...claudeBrowserArgs(spec));
  args.push(...toolPermissionArgs(spec));
  // `--bare` disables OAuth/keychain auth, so it is mutually exclusive with the
  // subscription (native session) route — suppress it there or the run 401s.
  if (spec.extra?.["bare"] === true && !suppressBare) args.push("--bare");
  return args;
}

/**
 * Map the external-context policy plus the user's per-harness tool allow/deny
 * lists to Claude flags. Uses the single comma-separated form: the repeated
 * variadic form is a known-fragile area of the Claude CLI.
 * Note `cached` executes as live web here (Claude has no cached web index);
 * the orchestrator discloses that upgrade via `policy.web.upgraded`.
 */
function toolPermissionArgs(spec: HarnessRunSpec): string[] {
  const { allow, deny } = toolPermissionSets(spec);
  const args: string[] = [];
  if (spec.access === "readonly") {
    const builtins = CLAUDE_READONLY_BUILTIN_TOOLS.filter((tool) => allow.has(tool));
    args.push("--tools", builtins.join(","));
  }
  if (allow.size > 0) args.push("--allowedTools", [...allow].join(","));
  if (deny.size > 0) args.push("--disallowedTools", [...deny].join(","));
  return args;
}

function toolPermissionSets(spec: HarnessRunSpec): { allow: Set<string>; deny: Set<string> } {
  const policy = spec.external_context_policy;
  // A run may narrow readonly access but can never widen it. User/project
  // Claude settings are independently suppressed by the readonly argv profile.
  const allow = new Set(spec.access === "readonly" ? [] : spec.tool_permission_policy.allow);
  const deny = new Set(spec.tool_permission_policy.deny);
  if (spec.access === "readonly") {
    for (const tool of CLAUDE_READONLY_ALLOWED_TOOLS) {
      if (!deny.has(tool)) allow.add(tool);
    }
    for (const tool of CLAUDE_READONLY_DENIED_TOOLS) {
      deny.add(tool);
      allow.delete(tool);
    }
  }
  if (policy === "off") {
    for (const tool of CLAUDE_WEB_TOOLS) {
      deny.add(tool);
      allow.delete(tool);
    }
  } else {
    for (const tool of CLAUDE_WEB_TOOLS) {
      if (!deny.has(tool)) allow.add(tool);
    }
  }
  // A browser-tool run allows the injected MCP server's tools (claude names them
  // `mcp__browser__*`; the server prefix `mcp__browser` allows the whole set).
  // Gated on policy: under `off` the MCP is never injected (claudeBrowserArgs is
  // empty), so this allow has no tool to match anyway.
  if (spec.browser && policy !== "off") allow.add("mcp__browser");
  return { allow, deny };
}

/**
 * Inject the Playwright browser MCP via `--mcp-config` inline JSON (no disk
 * write — fits the scoped HOME and works under `--bare`). Empty when no browser
 * this run OR when web policy is `off` (the browser is live egress and must ride
 * `external_context_policy`, mirroring web-tool gating).
 */
function claudeBrowserArgs(spec: HarnessRunSpec): string[] {
  if (!spec.browser || spec.external_context_policy === "off") return [];
  const mcp = browserMcpCommand(spec.browser);
  const cfg = JSON.stringify({
    mcpServers: { browser: mcp },
  });
  return ["--mcp-config", cfg];
}

async function* runClaude(
  spec: HarnessRunSpec,
  runtime: ClaudeRuntimeDeps,
): AsyncIterable<HarnessEvent> {
  const abortSignal = abortSignalFromSpec(spec);
  if (spec.access === "readonly") {
    const readonlyProfile = await runtime.probeReadonlyProfile(abortSignal);
    if (!readonlyProfile.supported) {
      yield {
        type: "error",
        session_id: spec.session_id,
        ts: nowIso(),
        error: `Claude readonly enforcement is unavailable: ${readonlyProfile.detail}`,
        payload: {
          code: "readonly_enforcement_unavailable",
          missing_flags: readonlyProfile.missingFlags,
        },
      };
      yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
      return;
    }
  }
  const channel: InteractionChannel | undefined = interactionChannelFromSpec(spec);
  const attachmentBlocks = claudeAttachmentBlocks(spec.attachments);
  // Images ride ONLY the stdin stream-json transport, so an attachment forces
  // the interactive path even with no interaction channel (control frames then
  // auto-decline). claudeArgsForSpec(interactive) selects --input-format stream-json.
  const interactive = channel !== undefined || attachmentBlocks.length > 0;
  const profile = spec.credential_profile;
  const authPreference = spec.auth_preference ?? "auto";
  let nativeEnv = claudeNativeEnv(spec.env);
  let key: string | null = null;
  let oauthToken: string | null = null;
  let subscriptionSource: "native_session" | "oauth_token_env" | null = null;
  let route: "subscription" | "api_key" | null;

  if (profile) {
    const resolved = await resolveClaudeProfileRoute(profile, spec.env, runtime, abortSignal);
    if (resolved.refusal !== null) {
      yield { type: "error", session_id: spec.session_id, ts: nowIso(), error: resolved.refusal };
      yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
      return;
    }
    ({ nativeEnv, key, oauthToken, subscriptionSource } = resolved);
    route = resolved.route;
  } else {
    const native: ClaudeAuthStatusProbe =
      authPreference === "api_key"
        ? { loggedIn: false, authed: false, authMethod: null, probeError: null }
        : await runtime.probeAuthStatus(BIN, {
            env: nativeEnv,
            abortSignal,
          });

    // Explicit routes are strict; auto is subscription-first and alone may fall
    // back to API-key auth. Preserve the exact selected subscription source so a
    // native session can never be silently replaced by an OAuth-token env route.
    const trySub = (): boolean => {
      if (native.authed) {
        subscriptionSource = "native_session";
        return true;
      }
      if (authPreference === "auto") oauthToken ??= runtime.claudeOAuthToken();
      if (authPreference === "auto" && oauthToken !== null) {
        subscriptionSource = "oauth_token_env";
        return true;
      }
      return false;
    };
    route = selectClaudeRunAuthRoute(authPreference, trySub, () => {
      key ??= runtime.anthropicApiKey();
      return key !== null;
    });

    // Auto selecting its API-key fallback is a paid-route switch and must remain
    // typed/visible; explicit routes never fall back.
    if (authPreference === "auto" && route === "api_key") {
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

    if (route === null) {
      yield {
        type: "error",
        session_id: spec.session_id,
        ts: nowIso(),
        error:
          authPreference === "subscription"
            ? "Claude subscription auth was explicitly requested but a verified claude.ai native session is not ready"
            : authPreference === "api_key"
              ? "Claude API-key auth was explicitly requested but no Anthropic API key route is ready"
              : "no usable Claude auth: native/setup-token subscription routes and API-key fallback are unavailable",
      };
      yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
      return;
    }
  }

  const useSubscription = route === "subscription";
  const args = claudeArgsForSpec(spec, interactive, useSubscription);
  // Scrub EVERY provider secret (incl. OpenAI/others — the cross-provider leak
  // fix) via the single core table, then re-add only the var this route needs.
  const env: Record<string, string | null | undefined> =
    subscriptionSource === "native_session" ? nativeEnv : { ...spec.env, ...providerScrubEnv() };
  if (route === "api_key" && key) {
    env.ANTHROPIC_API_KEY = key;
  } else if (subscriptionSource === "oauth_token_env" && oauthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  }

  // Route evidence: disclose the ACTUAL auth route on the started event
  // (typed `auth_route` payload); quota attribution consumes it.
  const credentialRoute = useSubscription
    ? ("vendor_native" as const)
    : ("managed_api_key" as const);
  const credentialSource = useSubscription ? subscriptionSource! : ("api_key_env" as const);
  const baseParser = createClaudeParser({ deniedTools: toolPermissionSets(spec).deny });
  yield* runtime.runCliHarness({
    bin: BIN,
    args,
    spec,
    env,
    label: "claude",
    redact: redactSecrets,
    parseEvent: (obj, sessionId) => {
      const out = baseParser(obj, sessionId);
      if (out) {
        for (const ev of out) {
          // The auth route is fixed before spawn. Carry it on every event so
          // a later api_retry/quota record remains independently attributable.
          ev.credential_route = credentialRoute;
          ev.credential_source = credentialSource;
          if (profile) ev.credential_profile_id = profile.profile_id;
        }
      }
      return out;
    },
    ...(interactive
      ? {
          session: {
            initialStdin: initialSessionFrames(spec.prompt, attachmentBlocks),
            matches: isControlRequestFrame,
            handle: (obj, io) => handleControlRequestFrame(obj, io, spec.session_id, channel),
            closeStdinOn: isResultFrame,
          },
        }
      : {}),
  });
}
