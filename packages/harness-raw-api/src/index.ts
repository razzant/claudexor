import type {
  ConformanceReport,
  HarnessEvent,
  HarnessManifest,
  HarnessRunSpec,
  ModelRoutingVariant,
  ProviderFamily,
  RawGitPatchEnvelope,
  RefusedModelVariant,
} from "@claudexor/schema";
import {
  ConformanceReport as ConformanceReportSchema,
  HarnessManifest as HarnessManifestSchema,
  RawGitPatchEnvelope as RawGitPatchEnvelopeSchema,
} from "@claudexor/schema";
import type { DoctorSpec, HarnessAdapter } from "@claudexor/core";
import {
  HarnessUnavailableError,
  abortSignalFromSpec,
  catalogRowFor,
  dispatchModelCatalog,
  parseUnifiedDiff,
} from "@claudexor/core";
import {
  CLAUDEXOR_VERSION,
  normalizeRetryDelayMs,
  nowIso,
  redactSecrets,
  sha256,
} from "@claudexor/util";
import { instanceApiKey, readCatalogWithKey, readRawApiCatalog, requestKeyFor } from "./catalog.js";
export {
  KEY_ALLOWANCE_SOURCE,
  instanceKeyCredentials,
  parseKeyAllowance,
  readKeyAllowance,
  type KeyCredential,
} from "./key-allowance.js";
import { parseChatCompletion } from "./parse.js";
import { isTerminalProviderCompletion, providerCompletionErrorEvent } from "./providerError.js";
import {
  estimateMessageTokens,
  finalWindowRefusal,
  imageInputDisclosure,
  rawApiMessages,
  rawApiRequestCapacity,
  rawContextDisclosure,
} from "./request.js";

/** A stalled remote endpoint must not hang a run forever. */
const RAW_API_TIMEOUT_MS = 180_000;
const RAW_API_TRANSIENT_STATUS = new Set([408, 502, 503, 504]);
const RAW_API_ENABLED_INTENTS = [
  "implement",
  "plan",
  "spec",
  "review",
  "synthesize",
  "explain",
] as const;
const RAW_API_DISABLED_INTENTS = ["create_from_scratch", "repair", "verify", "audit"] as const;
const ALL_RAW_API_INTENTS = [...RAW_API_ENABLED_INTENTS, ...RAW_API_DISABLED_INTENTS] as const;

function buildPatchEnvelope(
  text: string,
  context: NonNullable<HarnessRunSpec["raw_context_packet"]>,
): RawGitPatchEnvelope {
  const proposal = JSON.parse(text) as unknown;
  if (
    !proposal ||
    typeof proposal !== "object" ||
    typeof (proposal as Record<string, unknown>)["patch"] !== "string"
  ) {
    throw new Error("patch proposal must contain one string patch field");
  }
  const patch = (proposal as { patch: string }).patch;
  const parsed = parseUnifiedDiff(patch);
  if (parsed.files.length === 0) throw new Error("patch proposal has no complete file record");
  const baseOids = new Map(context.readable_files.map((file) => [file.path, file.blob_oid]));
  const evidence = new Map<string, string | null>();
  for (const file of parsed.files) {
    if (file.oldPath) evidence.set(file.oldPath, baseOids.get(file.oldPath) ?? null);
    if (file.newPath && file.newPath !== file.oldPath) evidence.set(file.newPath, null);
  }
  return RawGitPatchEnvelopeSchema.parse({
    schema_version: 1,
    context_packet_hash: context.packet_hash,
    base_tree_sha: context.base_tree_sha,
    patch,
    patch_hash: sha256(patch),
    touched_paths: [...evidence].map(([path, expected_blob_oid]) => ({
      path,
      expected_blob_oid,
    })),
  });
}

export interface RawApiConfig {
  id?: string;
  providerFamily?: ProviderFamily;
  /**
   * Declared unit for this endpoint's provider-reported `usage.cost`;
   * absent leaves the extension untrusted.
   */
  providerUsageCostUnit?: "usd";
  baseUrl?: string;
  keyEnv?: string;
  defaultModel?: string;
  /** Request-time routing suffixes this provider accepts on a listed id (#145);
   * declared by the registry instance, surfaced as `model_routing_variants`. */
  routingVariants?: readonly ModelRoutingVariant[];
  /** Suffixes this instance refuses on any id (#393): `model_refused_variants`. */
  refusedVariants?: readonly RefusedModelVariant[];
}

/**
 * A raw-API harness backed by an OpenAI-compatible chat-completions endpoint.
 * Implementing calls receive a bounded context packet and return a typed Git
 * patch envelope; the orchestrator validates/materializes it in isolation.
 */
