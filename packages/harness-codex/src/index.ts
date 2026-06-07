import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AccessProfile, ConformanceReport, HarnessEvent, HarnessManifest, HarnessRunSpec } from "@claudex/schema";
import { ConformanceReport as ConformanceReportSchema, HarnessManifest as HarnessManifestSchema } from "@claudex/schema";
import type { DoctorSpec, HarnessAdapter } from "@claudex/core";
import { HarnessUnavailableError, runCapture, spawnProcess } from "@claudex/core";
import { nowIso } from "@claudex/util";
import { parseCodexEvent } from "./parse.js";
import { estimateCodexCostUsd } from "./pricing.js";

const BIN = process.env.CLAUDEX_CODEX_BIN || "codex";

/**
 * Resolve an OpenAI API key for codex from the environment. Claudex-managed
 * `api_key` auth mirrors the harness's own variable (`OPENAI_API_KEY`); a
 * dedicated `CLAUDEX_CODEX_API_KEY` can override it for multi-key setups.
 */
function codexApiKey(): string | undefined {
  return process.env.CLAUDEX_CODEX_API_KEY || process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY;
}

/**
 * Seed `api_key` auth into an isolated CODEX_HOME. Codex does not read
 * `OPENAI_API_KEY` from the environment when run against an empty config dir
 * (it requires `auth.json`), so an envelope-scoped CODEX_HOME would otherwise
 * fail with 401 even though a key is available. We write the same file
 * `codex login --with-api-key` produces. No-op when not isolated (use codex's
 * native auth), when no key is available, or when auth already exists.
 */
export function ensureCodexApiAuth(env?: Record<string, string>): void {
  const home = env?.["CODEX_HOME"];
  if (!home) return;
  const apiKey = codexApiKey();
  if (!apiKey) return;
  const authPath = join(home, "auth.json");
  if (existsSync(authPath)) return;
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(authPath, JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: apiKey }) + "\n", { mode: 0o600 });
  } catch {
    /* best-effort: codex will surface an auth error if this did not take */
  }
}

function sandboxArgs(access: AccessProfile): string[] {
  switch (access) {
    case "readonly":
      return ["--sandbox", "read-only"];
    case "workspace_write":
      return ["--sandbox", "workspace-write"];
    case "full":
    case "external_sandbox_full":
      return ["--sandbox", "danger-full-access", "--ask-for-approval", "never"];
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

async function loggedIn(): Promise<boolean> {
  try {
    const r = await runCapture(BIN, ["login", "status"], { timeoutMs: 10_000 });
    return r.code === 0;
  } catch {
    return false;
  }
}

export function createCodexAdapter(): HarnessAdapter {
  return {
    id: "codex",

    async discover(): Promise<HarnessManifest> {
      const version = await detectVersion();
      if (version === null) {
        throw new HarnessUnavailableError(
          "codex CLI not found on PATH (set CLAUDEX_CODEX_BIN to override)",
        );
      }
      const authed = await loggedIn();
      return HarnessManifestSchema.parse({
        id: "codex",
        display_name: "Codex CLI",
        kind: "local_cli",
        version,
        adapter_version: "0.3.0",
        provider_family: "openai",
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
          worktree_native: false,
          quota_signal: "observed",
          usage_signal: "native",
        },
        auth_modes: authed ? ["local_session", "api_key"] : ["api_key"],
        access_profiles_supported: ["readonly", "workspace_write", "full", "inherit_native"],
        models: { discovery: "experimental" },
      });
    },

    async doctor(_spec: DoctorSpec): Promise<ConformanceReport> {
      const version = await detectVersion();
      if (version === null) {
        return ConformanceReportSchema.parse({
          harness_id: "codex",
          status: "unavailable",
          checks: [{ id: "installed", status: "fail", detail: "codex not found on PATH" }],
          reasons: ["codex CLI not found (install Codex or set CLAUDEX_CODEX_BIN)"],
        });
      }
      const authed = await loggedIn();
      return ConformanceReportSchema.parse({
        harness_id: "codex",
        status: authed ? "ok" : "degraded",
        checks: [
          { id: "installed", status: "pass", detail: version },
          { id: "auth", status: authed ? "pass" : "fail" },
        ],
        enabled_intents: authed
          ? ["plan", "spec", "implement", "repair", "create_from_scratch", "review", "verify", "compare", "arbitrate", "synthesize", "benchmark", "explain", "audit"]
          : ["explain", "audit"],
        disabled_intents: authed ? [] : ["implement", "review", "arbitrate"],
        reasons: authed ? [] : ["not authenticated (run `codex login`)"],
      });
    },

    run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runCodex(spec);
    },

    review(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runCodex(spec);
    },
  };
}

async function* runCodex(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
  ensureCodexApiAuth(spec.env);
  const args = ["exec", "--json", ...sandboxArgs(spec.access), "--skip-git-repo-check"];
  if (spec.model_hint) args.push("-m", spec.model_hint);
  args.push(spec.prompt);

  // Codex reports tokens but no $cost; estimate it from the (hint/configured)
  // model so the budget ledger does not see every codex run as free.
  const model = spec.model_hint ?? process.env.CLAUDEX_CODEX_MODEL ?? null;

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
        const out = parseCodexEvent(obj, spec.session_id);
        if (out) {
          if (out.type === "error") sawError = true;
          if (out.type === "usage" && out.usage && out.usage.cost_usd === undefined) {
            const est = estimateCodexCostUsd(model, out.usage);
            if (est !== undefined) {
              out.usage.cost_usd = est;
              out.usage.estimated = true;
              if (model) out.observed_model = model;
            }
          }
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
      error: `codex exited with code ${exitCode}`,
    };
  }
  yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
}
