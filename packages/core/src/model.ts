import { observeHarnessProgram, assertSameProgram } from "./program-observation.js";
import type { HarnessProgramIdentity } from "@claudexor/schema";
import type {
  HarnessCapabilities,
  HarnessModel,
  HarnessRunSpec,
  ModelInventoryAbsence,
  ModelRoutingVariant,
  RefusedModelVariant,
} from "@claudexor/schema";
import { ObservedModelCatalogMatch } from "@claudexor/schema";
import type {
  HarnessAdapter,
  HarnessModelSpec,
  ModelCatalogCredential,
  ModelCatalogFailure,
  ModelCatalogObservation,
} from "./adapter.js";

/** A model somebody chose, byte-identical; a blank string was never a choice. */
export function chosenModel(model: string | null | undefined): string | null {
  return model && model.trim() ? model : null;
}

/** The refusal of a route that must name a model and has none (#395), with what
 * repairs it once; null when the route has a model or its vendor chooses one. */
export function missingRouteModel(
  adapter: Pick<HarnessAdapter, "id" | "modelRequirement">,
  requested: string | null | undefined,
): string | null {
  const requirement = adapter.modelRequirement;
  if (!requirement || requirement.instanceChoice || chosenModel(requested)) return null;
  const { id } = adapter;
  return (
    `${id} needs a model and none is selected; nothing was sent. ` +
    `List its models with \`claudexor models --harness ${id}\`, then save one once with ` +
    `\`claudexor settings set harness.${id}.default_model <model>\`, pass it for this run` +
    `${requirement.env ? `, or set ${requirement.env}` : ""}.`
  );
}

/** A route-scoped producer is queried only for a known supported route.
 * Undeclared producers retain legacy behavior; failed producers never fall back. */
export function hasModelInventoryForRoute(
  adapter: Pick<HarnessAdapter, "models">,
  declaredRoutes: Readonly<HarnessCapabilities["model_inventory_routes"]>,
  route: "local_session" | "api_key" | null,
): adapter is Pick<HarnessAdapter, "models"> & Required<Pick<HarnessAdapter, "models">> {
  return (
    typeof adapter.models === "function" &&
    (declaredRoutes === undefined || (route !== null && declaredRoutes.includes(route)))
  );
}

/**
 * Validate a requested/configured model id against a harness's model truth
 * source — the model analog of the effort normalizer (`normalizeEffort`).
 * Data-driven: the caller supplies the truth list (live `models()` inventory
 * or manifest `known_models`) AND the harness's declaration of what an
 * absence from its lists proves (`model_inventory_absence`, INV-104). There
 * are no defaults: every caller states which list it holds and what that list
 * may refuse with, and no model id is ever hardcoded here.
 *
 * A list always proves PRESENCE. Where the harness declares absence
 * `authoritative` (the declaration a manifest gets when it says nothing), the
 * list is a complete enumeration and the strict rule holds:
 * - no model requested (null/empty) → ok (the harness default is used).
 * - truth list empty → rejected: the harness cannot verify models, so an
 *   EXPLICIT model is refused with actionable text instead of being forwarded
 *   to the vendor CLI to die as an opaque native error.
 * - requested ∈ list → ok.
 * - requested carries declared routing segments (#145) and the id without them
 *   is listed → ok with a note naming the variant and its billing effect.
 * - requested carries a declared REFUSED segment (OpenRouter `:online`) →
 *   rejected first, whatever the list says or whether it could be read.
 * - requested ∉ list → rejected, naming the truth source and the list. An
 *   empty list from a typed catalog read is a successful empty catalog and is
 *   phrased as one, without account/auth advice.
 *
 * ADVISORY (owner-approved 2026-09-21 for a live producer, 2026-09-24 for the
 * harness as a whole): a miss and an empty list are both `ok` with an
 * `unverified` note. The gate decides nothing it cannot prove; the explicit
 * model travels to the vendor unchanged and the vendor accepts or refuses it.
 * The declaration belongs to the HARNESS, not to one of its lists: a manifest
 * hint list is one day's memory of the same vendor menu the live producer
 * reads, so it can refuse no more than that producer can. No other list is
 * consulted — nothing is ever substituted to admit a model.
 */
