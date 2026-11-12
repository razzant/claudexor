import { z } from "zod/v3";
import { NonBlankString } from "./primitives.js";
import { ProcessingCapability } from "./processing.js";

/**
 * One enumerable model offered by a harness. Deliberately small: only the
 * fields a real enumeration source (an OpenAI-compatible `GET /v1/models`)
 * can honestly populate. `label`/`context_window` are nullable because the
 * raw `{data:[{id}]}` list rarely carries them.
 */
export const HarnessModel = z
  .object({
    processing: ProcessingCapability.optional(),
    id: z.string().describe("Model id as the vendor enumerates it."),
    label: z
      .string()
      .nullable()
      .default(null)
      .describe("Human-readable model label; null when the enumeration source has none."),
    context_window: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null)
      .describe("Context window in tokens; null when the enumeration source does not report it."),
    /** Declared catalog metadata, copied verbatim: it gates no request (#435). */
    input_modalities: z
      .array(NonBlankString)
      .min(1)
      .optional()
      .describe(
        "Input modalities the live catalog declares for this model, verbatim (e.g. text, image, file); absent = unknown, never an empty or 'none' claim. Declared metadata that refuses no request.",
      ),
    max_output_tokens: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Largest completion the live catalog declares for this model (OpenRouter top_provider.max_completion_tokens); absent = unknown. Input and output share the context window, so the effective maximum can be lower.",
      ),
    /** Credential routes the model is scoped to per the manifest annotation;
     * null = unannotated (available on every route). */
    routes: z
      .array(z.enum(["local_session", "api_key"]))
      .nullable()
      .default(null)
      .describe("Credential routes the model is scoped to; null = every route."),
    /** Row provenance inside ONE producer's answer. Absent = live, so producers
     * that predate the field (codex, cursor, raw-api) need no change. */
    origin: z
      .enum(["live", "hint"])
      .optional()
      .describe(
        "Where this row came from: live = the vendor's own enumeration reported it; hint = a frozen known-model id the producer appends when its live answer lacks it or could not be read. Absent = live.",
      ),
    /** What an alias row resolved to when the vendor was asked (claude's
     * `default` -> `claude-opus-5-5[1m]`). Diagnostic only: the row id is what
     * travels, never rewritten to this. */
    resolved_model: z
      .string()
      .nullable()
      .optional()
      .describe(
        "For an alias row, the exact model id the vendor reported it resolves to at enumeration time; null or absent when the source reports none. The row id is what is sent; this is never substituted for it.",
      ),
  })
  .describe(
    "One enumerable model offered by a harness, limited to fields a real enumeration source can honestly populate.",
  );
export type HarnessModel = z.infer<typeof HarnessModel>;

/**
 * A request-time routing suffix the provider accepts on a listed model id
 * without listing the suffixed id itself (OpenRouter `:nitro`). Declared by the
 * harness instance, never inferred from a model name: stripping only trailing
 * declared suffixes yields the catalog row whose presence and metadata apply,
 * and the request still carries the original id.
 */
export const ModelRoutingVariant = z
  .object({
    suffix: z
      .string()
      .regex(/^:[a-z][a-z0-9_-]*$/)
      .describe("The suffix, colon included (e.g. ':nitro')."),
    billing: z
      .enum(["base", "service_tier"])
      .describe(
        "base = billed like the listed row; service_tier = the provider may serve it on another service tier billed at that tier's rate.",
      ),
  })
  .strict()
  .describe("One declared request-time routing suffix and its billing effect.");
export type ModelRoutingVariant = z.infer<typeof ModelRoutingVariant>;
export const ModelRoutingVariants = z
  .array(ModelRoutingVariant)
  .min(1)
  .describe(
    "Request-time routing suffixes this harness's provider accepts on a listed model id; an id ending in declared suffixes is admitted when the id without them is an exact catalog row. Omitted = exact catalog membership only.",
  );

/**
 * A request-time suffix the provider accepts but this harness refuses on any
 * model id, whatever a catalog lists (#393). OpenRouter's `:online` attaches
 * provider-side web search: live egress this route neither governs nor
 * observes (its `web_policy` is `none`). A failed catalog read proves nothing
 * about membership, so this declaration is what still refuses such an id
 * while an explicit model is otherwise forwarded unverified.
 */
