import type {
  AccessProfile,
  ConformanceReport,
  HarnessCapabilityProfile,
  HarnessEvent,
  HarnessManifest,
  HarnessModel,
  HarnessRunSpec,
} from "@claudexor/schema";
import {
  ConformanceReport as ConformanceReportSchema,
  credentialProfilePolicyForPlatform,
  credentialTransportsForPlatform,
  HarnessCapabilityProfile as HarnessCapabilityProfileSchema,
  HarnessManifest as HarnessManifestSchema,
} from "@claudexor/schema";
import type { DoctorSpec, HarnessAdapter, HarnessModelSpec } from "@claudexor/core";
import {
  formatNativeArgs,
  HarnessUnavailableError,
  harnessPlatform,
  needsPrivatePerProfileKeychain,
  promptWithInstructions,
  runCapture,
  runCliHarness,
} from "@claudexor/core";
import { CLAUDEXOR_VERSION, nowIso, redactSecrets } from "@claudexor/util";
import { parseAgyEvent } from "./parse.js";
import { createAgyNativeCompletion } from "./native-completion.js";
import { isAgyProfileKeychainUnsafe, prepareAgyProfileKeychain } from "./keychain.js";
import {
  AGY_BIN,
  agyChildHome,
  defaultAgyModelProbe,
  probeAgyCredentialProfile,
  resolveAgyProfileRoute,
} from "./profile.js";
import { AGY_VENDOR_CLI_VERSION, agyReadonlyDoctorCheck } from "./vendor-cli-version.js";
import { listAgyModels } from "./models.js";
import { applyAgyRunProcessing, prepareAgyProcessing } from "./processing.js";
import { prepareAgyRunInput } from "./run-input.js";
import { withAgySessionSettings } from "./session-policy.js";
// The package publishes only what other packages consume. The profile probe,
// the route resolver and the stream parser are reached through the adapter
// this file returns, so re-exporting them would be a dead public surface.
export { AGY_BIN, agyProfileRunEnv, canonicalAgyProfileHome } from "./profile.js";
export { isAgyProfileKeychainUnsafe, prepareAgyProfileKeychain } from "./keychain.js";
export {
  classifyAgyPrintResult,
  runAgyPrintCommand,
  type AgyPrintClassification,
} from "./print-command.js";

/**
 * Access mapping, each leg LIVE-PROVEN on agy 1.1.13 (PLAN §1.2 F11, §1.2d):
 * plan mode answered read-only prompts and withheld a requested write;
 * accept-edits wrote into the workspace; --dangerously-skip-permissions wrote
 * and ran commands. Owner decision Л-7 admits full access explicitly.
 *
 * Those proofs read only inside the workspace. Real readonly callers also read
 * outside it, and in a headless run plan mode auto-denies such reads and every
 * shell command: on 2026-10-28, 62 of 123 managed readonly runs (agy 1.3.4)
 * ended without an answer that way. The profile read grant (read-grant.ts,
 * live-proven on 1.3.4) restores reading anywhere; a readonly run's session
 * settings deny commands and writes (session-policy.ts), so a refused call
 * returns to the model as a tool error instead of ending the turn.
 */
function accessArgs(access: AccessProfile): string[] {
  switch (access) {
    case "readonly":
      return ["--mode", "plan"];
    case "workspace_write":
      return ["--mode", "accept-edits"];
    case "full":
      return ["--dangerously-skip-permissions"];
    case "inherit_native":
      return [];
  }
}

/**
 * Agy's print mode treats an openable CONIN$ as an interactive terminal
 * (print-command.ts, antigravity-cli#508), and its runs select print mode from
 * piped stdin. Until a supported agy is proven to ignore CONIN$, its runs and
 * this version probe keep starting without a console on Windows, while other
 * harnesses get an invisible one; console programs an agy run starts may open
 * windows of their own.
 */
const AGY_WINDOWS_CONSOLE = "none";

async function detectVersion(): Promise<string | null> {
  try {
    const r = await runCapture(AGY_BIN(), ["--version"], {
      timeoutMs: 10_000,
      windowsConsole: AGY_WINDOWS_CONSOLE,
    });
    return r.stdout.trim() || `${AGY_BIN()} (version unknown)`;
  } catch {
    return null;
  }
}

