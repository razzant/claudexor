import { GROK_PROGRAM } from "./program.js";
export { GROK_PROGRAM } from "./program.js";
import type { HarnessAdapter, DoctorSpec, HarnessModelSpec } from "@claudexor/core";
import {
  HarnessUnavailableError,
  abortSignalFromSpec,
  effortLadders,
  effortResolutionEvent,
  resolveEffortEvidence,
  runCliHarness,
  throwIfEffortRejected,
} from "@claudexor/core";
import {
  HarnessCapabilityProfile,
  HarnessManifest,
  ConformanceReport,
  CredentialProfileStatus,
  type CredentialProfile,
  type HarnessEvent,
  type HarnessRunSpec,
} from "@claudexor/schema";
import { CLAUDEXOR_VERSION, nowIso, redactSecrets } from "@claudexor/util";
import { detectGrokVersion, resolveGrokBin } from "./bin.js";
import { grokAccessArgs } from "./access.js";
import { GROK_EFFORTS, probeGrokLogin, type GrokLoginProbe } from "./models.js";
import { GROK_PROFILE_REQUIRED, grokRouteEnv } from "./profile.js";
import { createGrokParser, grokFailure } from "./parse.js";
import { applyGrokRunProcessing, prepareGrokProcessing } from "./processing.js";
import { withGrokPromptFile } from "./prompt.js";
import { GROK_STARTUP_REFUSALS, createGrokStartupCheck, grokNoInitNote } from "./startup.js";
export { resolveGrokBin } from "./bin.js";
export { canonicalGrokProfileHome, grokProfileEnv } from "./profile.js";

export const GROK_MANAGED_LOGIN = { stdin: "none" } as const;
const INTENTS = [
  "explain",
  "audit",
  "plan",
  "spec",
  "implement",
  "repair",
  "create_from_scratch",
  "review",
  "verify",
  "synthesize",
];
export const GROK_CAPABILITY_PROFILE = HarnessCapabilityProfile.parse({
  auth: {
    supported_sources: ["native_session"],
    preferred_source: "native_session",
    credential_transports: [
      { source: "native_session", kind: "config_file", relocatable_by: ["HOME"] },
    ],
    managed_login: GROK_MANAGED_LOGIN,
  },
  access_control: {
    readonly_mechanism: "tool_allowlist",
    write_mechanism: "tool_policy",
    auxiliary_writable_roots: false,
  },
  isolation: { supported_containment: ["env_or_file_injection"] },
  attachment_inputs: [],
});

const defaults = {
  detectVersion: detectGrokVersion,
  probeLogin: probeGrokLogin,
  runCli: runCliHarness,
};
type Runtime = typeof defaults;

async function doctor(spec: DoctorSpec, runtime: Runtime) {
  const version = await runtime.detectVersion();
  const supported = spec.authSource === undefined || spec.authSource === "native_session";
  // Harness-level doctor has no account identity. Only a named profile probe
  // may verify credentials; never probe the operator's ordinary ~/.grok.
  const detail =
    !supported || spec.authPreference === "api_key"
      ? "Grok supports only grok.com subscription login"
      : version
        ? GROK_PROFILE_REQUIRED
        : "Grok CLI is unavailable";
  return ConformanceReport.parse({
    harness_id: "grok",
    status: "unavailable",
    checks: [
      {
        id: "installed",
        status: version ? "pass" : "fail",
        detail: version ?? "grok not found; set CLAUDEXOR_GROK_BIN",
      },
      { id: "default_credential", status: "fail", detail },
    ],
    enabled_intents: [],
    disabled_intents: INTENTS,
    reasons: [detail],
    auth_sources: [
      {
        source: spec.authSource ?? "native_session",
        availability: "unavailable",
        verification: "not_run",
        detail,
      },
    ],
  });
}

/** A probe that threw decided nothing about the login. */
async function probeOrUnknown(
  runtime: Runtime,
  env: Record<string, string | null | undefined>,
  abortSignal?: AbortSignal,
): Promise<GrokLoginProbe> {
  try {
    return await runtime.probeLogin(env, abortSignal);
  } catch (error) {
    const reason = redactSecrets(error instanceof Error ? error.message : String(error));
    return {
      authenticated: false,
      models: [],
      failed: true,
      detail: `Grok login probe failed (${reason.slice(0, 200)}); login state is unknown`,
    };
  }
}

