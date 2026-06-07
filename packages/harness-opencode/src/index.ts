import type { AccessProfile, ConformanceReport, HarnessEvent, HarnessManifest, HarnessRunSpec } from "@claudex/schema";
import { ConformanceReport as ConformanceReportSchema, HarnessManifest as HarnessManifestSchema } from "@claudex/schema";
import type { DoctorSpec, HarnessAdapter } from "@claudex/core";
import { HarnessUnavailableError, runCapture, spawnProcess } from "@claudex/core";
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

export function createOpenCodeAdapter(): HarnessAdapter {
  return {
    id: "opencode",

    async discover(): Promise<HarnessManifest> {
      const version = await detectVersion();
      if (version === null) {
        throw new HarnessUnavailableError("opencode not found on PATH (set CLAUDEX_OPENCODE_BIN)");
      }
      return HarnessManifestSchema.parse({
        id: "opencode",
        display_name: "OpenCode",
        kind: "local_cli",
        version,
        adapter_version: "0.3.0",
        provider_family: "opencode",
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
          worktree_native: false,
          quota_signal: "observed",
          usage_signal: "observed",
        },
        auth_modes: ["local_session", "api_key"],
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
      return ConformanceReportSchema.parse({
        harness_id: "opencode",
        status: "ok",
        checks: [{ id: "installed", status: "pass", detail: version }],
          enabled_intents: ["implement", "repair", "create_from_scratch", "verify", "compare", "synthesize"],
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
