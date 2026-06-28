import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccessProfile, ConformanceReport, HarnessCapabilityProfile, HarnessEvent, HarnessManifest, HarnessRunSpec } from "@claudexor/schema";
import { ConformanceReport as ConformanceReportSchema, HarnessCapabilityProfile as HarnessCapabilityProfileSchema, HarnessManifest as HarnessManifestSchema } from "@claudexor/schema";
import type { DoctorSpec, HarnessAdapter } from "@claudexor/core";
import { HarnessUnavailableError, needsScopedHomeKeychainBridge, providerScrubEnv, runCapture, runCliHarness } from "@claudexor/core";
import { resolveSecret } from "@claudexor/secrets";
import { CLAUDEXOR_VERSION, nowIso, redactSecrets } from "@claudexor/util";
import { createCursorParser } from "./parse.js";

const BIN = process.env.CLAUDEXOR_CURSOR_BIN || "cursor-agent";

const CURSOR_CAPABILITY_PROFILE: HarnessCapabilityProfile = HarnessCapabilityProfileSchema.parse({
  execution_surfaces: [{ kind: "cli_one_shot", input: "prompt_arg", output: "ndjson", event_schema: "native" }],
  session: { native_session_id_emitted: true, resume_latest: true, resume_by_id: true },
  output: { ndjson_events: true, tool_lifecycle: true, file_changes: true, final_json: false, json_schema_final: false, usage_signal: "observed", cost_signal: "observed" },
  auth: {
    supported_sources: ["native_session", "api_key_env"],
    preferred_source: null,
    probe_command: ["cursor-agent", "status"],
    env_vars: ["CURSOR_API_KEY"],
    credential_transports: [
      { source: "native_session", kind: "os_keychain", relocatable_by: ["HOME"], requires_user_session: false, bypass_env_vars: [] },
      { source: "api_key_env", kind: "env_var", relocatable_by: ["ENV"], requires_user_session: false, bypass_env_vars: ["CURSOR_API_KEY"] },
    ],
  },
  access_control: { readonly: true, workspace_write: true, full: false, mechanism: "cursor-agent --sandbox enabled", readonly_mechanism: "fs_sandbox" },
  isolation: { path_redirect_sufficient: false, requires_user_session: false, supported_containment: ["scoped_home_keychain_bridge", "env_or_file_injection"] },
  image_input: "none",
});

