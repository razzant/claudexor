import type { AccessProfile, ConformanceReport, HarnessEvent, HarnessManifest, HarnessRunSpec } from "@claudex/schema";
import { ConformanceReport as ConformanceReportSchema, HarnessManifest as HarnessManifestSchema } from "@claudex/schema";
import type { DoctorSpec, HarnessAdapter } from "@claudex/core";
import { HarnessUnavailableError, runCapture, spawnProcess } from "@claudex/core";
import { resolveSecret } from "@claudex/secrets";
import { nowIso } from "@claudex/util";
import { parseCursorEvent } from "./parse.js";

const BIN = process.env.CLAUDEX_CURSOR_BIN || "cursor-agent";

function accessArgs(access: AccessProfile): string[] {
  switch (access) {
    case "readonly":
      return ["--mode", "plan", "--trust"];
    case "workspace_write":
      return ["--force", "--trust"];
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

async function authOk(): Promise<boolean> {
  if (cursorApiKey()) return true;
  try {
    const r = await runCapture(BIN, ["status"], { timeoutMs: 10_000 });
    return r.code === 0;
  } catch {
    return false;
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
  return process.env.CLAUDEX_CURSOR_API_KEY || resolveSecret("cursor") || process.env.CURSOR_API_KEY || null;
}

export function createCursorAdapter(): HarnessAdapter {
  return {
    id: "cursor",

    async discover(): Promise<HarnessManifest> {
      const version = await detectVersion();
      if (version === null) {
        throw new HarnessUnavailableError("cursor-agent not found on PATH (set CLAUDEX_CURSOR_BIN)");
      }
      const authed = await authOk();
      const nativeAuthed = await nativeAuthOk();
      const apiKey = cursorApiKey() !== null;
      return HarnessManifestSchema.parse({
        id: "cursor",
        display_name: "Cursor CLI",
        kind: "local_cli",
        version,
        adapter_version: "0.4.0",
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
          resume: false,
          cancel: false,
          mcp: true,
          plugins: true,
          worktree_native: true,
          quota_signal: "observed",
          usage_signal: "observed",
        },
        capability_profile: {
          execution_surfaces: [{ kind: "cli_one_shot", input: "prompt_arg", output: "ndjson", event_schema: "native" }],
          session: { resume_latest: false, resume_by_id: false },
          output: { ndjson_events: true, tool_lifecycle: true, file_changes: true, final_json: false, json_schema_final: false, usage_signal: "observed", cost_signal: "observed" },
          auth: { supported_sources: ["native_session", "api_key_env", "api_key_flag"], preferred_source: nativeAuthed ? "native_session" : apiKey ? "api_key_env" : null, probe_command: ["cursor-agent", "status"], env_vars: ["CURSOR_API_KEY"] },
          access_control: { readonly: true, workspace_write: true, full: false, mechanism: "cursor-agent flags (feature-probed)" },
        },
        auth_modes: nativeAuthed ? ["local_session", "api_key"] : apiKey ? ["api_key"] : [],
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
          reasons: ["cursor-agent not found (install Cursor CLI or set CLAUDEX_CURSOR_BIN)"],
        });
      }
      const authed = await authOk();
      const nativeAuthed = await nativeAuthOk();
      const apiKey = cursorApiKey() !== null;
      return ConformanceReportSchema.parse({
        harness_id: "cursor",
        status: authed ? "ok" : "degraded",
        checks: [
          { id: "installed", status: "pass", detail: version },
          { id: "auth", status: nativeAuthed ? "pass" : "fail" },
          { id: "stored_key", status: apiKey ? "pass" : "fail", detail: apiKey ? "cursor secret/env available" : "no cursor key fallback" },
        ],
        enabled_intents: authed
          ? ["plan", "spec", "implement", "repair", "create_from_scratch", "review", "verify", "compare", "synthesize", "explain", "audit"]
          : [],
        disabled_intents: authed ? [] : ["implement", "review", "arbitrate"],
        reasons: authed ? [] : ["not authenticated (cursor-agent login or set CURSOR_API_KEY)"],
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
    return;
  }
  const args = ["-p", "--output-format", "stream-json", ...accessArgs(spec.access)];
  if (spec.model_hint) args.push("--model", spec.model_hint);
  args.push(spec.prompt);
  const nativeAuthed = await nativeAuthOk();
  const key = cursorApiKey();
  const env: Record<string, string | null | undefined> = { ...spec.env };
  if (nativeAuthed) env.CURSOR_API_KEY = null;
  else if (key) env.CURSOR_API_KEY = key;

  let sawError = false;
  let exitCode: number | null = null;
  try {
    for await (const ev of spawnProcess(BIN, args, { cwd: spec.cwd, env })) {
      if (ev.type === "stdout") {
        let obj: unknown;
        try {
          obj = JSON.parse(ev.line);
        } catch {
          continue;
        }
        for (const out of parseCursorEvent(obj, spec.session_id)) {
          if (out.type === "error") sawError = true;
          yield out;
        }
      } else if (ev.type === "exit") {
        exitCode = ev.code;
      }
    }
  } catch (err) {
    yield { type: "error", session_id: spec.session_id, ts: nowIso(), error: err instanceof Error ? err.message : String(err) };
    return;
  }
  if (exitCode !== null && exitCode !== 0 && !sawError) {
    yield { type: "error", session_id: spec.session_id, ts: nowIso(), error: `cursor-agent exited with code ${exitCode}` };
  }
  yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
}