/** Historical menu hints; account-specific presence comes from `models()`.
 * Effort rides the vendor slug: the separate effort ladder stays empty and an
 * effort preference selects the listed level variant of the model's family
 * from the pinned account's LIVE list only (processing.ts) — these hints never
 * authorize a rewrite. New Claude ids come from the profile listing instead of extending this
 * version-stamped fallback. Inherited Gemini 3.8 hints were recorded on
 * 2026-10-03 while the binary self-updated from 1.1.13 to 1.2.16, so those
 * additions did not re-verify the fixture pin. Older 4.6 routes remain hints:
 * one account's absence cannot retire them. */
const AGY_KNOWN_MODELS = [
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
  "gemini-3.7-flash-high",
  "gemini-3.7-flash-medium",
  "gemini-3.7-flash-low",
  "gemini-3.6-flash-high",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-low",
  "gemini-3.5-flash-high",
  "gemini-3.5-flash-medium",
  "gemini-3.5-flash-low",
  "gemini-3.1-pro-high",
  "gemini-3.1-pro-low",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
] as const;

/** The vendor names these two quota groups explicitly. Declare known family
 * prefixes alongside historical ids so newly enumerated siblings keep their
 * actual quota without assigning arbitrary unknown ids to either group. */
export const AGY_QUOTA_MODEL_GROUPS = {
  gemini: {
    applies_to_models: AGY_KNOWN_MODELS.filter((id) => id.startsWith("gemini-")),
    applies_to_model_prefixes: ["gemini-"],
  },
  thirdParty: {
    applies_to_models: AGY_KNOWN_MODELS.filter(
      (id) => id.startsWith("claude-") || id.startsWith("gpt-"),
    ),
    applies_to_model_prefixes: ["claude-", "gpt-"],
  },
};

/** One manifest-owned declaration of the managed login's stdin contract. */
export const AGY_MANAGED_LOGIN = { stdin: "terminal" } as const;

/**
 * Static auth/profile policy. Windows Credential Manager is scoped to the OS
 * user, not the profile HOME, so only one enabled binding is honest there.
 * Darwin keeps both the vendor file fallback and its private profile-local
 * keychain; Linux retains the legacy profile-scoped file route.
 */
export const AGY_CAPABILITY_PROFILE: HarnessCapabilityProfile =
  HarnessCapabilityProfileSchema.parse({
    auth: {
      supported_sources: ["native_session"],
      preferred_source: "native_session",
      credential_transports: [
        {
          source: "native_session",
          kind: "config_file",
          relocatable_by: ["HOME"],
          platforms: ["linux"],
        },
        {
          source: "native_session",
          kind: "config_file",
          relocatable_by: ["HOME"],
          platforms: ["darwin"],
        },
        {
          source: "native_session",
          kind: "os_keychain",
          relocatable_by: ["HOME"],
          platforms: ["darwin"],
        },
        {
          source: "native_session",
          kind: "os_keychain",
          relocatable_by: [],
          platforms: ["win32"],
        },
      ],
      credential_profile_policies: [
        {
          source: "native_session",
          platforms: ["win32"],
          identity_scope: "os_user",
          max_enabled_profiles: 1,
          cleanup_owner: "vendor",
        },
      ],
      managed_login: AGY_MANAGED_LOGIN,
    },
    // workspace_write rides the vendor's `--mode accept-edits` permission
    // policy — the same class as claude/cursor, not an unconfined "none".
    access_control: {
      readonly_mechanism: "permission_deny",
      write_mechanism: "tool_policy",
      auxiliary_writable_roots: false,
    },
    isolation: {
      supported_containment: ["env_or_file_injection", "private_per_profile_keychain"],
    },
    attachment_inputs: [],
  });

/** Platform disclosure derived from the same transport and effective-policy
 * facts used by admission. Darwin is the one live-proven profile-isolation
 * lane; other lanes stay explicit rather than maintaining parallel truth. */