export type ModelCheckStatus = "ok" | "rejected";
export interface ModelCheck {
  status: ModelCheckStatus;
  message: string | null;
  /** True only on an `ok` the truth source did not list verbatim: absence was
   * unprovable (an advisory harness), or the id is a declared routing variant
   * of a listed row. Callers that can disclose (the per-spawn gate, the
   * settings response, readiness detail) say so once; nothing depends on it. */
  unverified?: boolean;
  /** Set on a refusal caused by a FAILED catalog read (a missing or rejected
   * credential), never by a miss: consumers raise their typed
   * catalog-unavailable refusal from it. */
  catalogFailure?: ModelCatalogFailure;
  /** Set on a refusal caused by a declared refused variant, never by a miss. */
  refusedVariant?: RefusedModelVariant;
}

/** What else the caller knows about a list it validates against. */
export interface ModelListDetail {
  /** The list came from a typed successful catalog read, so an empty list is an
   * empty catalog rather than a fail-soft producer's possible failure. */
  catalogRead?: boolean;
  /** The harness's declared request-time routing suffixes (#145). */
  routingVariants?: readonly ModelRoutingVariant[];
  /** Request-time suffixes the harness refuses whatever a list says (#393). */
  refusedVariants?: readonly RefusedModelVariant[];
}

/** A catalog read as consumers hold it. `failSoft` marks a legacy `models()`
 * answer, whose [] may be a failed read and is therefore no catalog evidence. */
export type ModelCatalogRead = { sourceProgram: HarnessProgramIdentity | null } & (
  | {
      status: "listed";
      models: HarnessModel[];
      failSoft: boolean;
      credential?: ModelCatalogCredential;
    }
  | { status: "unavailable"; failure: ModelCatalogFailure; credential?: ModelCatalogCredential }
);

/** The one way consumers read a live catalog: a producer that types its
 * failures answers through `modelCatalog`; a fail-soft `models()` answer passes
 * through unchanged, and a throw from it still propagates as before. */
export async function readModelCatalog(
  adapter: Pick<HarnessAdapter, "models" | "modelCatalog" | "program">,
  spec?: HarnessModelSpec,
): Promise<ModelCatalogRead> {
  const before = await observeHarnessProgram(adapter.program, spec?.env, undefined, {
    fresh: spec?.fresh,
  });
  const read = adapter.modelCatalog
    ? await adapter.modelCatalog(spec)
    : { status: "listed" as const, models: (await adapter.models?.(spec)) ?? [] };
  assertSameProgram(before, await observeHarnessProgram(adapter.program, spec?.env));
  return read.status === "listed"
    ? { ...read, failSoft: !adapter.modelCatalog, sourceProgram: before.program }
    : { ...read, sourceProgram: before.program };
}

const DISPATCH_MODEL_CATALOG = "dispatchModelCatalog";

/** The spec one spawn sends, carrying the typed catalog read its dispatch gate
 * made at that spawn's credential identity (#146, #147). */
export function withDispatchModelCatalog(
  spec: HarnessRunSpec,
  read: ModelCatalogObservation,
): HarnessRunSpec {
  return { ...spec, extra: { ...spec.extra, [DISPATCH_MODEL_CATALOG]: read } };
}

/** The catalog read this spawn's dispatch gate made, so `run()` never reads the
 * same catalog again; undefined when the gate read none. */
export function dispatchModelCatalog(spec: HarnessRunSpec): ModelCatalogObservation | undefined {
  const read = spec.extra?.[DISPATCH_MODEL_CATALOG] as ModelCatalogObservation | undefined;
  return read?.status === "listed" || read?.status === "unavailable" ? read : undefined;
}

/** One phrase for a failed read, shared by every disclosure and refusal. */
export function modelCatalogFailureText(failure: ModelCatalogFailure): string {
  const status = failure.httpStatus === null ? "" : `HTTP ${failure.httpStatus}: `;
  return `the live model catalog could not be read (${failure.cause}; ${status}${failure.detail})`;
}

/** A failed read that still refuses an explicit model: no usable credential,
 * or the endpoint rejected it (HTTP 401/403). The request would be sent with
 * that same credential, so nothing is forwarded on it (#393, decision A). */
