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
import type { DoctorSpec, HarnessAdapter, InteractionChannel } from "@claudexor/core";
import {
  abortSignalFromSpec,
  browserMcpCommand,
  HarnessUnavailableError,
  interactionChannelFromSpec,
  needsScopedHomeKeychainBridge,
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
import {
  CLAUDE_CAPABILITY_PROFILE,
  CLAUDE_KNOWN_MODELS,
  CLAUDE_KNOWN_MODELS_VERIFIED_AGAINST,
} from "./capability-profile.js";
export { CLAUDE_MANAGED_LOGIN, claudeQuotaModelAliases } from "./capability-profile.js";
import { claudeNativeLoginRemedy } from "./doctor-remedy.js";
import { claudeNativeHomeEnv, defaultNativeClaudeConfigDir } from "./native-home.js";
export { claudeAccountIdentity, defaultNativeClaudeConfigDir } from "./native-home.js";
import { createClaudeParser } from "./parse.js";
import { probeClaudeCredentialProfile, resolveClaudeProfileRoute } from "./profile.js";
export { canonicalProfileConfigDir } from "./profile.js";
import {
  claudeAuthSourceReadiness,
  probeClaudeAuthStatus,
  redactClaudeDoctorDetail,
  staleClaudeAuthStatusEvent,
  type ClaudeAuthStatusProbe,
} from "./auth-status.js";
export {
  clearClaudeAuthStatusCache,
  claudeAuthSourceReadiness,
  redactClaudeDoctorDetail,
} from "./auth-status.js";
export type { ClaudeAuthStatusProbe } from "./auth-status.js";
import { smokeIsolatedApiKey, smokeIsolatedOAuthToken } from "./smoke.js";
import {
  BIN,
  CLAUDE_EFFORT_SNAPSHOT,
  CLAUDE_EFFORT_SNAPSHOT_VERIFIED_AGAINST,
  claudeRunEffortResolution,
  probeClaudeEffortLevels,
  probeClaudeHelp,
} from "./effort-probe.js";
export { BIN, CLAUDE_EFFORT_SNAPSHOT } from "./effort-probe.js";
export { CLAUDE_VENDOR_CLI_VERSION } from "./vendor-cli-version.js";
import {
  claudeAttachmentBlocks,
  handleControlRequestFrame,
  initialSessionFrames,
  isControlRequestFrame,
  isResultFrame,
} from "./interactive.js";

export const CLAUDE_PROVIDER_ENV_DENYLIST = PROVIDER_SECRET_ENV.filter(
  (k) => k !== "ANTHROPIC_API_KEY",
);

// The `--effort` ladder is read from the INSTALLED binary (`probeClaudeEffortLevels`).

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

/**
 * Derived from the SHARED `--help` capture on every call instead of behind a
 * second cache of its own. That cache had the same defect as the one under it —
 * a probe that failed once (or that a cancelled run read) stayed failed for the
 * process lifetime, so a long-lived daemon reported readonly enforcement
 * unavailable forever. It bought nothing either: the spawn is already memoized,
 * and what is left is a handful of `includes` over text we already hold.
 */
export async function probeClaudeReadonlyProfile(
  abortSignal?: AbortSignal,
): Promise<ClaudeReadonlyProfileProbe> {
  const probe = await probeClaudeHelp(abortSignal);
  if (!probe.ok) {
    return {
      supported: false,
      missingFlags: [...CLAUDE_READONLY_REQUIRED_FLAGS],
      detail: `readonly enforcement probe failed: ${probe.error}`,
    };
  }
  const help = probe.help;
  const missingFlags: string[] = CLAUDE_READONLY_REQUIRED_FLAGS.filter(
    (flag) => !help.includes(flag),
  );
  const hasPlanMode = help.includes('"plan"') || help.includes("plan,") || help.includes(", plan");
  if (!hasPlanMode) missingFlags.push("--permission-mode=plan");
  const supported = probe.code === 0 && missingFlags.length === 0;
  return {
    supported,
    missingFlags,
    detail: supported
      ? "installed Claude CLI exposes the complete restrictive readonly flag set"
      : `readonly enforcement unavailable; missing ${missingFlags.join(", ") || `help exited ${probe.code}`}`,
  };
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

/** Options for probing the default or explicitly selected native Claude store. */
export interface ClaudeAuthStatusProbeOptions {
  env?: Record<string, string | null | undefined>;
  /** Explicit CLAUDE_CONFIG_DIR for the probe (INV-135): a credential-profile
   * probe must inspect its own store, never the default's. */
  configDir?: string;
  abortSignal?: AbortSignal;
  runCapture?: typeof runCapture;
}

export function claudeNativeEnv(
  base?: Record<string, string | null | undefined>,
  configDir?: string,
): Record<string, string | null | undefined> {
  const raw = {
    ...(base ?? {}),
    ...providerScrubEnv(),
  };
  const native = needsScopedHomeKeychainBridge(CLAUDE_CAPABILITY_PROFILE)
    ? claudeNativeHomeEnv(raw)
    : raw;
  return {
    ...native,
    CLAUDE_CONFIG_DIR: configDir ?? defaultNativeClaudeConfigDir(base),
  };
}

export async function probeAuthStatus(
  bin: string = BIN,
  options: ClaudeAuthStatusProbeOptions = {},
): Promise<ClaudeAuthStatusProbe> {
  try {
    const configDir = options.configDir ?? defaultNativeClaudeConfigDir(options.env);
    const env = claudeNativeEnv(options.env, configDir);
    return await probeClaudeAuthStatus(bin, {
      env,
      configDir,
      abortSignal: options.abortSignal,
      runCapture: options.runCapture,
    });
  } catch (err) {
    // Config/home normalization is part of the probe boundary too.  A bad
    // locator or keychain bridge must remain a typed probe failure, rather
    // than escaping and making callers mistake a transient status problem for
    // a harness crash or a logged-out account.
    const detail = err instanceof Error ? err.message : String(err);
    return {
      loggedIn: false,
      authed: false,
      authMethod: null,
      probeError: redactClaudeDoctorDetail(detail),
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
  /** Effort ladder of the installed binary; falls back to the recorded snapshot. */
  probeEffortLevels: typeof probeClaudeEffortLevels;
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
    probeEffortLevels: probeClaudeEffortLevels,
    runCliHarness,
    ...deps,
  };
  return {
    id: "claude",
    capabilityProfile: CLAUDE_CAPABILITY_PROFILE,
    async discover(): Promise<HarnessManifest> {
      const version = await runtime.detectVersion();
      if (version === null) {
        throw new HarnessUnavailableError(
          "claude CLI not found on PATH (set CLAUDEXOR_CLAUDE_BIN to override)",
        );
      }
      const apiKey = runtime.anthropicApiKey() !== null;
      const readonlyProfile = await runtime.probeReadonlyProfile();
      // The ladder belongs to the INSTALLED CLI, so read it from that binary
      // rather than declaring one version's list for every version.
      const efforts = await runtime.probeEffortLevels();
      const native = await runtime.probeAuthStatus(BIN, { env: claudeNativeEnv() });
      // A stale result is only bounded last-known-good evidence for an
      // already selected profile.  Discovery must not advertise it as a
      // currently authenticated default route.
      const authed = native.authed && native.stale !== true;
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
          // D-16: `--json-schema` materializes a StructuredOutput TOOL, so a
          // WorkReport envelope rides the tool while the prose final stays
          // markdown (side_tool). Interactive stream-json lanes disclose
          // unsupported at spec build, not here.
          work_report_transport: "constrained",
          structured_output_channel: "side_tool",
          web_policy: "tools",
          max_turns: true,
          tool_lists: true,
          interactive: true,
          // Whatever THIS binary's --help documents; the snapshot fills in when
          // the parse fails. Claude's ladder is CLI-wide, not per model, so
          // `model_effort_levels` stays empty and every model falls back here.
          effort_levels: [...efforts.levels],
          effort_levels_verified_against: efforts.live
            ? version
            : CLAUDE_EFFORT_SNAPSHOT_VERIFIED_AGAINST,
          // Manifest model truth and its verified CLI live in capability-profile.ts.
          known_models: [...CLAUDE_KNOWN_MODELS],
          known_models_verified_against: CLAUDE_KNOWN_MODELS_VERIFIED_AGAINST,
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
          ...(["workspace_write", "full", "inherit_native"] as const),
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
      const nativeEnv = probeNative ? claudeNativeEnv(_spec.env) : _spec.env;
      const login: ClaudeAuthStatusProbe = probeNative
        ? await runtime.probeAuthStatus(BIN, {
            env: nativeEnv,
            abortSignal: _spec.abortSignal,
          })
        : { loggedIn: false, authed: false, authMethod: null, probeError: null };
      const nativeCliReady = login.authed && login.stale !== true;
      // Native-session and stored setup-token proofs are separate sources.
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
        preference !== "api_key" &&
        (login.probeError !== null || login.stale === true) &&
        !oauthTokenAvailable;
      // INV-067: name the real cause + designed remedy (see doctor-remedy.ts).
      const nativeLoginRemedy = claudeNativeLoginRemedy(nativeEnv);
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
              login.stale && !oauthTokenAvailable
                ? `Claude native-session auth-status probe is stale; using last-known-good session${
                    login.staleAgeMs === undefined ? "" : ` (${login.staleAgeMs}ms old)`
                  }`
                : login.probeError && !oauthTokenAvailable
                  ? `Claude native-session probe failed: ${redactClaudeDoctorDetail(login.probeError)}`
                  : oauthTokenAvailable
                    ? `Claude setup-token verification failed: ${oauthSmoke.detail}`
                    : `Claude subscription route is not ready: ${nativeLoginRemedy}`,
            ]
          : preference === "api_key"
            ? [
                apiKey
                  ? `isolated Claude API-key smoke failed: ${apiSmoke.detail}`
                  : "Claude API-key route is not configured",
              ]
            : login.stale
              ? [
                  `Claude native-session auth-status probe is stale; using last-known-good session${
                    login.staleAgeMs === undefined ? "" : ` (${login.staleAgeMs}ms old)`
                  }`,
                ]
              : apiKey
                ? [`isolated Claude API-key smoke failed: ${apiSmoke.detail}`]
                : login.probeError
                  ? [
                      `Claude native-session probe failed: ${redactClaudeDoctorDetail(login.probeError)}`,
                    ]
                  : [`not authenticated: ${nativeLoginRemedy}`];
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
                    : login.stale
                      ? `auth-status probe is stale; using last-known-good native session${
                          login.staleAgeMs === undefined ? "" : ` (${login.staleAgeMs}ms old)`
                        }`
                      : login.probeError
                        ? `auth-status probe failed (NOT an auth verdict): ${redactClaudeDoctorDetail(login.probeError)}`
                        : login.loggedIn
                          ? `logged in via ${login.authMethod ?? "unknown"}, not claude.ai`
                          : "not logged in (run `claudexor auth login claude`)",
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
  /** What the installed CLI advertises; the recorded snapshot by default so
   * arg-shape callers stay synchronous and the probe stays optional. */
  advertisedEfforts: readonly EffortHint[] = CLAUDE_EFFORT_SNAPSHOT,
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
  // Resolve against what the INSTALLED CLI advertises: an advertised level goes
  // through verbatim (so a newer binary's level needs no code change here), a
  // rankable one clamps, and anything else sends no flag rather than a level the
  // vendor would reject. Null = not requested OR not tunable -> pass no flag.
  const eff = normalizeEffort(spec.effort_hint, advertisedEfforts);
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
  args.push(...claudeMcpArgs(spec));
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
  // Gated on policy: under `off` the MCP is never injected (claudeMcpArgs is
  // empty for browser), so this allow has no tool to match anyway.
  if (spec.browser && policy !== "off") allow.add("mcp__browser");
  // Every engine-injected extra MCP server (the delegation belt, etc.) gets its
  // tool set allowed by server prefix. Extra servers are NOT web egress, so they
  // are injected regardless of web policy (unlike the browser).
  for (const server of spec.extra_mcp_servers ?? []) allow.add(`mcp__${server.name}`);
  return { allow, deny };
}

/**
 * Inject engine-owned MCP servers via `--mcp-config` inline JSON (no disk
 * write — fits the scoped HOME and works under `--bare`): the Playwright
 * browser MCP and every `extra_mcp_servers` entry (the delegation belt, etc.)
 * merged into one `mcpServers` map. The browser rides `external_context_policy`
 * (live egress, dropped under `off`); extra servers are engine-owned local
 * processes, not web egress, so they inject regardless of web policy. Empty
 * when nothing is to be injected.
 */
function claudeMcpArgs(spec: HarnessRunSpec): string[] {
  const mcpServers: Record<
    string,
    { command: string; args: string[]; env?: Record<string, string> }
  > = {};
  if (spec.browser && spec.external_context_policy !== "off") {
    mcpServers["browser"] = browserMcpCommand(spec.browser);
  }
  for (const server of spec.extra_mcp_servers ?? []) {
    mcpServers[server.name] = {
      command: server.command,
      args: server.args,
      ...(Object.keys(server.env).length > 0 ? { env: server.env } : {}),
    };
  }
  if (Object.keys(mcpServers).length === 0) return [];
  return ["--mcp-config", JSON.stringify({ mcpServers })];
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
  let staleAuthStatus: { ageMs?: number } | null = null;

  if (profile) {
    const resolved = await resolveClaudeProfileRoute(profile, spec.env, runtime, abortSignal);
    if (resolved.refusal !== null) {
      yield { type: "error", session_id: spec.session_id, ts: nowIso(), error: resolved.refusal };
      yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
      return;
    }
    ({ nativeEnv, key, oauthToken, subscriptionSource } = resolved);
    route = resolved.route;
    if (resolved.authStatusStale) staleAuthStatus = { ageMs: resolved.authStatusStaleAgeMs };
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
      // The process-local LKG grace belongs to explicit profile routes.  The
      // unprofiled/default ladder must not let a stale native verdict mask the
      // OAuth/API fallback or claim that the default session is live.
      if (native.authed && native.stale !== true) {
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

    if (native.stale) {
      staleAuthStatus = { ageMs: native.staleAgeMs };
    }

    if (staleAuthStatus !== null)
      yield staleClaudeAuthStatusEvent(spec.session_id, staleAuthStatus.ageMs);

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

  if (profile && staleAuthStatus !== null) {
    yield staleClaudeAuthStatusEvent(spec.session_id, staleAuthStatus.ageMs);
  }

  const useSubscription = route === "subscription";
  // Probe the installed effort ladder through the shared memoized help capture.
  const effort = await claudeRunEffortResolution(spec, runtime, abortSignalFromSpec(spec));
  const args = claudeArgsForSpec(spec, interactive, useSubscription, effort.advertised);
  if (effort.disclosure) yield effort.disclosure;
  // Scrub all provider secrets, then re-add only this route's credential.
  const env: Record<string, string | null | undefined> =
    subscriptionSource === "native_session" ? nativeEnv : { ...spec.env, ...providerScrubEnv() };
  if (route === "api_key" && key) {
    env.ANTHROPIC_API_KEY = key;
  } else if (subscriptionSource === "oauth_token_env" && oauthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  }

  // Disclose the actual auth route on every normalized event.
  const credentialRoute = useSubscription
    ? ("vendor_native" as const)
    : ("managed_api_key" as const);
  const credentialSource = useSubscription ? subscriptionSource! : ("api_key_env" as const);
  const baseParser = createClaudeParser({
    deniedTools: toolPermissionSets(spec).deny,
    requiredMcpServers: (spec.extra_mcp_servers ?? [])
      .filter((server) => server.required)
      .map((server) => server.name),
  });
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
    stopAfterEvent: (event) => event.payload?.["code"] === "required_mcp_startup_failed",
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