export const RefusedModelVariant = z
  .object({
    suffix: z
      .string()
      .regex(/^:[a-z][a-z0-9_-]*$/)
      .describe("The suffix, colon included (e.g. ':online')."),
    reason: z
      .enum(["provider_web_search"])
      .describe(
        "provider_web_search = the provider would search the web for the request, outside this route's web policy.",
      ),
  })
  .strict()
  .describe("One declared request-time suffix this harness refuses, and why.");
export type RefusedModelVariant = z.infer<typeof RefusedModelVariant>;

/** A harness's live-inventory declaration, part of `HarnessCapabilities`:
 * which routes its `models()` producer answers for, what an absence from its
 * lists proves, and which routing suffixes a listed row admits. */
export const ModelInventoryCapabilityFields = {
  model_inventory_routes: z
    .array(z.enum(["local_session", "api_key"]))
    .min(1)
    .optional()
    .describe(
      "Credential routes supported by the adapter's live models() producer; omitted preserves all-route support. Other routes use manifest known_models, never another account's live inventory.",
    ),
  /**
   * What this harness's model lists prove (INV-104) — the live `models()`
   * answer and the manifest `known_models` hints alike. A list always proves
   * PRESENCE; this says whether an absence from it is proof too. `authoritative`
   * (the default when omitted) keeps the strict gate: a model the list lacks is
   * refused. `advisory` means the harness cannot enumerate what its runtime
   * accepts, so the gate forwards the explicit model byte-identical and discloses it.
   */
  model_inventory_absence: z
    .enum(["authoritative", "advisory"])
    .optional()
    .describe(
      "Whether an absence from this harness's model lists (the live models() answer and the manifest known_models alike) proves a model is ABSENT; omitted = authoritative (an unlisted model is refused). advisory = absence is not proof, so an explicit model is forwarded to the vendor and disclosed instead of refused.",
    ),
  model_routing_variants: ModelRoutingVariants.optional(),
  model_refused_variants: z
    .array(RefusedModelVariant)
    .min(1)
    .optional()
    .describe(
      "Request-time suffixes this harness refuses in any position after the base id, whether or not a catalog lists the id or could be read. Omitted = none.",
    ),
};

/**
 * Proof that a stream-observed model string names one listed model. Cursor's
 * stream reports the vendor's display label ("GPT-5.5 High") while runs request
 * the listed id; the observed string itself is never rewritten. A match exists
 * only when the same spawn's own account catalog lists exactly one live entry
 * whose label is byte-identical to the string and no other entry uses the
 * string as its id. Absence means no proof, never a mismatch.
 */
export const ObservedModelCatalogMatch = z
  .object({
    label: NonBlankString.describe(
      "The observed model string, byte-identical to observed_model on the same event and to the matched entry's catalog label.",
    ),
    id: NonBlankString.describe(
      "Id of the only catalog entry whose label is exactly `label`; no other entry has `label` as its id.",
    ),
    source: z
      .enum(["account_catalog"])
      .describe("The model list the spawn's own account answered before the vendor process ran."),
    // A fresh instance, not the shared Id: generated schemas inline it
    // instead of re-anchoring existing $refs on this field.
    profile_id: z
      .string()
      .min(1)
      .nullable()
      .describe(
        "Credential profile whose catalog answered (the spawn's profile); null = engine-default credentials.",
      ),
  })
  .strict()
  .describe(
    "Exact same-spawn catalog evidence mapping an observed model label to its listed id; never derived from the requested model, normalized or fuzzy-matched.",
  );
export type ObservedModelCatalogMatch = z.infer<typeof ObservedModelCatalogMatch>;

/** HarnessEvent model identity: the vendor's raw string and its catalog proof. */
export const ObservedModelEventFields = {
  observed_model: z.string().optional().describe("Model the harness actually reported using."),
  observed_model_catalog_match: ObservedModelCatalogMatch.optional().describe(
    "Stamped by the per-spawn model gate from that spawn's own account catalog; adapters never set it, and the gate strips any value it did not compute.",
  ),
};

/** Attempt model identity: the first disclosed string and the proof of that same event. */
export const AttemptObservedModelFields = {
  observed_model: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "Model the harness stream actually reported; null when never disclosed (rendered as unverified, never guessed).",
    ),
  observed_model_catalog_match: ObservedModelCatalogMatch.nullable()
    .default(null)
    .describe(
      "Catalog proof carried by the same event that set observed_model, kept only while no later native try of the attempt started and no later event reported another model; null otherwise, even if a later try's event carried one.",
    ),
};