export function modelCatalogFailureRefuses(failure: ModelCatalogFailure): boolean {
  return failure.cause === "no_credential" || failure.cause === "auth_rejected";
}

/** What a refusal names as the way out of a missing or rejected credential. */
function catalogFailureRemedy(failure: ModelCatalogFailure): string {
  return failure.cause === "no_credential"
    ? "configure this route's API key (its environment variable or the selected profile's stored secret)"
    : "the endpoint rejected the API key: replace it or check its access";
}

/**
 * A live catalog read that FAILED is not a list (#393): it neither admits an
 * explicit model nor proves it absent. Owner decision A (2026-10-29): when the
 * catalog is temporarily unavailable or unusable (no answer, a timeout, another
 * HTTP status, a malformed or partial answer), an EXPLICIT model is forwarded
 * byte-identical on the same key with a note that it could not be verified;
 * the provider accepts or refuses it. A missing or rejected credential still
 * refuses with the read's typed cause (`catalogFailure`), as does a declared
 * refused variant. An advisory harness forwards any failure, as before.
 */
export function validateModelOnUnreadCatalog(
  requested: string | null | undefined,
  failure: ModelCatalogFailure,
  absence: ModelInventoryAbsence,
  detail: Pick<ModelListDetail, "refusedVariants"> = {},
): ModelCheck {
  const model = typeof requested === "string" ? requested.trim() : "";
  if (!model) return { status: "ok", message: null };
  const refused = refusedVariantCheck(model, detail.refusedVariants ?? []);
  if (refused) return refused;
  if (absence === "advisory")
    return {
      status: "ok",
      message: `${modelCatalogFailureText(failure)}; ${UNPROVABLE_ABSENCE}`,
      unverified: true,
    };
  if (modelCatalogFailureRefuses(failure))
    return {
      status: "rejected",
      message: `${modelCatalogFailureText(failure)}, so model "${model}" cannot be verified; ${catalogFailureRemedy(failure)}`,
      catalogFailure: failure,
    };
  return {
    status: "ok",
    message: `${modelCatalogFailureText(failure)}, so model "${model}" could not be verified; it is sent unchanged on the same key and the provider accepts or refuses it`,
    unverified: true,
  };
}

/** The refusal of an id carrying a declared refused suffix in any position
 * after its base (OpenRouter documents any-order suffixes), else null. */
function refusedVariantCheck(
  model: string,
  refused: readonly RefusedModelVariant[],
): ModelCheck | null {
  const segments = model.split(":").slice(1);
  const variant = refused.find((v) => segments.includes(v.suffix.slice(1)));
  if (!variant) return null;
  return {
    status: "rejected",
    message: `model "${model}" carries the ${variant.suffix} variant, which this harness refuses: ${REFUSAL_REASON[variant.reason]}`,
    refusedVariant: variant,
  };
}

const REFUSAL_REASON: Record<RefusedModelVariant["reason"], string> = {
  provider_web_search:
    "the provider would search the web for the request, outside this route's web policy",
};

/** The listed row a routing-variant id names (#145). OpenRouter documents that
 * suffixes combine in any order, with at most one catalog variant and any
 * number of routing variants, so every DECLARED routing segment after the base
 * id is removed and every other segment stays (m:nitro:free -> m:free). That
 * row must itself be listed; nothing is assumed about catalog variants. Null
 * when the id carries no declared routing segment. */
export function routingVariantOf(
  model: string,
  variants: readonly ModelRoutingVariant[],
): { metadataId: string; variants: ModelRoutingVariant[] } | null {
  const [base, ...segments] = model.split(":");
  if (!base) return null;
  const applied: ModelRoutingVariant[] = [];
  const kept = segments.filter((segment) => {
    const variant = variants.find((v) => v.suffix === `:${segment}`);
    if (variant) applied.push(variant);
    return !variant;
  });
  return applied.length > 0 ? { metadataId: [base, ...kept].join(":"), variants: applied } : null;
}

/** The catalog row whose metadata applies to a requested id: the exact row,
 * else the listed row its declared routing variant names. */
export function catalogRowFor(
  model: string,
  rows: readonly HarnessModel[],
  variants: readonly ModelRoutingVariant[],
): HarnessModel | null {
  const exact = rows.find((row) => row.id === model);
  if (exact) return exact;
  const variant = routingVariantOf(model, variants);
  return (variant && rows.find((row) => row.id === variant.metadataId)) ?? null;
}

