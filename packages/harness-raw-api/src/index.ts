import type { ConformanceReport, HarnessEvent, HarnessManifest, HarnessRunSpec, ProviderFamily } from "@claudexor/schema";
import { ConformanceReport as ConformanceReportSchema, HarnessManifest as HarnessManifestSchema } from "@claudexor/schema";
import type { DoctorSpec, HarnessAdapter } from "@claudexor/core";
import { HarnessUnavailableError, abortSignalFromSpec } from "@claudexor/core";
import { resolveSecret } from "@claudexor/secrets";
import { nowIso } from "@claudexor/util";
import { parseChatCompletion } from "./parse.js";

/** A stalled remote endpoint must not hang a run forever. */
const RAW_API_TIMEOUT_MS = 180_000;

export interface RawApiConfig {
  id?: string;
  providerFamily?: ProviderFamily;
  baseUrl?: string;
  keyEnv?: string;
  defaultModel?: string;
}

/**
 * A raw-API harness backed by an OpenAI-compatible chat-completions endpoint.
 * It has no native edit tools, so it serves as a planner/reviewer (useful as a
 * cross-family reviewer via API key when no CLI of that family is installed).
 */
export function createRawApiAdapter(config: RawApiConfig = {}): HarnessAdapter {
  const id = config.id ?? "raw-api";
  const providerFamily = config.providerFamily ?? "openai";
  const baseUrl = config.baseUrl ?? process.env.CLAUDEXOR_RAWAPI_BASE_URL ?? "https://api.openai.com/v1";
  const keyEnv = config.keyEnv ?? (process.env.CLAUDEXOR_RAWAPI_KEY ? "CLAUDEXOR_RAWAPI_KEY" : "OPENAI_API_KEY");
  const defaultModel = config.defaultModel ?? process.env.CLAUDEXOR_RAWAPI_MODEL ?? "gpt-4o-mini";

  function apiKey(): string | undefined {
    return process.env[keyEnv] ?? resolveSecret("raw") ?? (keyEnv === "OPENAI_API_KEY" ? (resolveSecret("openai") ?? undefined) : undefined);
  }

  return {
    id,

    async discover(): Promise<HarnessManifest> {
      if (!apiKey()) {
        throw new HarnessUnavailableError(`raw-api unavailable: set ${keyEnv}`);
      }
      return HarnessManifestSchema.parse({
        id,
        display_name: `Raw API (${providerFamily})`,
        kind: "remote_api",
        version: defaultModel,
        adapter_version: "0.7.0",
        provider_family: providerFamily,
        capabilities: {
          plan: true,
          spec: true,
          implement: false,
          create_from_scratch: false,
          repair: false,
          review: true,
          verify: false,
          compare: true,
          synthesize: true,
          shell: false,
          read_files: false,
          edit_files: false,
          apply_patch: false,
          structured_events: true,
          structured_output: true,
          // spec.output_schema is not wired to the request yet; do not overclaim.
          json_schema_output: false,
          resume: false,
          cancel: false,
          mcp: false,
          plugins: false,
          worktree_native: false,
          web_policy: "none",
          quota_signal: "unknown",
          usage_signal: "exact",
        },
        capability_profile: {
          execution_surfaces: [{ kind: "cli_one_shot", input: "prompt_arg", output: "json", event_schema: "normalized" }],
          session: { resume_latest: false, resume_by_id: false },
          output: { final_json: false, json_schema_final: false, usage_signal: "exact", cost_signal: "unknown" },
          auth: { supported_sources: ["api_key_env"], preferred_source: "api_key_env", probe_command: [], env_vars: [keyEnv] },
          access_control: { readonly: true, workspace_write: false, full: false, mechanism: "remote chat-completions only" },
        },
        auth_modes: ["api_key"],
        access_profiles_supported: ["readonly"],
        models: { discovery: "unavailable" },
      });
    },

    async doctor(_spec: DoctorSpec): Promise<ConformanceReport> {
      if (!apiKey()) {
        return ConformanceReportSchema.parse({
          harness_id: id,
          status: "unavailable",
          checks: [{ id: "api_key", status: "fail", detail: `${keyEnv} not set` }],
          reasons: [`set ${keyEnv} to enable the raw-api harness`],
        });
      }
      // A key STRING is source availability, not proven readiness: no isolated
      // smoke runs here (doctor must not spend paid API calls), so the honest
      // status is degraded-with-reason rather than ok-by-key-presence.
      return ConformanceReportSchema.parse({
        harness_id: id,
        status: "degraded",
        checks: [
          { id: "api_key", status: "pass", detail: "key available (unproven without isolated smoke)" },
          { id: "isolated_smoke", status: "skip", detail: "doctor does not spend paid API calls" },
        ],
        // No native edit tools: planner/reviewer roles only.
        enabled_intents: ["plan", "spec", "review", "compare", "synthesize", "explain"],
        disabled_intents: ["implement", "create_from_scratch", "repair", "verify"],
        reasons: ["key present but route unproven (no isolated smoke)"],
      });
    },

    async *run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      const key = apiKey();
      if (!key) {
        yield { type: "error", session_id: spec.session_id, ts: nowIso(), error: `raw-api: ${keyEnv} not set` };
        yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
        return;
      }
      const model = spec.model_hint ?? defaultModel;
      // The model is only REQUESTED here; the observed model comes from the response.
      yield { type: "started", session_id: spec.session_id, ts: nowIso(), payload: { requested_model: model } };
      try {
        const specSignal = abortSignalFromSpec(spec);
        const timeoutSignal = AbortSignal.timeout(RAW_API_TIMEOUT_MS);
        const signal = specSignal ? AbortSignal.any([specSignal, timeoutSignal]) : timeoutSignal;
        const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, messages: [{ role: "user", content: spec.prompt }] }),
          signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          const retryAfter = res.headers.get("retry-after");
          const resetsAt = retryAfter ? resetsAtFromRetryAfter(retryAfter) : null;
          yield {
            type: "error",
            session_id: spec.session_id,
            ts: nowIso(),
            error: `raw-api HTTP ${res.status}`,
            payload: res.status === 429 ? { resets_at: resetsAt } : { body: body.slice(0, 500) },
          };
          yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
          return;
        }
        const json = await res.json();
        const parsed = parseChatCompletion(json);
        if (parsed.text) yield { type: "message", session_id: spec.session_id, ts: nowIso(), text: parsed.text };
        yield {
          type: "usage",
          session_id: spec.session_id,
          ts: nowIso(),
          usage: { input_tokens: parsed.usage.input_tokens, output_tokens: parsed.usage.output_tokens },
          observed_model: parsed.model ?? undefined,
        };
        yield { type: "completed", session_id: spec.session_id, ts: nowIso(), observed_model: parsed.model ?? undefined };
      } catch (err) {
        yield { type: "error", session_id: spec.session_id, ts: nowIso(), error: err instanceof Error ? err.message : String(err) };
        yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
      }
    },
  };
}

function resetsAtFromRetryAfter(header: string): string | null {
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return new Date(Date.now() + seconds * 1000).toISOString();
  const date = new Date(header);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