export function agyPlatformIsolationDetail(
  platform: NodeJS.Platform = process.platform,
): string | null {
  const host = harnessPlatform(platform);
  if (!host) return `Antigravity credential behavior is undeclared on ${platform}`;
  const transports = credentialTransportsForPlatform(AGY_CAPABILITY_PROFILE.auth, host);
  const policy = credentialProfilePolicyForPlatform(
    AGY_CAPABILITY_PROFILE.auth,
    "native_session",
    host,
  );
  if (host === "darwin") return null;
  const kinds =
    transports.map((transport) => transport.kind).join(" + ") || "no declared transport";
  if (policy.identity_scope === "os_user") {
    return `Antigravity uses ${kinds} credentials scoped to the current OS user; the named HOME scopes vendor state but is not an independent identity (maximum ${policy.max_enabled_profiles ?? "unbounded"} enabled binding)`;
  }
  return `named-account isolation is unverified on ${host}: the declared ${kinds} transport has profile-scoped policy but no live multi-account proof on this platform`;
}

const AGY_ENABLED_INTENTS = [
  "explain",
  "plan",
  "spec",
  "implement",
  "repair",
  "create_from_scratch",
  "review",
  "verify",
  "synthesize",
  "audit",
] as const;

export interface AgyAdapterOptions {
  /** Test seam; production prepares the declared private Darwin keychain. */
  prepareProfileKeychain?: (home: string, platform?: NodeJS.Platform) => void;
}

