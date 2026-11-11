import { CLAUDE_PROGRAM } from "./program.js";
export { CLAUDE_PROGRAM } from "./program.js";
import { randomUUID } from "node:crypto";
import { claudeMcpArgs } from "./mcp-args.js";
import {
  prepareClaudeSessionProcessing,
  claudeProcessingArgs,
  applyClaudeRunProcessing,
  claudeProcessingObserver,
} from "./processing.js";
import { claudePromptCacheObserver, withClaudePromptCacheTtl } from "./prompt-cache.js";
import type {
  CredentialProfile,
  CredentialProfileStatus,
  EffortHint,
  HarnessEvent,
  HarnessManifest,
  HarnessRunSpec,
} from "@claudexor/schema";
import { HarnessManifest as HarnessManifestSchema } from "@claudexor/schema";
import type { HarnessAdapter, InteractionChannel } from "@claudexor/core";
import {
  abortSignalFromSpec,
  composeSpawnEnv,
  resolveHarnessCommandOnPath,
  HarnessUnavailableError,
  throwIfEffortRejected,
  interactionChannelFromSpec,
  providerScrubEnv,
  runCapture,
  runCliHarness,
  PROVIDER_SECRET_ENV,
  selectStrictAuthRoute,
} from "@claudexor/core";
import { resolveSecret } from "@claudexor/secrets";
import { CLAUDEXOR_VERSION, nowIso, redactSecrets } from "@claudexor/util";
import {
  CLAUDE_CAPABILITY_PROFILE,
  CLAUDE_KNOWN_MODELS,
  CLAUDE_KNOWN_MODELS_VERIFIED_AGAINST,
} from "./capability-profile.js";
export { CLAUDE_MANAGED_LOGIN } from "./capability-profile.js";
import { claudeInstallation, claudeMissingDetail } from "./doctor-remedy.js";
import { claudeDoctor } from "./doctor.js";
import { claudeNativeEnv, defaultNativeClaudeConfigDir } from "./native-home.js";
export {
  claudeAccountIdentity,
  defaultNativeClaudeConfigDir,
  claudeNativeEnv,
} from "./native-home.js";
import {
  claudeNativeAccess,
  permissionArgs,
  toolPermissionArgs,
  toolPermissionSets,
} from "./access-args.js";
import { createClaudeParser } from "./parse.js";
import { withClaudeApiFailureParser, withClaudeVendorFailure } from "./vendor-failure.js";
import { probeClaudeCredentialProfile, resolveClaudeProfileRoute } from "./profile.js";
export { canonicalProfileConfigDir } from "./profile.js";
import {
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
  resolveClaudeBin,
  CLAUDE_EFFORT_SNAPSHOT,
  CLAUDE_EFFORT_SNAPSHOT_VERIFIED_AGAINST,
  claudeRunEffortResolution,
  claudeEffortResolution,
  claudeRunPatchPath,
  detectClaudeVersion,
  probeClaudeEffortLevels,
  probeClaudeHelp,
} from "./effort-probe.js";
export { resolveClaudeBin, CLAUDE_EFFORT_SNAPSHOT, detectClaudeVersion } from "./effort-probe.js";
export {
  CLAUDE_AUTH_REFRESH_TERMINATION_UNCONFIRMED,
  claudeOauthAccessTokenIsFresh,
  refreshClaudeNativeAuth,
} from "./auth-refresh.js";
export { CLAUDE_VENDOR_CLI_VERSION } from "./vendor-cli-version.js";
import {
  claudeAttachmentBlocks,
  handleControlRequestFrame,
  initialSessionFrames,
  isControlRequestFrame,
} from "./interactive.js";
import { createClaudeLiveInput, type ClaudeLiveInput } from "./live-input.js";
import { withClaudeInstructionsFile } from "./instructions-file.js";
import { CLAUDE_MODEL_INVENTORY, probeClaudeModels } from "./model-probe.js";
export { clearClaudeModelProbeCache } from "./model-probe.js";
import { claudePersistence } from "./continuity.js";

export const CLAUDE_PROVIDER_ENV_DENYLIST = PROVIDER_SECRET_ENV.filter(
  (k) => k !== "ANTHROPIC_API_KEY",
);

/** Exported for focused route-policy tests; runtime uses this exact selector. */
export const selectClaudeRunAuthRoute = selectStrictAuthRoute;

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
 * and what is left is a handful of `includes` over text we already hold. A
 * run's PATH patch selects the binary the flags are read from, as for the ladder.
 */