/** Vendor answer -> account status. Only an explicit vendor refusal fails
 * verification; an inconclusive probe never condemns the credential. */
async function probeCredentialProfile(
  profile: CredentialProfile,
  runtime: Runtime,
  abortSignal?: AbortSignal,
) {
  const base = { profile_id: profile.profile_id, harness_id: "grok" };
  let env;
  try {
    env = grokRouteEnv(profile);
  } catch (error) {
    return CredentialProfileStatus.parse({
      ...base,
      availability: "unavailable",
      verification: "not_run",
      detail: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 300),
    });
  }
  const probe = await probeOrUnknown(runtime, env, abortSignal);
  if (probe.authenticated)
    return CredentialProfileStatus.parse({
      ...base,
      availability: "available",
      verification: "passed",
      verification_source: "vendor",
      last_verified_at: nowIso(),
      detail: probe.detail,
    });
  return CredentialProfileStatus.parse({
    ...base,
    availability: probe.failed ? "unknown" : "unavailable",
    verification: probe.failed ? "not_run" : "failed",
    ...(probe.failed ? {} : { verification_source: "vendor" }),
    detail: probe.detail,
  });
}

/** The HOME the vendor child receives: the named profile's own HOME. */
function grokChildHome(spec: Pick<HarnessRunSpec, "credential_profile">): string | null {
  try {
    return grokRouteEnv(spec.credential_profile).HOME ?? null;
  } catch {
    return null;
  }
}

export function createGrokAdapter(deps: Partial<Runtime> = {}): HarnessAdapter {
  const runtime = { ...defaults, ...deps };
  async function* stamped(input: HarnessRunSpec) {
    const spec = applyGrokRunProcessing(input);
    for await (const event of withGrokPromptFile(spec.prompt, (path) =>
      runGrok(spec, runtime, path),
    )) {
      // The route is the one selected before spawn; the source is stamped by
      // runGrok only once Grok's own init confirmed it.
      event.credential_route = "vendor_native";
      if (spec.credential_profile) event.credential_profile_id = spec.credential_profile.profile_id;
      event.processing = spec.processing;
      event.processing_cost_basis = spec.processing_cost_basis;
      yield event;
    }
  }
  return {
    id: "grok",
    program: GROK_PROGRAM,
    effortParameter: "--reasoning-effort",
    capabilityProfile: GROK_CAPABILITY_PROFILE,
    nativeHomeLifetime: {
      status: "not_pruned",
      reason: "Grok session pruning has no independently verified contract",
    },
    async discover() {
      const version = await runtime.detectVersion();
      if (!version)
        throw new HarnessUnavailableError(
          "grok not found (install Grok Build or set CLAUDEXOR_GROK_BIN)",
        );
      return HarnessManifest.parse({
        id: "grok",
        display_name: "Grok Build",
        kind: "local_cli",
        version,
        adapter_version: CLAUDEXOR_VERSION,
        provider_family: "xai",
        capabilities: {
          plan: true,
          implement: true,
          create_from_scratch: true,
          review: true,
          verify: true,
          synthesize: true,
          read_files: true,
          browser_tool: false,
          max_turns: true,
          web_policy: "native",
          effort_levels: GROK_EFFORTS,
          effort_levels_verified_against: "1.0.46",
          // Account inventories need a named profile; an unscoped query has
          // no account to run `grok models` under and claims no live list.
          model_inventory_routes: ["local_session"],
          model_inventory_absence: "advisory",
          json_schema_output: true,
          work_report_transport: "unsupported",
        },
        capability_profile: GROK_CAPABILITY_PROFILE,
        auth_modes: ["local_session"],
        access_profiles_supported: ["readonly", "workspace_write", "full", "inherit_native"],
      });
    },
    doctor: (spec) => doctor(spec, runtime),
    probeCredentialProfile: (profile, signal) => probeCredentialProfile(profile, runtime, signal),
    async models(spec?: HarnessModelSpec) {
      if (spec?.authPreference === "api_key") return [];
      try {
        const probe = await runtime.probeLogin(
          grokRouteEnv(spec?.credentialProfile, spec?.env),
          spec?.abortSignal,
        );
        return probe.authenticated ? probe.models : [];
      } catch {
        return [];
      }
    },
    async prepareProcessing(spec) {
      return prepareGrokProcessing(spec);
    },
    childHome: grokChildHome,
    run: stamped,
    review: stamped,
  };
}