export function createAgyAdapter(options: AgyAdapterOptions = {}): HarnessAdapter {
  const prepareProfileKeychain =
    options.prepareProfileKeychain ??
    ((home: string, platform = process.platform): void => {
      if (!needsPrivatePerProfileKeychain(AGY_CAPABILITY_PROFILE, platform)) return;
      prepareAgyProfileKeychain(home, { platform });
    });
  const listModels = (spec: HarnessModelSpec) => listAgyModels(spec, prepareProfileKeychain);
  return {
    nativeHomeLifetime: {
      status: "not_pruned",
      reason: "Agy native session storage has no proven independent pruning contract.",
    },
    id: "agy",
    childHome: agyChildHome,
    nativeAccess: (spec) => formatNativeArgs(accessArgs(spec.access)),
    // The level is a token of the model id: `prepareProcessing` selects the
    // listed variant of the requested model's family from the pinned
    // account's live inventory and returns the effort receipt with it.
    effortParameter: "--model",
    capabilityProfile: AGY_CAPABILITY_PROFILE,

    async discover(): Promise<HarnessManifest> {
      const version = await detectVersion();
      if (version === null) {
        throw new HarnessUnavailableError(
          "agy not found on PATH (install Antigravity CLI or set CLAUDEXOR_AGY_BIN)",
        );
      }
      return HarnessManifestSchema.parse({
        id: "agy",
        display_name: "Antigravity",
        kind: "local_cli",
        version,
        adapter_version: CLAUDEXOR_VERSION,
        provider_family: "google",
        capabilities: {
          plan: true,
          implement: true,
          create_from_scratch: true,
          review: true,
          verify: true,
          synthesize: true,
          read_files: true,
          // No MCP flag path exists (config is file-only), so no browser
          // injector is wired — honest false (INV-066).
          browser_tool: false,
          // Built-in web tools with no enforceable off switch (cursor parity).
          web_policy: "uncontrolled",
          // D-16 default recommendation (В-10): the fenced-block tier costs
          // zero extra vendor turns; the schema-constrained tier is proven to
          // force a SECOND turn per run (PLAN §1.2e) and stays off until the
          // owner opts in.
          work_report_transport: "validated",
          // Effort rides the model slug (`-high`), not a flag (Л-21): an effort
          // preference selects the listed slug variant at preparation.
          effort_levels: [],
          model_inventory_absence: "advisory",
          known_models: [...AGY_KNOWN_MODELS],
          known_models_verified_against: AGY_VENDOR_CLI_VERSION,
        },
        capability_profile: AGY_CAPABILITY_PROFILE,
        auth_modes: ["local_session"],
        access_profiles_supported: ["readonly", "workspace_write", "full", "inherit_native"],
      });
    },

    async models(spec) {
      if (!spec?.credentialProfile) {
        // There is no default AGY account. These rows are historical hints,
        // never another profile's live inventory or admission authority.
        return AGY_KNOWN_MODELS.map((id) => ({
          id,
          label: null,
          context_window: null,
          routes: ["local_session" as const],
          origin: "hint" as const,
        }));
      }
      return listModels(spec);
    },

    prepareProcessing(spec) {
      return prepareAgyProcessing(spec, listModels);
    },

    async doctor(spec: DoctorSpec): Promise<ConformanceReport> {
      const version = await detectVersion();
      const installedSemver =
        version === null ? null : (/\d+\.\d+\.\d+/.exec(version)?.[0] ?? null);
      const versionDrift =
        version !== null && installedSemver !== AGY_VENDOR_CLI_VERSION
          ? `installed agy "${version}" differs from the verified ${AGY_VENDOR_CLI_VERSION}; the platform credential transport and profile policy are re-proven per version (R-2')`
          : null;
      // Л-24 + INV-067: Darwin's profile-local keychain plus vendor fallback
      // preserves the proven profile identity route. Linux retains the
      // config-file transport without a live multi-account proof. Windows has
      // a different effective policy altogether: the vendor credential is
      // OS-user-scoped and HOME scopes state only.
      const platformProof = agyPlatformIsolationDetail();
      // The readonly minimum (#653) is its own fact, apart from the fixture pin.
      const readonly = agyReadonlyDoctorCheck(installedSemver);
      const requestedSource = spec.authSource;
      if (requestedSource !== undefined && requestedSource !== "native_session") {
        return ConformanceReportSchema.parse({
          harness_id: "agy",
          status: "unavailable",
          checks: [
            version === null
              ? { id: "installed", status: "fail", detail: "agy not found" }
              : { id: "installed", status: "pass", detail: redactSecrets(version) },
            {
              id: "auth_source",
              status: "fail",
              detail: `agy does not support ${requestedSource}`,
            },
          ],
          enabled_intents: [],
          disabled_intents: AGY_ENABLED_INTENTS,
          reasons: [`agy does not support auth source ${requestedSource}`],
          auth_sources: [
            {
              source: requestedSource,
              availability: "unavailable",
              verification: "not_run",
              detail: `agy does not support ${requestedSource}`,
            },
          ],
        });
      }
      if (version === null) {
        return ConformanceReportSchema.parse({
          harness_id: "agy",
          status: "unavailable",
          checks: [{ id: "installed", status: "fail", detail: "agy not found" }],
          enabled_intents: [],
          disabled_intents: AGY_ENABLED_INTENTS,
          reasons: ["agy not found (install Antigravity CLI or set CLAUDEXOR_AGY_BIN)"],
          auth_sources: [
            {
              source: "native_session",
              availability: "unknown",
              verification: "not_run",
              detail: "agy binary not installed",
            },
          ],
        });
      }
      // Owner decision Л-4: agy has NO engine-default credential store — every
      // account is a named profile. The harness-level doctor therefore reports
      // the default subject honestly unavailable with the remedy; PINNED
      // routing is admitted by the per-profile probe (INV-135 round-15 #1),
      // exactly like a logged-out cursor default with valid named profiles.
      return ConformanceReportSchema.parse({
        harness_id: "agy",
        status: "unavailable",
        checks: [
          { id: "installed", status: "pass", detail: redactSecrets(version) },
          {
            id: "default_credential",
            status: "fail",
            detail: "agy has no engine-default credential by design; accounts are named profiles",
          },
          ...(versionDrift
            ? [{ id: "version_pin", status: "fail" as const, detail: versionDrift }]
            : [{ id: "version_pin", status: "pass" as const, detail: AGY_VENDOR_CLI_VERSION }]),
          readonly,
          ...(platformProof
            ? [{ id: "platform_isolation", status: "skip" as const, detail: platformProof }]
            : []),
        ],
        enabled_intents: [],
        disabled_intents: AGY_ENABLED_INTENTS,
        reasons: [
          "agy routes only through named accounts: add one (`claudexor profiles add agy <id>` + `claudexor profiles login agy <id>`) and pin it (--profile)",
          ...(versionDrift ? [versionDrift] : []),
          ...(readonly.status === "fail" ? [readonly.detail] : []),
          ...(platformProof ? [platformProof] : []),
        ],
        auth_sources: [
          {
            source: "native_session",
            availability: "unavailable",
            verification: "not_run",
            detail: "no default store by design (accounts are named profiles)",
          },
        ],
      });
    },

    run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runAgy(spec, prepareProfileKeychain, listModels);
    },

    review(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runAgy(spec, prepareProfileKeychain, listModels);
    },

    // INV-135: pinned routing is admitted by THIS probe (there is no default
    // store for the harness doctor to credit).
    async probeCredentialProfile(profile, abortSignal) {
      // The signal must reach the live probe: dropping it left an aborted
      // doctor sweep waiting out the probe's own 30s timeout.
      return probeAgyCredentialProfile(
        profile,
        {
          runModelProbe: defaultAgyModelProbe,
          prepareProfileKeychain: (home) => prepareProfileKeychain(home),
        },
        abortSignal,
      );
    },
  };
}

