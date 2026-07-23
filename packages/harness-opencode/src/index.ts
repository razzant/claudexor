import type {
  AccessProfile,
  ConformanceReport,
  CredentialProfile,
  CredentialProfileStatus,
  HarnessEvent,
  HarnessManifest,
  HarnessRunSpec,
} from "@claudexor/schema";
import {
  ConformanceReport as ConformanceReportSchema,
  CredentialProfileStatus as CredentialProfileStatusSchema,
  HarnessManifest as HarnessManifestSchema,
} from "@claudexor/schema";
import type { DoctorSpec, HarnessAdapter } from "@claudexor/core";
import {
  HarnessUnavailableError,
  promptWithInstructions,
  providerScrubEnv,
  runCapture,
  runCliHarness,
} from "@claudexor/core";
import { namespacedSecretRefBase, resolveSecret } from "@claudexor/secrets";
import { CLAUDEXOR_VERSION, nowIso, redactSecrets } from "@claudexor/util";
import { parseOpenCodeEvent } from "./parse.js";

const BIN = process.env.CLAUDEXOR_OPENCODE_BIN || "opencode";

function accessArgs(access: AccessProfile): string[] {
  switch (access) {
    case "full":
    case "external_sandbox_full":
      return ["--dangerously-skip-permissions"];
    case "readonly":
    case "inherit_native":
      return [];
    case "workspace_write":
      // Unreachable: runOpenCode rejects workspace_write up front (no proven
      // scoped confinement). Returning the full-access flag here would silently
      // upgrade the access, so refuse loudly instead.
      throw new HarnessUnavailableError(
        "opencode workspace_write has no conformance-proven scoped confinement; this profile is rejected before run",
      );
  }
}

async function detectVersion(): Promise<string | null> {
  try {
    const r = await runCapture(BIN, ["--version"], { timeoutMs: 10_000 });
    return r.stdout.trim() || `${BIN} (version unknown)`;
  } catch {
    return null;
  }
}

