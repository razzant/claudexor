import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AccessProfile, ConformanceReport, HarnessEvent, HarnessManifest, HarnessRunSpec } from "@claudexor/schema";
import { ConformanceReport as ConformanceReportSchema, HarnessManifest as HarnessManifestSchema } from "@claudexor/schema";
import type { DoctorSpec, HarnessAdapter } from "@claudexor/core";
import { HarnessUnavailableError, runCapture, runCliHarness } from "@claudexor/core";
import { resolveSecret } from "@claudexor/secrets";
import { nowIso, redactSecrets } from "@claudexor/util";
import { createClaudeParser } from "./parse.js";

const BIN = process.env.CLAUDEXOR_CLAUDE_BIN || "claude";
const CLAUDE_PROVIDER_ENV_DENYLIST = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  // An inherited base-URL override could redirect traffic that carries the injected key.
  "ANTHROPIC_BASE_URL",
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
  return process.env.CLAUDEXOR_ANTHROPIC_API_KEY || resolveSecret("anthropic") || process.env.ANTHROPIC_API_KEY || null;
}

async function smokeIsolatedApiKey(): Promise<{ ok: boolean; detail: string }> {
  const key = anthropicApiKey();
  if (!key) return { ok: false, detail: "no API key fallback available" };
  const dir = mkdtempSync(`${tmpdir()}/claudexor-claude-smoke-`);
  try {
    const env: Record<string, string | null | undefined> = Object.fromEntries(CLAUDE_PROVIDER_ENV_DENYLIST.map((name) => [name, null]));
    env.HOME = dir;
    env.XDG_CONFIG_HOME = `${dir}/.config`;
    env.CLAUDE_CONFIG_DIR = dir;
    env.ANTHROPIC_API_KEY = key;
    const r = await runCapture(
      BIN,
      ["-p", "Reply exactly OK", "--output-format", "stream-json", "--verbose", "--permission-mode", "plan"],
      { cwd: dir, env, timeoutMs: 60_000 },
    );
    const text = `${r.stdout}\n${r.stderr}`;
    if (r.code === 0 && text.includes("OK")) return { ok: true, detail: "isolated CLAUDE_CONFIG_DIR smoke passed" };
    return { ok: false, detail: redactClaudeDoctorDetail(text || `claude exited with code ${r.code}`) };
  } catch (err) {
    return { ok: false, detail: redactClaudeDoctorDetail(err instanceof Error ? err.message : String(err)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function redactClaudeDoctorDetail(text: string): string {
  return redactSecrets(text).slice(0, 500);
}

export function createClaudeAdapter(): HarnessAdapter {
  return {
    id: "claude",

    async discover(): Promise<HarnessManifest> {
      const version = await detectVersion();
      if (version === null) {
        throw new HarnessUnavailableError(
          "claude CLI not found on PATH (set CLAUDEXOR_CLAUDE_BIN to override)",
        );
      }
      const apiKey = anthropicApiKey() !== null;
      const authed = await authStatusOk();
      const authModes = [
        ...(authed ? ["local_session"] : []),
        ...(apiKey ? ["api_key"] : []),
      ];
      return HarnessManifestSchema.parse({
        id: "claude",
        display_name: "Claude Code",
        kind: "local_cli",
        version,
        adapter_version: "0.6.0",
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
          cancel: true,
          mcp: true,
          plugins: true,
          worktree_native: true,
          web_policy: "tools",
          quota_signal: "observed",
          usage_signal: "exact",
        },
        capability_profile: {
          execution_surfaces: [
            { kind: "cli_one_shot", input: "prompt_arg", output: "ndjson", event_schema: "native", supports_interrupt: true },
          ],
          session: { resume_latest: false, resume_by_id: false },
          output: { ndjson_events: true, partial_deltas: true, tool_lifecycle: true, final_json: false, json_schema_final: false, usage_signal: "exact", cost_signal: "exact" },
          auth: { supported_sources: ["native_session", "api_key_env"], preferred_source: apiKey ? "api_key_env" : authed ? "native_session" : null, probe_command: ["claude", "auth", "status"], env_vars: ["ANTHROPIC_API_KEY"] },
          access_control: { readonly: true, workspace_write: true, full: true, mechanism: "claude --permission-mode" },
        },
        auth_modes: authModes,
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
          reasons: ["claude CLI not found (install Claude Code or set CLAUDEXOR_CLAUDE_BIN)"],
        });
      }
      const apiKey = anthropicApiKey() !== null;
      const authed = await authStatusOk();
      const smoke = apiKey ? await smokeIsolatedApiKey() : { ok: false, detail: "no API key fallback available" };
      const ok = smoke.ok;
      const allIntents = ["plan", "spec", "implement", "repair", "create_from_scratch", "review", "verify", "compare", "arbitrate", "synthesize", "explain", "audit"];
      return ConformanceReportSchema.parse({
        harness_id: "claude",
        status: ok ? "ok" : authed || apiKey ? "degraded" : "unavailable",
        checks: [
          { id: "installed", status: "pass", detail: version },
          { id: "auth", status: authed ? "pass" : "fail" },
          { id: "stored_key", status: apiKey ? "pass" : "fail", detail: apiKey ? "anthropic secret/env available" : "isolated Claudexor envelopes require an anthropic key fallback" },
          { id: "isolated_api_smoke", status: smoke.ok ? "pass" : "fail", detail: smoke.detail },
        ],
        enabled_intents: ok ? allIntents : [],
        disabled_intents: ok ? [] : allIntents,
        reasons: ok
          ? []
          : authed || apiKey
            ? [`isolated Claude API-key smoke failed: ${smoke.detail}`]
            : ["not authenticated (run `claude /login` for native use or store anthropic API key fallback for Claudexor runs)"],
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

/** Claude's native names for web-permissioned tools. This knowledge lives ONLY in the adapter. */
const CLAUDE_WEB_TOOLS = ["WebSearch", "WebFetch"];

export function claudeArgsForSpec(spec: HarnessRunSpec): string[] {
  const args = ["-p", spec.prompt, "--output-format", "stream-json", "--verbose", ...permissionArgs(spec.access)];
  if (spec.model_hint) args.push("--model", spec.model_hint);
  if (spec.effort_hint) args.push("--effort", spec.effort_hint);
  if (spec.max_turns !== null && spec.max_turns > 0) args.push("--max-turns", String(spec.max_turns));
  args.push(...toolPermissionArgs(spec));
  if (spec.extra?.["bare"] === true) args.push("--bare");
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
  const policy = spec.external_context_policy;
  const allow = new Set(spec.tool_permission_policy.allow);
  const deny = new Set(spec.tool_permission_policy.deny);
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
  const args: string[] = [];
  if (allow.size > 0) args.push("--allowedTools", [...allow].join(","));
  if (deny.size > 0) args.push("--disallowedTools", [...deny].join(","));
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

  yield* runCliHarness({
    bin: BIN,
    args,
    spec,
    env,
    label: "claude",
    redact: redactSecrets,
    parseEvent: createClaudeParser(),
  });
}
