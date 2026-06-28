import type { AccessProfile, ConformanceReport, HarnessEvent, HarnessManifest, HarnessRunSpec } from "@claudexor/schema";
import { ConformanceReport as ConformanceReportSchema, HarnessManifest as HarnessManifestSchema } from "@claudexor/schema";
import type { DoctorSpec, HarnessAdapter } from "@claudexor/core";
import { HarnessUnavailableError, providerScrubEnv, runCapture, runCliHarness } from "@claudexor/core";
import { resolveSecret } from "@claudexor/secrets";
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

function providerKey(env: Record<string, string | undefined> = process.env): { envVar: (typeof PROVIDER_KEY_ENV)[number]; value: string } | null {
  for (const envVar of PROVIDER_KEY_ENV) {
    if (env[envVar]) return { envVar, value: env[envVar] as string };
  }
  return (
    (resolveSecret("opencode") && { envVar: "OPENCODE_API_KEY" as const, value: resolveSecret("opencode") as string }) ||
    (resolveSecret("openai") && { envVar: "OPENAI_API_KEY" as const, value: resolveSecret("openai") as string }) ||
    (resolveSecret("anthropic") && { envVar: "ANTHROPIC_API_KEY" as const, value: resolveSecret("anthropic") as string }) ||
    null
  );
}

function providerKeyAvailable(): boolean {
  return providerKey() !== null;
}

export function createOpenCodeAdapter(): HarnessAdapter {
  return {
    id: "opencode",

    async discover(): Promise<HarnessManifest> {
      const version = await detectVersion();
      if (version === null) {
        throw new HarnessUnavailableError("opencode not found on PATH (set CLAUDEXOR_OPENCODE_BIN)");
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
          plan: authReady,
          spec: authReady,
          implement: true,
          create_from_scratch: true,
          repair: true,
          review: true,
          verify: true,
          compare: true,
          synthesize: true,
          shell: true,
          read_files: true,
          edit_files: true,
          apply_patch: true,
          structured_events: true,
          structured_output: true,
          json_schema_output: false,
          resume: true,
          cancel: false,
          mcp: true,
          // MCP-capable, but no browser-MCP injector wired for opencode yet —
          // honest false until that path exists + is verified.
          browser_tool: false,
          plugins: true,
          worktree_native: false,
          web_policy: "uncontrolled",
          // No real rate-limit detector for opencode yet (a detector waits on a
          // recorded rate-limited transcript) -> honest `unknown`, not `observed`.
          quota_signal: "unknown",
          usage_signal: "observed",
          // opencode exposes no reasoning-effort flag -> effort is not tunable.
          effort_levels: [],
        },
        capability_profile: {
          execution_surfaces: [{ kind: "cli_one_shot", input: "prompt_arg", output: "ndjson", event_schema: "native" }],
          session: { native_session_id_emitted: true, resume_latest: true, resume_by_id: true, fork: true },
          output: { ndjson_events: true, final_json: false, file_changes: false, json_schema_final: false, usage_signal: "observed", cost_signal: "observed" },
          auth: {
            supported_sources: ["api_key_env"],
            preferred_source: authReady ? "api_key_env" : null,
            probe_command: [],
            env_vars: [...PROVIDER_KEY_ENV],
            credential_transports: [{ source: "api_key_env", kind: "env_var", relocatable_by: ["ENV"], requires_user_session: false, bypass_env_vars: [...PROVIDER_KEY_ENV] }],
          },
          // HONEST access surface: the only permission flag the adapter drives is
          // `--dangerously-skip-permissions` (full access). opencode exposes no
          // CONFIRMED scoped workspace-write confinement the adapter can map to
          // (and opencode is not installed to live-verify one), so advertising
          // workspace_write would silently grant full. full-only until a scoped
          // mechanism is conformance-proven.
          access_control: { readonly: false, workspace_write: false, full: true, mechanism: "opencode --dangerously-skip-permissions (full access only; no proven scoped workspace-write)", readonly_mechanism: "none" },
          isolation: { path_redirect_sufficient: true, requires_user_session: false, supported_containment: ["env_or_file_injection"] },
          // No proven headless image input surface — attach is gated off until verified.
          image_input: "none",
        },
        auth_modes: authReady ? ["api_key"] : [],
        access_profiles_supported: ["full", "inherit_native"],
      });
    },

    async doctor(_spec: DoctorSpec): Promise<ConformanceReport> {
      const version = await detectVersion();
      if (version === null) {
        return ConformanceReportSchema.parse({
          harness_id: "opencode",
          status: "unavailable",
          checks: [{ id: "installed", status: "fail", detail: "opencode not found" }],
          reasons: ["opencode not found (install OpenCode or set CLAUDEXOR_OPENCODE_BIN)"],
        });
      }
      const authReady = providerKeyAvailable();
      // A key STRING is source availability, not readiness: without an isolated
      // smoke proving the route, the honest status is degraded (cursor parity).
      return ConformanceReportSchema.parse({
        harness_id: "opencode",
        // No auth source at all = unavailable; key-present-but-unproven = degraded.
        status: authReady ? "degraded" : "unavailable",
        checks: [
          { id: "installed", status: "pass", detail: version },
          { id: "provider_auth", status: authReady ? "pass" : "fail", detail: authReady ? "provider key available (unproven without isolated smoke)" : undefined },
          { id: "isolated_smoke", status: "skip", detail: "no isolated smoke implemented for opencode yet" },
          { id: "readonly_conformance", status: "skip", detail: "readonly not proven for opencode adapter yet" },
        ],
        enabled_intents: authReady ? ["implement", "repair", "create_from_scratch", "verify", "compare", "synthesize"] : [],
        disabled_intents: authReady ? ["explain", "audit"] : ["implement", "repair", "create_from_scratch", "verify", "compare", "synthesize", "explain", "audit"],
        reasons: authReady
          ? ["key present but route unproven (no isolated smoke); readonly/audit not enabled until conformance-proven"]
          : ["opencode provider auth not configured"],
      });
    },

    run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runOpenCode(spec);
    },

    review(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runOpenCode(spec);
    },
  };
}

async function* runOpenCode(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
  // The manifest declares readonly unsupported; running it with default
  // (write-capable) permissions would be a silent access downgrade.
  if (spec.access === "readonly") {
    yield {
      type: "error",
      session_id: spec.session_id,
      ts: nowIso(),
      error: "opencode does not support a conformance-proven readonly profile; use another harness for read-only intents",
    };
    yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
    return;
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
  args.push(spec.prompt);
  // Doctor/run symmetry: resolve the key from the same sources doctor credits
  // (spec env first, then process env, then stored secrets) so a doctor "ok"
  // cannot precede a guaranteed-unauthenticated run.
  const key = providerKey({ ...process.env, ...spec.env });
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
    parseEvent: parseOpenCodeEvent,
  });
}
