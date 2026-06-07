import type { AccessProfile, ConformanceReport, HarnessEvent, HarnessManifest, HarnessRunSpec } from "@claudex/schema";
import { ConformanceReport as ConformanceReportSchema, HarnessManifest as HarnessManifestSchema } from "@claudex/schema";
import type { DoctorSpec, HarnessAdapter } from "@claudex/core";
import { HarnessUnavailableError, runCapture, spawnProcess } from "@claudex/core";
import { nowIso } from "@claudex/util";
import { parseClaudeEvent } from "./parse.js";

const BIN = process.env.CLAUDEX_CLAUDE_BIN || "claude";

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
    const r = await runCapture(BIN, ["auth", "status"], { timeoutMs: 10_000 });
    return r.code === 0;
  } catch {
    return false;
  }
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
      const authed = await authStatusOk();
      return HarnessManifestSchema.parse({
        id: "claude",
        display_name: "Claude Code",
        kind: "local_cli",
        version,
        adapter_version: "0.3.0",
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
          json_schema_output: true,
          resume: true,
          cancel: false,
          mcp: true,
          plugins: true,
          worktree_native: true,
          quota_signal: "observed",
          usage_signal: "exact",
        },
        auth_modes: authed ? ["local_session", "api_key"] : ["api_key"],
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
      const authed = await authStatusOk();
      return ConformanceReportSchema.parse({
        harness_id: "claude",
        status: authed ? "ok" : "degraded",
        checks: [
          { id: "installed", status: "pass", detail: version },
          { id: "auth", status: authed ? "pass" : "fail" },
        ],
        enabled_intents: authed
          ? ["plan", "spec", "implement", "repair", "create_from_scratch", "review", "verify", "compare", "arbitrate", "synthesize", "benchmark", "explain", "audit"]
          : ["explain", "audit"],
        disabled_intents: authed ? [] : ["implement", "review", "arbitrate"],
        reasons: authed ? [] : ["not authenticated (run `claude /login` or set ANTHROPIC_API_KEY)"],
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

async function* runClaude(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
  const args = ["-p", spec.prompt, "--output-format", "stream-json", "--verbose", ...permissionArgs(spec.access)];
  if (spec.model_hint) args.push("--model", spec.model_hint);
  if (spec.extra?.["bare"] === true) args.push("--bare");

  let sawError = false;
  let exitCode: number | null = null;
  try {
    for await (const ev of spawnProcess(BIN, args, { cwd: spec.cwd, env: spec.env })) {
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