export async function probeClaudeReadonlyProfile(
  abortSignal?: AbortSignal,
  patchPath?: string,
): Promise<ClaudeReadonlyProfileProbe> {
  const probe = await probeClaudeHelp(abortSignal, patchPath);
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

/** Options for probing the default or explicitly selected native Claude store. */
export interface ClaudeAuthStatusProbeOptions {
  env?: Record<string, string | null | undefined>;
  /** Explicit CLAUDE_CONFIG_DIR for the probe (INV-135): a credential-profile
   * probe must inspect its own store, never the default's. */
  configDir?: string;
  abortSignal?: AbortSignal;
  runCapture?: typeof runCapture;
}

export async function probeAuthStatus(
  bin: string = resolveClaudeBin(),
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

export type ClaudeRuntimeDeps = {
  detectVersion: typeof detectClaudeVersion;
  installation: typeof claudeInstallation;
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
  /** Cached prompt-free initialize picker (model-probe.ts); total, never empty. */
  probeModels: typeof probeClaudeModels;
  runCliHarness: typeof runCliHarness;
};

export function createClaudeAdapter(deps: Partial<ClaudeRuntimeDeps> = {}): HarnessAdapter {
  const runtime: ClaudeRuntimeDeps = {
    detectVersion: detectClaudeVersion,
    installation: claudeInstallation,
    probeAuthStatus,
    anthropicApiKey,
    claudeOAuthToken,
    resolveProfileSecret: (ref) => resolveSecret(ref),
    smokeIsolatedApiKey,
    smokeIsolatedOAuthToken,
    probeReadonlyProfile: probeClaudeReadonlyProfile,
    probeEffortLevels: probeClaudeEffortLevels,
    probeModels: probeClaudeModels,
    runCliHarness,
    ...deps,
  };
  const live = createClaudeLiveInput();
  return {
    id: "claude",
    program: CLAUDE_PROGRAM,
    effortParameter: "--effort",
    nativeAccess: claudeNativeAccess,
    capabilityProfile: CLAUDE_CAPABILITY_PROFILE,
    prepareProcessing: prepareClaudeSessionProcessing,
    // Live input into a running interactive session (live-input.ts): typed
    // receipts from the native stdin queue; never cancels or fails the run.
    message: live.message,
    async discover(): Promise<HarnessManifest> {
      const version = await runtime.detectVersion();
      if (version === null) {
        throw new HarnessUnavailableError(
          claudeMissingDetail(
            runtime.installation(resolveClaudeBin()),
            "claude CLI not found on PATH (set CLAUDEXOR_CLAUDE_BIN to override)",
          ),
        );
      }
      const apiKey = runtime.anthropicApiKey() !== null;
      const readonlyProfile = await runtime.probeReadonlyProfile();
      // The ladder belongs to the INSTALLED CLI, so read it from that binary
      // rather than declaring one version's list for every version.
      const efforts = await runtime.probeEffortLevels();
      const native = await runtime.probeAuthStatus(resolveClaudeBin(), { env: claudeNativeEnv() });
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
          ...CLAUDE_MODEL_INVENTORY,
          processing_preferences: ["standard", "fast", "economy"],
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
            ...CLAUDE_CAPABILITY_PROFILE.access_control,
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
    doctor: (spec) => claudeDoctor(spec, runtime, claudeNativeEnv),
    ...claudePersistence,

    run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runClaude(spec, runtime, live);
    },

    review(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runClaude(spec, runtime, live);
    },

    models(spec) {
      return runtime.probeModels(spec, { resolveProfileSecret: runtime.resolveProfileSecret });
    },

    probeCredentialProfile(
      profile: CredentialProfile,
      abortSignal?: AbortSignal,
    ): Promise<CredentialProfileStatus> {
      return probeClaudeCredentialProfile(profile, runtime, abortSignal);
    },
  };
}

export function claudeArgsForSpec(
  spec: HarnessRunSpec,
  interactive = false,
  suppressBare = false,
  /** The run's ONE effort receipt (`submitted`, see claudeRunEffortResolution);
   * arg-shape callers without a probe resolve against the recorded snapshot
   * through the same resolver, so they stay synchronous and never diverge. */
  effort: EffortHint | null = claudeEffortResolution(
    spec.effort_hint,
    CLAUDE_EFFORT_SNAPSHOT,
    "versioned_snapshot",
  ).submitted,
  instructionsPath?: string,
): string[] {
  // Both paths use stdin; the interactive control protocol keeps sole ownership.
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
        // Echo every stdin user frame back (`isReplay`): the live-input receipt.
        "--replay-user-messages",
        ...permissionArgs(spec.access),
      ]
    : [
        "-p",
        "--input-format",
        "text",
        "--output-format",
        "stream-json",
        "--verbose",
        ...permissionArgs(spec.access),
      ];
  if (spec.model_hint) args.push("--model", spec.model_hint);
  args.push(...claudeProcessingArgs(spec));
  // W-C4 live deltas (engine-gated to single-candidate lanes; parser tags payload.delta).
  if (spec.stream_deltas) args.push("--include-partial-messages");
  // The flag is the receipt's `submitted`: exact, clamped, or omitted — never a
  // second resolution against a different ladder.
  if (effort) args.push("--effort", effort);
  if (spec.max_turns !== null && spec.max_turns > 0)
    args.push("--max-turns", String(spec.max_turns));
  if (spec.instructions?.trim()) {
    if (!instructionsPath) throw new Error("Claude system instructions require an owned file");
    args.push("--append-system-prompt-file", instructionsPath);
  }
  // The engine gates native final-output constraints on json_schema_output.
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

async function* runClaude(
  spec: HarnessRunSpec,
  runtime: ClaudeRuntimeDeps,
  live: ClaudeLiveInput,
): AsyncIterable<HarnessEvent> {
  spec = withClaudePromptCacheTtl(spec);
  const abortSignal = abortSignalFromSpec(spec);
  if (spec.access === "readonly") {
    const readonlyProfile = await runtime.probeReadonlyProfile(
      abortSignal,
      claudeRunPatchPath(spec),
    );
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
  // The prompt frame's uuid: live input tells this prompt's own result from
  // a resumed session's earlier one by it (#536).
  const promptUuid = randomUUID();
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
        : await runtime.probeAuthStatus(resolveClaudeBin(), {
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
  const effort = await claudeRunEffortResolution(spec, runtime, abortSignalFromSpec(spec));
  spec = applyClaudeRunProcessing(spec, nativeEnv.CLAUDE_CONFIG_DIR, useSubscription);
  const processing = spec.processing;
  yield effort.event;
  throwIfEffortRejected(effort.resolution);
  // Scrub all provider secrets, then re-add only this route's credential.
  const env: Record<string, string | null | undefined> =
    subscriptionSource === "native_session" ? nativeEnv : { ...spec.env, ...providerScrubEnv() };
  if (route === "api_key" && key) env.ANTHROPIC_API_KEY = key;
  else if (subscriptionSource === "oauth_token_env" && oauthToken)
    env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;

  // Disclose the actual auth route on every normalized event.
  const credentialRoute = useSubscription
    ? ("vendor_native" as const)
    : ("managed_api_key" as const);
  const credentialSource = useSubscription ? subscriptionSource! : ("api_key_env" as const);
  const observeProcessing =
    processing && claudeProcessingObserver(processing, spec.processing_cost_basis!);
  const observePromptCache = claudePromptCacheObserver(spec);
  // Whether the session's stdin is still open, as the run loop reports it.
  let inputOpen = false;
  const baseParser = withClaudeApiFailureParser(
    createClaudeParser({
      deniedTools: toolPermissionSets(spec).deny,
      requiredMcpServers: (spec.extra_mcp_servers ?? [])
        .filter((server) => server.required)
        .map((server) => server.name),
      questionInput: () => (!interactive ? "none" : inputOpen ? "open" : "closed"),
    }),
    resolveHarnessCommandOnPath(
      resolveClaudeBin(),
      composeSpawnEnv(spec.env_inheritance, env).PATH ?? "",
    ).command?.entrypoint ?? null,
  );
  const events = withClaudeInstructionsFile(spec.instructions, (instructionsPath) =>
    runtime.runCliHarness({
      program: CLAUDE_PROGRAM,
      programVersion: (raw) => {
        const frame = raw as { type?: string; subtype?: string; claude_code_version?: unknown };
        return frame?.type === "system" && frame.subtype === "init"
          ? frame.claude_code_version
          : null;
      },
      bin: resolveClaudeBin(),
      args: claudeArgsForSpec(
        spec,
        interactive,
        useSubscription,
        effort.resolution.submitted,
        instructionsPath,
      ),
      spec,
      env,
      label: "claude",
      redact: redactSecrets,
      parseEvent: (obj, sessionId) => {
        const parsed = baseParser(obj, sessionId);
        const processed = observeProcessing ? observeProcessing(obj, parsed, sessionId) : parsed;
        const out = live.observe(obj, observePromptCache(obj, processed, sessionId), sessionId);
        if (out) {
          for (const ev of out) {
            // Keep every event attributable to its fixed auth route.
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
              initialStdin: initialSessionFrames(spec.prompt, attachmentBlocks, promptUuid),
              matches: isControlRequestFrame,
              handle: (obj, io) => handleControlRequestFrame(obj, io, spec.session_id, channel),
              // Hold stdin while live messages or background work remain.
              closeStdinOn: (obj) => live.closeStdinOn(spec.session_id, obj),
              onIo: (io, sessionId) => {
                inputOpen = io !== null;
                live.onIo(io, sessionId, promptUuid);
              },
            },
          }
        : { input: spec.prompt }),
    }),
  );
  yield* withClaudeVendorFailure(events);
}
export { claudeResourceReason, claudeResetDescription } from "./account-resources.js";