const PROVIDER_KEY_ENV = ["OPENCODE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;

function providerKey(
  env: Record<string, string | null | undefined> = process.env,
): { envVar: (typeof PROVIDER_KEY_ENV)[number]; value: string } | null {
  for (const envVar of PROVIDER_KEY_ENV) {
    if (env[envVar]) return { envVar, value: env[envVar] as string };
  }
  // Resolve each stored candidate once (the store may spawn a keychain read
  // per call); the hermetic kill switch is honored inside resolveSecret.
  for (const [name, envVar] of [
    ["opencode", "OPENCODE_API_KEY"],
    ["openai", "OPENAI_API_KEY"],
    ["anthropic", "ANTHROPIC_API_KEY"],
  ] as const) {
    const value = resolveSecret(name);
    if (value) return { envVar, value };
  }
  return null;
}

function providerKeyAvailable(
  env: Record<string, string | null | undefined> = process.env,
): boolean {
  return providerKey(env) !== null;
}

/**
 * INV-135 strict profile routing, ONE owner for the run route and the doctor
 * probe: an opencode profile is exactly its secret-ref API key, and the ref's
 * NAMESPACED base selects the provider env var it rides (opencode is
 * multi-provider by design). A bare ref would alias the engine-default slot;
 * other kinds and missing secrets refuse typed, never the default ladder.
 */
export function opencodeProfileKeyOrRefusal(
  profile: {
    profile_id: string;
    credential_kind: string;
    secret_ref: string | null;
  },
  resolve: (ref: string) => string | null = resolveSecret,
):
  | { envVar: string; value: string }
  | { refusal: string; reason: "misconfigured" | "missing_secret" } {
  if (profile.credential_kind !== "api_key")
    return {
      refusal: `credential profile "${profile.profile_id}": opencode supports only the api_key transport`,
      reason: "misconfigured",
    };
  const ref = profile.secret_ref ?? "";
  const base = namespacedSecretRefBase(ref);
  const envVar = base
    ? { opencode: "OPENCODE_API_KEY", openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" }[
        base
      ]
    : undefined;
  if (!envVar)
    return {
      refusal: `credential profile "${profile.profile_id}": api_key secret_ref must use a namespaced opencode/openai/anthropic slot (base:profile, e.g. opencode:${profile.profile_id}; got "${ref}")`,
      reason: "misconfigured",
    };
  const value = resolve(ref);
  if (!value)
    return {
      refusal: `credential profile "${profile.profile_id}": secret "${ref}" is not stored`,
      reason: "missing_secret",
    };
  return { envVar, value };
}

/**
 * Doctor projection for one opencode profile (INV-135, release wave round-15
 * #1): the SAME resolution the run route uses, mapped to a status. PRESENCE
 * is the honest doctor fact for a stored key; liveness is the run's job.
 */
export function probeOpencodeCredentialProfile(
  profile: CredentialProfile,
  resolve: (ref: string) => string | null = resolveSecret,
): CredentialProfileStatus {
  const base = { profile_id: profile.profile_id, harness_id: "opencode" };
  try {
    const gate = opencodeProfileKeyOrRefusal(profile, resolve);
    if ("refusal" in gate)
      return CredentialProfileStatusSchema.parse({
        ...base,
        availability: "unavailable",
        verification: gate.reason === "missing_secret" ? "not_run" : "failed",
        detail: gate.refusal,
      });
    return CredentialProfileStatusSchema.parse({
      ...base,
      availability: "available",
      verification: "not_run",
      detail: `secret "${profile.secret_ref}" is stored`,
    });
  } catch (err) {
    return CredentialProfileStatusSchema.parse({
      ...base,
      availability: "unavailable",
      verification: "failed",
      detail: redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
  }
}

const OPENCODE_ENABLED_INTENTS = [
  "implement",
  "repair",
  "create_from_scratch",
  "verify",
  "synthesize",
] as const;
const OPENCODE_DISABLED_INTENTS = ["explain", "audit", "plan", "spec", "review"] as const;
const ALL_OPENCODE_INTENTS = [...OPENCODE_ENABLED_INTENTS, ...OPENCODE_DISABLED_INTENTS] as const;

export function createOpenCodeAdapter(): HarnessAdapter {
  return {
    id: "opencode",

    async discover(): Promise<HarnessManifest> {
      const version = await detectVersion();
      if (version === null) {
        throw new HarnessUnavailableError(
          "opencode not found on PATH (set CLAUDEXOR_OPENCODE_BIN)",
        );
      }
      const authReady = providerKeyAvailable();
      return HarnessManifestSchema.parse({
        id: "opencode",
        display_name: "OpenCode",
        kind: "local_cli",
        version,
        adapter_version: CLAUDEXOR_VERSION,
        provider_family: "opencode",
        capabilities: {
          // Capabilities are ABILITIES; auth readiness lives in auth_modes and
          // doctor. opencode can draft plans whenever it can run at all.
          plan: true,
          implement: true,
          create_from_scratch: true,
          review: true,
          verify: true,
          synthesize: true,
          read_files: true,
          // No browser-MCP injection path exists for opencode yet —
          // honest false until that path exists + is verified.
          browser_tool: false,
          web_policy: "uncontrolled",
          // D-16: no schema-constrained transport -> WorkReport unsupported
          // (work_state stays unverified, a disclosed absence, never a failure).
          work_report_transport: "unsupported",
          // opencode exposes no reasoning-effort flag -> effort is not tunable.
          effort_levels: [],
        },
        capability_profile: {
          auth: {
            supported_sources: ["api_key_env"],
            preferred_source: authReady ? "api_key_env" : null,
            credential_transports: [
              { source: "api_key_env", kind: "env_var", relocatable_by: ["ENV"] },
            ],
          },
          // HONEST access surface: the only permission flag the adapter drives
          // is `--dangerously-skip-permissions` (full access), so there is no
          // scoped readonly mechanism to declare (see access_profiles below).
          access_control: { readonly_mechanism: "none" },
          isolation: { supported_containment: ["env_or_file_injection"] },
          attachment_inputs: [],
        },
        auth_modes: authReady ? ["api_key"] : [],
        access_profiles_supported: ["full", "inherit_native"],
      });
    },

    async doctor(spec: DoctorSpec): Promise<ConformanceReport> {
      const version = await detectVersion();
      const requestedSource = spec.authSource;
      if (requestedSource !== undefined && requestedSource !== "api_key_env") {
        return ConformanceReportSchema.parse({
          harness_id: "opencode",
          status: "unavailable",
          checks: [
            version === null
              ? { id: "installed", status: "fail", detail: "opencode not found" }
              : { id: "installed", status: "pass", detail: redactSecrets(version) },
            {
              id: "auth_source",
              status: "fail",
              detail: `opencode does not support ${requestedSource}`,
            },
          ],
          enabled_intents: [],
          disabled_intents: ALL_OPENCODE_INTENTS,
          reasons: [
            ...(version === null
              ? ["opencode not found (install OpenCode or set CLAUDEXOR_OPENCODE_BIN)"]
              : []),
            `opencode does not support auth source ${requestedSource}`,
          ],
          auth_sources: [
            {
              source: requestedSource,
              availability: "unavailable",
              verification: "not_run",
              detail: `opencode does not support ${requestedSource}`,
            },
          ],
        });
      }

      const authReady = providerKeyAvailable({ ...process.env, ...spec.env });
      const readiness = {
        source: "api_key_env" as const,
        availability: authReady ? ("available" as const) : ("unavailable" as const),
        verification: "not_run" as const,
        detail: authReady
          ? "credential source is present; verification requires an isolated capability smoke"
          : "no provider API key is configured",
      };
      if (version === null) {
        return ConformanceReportSchema.parse({
          harness_id: "opencode",
          status: "unavailable",
          checks: [
            { id: "installed", status: "fail", detail: "opencode not found" },
            { id: "provider_auth", status: authReady ? "pass" : "fail", detail: readiness.detail },
          ],
          enabled_intents: [],
          disabled_intents: ALL_OPENCODE_INTENTS,
          reasons: [
            "opencode not found (install OpenCode or set CLAUDEXOR_OPENCODE_BIN)",
            ...(authReady ? [] : ["opencode provider auth not configured"]),
          ],
          auth_sources: [readiness],
        });
      }
      // A key STRING is source availability, not readiness: without an isolated
      // smoke proving the route, the honest status is degraded (cursor parity).
      return ConformanceReportSchema.parse({
        harness_id: "opencode",
        // No auth source at all = unavailable; key-present-but-unproven = degraded.
        status: authReady ? "degraded" : "unavailable",
        checks: [
          { id: "installed", status: "pass", detail: redactSecrets(version) },
          {
            id: "provider_auth",
            status: authReady ? "pass" : "fail",
            detail: authReady
              ? "provider key available (unproven without isolated smoke)"
              : undefined,
          },
          {
            id: "isolated_smoke",
            status: "skip",
            detail: "no isolated smoke implemented for opencode yet",
          },
          {
            id: "readonly_conformance",
            status: "skip",
            detail: "readonly not proven for opencode adapter yet",
          },
        ],
        // COMPLETE intent bookkeeping: every declared-capability intent is in
        // exactly one list, so routing can never lose an intent to a gap
        // (review/plan/spec stay gated until an isolated smoke proves the
        // route — the same conformance bar explain/audit wait on).
        enabled_intents: authReady ? OPENCODE_ENABLED_INTENTS : [],
        disabled_intents: authReady ? OPENCODE_DISABLED_INTENTS : ALL_OPENCODE_INTENTS,
        reasons: authReady
          ? [
              "key present but route unproven (no isolated smoke); read-only and reviewer intents stay disabled until conformance-proven",
            ]
          : ["opencode provider auth not configured"],
        auth_sources: [readiness],
      });
    },

    run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runOpenCode(spec);
    },

    review(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runOpenCode(spec);
    },

    // INV-135 (release wave round-15 #1): a valid opencode profile must admit
    // the route even when no default provider key exists — the orchestrator
    // consults THIS probe to override the default auth verdict.
    async probeCredentialProfile(profile) {
      return probeOpencodeCredentialProfile(profile);
    },
  };
}

async function* runOpenCode(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
  // The manifest declares readonly unsupported; running it with default
  // (write-capable) permissions would be a silent access downgrade. Same
  // typed throw as workspace_write below — an unsupported access profile is
  // a routing error, not a stream that "completed".
  if (spec.access === "readonly") {
    throw new HarnessUnavailableError(
      "opencode does not support a conformance-proven readonly profile; use another harness for read-only intents",
    );
  }
  // The only permission flag the adapter drives is --dangerously-skip-permissions
  // (full access). A workspace_write request has NO proven scoped confinement, so
  // honoring it would SILENTLY grant full. Reject loudly instead of downgrading
  // the access guarantee (manifest advertises full-only).
  if (spec.access === "workspace_write") {
    throw new HarnessUnavailableError(
      "opencode does not support a conformance-proven workspace_write (scoped) profile; it can only run with full access (--dangerously-skip-permissions). Use full access explicitly or another harness for confined writes.",
    );
  }
  const args = ["run", "--format", "json", ...accessArgs(spec.access)];
  if (spec.model_hint) args.push("--model", spec.model_hint);
  // Resume the thread's native opencode session (ses_...) as a follow-up turn.
  if (spec.resume_session_id) args.push("--session", spec.resume_session_id);
  // opencode has no native system-prompt flag; layer instructions as a delimited
  // prompt prefix (the engine already withheld them from synthesis/reviewers).
  args.push(promptWithInstructions(spec));
  // Doctor/run symmetry: resolve the key from the same sources doctor credits
  // (spec env first, then process env, then stored secrets) so a doctor "ok"
  // cannot precede a guaranteed-unauthenticated run.
  const profile = spec.credential_profile;
  let key: { envVar: string; value: string } | null;
  if (profile) {
    // INV-135 strict profile routing — the same single owner the doctor
    // probe consults (opencodeProfileKeyOrRefusal). The refusal rides the
    // TYPED stream shape (error then completed) like every other adapter's
    // profile gate (round-18 scope) — one refusal mechanism across the five.
    const gate = opencodeProfileKeyOrRefusal(profile);
    if ("refusal" in gate) {
      yield { type: "error", session_id: spec.session_id, ts: nowIso(), error: gate.refusal };
      yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
      return;
    }
    key = gate;
  } else {
    key = providerKey({ ...process.env, ...spec.env });
  }
  // Unified provider scrub (cross-provider leak fix): clear EVERY known provider
  // secret/redirect from the child, then re-add ONLY the single key opencode's
  // chosen provider route needs. The shared runner starts from process.env, so
  // an adapter-local partial denylist would leak unrelated host credentials.
  const env: Record<string, string | null | undefined> = {
    ...spec.env,
    ...providerScrubEnv(),
  };
  if (key) env[key.envVar] = key.value;

  yield* runCliHarness({
    bin: BIN,
    args,
    spec,
    env,
    label: "opencode",
    redact: redactSecrets,
    parseEvent: (obj, sessionId) => {
      const out = parseOpenCodeEvent(obj, sessionId);
      if (out) {
        // Route evidence (release wave tier1 #5): opencode always runs the
        // managed key route; profiled runs additionally stamp their profile
        // so the attempt's auth receipt stays attributable.
        for (const ev of out) {
          ev.credential_route = "managed_api_key";
          ev.credential_source = "api_key_env";
          if (profile) ev.credential_profile_id = profile.profile_id;
        }
      }
      return out;
    },
  });
}