function accessArgs(access: AccessProfile): string[] {
  switch (access) {
    case "readonly":
      return ["--sandbox", "enabled", "--trust"];
    case "workspace_write":
      // `--force` alone force-allows commands with NO sandbox — materially
      // broader than claude acceptEdits / codex --sandbox workspace-write for
      // the same profile. Keep the sandbox on for workspace_write parity.
      return ["--force", "--sandbox", "enabled", "--trust"];
    case "full":
    case "external_sandbox_full":
      return ["--force", "--sandbox", "disabled", "--trust"];
    case "inherit_native":
      return ["--trust"];
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

async function nativeAuthOk(env?: Record<string, string | null | undefined>): Promise<boolean> {
  try {
    const r = await runCapture(BIN, ["status"], { env, timeoutMs: 10_000 });
    return cursorStatusAuthenticated(r.code, `${r.stdout}\n${r.stderr}`);
  } catch {
    return false;
  }
}

export function cursorStatusAuthenticated(code: number | null, text: string): boolean {
  if (code !== 0) return false;
  const normalized = text.toLowerCase();
  if (normalized.includes("not logged in") || normalized.includes("authentication required")) return false;
  return normalized.includes("logged in") || normalized.includes("authenticated") || normalized.includes("account");
}

function cursorApiKey(): string | null {
  return process.env.CLAUDEXOR_CURSOR_API_KEY || resolveSecret("cursor") || process.env.CURSOR_API_KEY || null;
}

function bridgeMacLoginKeychain(home: string): void {
  if (process.platform !== "darwin") return;
  const realHome = process.env.HOME;
  if (!realHome || realHome === home) return;
  const source = join(realHome, "Library", "Keychains");
  if (!existsSync(source)) return;
  const targetParent = join(home, "Library");
  const target = join(targetParent, "Keychains");
  if (existsSync(target)) return;
  try {
    mkdirSync(targetParent, { recursive: true, mode: 0o700 });
    symlinkSync(source, target, "dir");
  } catch {
    // The smoke will fail honestly if the OS credential bridge cannot be created.
  }
}

async function smokeIsolatedApiKey(): Promise<{ ok: boolean; detail: string }> {
  const key = cursorApiKey();
  if (!key) return { ok: false, detail: "no Cursor API key" };
  const base = mkdtempSync(join(tmpdir(), "claudexor-cursor-smoke-"));
  const home = join(base, "home");
  try {
    mkdirSync(join(home, ".config"), { recursive: true, mode: 0o700 });
    if (needsScopedHomeKeychainBridge(CURSOR_CAPABILITY_PROFILE)) bridgeMacLoginKeychain(home);
    const env: Record<string, string | null> = {
      ...providerScrubEnv(),
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      CURSOR_API_KEY: key,
    };
    const r = await runCapture(BIN, ["-p", "--output-format", "stream-json", "--mode", "plan", "--trust", "Reply exactly OK"], {
      env,
      timeoutMs: 45_000,
    });
    const text = `${r.stdout}\n${r.stderr}`;
    if (r.code === 0 && text.includes("OK")) return { ok: true, detail: "isolated cursor-agent API-key smoke passed" };
    return { ok: false, detail: `isolated cursor-agent API-key smoke failed (exit ${r.code ?? "signal"}): ${redactSecrets(text).trim().split("\n").slice(-3).join(" ").slice(0, 500)}` };
  } catch (err) {
    return { ok: false, detail: `isolated cursor-agent API-key smoke failed (${err instanceof Error ? err.message.split("\n")[0] : String(err)})` };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

export function createCursorAdapter(): HarnessAdapter {
  return {
    id: "cursor",

    async discover(): Promise<HarnessManifest> {
      const version = await detectVersion();
      if (version === null) {
        throw new HarnessUnavailableError("cursor-agent not found on PATH (set CLAUDEXOR_CURSOR_BIN)");
      }
      const nativeAuthed = await nativeAuthOk();
      const apiKey = cursorApiKey() !== null;
      return HarnessManifestSchema.parse({
        id: "cursor",
        display_name: "Cursor CLI",
        kind: "local_cli",
        version,
        adapter_version: CLAUDEXOR_VERSION,
        provider_family: "cursor",
        capabilities: {
          plan: true,
          spec: true,
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
          // MCP-capable, but Claudexor has not wired a browser-MCP injector for
          // cursor-agent yet — honest false until that path exists + is verified.
          browser_tool: false,
          plugins: true,
          worktree_native: true,
          web_policy: "uncontrolled",
          // No real rate-limit detector for cursor yet (a detector waits on a
          // recorded rate-limited transcript) -> honest `unknown`, not `observed`.
          quota_signal: "unknown",
          usage_signal: "observed",
          // cursor-agent exposes no reasoning-effort flag -> effort is not tunable.
          effort_levels: [],
        },
        capability_profile: {
          ...CURSOR_CAPABILITY_PROFILE,
          auth: {
            ...CURSOR_CAPABILITY_PROFILE.auth,
            preferred_source: nativeAuthed ? "native_session" : apiKey ? "api_key_env" : null,
          },
        },
        // Source AVAILABILITY truth: each mode is listed only when its source
        // actually exists right now (a native session does not imply a key).
        auth_modes: [...(nativeAuthed ? ["local_session" as const] : []), ...(apiKey ? ["api_key" as const] : [])],
        access_profiles_supported: ["readonly", "workspace_write", "inherit_native"],
      });
    },

    async doctor(_spec: DoctorSpec): Promise<ConformanceReport> {
      const version = await detectVersion();
      if (version === null) {
        return ConformanceReportSchema.parse({
          harness_id: "cursor",
          status: "unavailable",
          checks: [{ id: "installed", status: "fail", detail: "cursor-agent not found" }],
          reasons: ["cursor-agent not found (install Cursor CLI or set CLAUDEXOR_CURSOR_BIN)"],
        });
      }
      const nativeAuthed = await nativeAuthOk();
      const apiKey = cursorApiKey() !== null;
      const apiSmoke = apiKey ? await smokeIsolatedApiKey() : { ok: false, detail: "no Cursor API key" };
      // Readiness doctrine: a key string alone is source availability, not
      // proven readiness. Native auth proves read-only/session reuse; an isolated
      // API-key smoke proves envelope/write routes.
      const allIntents = ["plan", "spec", "implement", "repair", "create_from_scratch", "review", "verify", "compare", "synthesize", "explain", "audit"];
      // Write-class intents run in isolated envelopes with a scoped HOME where
      // the native cursor session is unreachable — they REQUIRE the key
      // fallback. Native-only auth honestly enables only the non-envelope
      // (read-only) intents so doctor-ok can never precede a guaranteed run
      // failure (readiness/routing contract).
      const readOnlyIntents = ["plan", "spec", "review", "verify", "compare", "synthesize", "explain", "audit"];
      const enabled = apiSmoke.ok ? allIntents : nativeAuthed ? readOnlyIntents : [];
      const ok = nativeAuthed || apiSmoke.ok;
      return ConformanceReportSchema.parse({
        harness_id: "cursor",
        status: ok ? "ok" : apiKey ? "degraded" : "unavailable",
        checks: [
          { id: "installed", status: "pass", detail: version },
          { id: "auth", status: nativeAuthed ? "pass" : "fail" },
          { id: "stored_key", status: apiKey ? "pass" : "fail", detail: apiKey ? "cursor secret/env available" : "no cursor key fallback (write/envelope intents disabled)" },
          { id: "isolated_api_smoke", status: apiSmoke.ok ? "pass" : apiKey ? "fail" : "skip", detail: apiSmoke.detail },
        ],
        enabled_intents: enabled,
        disabled_intents: allIntents.filter((i) => !enabled.includes(i)),
        reasons: ok
          ? apiSmoke.ok
            ? []
            : ["native session only: isolated envelope (write) intents need a passing Cursor API-key smoke"]
          : apiKey
            ? [`cursor key present but route unproven: ${apiSmoke.detail}`]
            : ["not authenticated (cursor-agent login or set CURSOR_API_KEY)"],
      });
    },

    run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runCursor(spec);
    },

    review(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runCursor(spec);
    },
  };
}

async function* runCursor(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
  if (spec.access === "full" || spec.access === "external_sandbox_full") {
    yield { type: "error", session_id: spec.session_id, ts: nowIso(), error: "cursor full access is not conformance-proven; use workspace_write or another harness" };
    yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
    return;
  }
  const args = ["-p", "--output-format", "stream-json", ...accessArgs(spec.access)];
  if (spec.model_hint) args.push("--model", spec.model_hint);
  // Resume the thread's native cursor chat as a follow-up turn.
  if (spec.resume_session_id) args.push("--resume", spec.resume_session_id);
  args.push(spec.prompt);
  const key = cursorApiKey();
  // Unified provider scrub (cross-provider leak fix); the chosen route re-adds
  // ONLY its own variable below.
  const env: Record<string, string | null | undefined> = {
    ...spec.env,
    ...providerScrubEnv(),
  };
  // Envelope runs use a scoped HOME where the native cursor session is
  // unreachable, so the native-auth probe (which runs against the REAL home)
  // must not be trusted for them: inside an envelope a key is required.
  const scopedHome = Boolean(spec.env?.["HOME"]);
  const preferApi = spec.auth_preference === "api_key";
  if (scopedHome) {
    const scopedHomePath = spec.env?.["HOME"];
    if (scopedHomePath && needsScopedHomeKeychainBridge(CURSOR_CAPABILITY_PROFILE)) bridgeMacLoginKeychain(scopedHomePath);
    const nativeAuthed = await nativeAuthOk(env);
    const preferSubscription = spec.auth_preference === "subscription";
    // Scoped homes are precisely where native Cursor keychain state is brittle.
    // Prefer the smoke-proven API-key transport whenever available unless the
    // caller explicitly requested subscription/native routing.
    if (!preferSubscription && key) {
      env.CURSOR_API_KEY = key;
    } else if (preferApi && !key && nativeAuthed) {
      env.CURSOR_API_KEY = null;
      yield {
        type: "message",
        session_id: spec.session_id,
        ts: nowIso(),
        text: "[auth] api_key route unavailable (no key); fell back to subscription",
        payload: { auth_switched: true, from_auth_mode: "api_key", to_auth_mode: "local_session" },
      };
    } else if (nativeAuthed) {
      env.CURSOR_API_KEY = null;
    } else if (key) {
      env.CURSOR_API_KEY = key;
      if (spec.auth_preference === "subscription") {
        yield {
          type: "message",
          session_id: spec.session_id,
          ts: nowIso(),
          text: "[auth] subscription route unavailable (not logged in); fell back to api_key",
          payload: { auth_switched: true, from_auth_mode: "local_session", to_auth_mode: "api_key" },
        };
      }
    } else {
      yield {
        type: "error",
        session_id: spec.session_id,
        ts: nowIso(),
        error: "scoped Cursor HOME requires either a bridged native session or a stored Cursor API key fallback",
      };
      yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
      return;
    }
  } else {
    const nativeAuthed = await nativeAuthOk();
    // An EXPLICIT auth preference is honored; an unfulfillable one falls back
    // with a typed disclosure (never silent).
    if (preferApi && key) {
      env.CURSOR_API_KEY = key;
    } else if (preferApi && !key && nativeAuthed) {
      env.CURSOR_API_KEY = null;
      yield {
        type: "message",
        session_id: spec.session_id,
        ts: nowIso(),
        text: "[auth] api_key route unavailable (no key); fell back to subscription",
        payload: { auth_switched: true, from_auth_mode: "api_key", to_auth_mode: "local_session" },
      };
    } else if (nativeAuthed) {
      env.CURSOR_API_KEY = null;
      if (spec.auth_preference === "subscription") {
        // honored — nothing to disclose
      }
    } else if (key) {
      env.CURSOR_API_KEY = key;
      if (spec.auth_preference === "subscription") {
        yield {
          type: "message",
          session_id: spec.session_id,
          ts: nowIso(),
          text: "[auth] subscription route unavailable (not logged in); fell back to api_key",
          payload: { auth_switched: true, from_auth_mode: "local_session", to_auth_mode: "api_key" },
        };
      }
    }
  }

  yield* runCliHarness({
    bin: BIN,
    args,
    spec,
    env,
    label: "cursor-agent",
    redact: redactSecrets,
    parseEvent: createCursorParser(),
  });
}
