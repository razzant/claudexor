import type { AccessProfile, ConformanceReport, HarnessEvent, HarnessManifest, HarnessRunSpec } from "@claudexor/schema";
import { ConformanceReport as ConformanceReportSchema, HarnessManifest as HarnessManifestSchema } from "@claudexor/schema";
import type { DoctorSpec, HarnessAdapter } from "@claudexor/core";
import { HarnessUnavailableError, providerScrubEnv, runCapture, runCliHarness } from "@claudexor/core";
import { resolveSecret } from "@claudexor/secrets";
import { nowIso, redactSecrets } from "@claudexor/util";
import { createCursorParser } from "./parse.js";

const BIN = process.env.CLAUDEXOR_CURSOR_BIN || "cursor-agent";

function accessArgs(access: AccessProfile): string[] {
  switch (access) {
    case "readonly":
      return ["--mode", "plan", "--trust"];
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

async function nativeAuthOk(): Promise<boolean> {
  try {
    const r = await runCapture(BIN, ["status"], { timeoutMs: 10_000 });
    return r.code === 0;
  } catch {
    return false;
  }
}

function cursorApiKey(): string | null {
  return process.env.CLAUDEXOR_CURSOR_API_KEY || resolveSecret("cursor") || process.env.CURSOR_API_KEY || null;
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
        adapter_version: "0.9.0",
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
          plugins: true,
          worktree_native: true,
          web_policy: "uncontrolled",
          quota_signal: "observed",
          usage_signal: "observed",
        },
        capability_profile: {
          execution_surfaces: [{ kind: "cli_one_shot", input: "prompt_arg", output: "ndjson", event_schema: "native" }],
          session: { native_session_id_emitted: true, resume_latest: true, resume_by_id: true },
          output: { ndjson_events: true, tool_lifecycle: true, file_changes: true, final_json: false, json_schema_final: false, usage_signal: "observed", cost_signal: "observed" },
          auth: { supported_sources: ["native_session", "api_key_env", "api_key_flag"], preferred_source: nativeAuthed ? "native_session" : apiKey ? "api_key_env" : null, probe_command: ["cursor-agent", "status"], env_vars: ["CURSOR_API_KEY"] },
          access_control: { readonly: true, workspace_write: true, full: false, mechanism: "cursor-agent flags (feature-probed)" },
        },
        // Source AVAILABILITY truth: each mode is listed only when its source
        // actually exists right now (a native session does not imply a key).
        auth_modes: [...(nativeAuthed ? ["local_session" as const] : []), ...(apiKey ? ["api_key" as const] : [])],
        access_profiles_supported: ["readonly", "workspace_write", "inherit_native"],
        models: { discovery: "available" },
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
      // Readiness doctrine: a key string alone is source availability, not
      // proven readiness. Only a passing native session probe yields "ok";
      // key-only setups are degraded until an isolated smoke exists for cursor.
      const allIntents = ["plan", "spec", "implement", "repair", "create_from_scratch", "review", "verify", "compare", "synthesize", "explain", "audit"];
      // Write-class intents run in isolated envelopes with a scoped HOME where
      // the native cursor session is unreachable — they REQUIRE the key
      // fallback. Native-only auth honestly enables only the non-envelope
      // (read-only) intents so doctor-ok can never precede a guaranteed run
      // failure (readiness/routing contract).
      const readOnlyIntents = ["plan", "spec", "review", "verify", "compare", "synthesize", "explain", "audit"];
      const enabled = nativeAuthed ? (apiKey ? allIntents : readOnlyIntents) : [];
      return ConformanceReportSchema.parse({
        harness_id: "cursor",
        status: nativeAuthed ? "ok" : apiKey ? "degraded" : "unavailable",
        checks: [
          { id: "installed", status: "pass", detail: version },
          { id: "auth", status: nativeAuthed ? "pass" : "fail" },
          { id: "stored_key", status: apiKey ? "pass" : "fail", detail: apiKey ? "cursor secret/env available (unproven without isolated smoke)" : "no cursor key fallback (write/envelope intents disabled)" },
        ],
        enabled_intents: enabled,
        disabled_intents: allIntents.filter((i) => !enabled.includes(i)),
        reasons: nativeAuthed
          ? apiKey
            ? []
            : ["native session only: isolated envelope (write) intents need a stored Cursor API key fallback"]
          : apiKey
            ? ["cursor key present but unproven: no isolated smoke exists for cursor key-only auth"]
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
    if (!key) {
      yield {
        type: "error",
        session_id: spec.session_id,
        ts: nowIso(),
        error: "isolated envelope HOME requires a stored Cursor API key fallback; the native cursor session cannot be reused inside this envelope",
      };
      yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
      return;
    }
    env.CURSOR_API_KEY = key;
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
