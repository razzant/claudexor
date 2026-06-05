import type { AccessProfile, ConformanceReport, HarnessEvent, HarnessManifest, HarnessRunSpec } from "@claudex/schema";
import { ConformanceReport as ConformanceReportSchema, HarnessManifest as HarnessManifestSchema } from "@claudex/schema";
import type { DoctorSpec, HarnessAdapter } from "@claudex/core";
import { HarnessUnavailableError, runCapture, spawnProcess } from "@claudex/core";
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
  if (process.env.CURSOR_API_KEY) return true;
  try {
    const r = await runCapture(BIN, ["status"], { timeoutMs: 10_000 });
    return r.code === 0;
  } catch {
    return false;
  }
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
      return HarnessManifestSchema.parse({
        id: "cursor",
        display_name: "Cursor CLI",
        kind: "local_cli",
        version,
        adapter_version: "0.1.0",
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
          quota_signal: "observed",
          usage_signal: "observed",
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
          harness_id: "cursor",
          status: "unavailable",
          checks: [{ id: "installed", status: "fail", detail: "cursor-agent not found" }],
          reasons: ["cursor-agent not found (install Cursor CLI or set CLAUDEX_CURSOR_BIN)"],
        });
      }
      const authed = await authOk();
      return ConformanceReportSchema.parse({
        harness_id: "cursor",
        status: authed ? "ok" : "degraded",
        checks: [
          { id: "installed", status: "pass", detail: version },
          { id: "auth", status: authed ? "pass" : "fail" },
        ],
        enabled_intents: authed
          ? ["plan", "spec", "implement", "repair", "create_from_scratch", "review", "verify", "compare", "synthesize", "explain", "audit"]
          : ["explain", "audit"],
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
  const args = ["-p", "--output-format", "stream-json", ...accessArgs(spec.access)];
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