function routingVariantNote(
  model: string,
  variant: NonNullable<ReturnType<typeof routingVariantOf>>,
): string {
  const tiered = variant.variants.filter((v) => v.billing === "service_tier").map((v) => v.suffix);
  return (
    `model "${model}" is listed model "${variant.metadataId}" with routing variant ` +
    `${variant.variants.map((v) => v.suffix).join("")}; it is sent unchanged, the provider picks the endpoint, and ` +
    (tiered.length > 0
      ? `${tiered.join(" and ")} may bill that endpoint's service-tier rate instead of the listed price`
      : "it bills the listed price")
  );
}

/** Where the truth list came from; used to phrase actionable refusals. */
export type ModelTruthSource = "api" | "manifest";

/** The note a forwarded (unverifiable) model carries. One sentence, frozen:
 * what the list said, why it cannot refuse, and what happens instead. */
const UNPROVABLE_ABSENCE =
  "this harness's list cannot prove a model is absent, so the request is forwarded to the vendor";

export function validateModel(
  requested: string | null | undefined,
  known: readonly string[],
  source: ModelTruthSource,
  absence: ModelInventoryAbsence,
  detail: ModelListDetail = {},
): ModelCheck {
  const model = typeof requested === "string" ? requested.trim() : "";
  if (!model) return { status: "ok", message: null };
  const refused = refusedVariantCheck(model, detail.refusedVariants ?? []);
  if (refused) return refused;
  const advisory = absence === "advisory";
  if (known.includes(model)) return { status: "ok", message: null };
  const variant = routingVariantOf(model, detail.routingVariants ?? []);
  if (variant && known.includes(variant.metadataId))
    return { status: "ok", message: routingVariantNote(model, variant), unverified: true };
  if (known.length === 0) {
    if (advisory) {
      return {
        status: "ok",
        message: `${source === "api" ? "the harness returned no model list" : "the harness manifest lists no models"}; ${UNPROVABLE_ABSENCE}`,
        unverified: true,
      };
    }
    if (detail.catalogRead && source === "api")
      return {
        status: "rejected",
        message: `model "${model}" is not in the harness's live model inventory (the catalog lists no models)`,
      };
    return {
      status: "rejected",
      message:
        `this harness cannot verify models (no ${source === "api" ? "live model inventory" : "manifest known_models"}); ` +
        (source === "api"
          ? "repair the live account/auth route or use the harness default (omit the model)"
          : "use the harness default (omit the model) or add known_models to the manifest"),
    };
  }
  if (advisory) {
    return {
      status: "ok",
      message: `model "${model}" is not in ${source === "api" ? "this account's listed models" : "this harness's manifest known-model list"}; ${UNPROVABLE_ABSENCE}`,
      unverified: true,
    };
  }
  const shown = known.slice(0, 80).join(", ");
  const suffix = known.length > 80 ? `, ... (${known.length} total)` : "";
  return {
    status: "rejected",
    message: `model "${model}" is not in the harness's ${source === "api" ? "live model inventory" : "manifest known-model list"} (${shown}${suffix})`,
  };
}

/**
 * Catalog proof for a stream-observed model string, or null. A stream may
 * report the vendor's display label instead of the listed id. The proof names
 * that id only when exactly one live row of THIS spawn's catalog carries a
 * label byte-identical to `observed` and no other row uses `observed` as its
 * id. Nothing is trimmed, case-folded or taken from the requested model, and a
 * result the schema would reject is no proof either.
 */
export function observedModelCatalogMatch(
  observed: string,
  catalog: readonly HarnessModel[],
  profileId: string | null,
): ObservedModelCatalogMatch | null {
  const labelled = catalog.filter((row) => row.origin !== "hint" && row.label === observed);
  const entry = labelled.length === 1 ? labelled[0] : undefined;
  if (!entry || catalog.some((row) => row.id === observed && row.id !== entry.id)) return null;
  const match = ObservedModelCatalogMatch.safeParse({
    label: observed,
    id: entry.id,
    source: "account_catalog",
    profile_id: profileId,
  });
  return match.success ? match.data : null;
}