export function createRawApiAdapter(config: RawApiConfig = {}): HarnessAdapter {
  const id = config.id ?? "raw-api";
  const providerFamily = config.providerFamily ?? "openai";
  const providerUsageCostUnit = config.providerUsageCostUnit;
  const baseUrl =
    config.baseUrl ?? process.env.CLAUDEXOR_RAWAPI_BASE_URL ?? "https://api.openai.com/v1";
  const keyEnv =
    config.keyEnv ?? (process.env.CLAUDEXOR_RAWAPI_KEY ? "CLAUDEXOR_RAWAPI_KEY" : "OPENAI_API_KEY");
  const defaultModel = config.defaultModel ?? process.env.CLAUDEXOR_RAWAPI_MODEL ?? "gpt-4o-mini";
  const routingVariants = config.routingVariants ?? [];
  const refusedVariants = config.refusedVariants ?? [];
  const instance = { id, baseUrl, keyEnv };
  const apiKey = (env?: Record<string, string | null | undefined>) => instanceApiKey(instance, env);

  const adapter: HarnessAdapter = {
    id,

    async discover(): Promise<HarnessManifest> {
      if (!apiKey()) {
        // QA-058: outward identity is the configured instance id (e.g.
        // "openrouter"), never the implementation-class name "raw-api" — which
        // is a DIFFERENT registered harness with its own key/secret slot.
        throw new HarnessUnavailableError(`${id} unavailable: set ${keyEnv}`);
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
          implement: true,
          implementation_transport: "git_patch_envelope",
          create_from_scratch: false,
          review: true,
          verify: false,
          synthesize: true,
          read_files: false,
          browser_tool: false,
          web_policy: "none",
          // D-16: the git-patch-envelope route carries no schema-constrained
          // final answer -> WorkReport unsupported (work_state stays unverified).
          work_report_transport: "unsupported",
          // The chat-completions request sends no `reasoning_effort` field
          // (body is {model, messages} only) -> effort is not a tunable surface.
          effort_levels: [],
          ...(routingVariants.length > 0 ? { model_routing_variants: [...routingVariants] } : {}),
          ...(refusedVariants.length > 0 ? { model_refused_variants: [...refusedVariants] } : {}),
        },
        capability_profile: {
          auth: {
            supported_sources: ["api_key_env"],
            preferred_source: "api_key_env",
            credential_transports: [
              { source: "api_key_env", kind: "http_header", relocatable_by: ["ENV"] },
            ],
          },
          access_control: {
            readonly_mechanism: "none",
            write_mechanism: "none",
            auxiliary_writable_roots: false,
          },
          isolation: { supported_containment: ["env_or_file_injection"] },
          attachment_inputs: [
            {
              kind: "image",
              mime_types: ["image/png", "image/jpeg", "image/gif", "image/webp"],
              max_bytes: 20 * 1024 * 1024,
              max_count: 20,
              transport: "base64_inline",
            },
            {
              kind: "file",
              mime_types: ["text/plain", "text/markdown", "application/json"],
              max_bytes: 1024 * 1024,
              max_count: 10,
              transport: "text_inline",
            },
          ],
        },
        auth_modes: ["api_key"],
        access_profiles_supported: ["readonly"],
      });
    },

    async doctor(spec: DoctorSpec): Promise<ConformanceReport> {
      const requestedSource = spec.authSource;
      if (requestedSource !== undefined && requestedSource !== "api_key_env") {
        return ConformanceReportSchema.parse({
          harness_id: id,
          status: "unavailable",
          checks: [
            {
              id: "auth_source",
              status: "fail",
              detail: `${id} does not support ${requestedSource}`,
            },
          ],
          enabled_intents: [],
          disabled_intents: ALL_RAW_API_INTENTS,
          reasons: [`${id} does not support auth source ${requestedSource}`],
          auth_sources: [
            {
              source: requestedSource,
              availability: "unavailable",
              verification: "not_run",
              detail: `${id} does not support ${requestedSource}`,
            },
          ],
        });
      }

      const keyAvailable = apiKey({ ...process.env, ...spec.env }) !== undefined;
      const readiness = {
        source: "api_key_env" as const,
        availability: keyAvailable ? ("available" as const) : ("unavailable" as const),
        verification: "not_run" as const,
        detail: keyAvailable
          ? "credential source is present; verification requires an isolated capability smoke"
          : `${keyEnv} is not configured`,
      };
      if (!keyAvailable) {
        return ConformanceReportSchema.parse({
          harness_id: id,
          status: "unavailable",
          checks: [{ id: "api_key", status: "fail", detail: `${keyEnv} not set` }],
          enabled_intents: [],
          disabled_intents: ALL_RAW_API_INTENTS,
          reasons: [`set ${keyEnv} to enable the ${id} harness`],
          auth_sources: [readiness],
        });
      }
      // A key STRING is source availability, not proven readiness: no isolated
      // smoke runs here (doctor must not spend paid API calls), so the honest
      // status is degraded-with-reason rather than ok-by-key-presence.
      return ConformanceReportSchema.parse({
        harness_id: id,
        status: "degraded",
        checks: [
          {
            id: "api_key",
            status: "pass",
            detail: "key available (unproven without isolated smoke)",
          },
          { id: "isolated_smoke", status: "skip", detail: "doctor does not spend paid API calls" },
        ],
        enabled_intents: RAW_API_ENABLED_INTENTS,
        disabled_intents: RAW_API_DISABLED_INTENTS,
        reasons: ["key present but route unproven (no isolated smoke)"],
        auth_sources: [readiness],
      });
    },

    // The typed catalog read (#393): the credential identity run() would use,
    // and a failed or partial read is never an (apparently complete) list.
    modelCatalog: (spec) => readRawApiCatalog(instance, spec),
    // Fail-soft display projection of the same read; consumers that decide
    // anything read `modelCatalog` through core's `readModelCatalog`.
    async models(spec) {
      const read = await readRawApiCatalog(instance, spec);
      return read.status === "listed" ? read.models : [];
    },

    rawRequestCapacity: (spec, catalog) =>
      rawApiRequestCapacity(spec, spec.model_hint ?? defaultModel, routingVariants, catalog),

    async *run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      // INV-135 strict profile routing: one resolution with the catalog read
      // (catalog.ts); other kinds, fenced refs and missing secrets refuse typed.
      // The key this spawn's dispatch read checked is the one sent.
      const profile = spec.credential_profile;
      const credential = requestKeyFor(instance, profile, spec.env, dispatchModelCatalog(spec));
      if ("refusal" in credential) {
        yield {
          type: "error",
          session_id: spec.session_id,
          ts: nowIso(),
          error: credential.refusal,
        };
        yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
        return;
      }
      const { key } = credential;
      const model = spec.model_hint ?? defaultModel;
      // The model is only REQUESTED here; the observed model comes from the response.
      yield {
        type: "started",
        session_id: spec.session_id,
        ts: nowIso(),
        credential_route: "managed_api_key",
        credential_source: "api_key_env",
        ...(profile ? { credential_profile_id: profile.profile_id } : {}),
        payload: { requested_model: model },
      };
      try {
        const specSignal = abortSignalFromSpec(spec);
        const timeoutSignal = AbortSignal.timeout(RAW_API_TIMEOUT_MS);
        const signal = specSignal ? AbortSignal.any([specSignal, timeoutSignal]) : timeoutSignal;
        const messages = rawApiMessages(spec);
        const budget = spec.raw_context_packet?.budget;
        if (budget && (spec.intent === "implement" || spec.intent === "synthesize")) {
          // #147 backstop: the packet was sized for this request; a request that
          // grew past that KNOWN window afterwards is refused before sending.
          const estimated = estimateMessageTokens(messages);
          const refusal = finalWindowRefusal(budget, model, estimated);
          if (refusal) {
            yield {
              type: "error",
              session_id: spec.session_id,
              ts: nowIso(),
              error: refusal,
              refusal_code: "raw_context_exceeds_window",
            };
            yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
            return;
          }
          const text = rawContextDisclosure(budget, model, estimated);
          // The same facts typed, so no consumer reads them from the sentence.
          const raw_context = { model, estimated_request_tokens: estimated, budget };
          yield { type: "status", session_id: spec.session_id, ts: nowIso(), text, raw_context };
        }
        if (spec.attachments.some((a) => a.kind === "image")) {
          // The dispatch gate's read of this key's catalog when it made one,
          // else one read with the key this request sends.
          const read = dispatchModelCatalog(spec) ?? (await readCatalogWithKey(instance, key));
          const row =
            read.status === "listed" ? catalogRowFor(model, read.models, routingVariants) : null;
          const text = imageInputDisclosure(model, row);
          if (text) yield { type: "status", session_id: spec.session_id, ts: nowIso(), text };
        }
        const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, messages }),
          signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          const retryAfter = res.headers.get("retry-after");
          const resetsAt = retryAfter ? resetsAtFromRetryAfter(retryAfter) : null;
          const retryDelayMs = normalizeRetryDelayMs(
            retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : null,
          );
          yield {
            type: "error",
            session_id: spec.session_id,
            ts: nowIso(),
            error: `${id} HTTP ${res.status}`,
            // A 429 is a TYPED rate-limit signal (cooldown/fallback governance
            // reads ev.rate_limit, never prose), with the native reset when known.
            ...(res.status === 429
              ? { rate_limit: { resets_at: resetsAt, retry_delay_ms: retryDelayMs } }
              : {}),
            ...(res.status === 429 || RAW_API_TRANSIENT_STATUS.has(res.status)
              ? {
                  transient: {
                    kind: res.status === 408 ? "timeout" : "service_unavailable",
                    retry_delay_ms: retryDelayMs,
                  },
                }
              : {}),
            payload:
              res.status === 429
                ? { resets_at: resetsAt }
                : { body: redactSecrets(body.slice(0, 500)) },
          };
          yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
          return;
        }
        const json = await res.json();
        const parsed = parseChatCompletion(json);
        const usage = {
          input_tokens: parsed.usage.input_tokens,
          output_tokens: parsed.usage.output_tokens,
          ...(providerUsageCostUnit === "usd" && parsed.usage.provider_cost !== undefined
            ? {
                cost_usd: parsed.usage.provider_cost,
                ...(spec.processing
                  ? {
                      cost_basis: {
                        kind: "cash" as const,
                        source: "raw_api_declared_provider_usage_usd",
                      },
                    }
                  : {}),
              }
            : {}),
        };
        if (isTerminalProviderCompletion(parsed)) {
          yield providerCompletionErrorEvent(id, spec.session_id, nowIso(), parsed);
          yield {
            type: "usage",
            session_id: spec.session_id,
            ts: nowIso(),
            usage,
            observed_model: parsed.model ?? undefined,
          };
          yield {
            type: "completed",
            session_id: spec.session_id,
            ts: nowIso(),
            observed_model: parsed.model ?? undefined,
          };
          return;
        }
        if (spec.intent === "implement" || spec.intent === "synthesize") {
          if (!spec.raw_context_packet) {
            yield {
              type: "error",
              session_id: spec.session_id,
              ts: nowIso(),
              error: `${id} ${spec.intent} requires a RawContextPacket`,
              refusal_code: "raw_patch_missing_evidence",
            };
          } else {
            let patchEnvelope: RawGitPatchEnvelope | null = null;
            try {
              patchEnvelope = buildPatchEnvelope(parsed.text, spec.raw_context_packet);
            } catch {
              // A provider stop at its output limit is the typed truncation cause.
              const cut = parsed.finish_reason === "length";
              yield {
                type: "error",
                session_id: spec.session_id,
                ts: nowIso(),
                error: `${id} ${spec.intent} response was not a complete Git patch proposal JSON object${cut ? " (the provider stopped at its output limit: finish_reason length)" : ""}`,
                refusal_code: "raw_patch_truncated",
                ...(cut ? { payload: { finish_reason: "length" } } : {}),
              };
            }
            if (patchEnvelope) {
              // INV-146: secret-like content in the proposal is not a refusal;
              // the engine keeps and saves the exact bytes.
              yield {
                type: "patch_produced",
                session_id: spec.session_id,
                ts: nowIso(),
                patch_envelope: patchEnvelope,
              };
            }
          }
        } else if (parsed.text) {
          yield { type: "message", session_id: spec.session_id, ts: nowIso(), text: parsed.text };
          // An answer cut at the provider's output limit stays an answer (#144)
          // and says so, typed in the payload, instead of reading as complete.
          if (parsed.finish_reason === "length")
            yield {
              type: "status",
              session_id: spec.session_id,
              ts: nowIso(),
              text: "the provider stopped this answer at its output limit (finish_reason length); it may be incomplete",
              payload: { finish_reason: "length" },
            };
        }
        yield {
          type: "usage",
          session_id: spec.session_id,
          ts: nowIso(),
          usage,
          observed_model: parsed.model ?? undefined,
        };
        yield {
          type: "completed",
          session_id: spec.session_id,
          ts: nowIso(),
          observed_model: parsed.model ?? undefined,
        };
      } catch (err) {
        const message = redactSecrets(err instanceof Error ? err.message : String(err));
        yield {
          type: "error",
          session_id: spec.session_id,
          ts: nowIso(),
          error: message,
          transient: {
            kind:
              err instanceof DOMException && err.name === "TimeoutError" ? "timeout" : "network",
            retry_delay_ms: null,
          },
        };
        yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
      }
    },
  };
  const run = adapter.run;
  adapter.run = async function* (spec) {
    if (!spec.processing && spec.processing_preference)
      spec = {
        ...spec,
        processing: {
          requested: spec.processing_preference,
          submitted: null,
          submittedNative: null,
          observed: "unknown",
          observedNative: [],
          reason: "processing_control_unavailable; compatible_endpoint_preserved",
          source: id,
        },
        processing_cost_basis: { nativeMode: null, kind: "unknown", source: id },
      };
    // Preserve compatible endpoints without guessing flags from the provider-family label.
    for await (const event of run(spec)) {
      if (spec.processing) {
        event.processing = spec.processing;
        event.processing_cost_basis = spec.processing_cost_basis;
      }
      yield event;
    }
  };
  return adapter;
}

function resetsAtFromRetryAfter(header: string): string | null {
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0)
    return new Date(Date.now() + seconds * 1000).toISOString();
  const date = new Date(header);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
