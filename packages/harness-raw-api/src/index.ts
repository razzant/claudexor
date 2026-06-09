import type { ConformanceReport, HarnessEvent, HarnessManifest, HarnessRunSpec, ProviderFamily } from "@claudexor/schema";
import { ConformanceReport as ConformanceReportSchema, HarnessManifest as HarnessManifestSchema } from "@claudexor/schema";
import type { DoctorSpec, HarnessAdapter } from "@claudexor/core";
import { HarnessUnavailableError } from "@claudexor/core";
import { resolveSecret } from "@claudexor/secrets";
import { nowIso } from "@claudexor/util";
import { parseChatCompletion } from "./parse.js";

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
        adapter_version: "0.6.0",
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
          json_schema_output: true,
          resume: false,
          cancel: false,
          mcp: false,
          plugins: false,
          worktree_native: false,
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
      return ConformanceReportSchema.parse({
        harness_id: id,
        status: "ok",
        checks: [{ id: "api_key", status: "pass" }],
        // No native edit tools: planner/reviewer roles only.
        enabled_intents: ["plan", "spec", "review", "compare", "synthesize", "explain"],
        disabled_intents: ["implement", "create_from_scratch", "repair", "verify"],
      });
    },

    async *run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      const key = apiKey();
      if (!key) {
        yield { type: "error", session_id: spec.session_id, ts: nowIso(), error: `raw-api: ${keyEnv} not set` };
        return;
      }
      const model = spec.model_hint ?? defaultModel;
      yield { type: "started", session_id: spec.session_id, ts: nowIso(), observed_model: model };
      try {
        const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, messages: [{ role: "user", content: spec.prompt }] }),
          signal: abortSignalFromSpec(spec),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          yield {
            type: "error",
            session_id: spec.session_id,
            ts: nowIso(),
            error: `raw-api HTTP ${res.status}`,
            payload: res.status === 429 ? { resets_at: null } : { body: body.slice(0, 500) },
          };
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
          observed_model: parsed.model ?? model,
        };
        yield { type: "completed", session_id: spec.session_id, ts: nowIso(), observed_model: parsed.model ?? model };
      } catch (err) {
        yield { type: "error", session_id: spec.session_id, ts: nowIso(), error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

function abortSignalFromSpec(spec: HarnessRunSpec): AbortSignal | undefined {
  const signal = spec.extra["abortSignal"];
  return signal instanceof AbortSignal ? signal : undefined;
}