/** Typed retryable refusal: a probe that could not decide is not a logout. */
function inconclusiveLogin(
  spec: HarnessRunSpec,
  detail: string,
  timedOut: boolean,
): HarnessEvent[] {
  const ts = nowIso();
  return [
    {
      type: "error",
      session_id: spec.session_id,
      ts,
      error: detail,
      transient: { kind: timedOut ? "timeout" : "unknown", retry_delay_ms: null },
      payload: { code: "grok_login_probe_inconclusive" },
    },
    { type: "completed", session_id: spec.session_id, ts },
  ];
}

async function* runGrok(
  spec: HarnessRunSpec,
  runtime: Runtime,
  promptPath: string,
): AsyncGenerator<HarnessEvent> {
  if (spec.auth_preference === "api_key")
    throw new HarnessUnavailableError("Grok Build requires grok.com subscription authentication");
  let env;
  try {
    env = grokRouteEnv(spec.credential_profile, spec.env);
  } catch {
    throw new HarnessUnavailableError(
      `Grok credential profile is missing or invalid. ${GROK_PROFILE_REQUIRED}`,
    );
  }
  const abortSignal = abortSignalFromSpec(spec);
  const probe = await probeOrUnknown(runtime, env, abortSignal);
  if (abortSignal?.aborted) {
    yield { type: "completed", session_id: spec.session_id, ts: nowIso(), aborted: true };
    return;
  }
  if (!probe.authenticated && probe.failed) {
    yield* inconclusiveLogin(spec, probe.detail, probe.timedOut === true);
    return;
  }
  if (!probe.authenticated) throw new HarnessUnavailableError(probe.detail);
  // The shared order places preferences outside the recorded ladder
  // (max/ultra downward, none/minimal at the floor); unknown words still fail.
  const effort = resolveEffortEvidence(
    spec.effort_hint,
    GROK_EFFORTS,
    effortLadders([GROK_EFFORTS]),
    "versioned_snapshot",
    "--reasoning-effort",
  );
  yield effortResolutionEvent(spec.session_id, effort);
  throwIfEffortRejected(effort);
  const args = [
    "--no-auto-update",
    "--prompt-file",
    promptPath,
    "--cwd",
    spec.cwd,
    "--output-format",
    "streaming-messages-json",
    ...grokAccessArgs(spec),
  ];
  if (spec.instructions) args.push("--rules", spec.instructions);
  if (spec.model_hint) args.push("-m", spec.model_hint);
  if (effort.submitted) args.push("--reasoning-effort", effort.submitted);
  if (spec.max_turns !== null) args.push("--max-turns", String(spec.max_turns));
  if (spec.output_schema) args.push("--json-schema", JSON.stringify(spec.output_schema));
  if (spec.resume_session_id) args.push("--resume", spec.resume_session_id);
  if (spec.tool_permission_policy.web === "off" || spec.external_context_policy === "off") {
    args.push("--disable-web-search");
    // web_fetch has its own vendor switch; an inherited GROK_WEB_FETCH=1 must
    // not re-enable it under `full`. Access stays exactly as requested.
    env = { ...env, GROK_WEB_FETCH: "0" };
  }
  const parser = createGrokParser();
  const startup = createGrokStartupCheck(spec);
  for await (const event of runtime.runCli({
    bin: resolveGrokBin(),
    args,
    spec,
    env,
    label: "grok",
    redact: redactSecrets,
    parseEvent: (raw, id) => {
      const verdict = startup.observe(raw, id);
      if (verdict.refusal) return [verdict.refusal];
      const events = parser.parseEvent(raw, id);
      return events && verdict.note ? [...events, verdict.note] : events;
    },
    stopAfterEvent: (event) => GROK_STARTUP_REFUSALS.has(String(event.payload?.code)),
    parseStderrFailure: (stderr, id) => grokFailure(stderr, id),
  })) {
    if (event.type === "completed" && event.payload?.exit_code === 0) {
      if (!startup.sawInit) yield grokNoInitNote(spec.session_id);
      if (!parser.hasTerminal())
        yield grokFailure("Grok exited without a terminal result", spec.session_id);
    }
    if (startup.sourceConfirmed) event.credential_source = "native_session";
    yield event;
  }
}
