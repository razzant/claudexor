import { readFileSync } from "node:fs";
import type { ConformanceReport, HarnessEvent, HarnessManifest, HarnessModel, HarnessRunSpec, ProviderFamily } from "@claudexor/schema";
import { ConformanceReport as ConformanceReportSchema, HarnessManifest as HarnessManifestSchema } from "@claudexor/schema";
import type { DoctorSpec, HarnessAdapter } from "@claudexor/core";
import { HarnessUnavailableError, abortSignalFromSpec } from "@claudexor/core";
import { resolveSecret } from "@claudexor/secrets";
import { CLAUDEXOR_VERSION, nowIso, redactSecrets } from "@claudexor/util";
import { parseChatCompletion, parseModelsList } from "./parse.js";

/** A stalled remote endpoint must not hang a run forever. */
const RAW_API_TIMEOUT_MS = 180_000;
/** Model enumeration is interactive (a picker waits on it): keep it snappy. */
const RAW_API_MODELS_TIMEOUT_MS = 15_000;
const RAW_API_TRANSIENT_STATUS = new Set([408, 502, 503, 504]);

/**
 * Build the chat-completions user `content`. With image attachments, switch
 * from a plain string to the OpenAI-compatible parts array (`text` +
 * `image_url` data URLs). Non-image attachments have no inline chat shape.
 */
function rawApiUserContent(spec: HarnessRunSpec): string | Array<Record<string, unknown>> {
  const images = (spec.attachments ?? []).filter((a) => a.kind === "image");
  if (images.length === 0) return spec.prompt;
  const parts: Array<Record<string, unknown>> = [{ type: "text", text: spec.prompt }];
  for (const a of images) {
    try {
      parts.push({ type: "image_url", image_url: { url: `data:${a.mime};base64,${readFileSync(a.path).toString("base64")}` } });
    } catch {
      // Late-deleted attachment: skip; the text prompt still goes through.
    }
  }
  return parts.length > 1 ? parts : spec.prompt;
}

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
    const env = process.env[keyEnv];
    if (env) return env;
    // Secret fallback is INSTANCE-SCOPED so a key for one provider is never sent
    // to another (e.g. an OpenAI "raw" key must not reach openrouter.ai). The
    // default OpenAI-compatible instance owns the managed "raw" (and "openai")
    // secret; every named instance (openrouter, …) resolves ONLY its own slot.
    if (id === "raw-api") {
      return resolveSecret("raw") ?? (keyEnv === "OPENAI_API_KEY" ? (resolveSecret("openai") ?? undefined) : undefined);
    }
    return resolveSecret(id) ?? undefined;
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
        // A remote HTTP API has no CLI binary version; the endpoint contract
        // is the closest honest "version" (UIs render this field verbatim —
        // a model id here would read as a bogus harness version).
        version: `${providerFamily} chat-completions API`,
        adapter_version: CLAUDEXOR_VERSION,
        provider_family: providerFamily,
        capabilities: {
          plan: true,
          implement: false,
          create_from_scratch: false,
          review: true,
          verify: false,
          synthesize: true,
          orchestrate: true,
          read_files: false,
          browser_tool: false,
          web_policy: "none",
          quota_signal: "unknown",
          usage_signal: "exact",
          // The chat-completions request sends no `reasoning_effort` field
          // (body is {model, messages} only) -> effort is not a tunable surface.
          effort_levels: [],
        },
        capability_profile: {
          auth: {
            supported_sources: ["api_key_env"],
            preferred_source: "api_key_env",
            credential_transports: [{ source: "api_key_env", kind: "http_header", relocatable_by: ["ENV"] }],
          },
          access_control: { readonly_mechanism: "none" },
          isolation: { supported_containment: ["env_or_file_injection"] },
          // OpenAI-compatible chat-completions accept images as an inline `image_url` data URL part.
          image_input: "base64_inline",
        },
        auth_modes: ["api_key"],
        access_profiles_supported: ["readonly"],
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
        enabled_intents: ["plan", "spec", "review", "synthesize", "explain", "orchestrate"],
        disabled_intents: ["implement", "create_from_scratch", "repair", "verify"],
        reasons: ["key present but route unproven (no isolated smoke)"],
      });
    },

    // The REAL enumeration producer (ADP4): an OpenAI-compatible endpoint
    // exposes `GET <baseURL>/models`. Fails SOFT — a picker must never see a
    // throw, so network/auth/parse errors collapse to an empty list.
    async models(): Promise<HarnessModel[]> {
      const key = apiKey();
      if (!key) return [];
      try {
        const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
          method: "GET",
          headers: { accept: "application/json", authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(RAW_API_MODELS_TIMEOUT_MS),
        });
        if (!res.ok) return [];
        const json = await res.json();
        return parseModelsList(json).map((m) => ({ id: m.id, label: m.label, context_window: m.context_window }));
      } catch {
        return [];
      }
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
          body: JSON.stringify({ model, messages: [{ role: "user", content: rawApiUserContent(spec) }] }),
          signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          const retryAfter = res.headers.get("retry-after");
          const resetsAt = retryAfter ? resetsAtFromRetryAfter(retryAfter) : null;
          const retryDelayMs = retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : null;
          yield {
            type: "error",
            session_id: spec.session_id,
            ts: nowIso(),
            error: `raw-api HTTP ${res.status}`,
            // A 429 is a TYPED rate-limit signal (cooldown/fallback governance
            // reads ev.rate_limit, never prose), with the native reset when known.
            ...(res.status === 429 ? { rate_limit: { resets_at: resetsAt, retry_delay_ms: retryDelayMs } } : {}),
            ...(res.status === 429 || RAW_API_TRANSIENT_STATUS.has(res.status)
              ? { transient: { kind: res.status === 408 ? "timeout" : "service_unavailable", retry_delay_ms: retryDelayMs } }
              : {}),
            payload: res.status === 429 ? { resets_at: resetsAt } : { body: redactSecrets(body.slice(0, 500)) },
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
        const message = redactSecrets(err instanceof Error ? err.message : String(err));
        yield {
          type: "error",
          session_id: spec.session_id,
          ts: nowIso(),
          error: message,
          transient: { kind: err instanceof DOMException && err.name === "TimeoutError" ? "timeout" : "network", retry_delay_ms: null },
        };
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
