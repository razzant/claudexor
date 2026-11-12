import {
  SharedRead,
  waitForRead,
  onProgramObservationChange,
  type ModelAdapterContext,
} from "@claudexor/core";
import type { ControlModelCatalogResponse, ModelCatalogEntry } from "@claudexor/schema";
import { CLAUDEXOR_VERSION, measureModelPreparation } from "@claudexor/util";
import type { CodexModelAuth } from "./model-auth.js";
import { CodexModelError, providerProblem, record, text } from "./responses.js";
import { codexProcessingCapability } from "./processing.js";
import { codexModelEfforts } from "./model-effort.js";
import type { CodexCatalogClientVersion } from "./http-client-version.js";

/** Transport limit for the entire /models request and body, not a selection budget.
 * Never shorter than the host's 60-second catalog read timeout. */
export const CODEX_CATALOG_TRANSPORT_MS = 60_000;

export function codexModelHeaders(auth: CodexModelAuth): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    "ChatGPT-Account-ID": auth.accountId,
    "Content-Type": "application/json",
    originator: "claudexor",
    "User-Agent": `claudexor/${CLAUDEXOR_VERSION}`,
  };
}

/** An expired/opaque access token's 401 is not proof that a new login is needed. */
export function authenticatedProblem(
  response: Response,
  body: unknown,
  auth: CodexModelAuth,
  now: number,
) {
  const problem = providerProblem(response.status, body, response.headers);
  return response.status === 401 && (auth.expiresAt === null || auth.expiresAt <= now)
    ? new CodexModelError(
        "auth_refresh_failed",
        "Codex refused access credentials whose freshness could not be confirmed.",
        problem.context,
      ).problem
    : problem;
}

function capacity(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Declared input kinds verbatim (open vocabulary). Only a wholly valid, non-empty
 * list counts: a missing, empty, non-array or partly invalid one is unknown (`[]`),
 * never a filtered subset that would read as a confident negative. */
function declaredInputModalities(value: unknown): string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => text(item)?.trim())
    ? [...value]
    : [];
}

/** Exact backend metadata only; no CLI alias list, compaction limit, or historical default. */
export function parseCodexModelCatalog(value: unknown): ModelCatalogEntry[] {
  const models = record(value)?.models;
  if (!Array.isArray(models))
    throw new CodexModelError("catalog_unavailable", "Codex did not return a model catalog.");
  // Mirror ModelsManager::build_available_models + mark_default_by_picker_visibility
  // using THIS account's metadata. Incomplete metadata does not invent a default.
  const hasPriority = models.every((value) => {
    const item = record(value);
    return (
      Number.isSafeInteger(item?.priority) &&
      ["list", "hide", "none"].includes(String(item?.visibility))
    );
  });
  const ordered = hasPriority
    ? [...models].sort((a, b) => Number(record(a)?.priority) - Number(record(b)?.priority))
    : models;
  const defaultEntry = hasPriority
    ? (ordered.find((value) => record(value)?.visibility === "list") ?? ordered[0])
    : null;
  return ordered.map((value) => {
    const entry = record(value),
      id = text(entry?.slug);
    if (!entry || !id)
      throw new CodexModelError(
        "catalog_unavailable",
        "Codex returned an invalid model catalog entry.",
      );
    const reportedEfforts = entry.supported_reasoning_levels;
    const reasoningEffortsVerified =
      Array.isArray(reportedEfforts) &&
      reportedEfforts.every((item) => text(record(item)?.effort)?.trim());
    const efforts = reasoningEffortsVerified
      ? reportedEfforts.map((item) => text(record(item)?.effort)!)
      : [];
    const projectedEfforts = codexModelEfforts(efforts);
    return {
      id,
      processing: codexProcessingCapability(entry, "codex.models"),
      label: text(entry.display_name),
      isDefault: value === defaultEntry,
      contextWindow: capacity(entry.context_window),
      maxContextWindow: capacity(entry.max_context_window),
      // Backend output-cap parameters are unsupported even when a model has a published output capacity.
      maxOutputTokens: capacity(entry.max_output_tokens),
      inputModalities: declaredInputModalities(entry.input_modalities),
      ...projectedEfforts,
      reasoningEffortsVerified,
      defaultReasoningEffort:
        entry.default_reasoning_level === "ultra" ? null : text(entry.default_reasoning_level),
      supportedOptions: [
        "toolChoice",
        "cacheKey",
        "serviceTier",
        "processingPreference",
        ...(projectedEfforts.reasoningEfforts.length ? ["reasoningEffort"] : []),
        ...(entry.supports_parallel_tool_calls === true ? ["parallelToolCalls"] : []),
      ],
    };
  });
}