async function* runAgy(
  spec: HarnessRunSpec,
  prepareProfileKeychain: (home: string, platform?: NodeJS.Platform) => void,
  listModels: (spec: HarnessModelSpec) => Promise<HarnessModel[]>,
): AsyncIterable<HarnessEvent> {
  if (!promptWithInstructions(spec)) {
    yield {
      type: "error",
      session_id: spec.session_id,
      ts: nowIso(),
      error: "agy requires nonempty input for headless execution",
    };
    yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
    return;
  }
  const profile = spec.credential_profile;
  // Л-4: no engine-default credential — an unpinned agy run has nothing to
  // route. Typed stream refusal (error then completed), the one refusal
  // mechanism every adapter's profile gate uses.
  if (!profile) {
    yield {
      type: "error",
      session_id: spec.session_id,
      ts: nowIso(),
      error:
        "agy has no engine-default credential; pin a named account (--profile, or `claudexor profiles add agy <id>`)",
    };
    yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
    return;
  }
  const route = resolveAgyProfileRoute(profile, spec.env);
  if ("refusal" in route) {
    yield { type: "error", session_id: spec.session_id, ts: nowIso(), error: route.refusal };
    yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
    return;
  }

  // Path and identity failures are unsafe and stop before the vendor child.
  // A recoverable security-tool miss keeps agy's own file fallback available;
  // a custom test seam may model that same operational degradation.
  try {
    prepareProfileKeychain(route.home);
  } catch (error) {
    if (isAgyProfileKeychainUnsafe(error)) {
      yield {
        type: "error",
        session_id: spec.session_id,
        ts: nowIso(),
        error: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 300),
      };
      yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
      return;
    }
    // The vendor probe/run remains the final transport authority.
  }

  // Read grant, readonly session policy and note, and inline or file input (#653).
  const access = yield* prepareAgyRunInput(spec, route.home);
  if (!access) return;
  const { settings, input } = access;

  // AGY 1.1.13 selects print mode from piped stdin only without a print/prompt flag.
  const args = ["--output-format", "stream-json"];
  // Л-18: without --add-dir agy resolves relative paths against its own app
  // data dir instead of the workspace (live-proven §1.2d).
  args.push("--add-dir", spec.cwd);
  args.push(...accessArgs(spec.access));
  // ONE prepared result: the id sent is the processing receipt's
  // submittedNative (the effort-selected family variant); spec.model_hint
  // stays the caller's requested id.
  const prepared = await applyAgyRunProcessing(spec, listModels);
  spec = prepared.spec;
  if (prepared.nativeModel) args.push("--model", prepared.nativeModel);
  // INV-137: the vendor conversation id is the resumable native session.
  if (spec.resume_session_id) args.push("--conversation", spec.resume_session_id);

  const completion = createAgyNativeCompletion();
  const run = (settingsArgs: string[]) =>
    runCliHarness({
      bin: AGY_BIN(),
      args: [...settingsArgs, ...args],
      input,
      spec,
      env: route.env,
      windowsConsole: AGY_WINDOWS_CONSOLE,
      label: "agy",
      redact: redactSecrets,
      observeStderr: completion.observeStderr,
      parseStderrFailure: completion.parseStderrFailure,
      parseEvent: (obj, sessionId) => {
        const out = parseAgyEvent(obj, sessionId);
        if (out) {
          for (const ev of out) {
            ev.credential_route = "vendor_native";
            ev.credential_source = "native_session";
            ev.credential_profile_id = profile.profile_id;
            if (spec.processing) {
              ev.processing = spec.processing;
              ev.processing_cost_basis = spec.processing_cost_basis;
            }
          }
        }
        return out;
      },
    });
  yield* completion.wrap(withAgySessionSettings(settings, spec.session_id, run));
}
