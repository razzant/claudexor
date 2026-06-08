import type { AccessProfile, ConformanceReport, HarnessEvent, HarnessManifest, HarnessRunSpec } from "@claudex/schema";
import { ConformanceReport as ConformanceReportSchema, HarnessManifest as HarnessManifestSchema } from "@claudex/schema";
import type { DoctorSpec, HarnessAdapter } from "@claudex/core";
import { HarnessUnavailableError, runCapture, spawnProcess } from "@claudex/core";
import { resolveSecret } from "@claudex/secrets";
import { nowIso } from "@claudex/util";
import { parseOpenCodeEvent } from "./parse.js";

const BIN = process.env.CLAUDEX_OPENCODE_BIN || "opencode";

function accessArgs(access: AccessProfile): string[] {
  switch (access) {
    case "workspace_write":
    case "full":
    case "external_sandbox_full":
      return ["--dangerously-skip-permissions"];
    case "readonly":
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
        throw new HarnessUnavailableError("opencode not found on PATH (set CLAUDEX_OPENCODE_BIN)");
      }
      const authReady = providerKeyAvailable();
      return HarnessManifestSchema.parse({
        id: "opencode",
        display_name: "OpenCode",
        kind: "local_cli",
        version,
        adapter_version: "0.4.0",
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
          resume: false,
          cancel: false,
          mcp: true,
          plugins: true,
          worktree_native: false,
          quota_signal: "observed",
          usage_signal: "observed",
        },
        capability_profile: {
          execution_surfaces: [{ kind: "cli_one_shot", input: "prompt_arg", output: "json", event_schema: "native" }],
          session: { resume_latest: false, resume_by_id: false },
          output: { final_json: true, file_changes: false, json_schema_final: false, usage_signal: "observed", cost_signal: "observed" },
          auth: { supported_sources: ["api_key_env"], preferred_source: authReady ? "api_key_env" : null, probe_command: [], env_vars: [...PROVIDER_KEY_ENV] },
          access_control: { readonly: false, workspace_write: true, full: true, mechanism: "opencode permissions not yet conformance-proven" },
        },
        auth_modes: authReady ? ["api_key"] : [],
        access_profiles_supported: ["workspace_write", "full", "inherit_native"],
        models: { discovery: "available" },
      });
    },

    async doctor(_spec: DoctorSpec): Promise<ConformanceReport> {
      const version = await detectVersion();
      if (version === null) {
        return ConformanceReportSchema.parse({
          harness_id: "opencode",
          status: "unavailable",
          checks: [{ id: "installed", status: "fail", detail: "opencode not found" }],
          reasons: ["opencode not found (install OpenCode or set CLAUDEX_OPENCODE_BIN)"],
        });
      }
      const authReady = providerKeyAvailable();
      return ConformanceReportSchema.parse({
        harness_id: "opencode",
        status: authReady ? "ok" : "degraded",
        checks: [
          { id: "installed", status: "pass", detail: version },
          { id: "provider_auth", status: authReady ? "pass" : "fail" },
          { id: "readonly_conformance", status: "skip", detail: "readonly not proven for opencode adapter yet" },
        ],
        enabled_intents: authReady ? ["implement", "repair", "create_from_scratch", "verify", "compare", "synthesize"] : [],
        disabled_intents: authReady ? ["explain", "audit"] : ["implement", "repair", "create_from_scratch", "verify", "compare", "synthesize", "explain", "audit"],
        reasons: authReady ? ["readonly/audit not enabled until conformance-proven"] : ["opencode provider auth not configured"],
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
  const args = ["run", "--format", "json", ...accessArgs(spec.access)];
  if (spec.model_hint) args.push("--model", spec.model_hint);
  args.push(spec.prompt);
  const env: Record<string, string | null | undefined> = { ...spec.env };
  const key = providerKey(spec.env);
  for (const envVar of PROVIDER_KEY_ENV) env[envVar] = key?.envVar === envVar ? key.value : null;

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
        for (const out of parseOpenCodeEvent(obj, spec.session_id)) {
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
    yield { type: "error", session_id: spec.session_id, ts: nowIso(), error: `opencode exited with code ${exitCode}` };
  }
  yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
}
