import type { AccessProfile, ConformanceReport, HarnessEvent, HarnessManifest, HarnessRunSpec } from "@claudex/schema";
import { ConformanceReport as ConformanceReportSchema, HarnessManifest as HarnessManifestSchema } from "@claudex/schema";
import type { DoctorSpec, HarnessAdapter } from "@claudex/core";
import { HarnessUnavailableError, runCapture, spawnProcess } from "@claudex/core";
import { resolveSecret } from "@claudex/secrets";
import { nowIso } from "@claudex/util";
import { parseClaudeEvent } from "./parse.js";

const BIN = process.env.CLAUDEX_CLAUDE_BIN || "claude";
const CLAUDE_PROVIDER_ENV_DENYLIST = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
];

function permissionArgs(access: AccessProfile): string[] {
  switch (access) {
    case "readonly":
      return ["--permission-mode", "plan"];
    case "workspace_write":
      return ["--permission-mode", "acceptEdits"];
    case "full":
    case "external_sandbox_full":
      return ["--permission-mode", "bypassPermissions"];
    case "inherit_native":
      return [];
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

async function authStatusOk(): Promise<boolean> {
  try {
    const env = Object.fromEntries(CLAUDE_PROVIDER_ENV_DENYLIST.map((name) => [name, null]));
    const r = await runCapture(BIN, ["auth", "status"], { env, timeoutMs: 10_000 });
    return r.code === 0;
  } catch {
    return false;
  }
}

function anthropicApiKey(): string | null {
  return process.env.CLAUDEX_ANTHROPIC_API_KEY || resolveSecret("anthropic") || process.env.ANTHROPIC_API_KEY || null;
}

export function createClaudeAdapter(): HarnessAdapter {
  return {
    id: "claude",

    async discover(): Promise<HarnessManifest> {
      const version = await detectVersion();
      if (version === null) {
        throw new HarnessUnavailableError(
          "claude CLI not found on PATH (set CLAUDEX_CLAUDE_BIN to override)",
        );
      }
      const apiKey = anthropicApiKey() !== null;
      const authed = await authStatusOk();
      return HarnessManifestSchema.parse({
        id: "claude",
        display_name: "Claude Code",
        kind: "local_cli",
        version,
        adapter_version: "0.4.1",
        provider_family: "anthropic",
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
          usage_signal: "exact",
        },
        capability_profile: {
          execution_surfaces: [{ kind: "cli_one_shot", input: "prompt_arg", output: "ndjson", event_schema: "native" }],
          session: { resume_latest: false, resume_by_id: false },
          output: { ndjson_events: true, partial_deltas: true, tool_lifecycle: true, final_json: false, json_schema_final: false, usage_signal: "exact", cost_signal: "exact" },
          auth: { supported_sources: ["native_session", "api_key_env"], preferred_source: apiKey ? "api_key_env" : authed ? "native_session" : null, probe_command: ["claude", "auth", "status"], env_vars: ["ANTHROPIC_API_KEY"] },
          access_control: { readonly: true, workspace_write: true, full: true, mechanism: "claude --permission-mode" },
        },
        auth_modes: authed ? ["local_session", "api_key"] : apiKey ? ["api_key"] : [],
        access_profiles_supported: ["readonly", "workspace_write", "full", "inherit_native"],
        models: { discovery: "available" },
      });
    },

    async doctor(_spec: DoctorSpec): Promise<ConformanceReport> {
      const version = await detectVersion();
      if (version === null) {
        return ConformanceReportSchema.parse({
          harness_id: "claude",
          status: "unavailable",
          checks: [{ id: "installed", status: "fail", detail: "claude not found on PATH" }],
          reasons: ["claude CLI not found (install Claude Code or set CLAUDEX_CLAUDE_BIN)"],
        });
      }
      const apiKey = anthropicApiKey() !== null;
      const authed = await authStatusOk();
      const ok = apiKey;
      return ConformanceReportSchema.parse({
        harness_id: "claude",
        status: ok ? "ok" : "degraded",
        checks: [
          { id: "installed", status: "pass", detail: version },
          { id: "auth", status: authed ? "pass" : "fail" },
          { id: "stored_key", status: apiKey ? "pass" : "fail", detail: apiKey ? "anthropic secret/env available" : "isolated Claudex envelopes require an anthropic key fallback" },
        ],
        enabled_intents: ok
          ? ["plan", "spec", "implement", "repair", "create_from_scratch", "review", "verify", "compare", "arbitrate", "synthesize", "benchmark", "explain", "audit"]
          : [],
        disabled_intents: ok ? [] : ["implement", "review", "arbitrate"],
        reasons: ok
          ? []
          : authed
            ? ["native Claude login is present, but isolated Claudex runs require a stored anthropic API key fallback"]
            : ["not authenticated (run `claude /login` for native use or store anthropic API key fallback for Claudex runs)"],
      });
    },

    run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runClaude(spec);
    },

    review(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runClaude(spec);
    },
  };
}

export function claudeArgsForSpec(spec: HarnessRunSpec): string[] {
  const args = ["-p", spec.prompt, "--output-format", "stream-json", "--verbose", ...permissionArgs(spec.access)];
  if (spec.model_hint) args.push("--model", spec.model_hint);
  if (spec.effort_hint) args.push("--effort", spec.effort_hint);
  if (spec.extra?.["bare"] === true) args.push("--bare");
  return args;
}

async function* runClaude(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
  const args = claudeArgsForSpec(spec);
  const nativeAuthed = await authStatusOk();
  const key = anthropicApiKey();
  const scopedConfigNeedsAuth = Boolean(spec.env?.["CLAUDE_CONFIG_DIR"]);
  if (scopedConfigNeedsAuth && !key) {
    yield {
      type: "error",
      session_id: spec.session_id,
      ts: nowIso(),
      error: "isolated CLAUDE_CONFIG_DIR requires a stored Anthropic API key fallback; native Claude login cannot be reused inside this envelope",
    };
    yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
    return;
  }
  const env: Record<string, string | null | undefined> = { ...spec.env };
  for (const name of CLAUDE_PROVIDER_ENV_DENYLIST) env[name] = null;
  if ((!nativeAuthed || scopedConfigNeedsAuth) && key) env.ANTHROPIC_API_KEY = key;

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
        for (const out of parseClaudeEvent(obj, spec.session_id)) {
          if (out.type === "error") sawError = true;
          yield out;
        }
      } else if (ev.type === "exit") {
        exitCode = ev.code;
      }
    }
  } catch (err) {
    yield {
      type: "error",
      session_id: spec.session_id,
      ts: nowIso(),
      error: err instanceof Error ? err.message : String(err),
    };
    return;
  }
  if (exitCode !== null && exitCode !== 0 && !sawError) {
    yield {
      type: "error",
      session_id: spec.session_id,
      ts: nowIso(),
      error: `claude exited with code ${exitCode}`,
    };
  }
  yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
}