/** One adapter instance owns raw in-flight reads, never completed catalogs. */
export function createCodexCatalogReader(
  fetcher: typeof fetch,
  now: () => number,
  clientVersion: () => Promise<CodexCatalogClientVersion>,
) {
  const reads = new SharedRead<ControlModelCatalogResponse>();
  return async (
    auth: CodexModelAuth,
    context: Omit<ModelAdapterContext, "onDispatch">,
  ): Promise<ControlModelCatalogResponse> => {
    context.signal.throwIfAborted();
    const declared = await waitForRead(clientVersion(), context.signal);
    const scope = context.profile.profile_id;
    const key =
      Number.isFinite(context.credentialGeneration) &&
      auth.accountFingerprint &&
      auth.capabilityFingerprint &&
      declared.programKey &&
      declared.program?.version
        ? JSON.stringify([
            "codex",
            context.profile,
            context.credentialGeneration,
            auth.credentialFingerprint,
            auth.accountFingerprint,
            auth.capabilityFingerprint,
            declared.programKey,
            declared.version,
            declared.source,
          ])
        : null;
    const catalog = await measureModelPreparation("catalogTransport", () =>
      reads.read(scope, key, context.signal, async (signal) => {
        const replaced = new AbortController();
        const unsubscribe = onProgramObservationChange((harness) => {
          if (!harness || harness === "codex")
            replaced.abort(
              new CodexModelError(
                "auth_changed",
                "The Codex program changed during catalog discovery.",
              ),
            );
        });
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), CODEX_CATALOG_TRANSPORT_MS);
        timer.unref?.();
        const transport = AbortSignal.any([signal, replaced.signal, deadline.signal]);
        try {
          const work = async () => {
            const response = await fetcher(
              `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(declared.version)}`,
              {
                headers: codexModelHeaders(auth),
                signal: transport,
                redirect: "error",
              },
            );
            transport.throwIfAborted();
            let body: unknown = null;
            try {
              body = await response.json();
            } catch {
              transport.throwIfAborted();
              if (response.ok)
                throw new CodexModelError(
                  "catalog_unavailable",
                  "Codex returned an unreadable model catalog.",
                );
            }
            transport.throwIfAborted();
            if (!response.ok) {
              const problem = authenticatedProblem(response, body, auth, now());
              throw new CodexModelError(
                problem.code === "provider_failed" ? "catalog_unavailable" : problem.code,
                problem.message,
                problem.context,
                problem.retryable,
              );
            }
            return {
              source: "codex",
              credentialProfileId: context.profile.profile_id,
              accountFingerprint: auth.accountFingerprint,
              capabilityFingerprint: auth.capabilityFingerprint,
              observedAt: new Date(now()).toISOString(),
              provenance: "provider_http",
              sourceProgram: declared.program ?? null,
              clientVersion: declared.version,
              clientVersionSource: declared.source,
              models: parseCodexModelCatalog(body),
            };
          };
          return await waitForRead(work(), transport);
        } catch (error) {
          signal.throwIfAborted();
          replaced.signal.throwIfAborted();
          if (error instanceof CodexModelError) throw error;
          throw new CodexModelError(
            "catalog_unavailable",
            deadline.signal.aborted
              ? "The selected Codex account's catalog exceeded its transport limit."
              : "The selected Codex account's catalog could not be reached.",
            {},
            true,
          );
        } finally {
          clearTimeout(timer);
          unsubscribe();
        }
      }),
    );
    // A program change observed during the read already ended it; an answer is
    // labelled with the client version it was read for.
    return structuredClone(catalog);
  };
}
