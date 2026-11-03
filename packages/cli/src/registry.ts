import {
  hasModelInventoryForRoute,
  modelCatalogFailureRetryable,
  modelCatalogFailureText,
  readModelCatalog,
  validateModel,
  validateModelOnUnreadCatalog,
  type ModelCatalogFailure,
  type ModelCheck,
  type AdapterRegistry,
  type HarnessAdapter,
} from "@claudexor/core";
import {
  ControlHarnessAccountModelsResponse,
  ControlProblem,
  harnessHasDefaultCredentialStore,
  type ControlHarnessModelsResponse,
  type ModelInventoryAbsence,
  type ModelRoutingVariant,
  type RefusedModelVariant,
} from "@claudexor/schema";
import { HarnessGateway } from "@claudexor/gateway";
import { createAgyAdapter } from "@claudexor/harness-agy";
import { copilot, createAcpAdapter } from "@claudexor/harness-acp";
import { createClaudeAdapter } from "@claudexor/harness-claude";
import { createCodexAdapter } from "@claudexor/harness-codex";
import { createCursorAdapter } from "@claudexor/harness-cursor";
import { FAKE_KINDS, createFakeHarness } from "@claudexor/harness-fake";
import { createOpenCodeAdapter } from "@claudexor/harness-opencode";
import { createGrokAdapter } from "@claudexor/harness-grok";
import { createRawApiAdapter } from "@claudexor/harness-raw-api";
import {
  catalogProfiles,
  enumerateAccountCatalogs,
  type AccountCatalogContext,
} from "./account-catalog.js";

import { retainAccountProbeObservations } from "./account-observations.js";

/**
 * The request-time routing variants the OpenRouter instance admits on a listed
 * model id (#145). Provenance: OpenRouter's public model-variants overview,
 * https://openrouter.ai/docs/guides/routing/model-variants/overview (read
 * 2026-10-28 and 2026-10-29): `:nitro` sorts providers by throughput and
 * admits priority-tier endpoints billed at their priority rate; `:floor` sorts
 * by price and admits flex-tier endpoints billed at their flex rate; `:exacto`
 * sorts by tool-calling quality and does not change billing. Suffixes combine
 * in any order, with at most one catalog variant. Every undeclared suffix is
 * admitted only by exact catalog membership.
 */
export const OPENROUTER_ROUTING_VARIANTS: readonly ModelRoutingVariant[] = [
  { suffix: ":nitro", billing: "service_tier" },
  { suffix: ":floor", billing: "service_tier" },
  { suffix: ":exacto", billing: "base" },
];

/** The OpenRouter instance's identity, endpoint and default key variable:
 * one declaration for its adapter and its key-allowance source. */
export function openRouterInstance() {
  return {
    id: "openrouter",
    baseUrl: process.env.CLAUDEXOR_OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
  };
}

/** `:online` (same documentation; deprecated there) runs provider web search
 * for the request: live egress outside this route's `web_policy: none`. It is
 * refused even while the catalog cannot be read, when an explicit model is
 * otherwise forwarded unverified (#393). */
export const OPENROUTER_REFUSED_VARIANTS: readonly RefusedModelVariant[] = [
  { suffix: ":online", reason: "provider_web_search" },
];

export interface RegistryOptions {
  /** Register the fake-harness suite (so `--harness fake-*` works). Default true. */
  includeFakes?: boolean;
}

/**
 * Build the adapter registry. All real adapters are always registered;
 * the gateway only selects doctor-OK non-fake harnesses by default. Fakes are
 * registered for explicit `--harness`. An `openrouter` raw-API instance is the
 * direct-API path for explicitly requested auxiliary models when its key exists.
 */
export function buildRegistry(opts: RegistryOptions = {}): AdapterRegistry {
  const registry: AdapterRegistry = new Map();
  for (const adapter of [
    createCodexAdapter(),
    createAgyAdapter(),
    createAcpAdapter(copilot),
    createClaudeAdapter(),
    createCursorAdapter(),
    createOpenCodeAdapter(),
    createGrokAdapter(),
    createRawApiAdapter(),
    createRawApiAdapter({
      ...openRouterInstance(),
      providerFamily: "unknown",
      providerUsageCostUnit: "usd",
      modelEnv: "CLAUDEXOR_OPENROUTER_MODEL",
      routingVariants: OPENROUTER_ROUTING_VARIANTS,
      refusedVariants: OPENROUTER_REFUSED_VARIANTS,
    }),
  ]) {
    registry.set(adapter.id, retainAccountProbeObservations(adapter));
  }
  if (opts.includeFakes !== false) {
    for (const kind of FAKE_KINDS) registry.set(kind, createFakeHarness(kind));
  }
  return registry;
}

export function buildGateway(opts: RegistryOptions = {}): HarnessGateway {
  return new HarnessGateway(buildRegistry(opts));
}

/** A harness's model truth for the unscoped listing: the list itself plus the
 * harness's own declaration of what an absence from it proves (INV-104). The
 * two travel together so no consumer can hold one and silently lose the other. */
export type HarnessModelTruth = {
  response: ControlHarnessModelsResponse;
  absence: ModelInventoryAbsence;
  /** Set when the live read failed: the empty list proves nothing (#393). */
  failure?: ModelCatalogFailure;
  /** The list is a typed successful read, so its [] is an empty catalog. */
  catalogRead?: boolean;
  routingVariants?: readonly ModelRoutingVariant[];
  refusedVariants?: readonly RefusedModelVariant[];
};

/** The control-API face of a failed read; the typed cause stays in context. */
export function catalogFailureProblem(failure: ModelCatalogFailure): ControlProblem {
  return ControlProblem.parse({
    code: "model_catalog_unavailable",
    message: modelCatalogFailureText(failure),
    retryable: modelCatalogFailureRetryable(failure),
    context: { cause: failure.cause, httpStatus: failure.httpStatus },
  });
}

/**
 * Resolve enumerable models for one harness (ADP4). The SSOT shared by the
 * control-api `harnessModels` service and the CLI `models` command, so both
 * surfaces report identical truth: `source: "api"` when the adapter has a real
 * models() producer, `"manifest"` when the manifest's known-good hint set is
 * the truth source (with the CLI version it was verified against), `"none"`
 * only when the harness has no truth source at all. Fails soft for the picker:
 * a typed failed read answers `source: "api"`, no models and a `problem`, never
 * an apparently empty catalog (#393).
 */
export async function harnessModelTruth(
  harnessId: string,
  cwd: string,
  includeFakes = false,
  route?: "local_session" | "api_key",
): Promise<HarnessModelTruth> {
  const none: ControlHarnessModelsResponse = {
    harnessId,
    models: [],
    source: "none",
    verifiedAgainst: null,
  };
  const adapter = buildRegistry({ includeFakes }).get(harnessId);
  if (!adapter) return { response: none, absence: "authoritative" };
  const manifest = await adapter.discover();
  const absence = manifest.capabilities.model_inventory_absence ?? "authoritative";
  const routingVariants = manifest.capabilities.model_routing_variants ?? [];
  const refusedVariants = manifest.capabilities.model_refused_variants ?? [];
  // The declared suffixes travel with the rows they apply to (#146): a
  // surface resolves a variant id to its listed row without guessing.
  const declared = routingVariants.length > 0 ? { routingVariants: [...routingVariants] } : {};
  if (
    hasModelInventoryForRoute(adapter, manifest.capabilities.model_inventory_routes, route ?? null)
  ) {
    // A live enumeration already reflects the credentials it ran under; the
    // route filter applies to manifest annotations only.
    const read = await readModelCatalog(adapter, {
      cwd,
      ...(route
        ? { authPreference: route === "api_key" ? ("api_key" as const) : ("subscription" as const) }
        : {}),
    });
    if (read.status === "unavailable") {
      const problem = catalogFailureProblem(read.failure);
      const response = { harnessId, models: [], source: "api" as const, verifiedAgainst: null };
      return {
        response: { ...response, problem },
        absence,
        failure: read.failure,
        refusedVariants,
      };
    }
    const rows = read.models.map(({ processing: _processing, ...model }) => ({
      ...model,
      routes: model.routes ?? null,
    }));
    // A harness whose subscription accounts are all named rows has no account
    // for this profile-less query, so an empty answer read no catalog (INV-104).
    if (rows.length === 0 && route !== "api_key" && !harnessHasDefaultCredentialStore(harnessId))
      return { response: none, absence };
    const hintsOnly = answeredOnlyHints(rows);
    return {
      response: {
        harnessId,
        models: rows,
        source: hintsOnly ? "manifest" : "api",
        verifiedAgainst: hintsOnly ? manifest.capabilities.known_models_verified_against : null,
        ...declared,
      },
      absence,
      catalogRead: !read.failSoft,
      routingVariants,
      refusedVariants,
    };
  }
  const known = manifest.capabilities.known_models.filter((entry) =>
    // Route filter (one matcher shape with the governance gate): a bare string
    // is every-route; an annotated entry must include the requested route.
    typeof entry === "string" ? true : route === undefined || entry.routes.includes(route),
  );
  if (known.length === 0) return { response: none, absence };
  return {
    response: {
      harnessId,
      models: known.map((entry) =>
        typeof entry === "string"
          ? { id: entry, label: null, context_window: null, routes: null }
          : { id: entry.id, label: null, context_window: null, routes: entry.routes },
      ),
      source: "manifest",
      verifiedAgainst: manifest.capabilities.known_models_verified_against,
      ...declared,
    },
    absence,
    routingVariants,
    refusedVariants,
  };
}

/** A producer that labels its rows (`origin`) and answered ONLY hint rows could
 * not read the vendor: that is manifest truth with its frozen freshness stamp,
 * never a live `api` claim (INV-104) — on the unscoped listing and on every
 * account row alike. Producers that emit no `origin` are live by definition. */
function answeredOnlyHints(rows: readonly { origin?: string | undefined }[]): boolean {
  return rows.length > 0 && rows.every((row) => row.origin === "hint");
}

/** The unscoped model list alone (the wire shape of `/harnesses/:id/models`). */
export async function harnessModels(
  harnessId: string,
  cwd: string,
  includeFakes = false,
  route?: "local_session" | "api_key",
): Promise<ControlHarnessModelsResponse> {
  return (await harnessModelTruth(harnessId, cwd, includeFakes, route)).response;
}

/**
 * Judge one explicit model against a harness's truth: ONE owner for the
 * (list, source, declaration) triple that the settings write, the doctor's
 * configured-model readiness and the capability catalog used to assemble by
 * hand — and were silently strict for every harness (INV-104). An
 * authoritative harness refuses a miss; an advisory one admits it with the
 * `unverified` note the caller surfaces.
 */
export function checkHarnessModelTruth(truth: HarnessModelTruth, model: string): ModelCheck {
  const refusedVariants = truth.refusedVariants ?? [];
  if (truth.failure)
    return validateModelOnUnreadCatalog(model, truth.failure, truth.absence, { refusedVariants });
  return validateModel(
    model,
    truth.response.models.map((entry) => entry.id),
    truth.response.source === "api" ? "api" : "manifest",
    truth.absence,
    {
      catalogRead: truth.catalogRead === true,
      routingVariants: truth.routingVariants ?? [],
      refusedVariants,
    },
  );
}

/** `harnessModelTruth` + `checkHarnessModelTruth` for callers holding one model. */
export async function checkHarnessModel(
  harnessId: string,
  model: string,
  cwd: string,
  includeFakes = false,
): Promise<{ truth: ControlHarnessModelsResponse; check: ModelCheck }> {
  const truth = await harnessModelTruth(harnessId, cwd, includeFakes);
  return { truth: truth.response, check: checkHarnessModelTruth(truth, model) };
}

/** Opt-in account inventory. The legacy unscoped CLI/model list above keeps its exact contract. */
export async function harnessAccountModels(
  input: AccountCatalogContext & {
    harnessId: string;
    cwd: string;
    credentialProfileId?: string;
    route?: "local_session" | "api_key";
    registry?: AdapterRegistry;
  },
): Promise<ControlHarnessAccountModelsResponse> {
  const adapter = (input.registry ?? buildRegistry({ includeFakes: false })).get(input.harnessId);
  const profiles = catalogProfiles(input, input.harnessId, input.credentialProfileId);
  // The account view is explicitly route-scoped. Keep the durable account
  // rows separate, but do not enumerate a credential from the other route.
  // A conflicting explicit pin is a typed unavailable account rather than a
  // silent cross-route fallback.
  const routeProfiles = input.route
    ? profiles.filter(
        (profile) =>
          (profile.credential_kind === "api_key" ? "api_key" : "local_session") === input.route,
      )
    : profiles;
  if (input.route && routeProfiles.length === 0 && input.credentialProfileId) {
    throw Object.assign(
      new Error("The pinned catalog account does not support the requested route"),
      {
        code: "model_account_unavailable",
        status: 409,
        retryable: false,
      },
    );
  }
  // Discovery is host-level capability data, shared by this request's rows.
  let manifestPromise: ReturnType<HarnessAdapter["discover"]> | undefined;
  const accounts = await enumerateAccountCatalogs({
    observationKey: `agent-models:${input.cwd}:${input.route ?? "all"}`,
    context: input,
    adapter,
    profiles: routeProfiles,
    read: async (profile, canReadCatalog) => {
      if (!adapter) return null;
      const manifest = await (manifestPromise ??= adapter.discover());
      const route = profile.credential_kind === "api_key" ? "api_key" : "local_session";
      if (
        canReadCatalog &&
        hasModelInventoryForRoute(adapter, manifest.capabilities.model_inventory_routes, route)
      ) {
        const read = await readModelCatalog(adapter, {
          cwd: input.cwd,
          credentialProfile: profile,
        });
        // A typed failed read keeps its cause on the account row (#393).
        if (read.status === "unavailable")
          throw Object.assign(new Error(modelCatalogFailureText(read.failure)), {
            problem: catalogFailureProblem(read.failure),
          });
        const models = read.models;
        // A fail-soft producer also returns [] on transport failures; that is
        // not a receipt proving this account has an empty vendor inventory.
        if (models.length === 0 && read.failSoft) return null;
        // A profile probe that could not read the vendor answers hint rows
        // only; that account row is manifest truth, not a live enumeration.
        const hintsOnly = answeredOnlyHints(models);
        return {
          harnessId: input.harnessId,
          credentialProfileId: profile.profile_id,
          models: models.map((model) => ({ ...model, routes: model.routes ?? null })),
          source: hintsOnly ? ("manifest" as const) : ("api" as const),
          verifiedAgainst: hintsOnly ? manifest.capabilities.known_models_verified_against : null,
          // models() may reuse a provider-owned cache and carries no observation receipt.
          observedAt: null,
          provenance: hintsOnly ? "manifest" : "adapter_models",
        };
      }
      const known = manifest.capabilities.known_models.filter(
        (entry) => typeof entry === "string" || entry.routes.includes(route),
      );
      if (known.length === 0) return null;
      return {
        harnessId: input.harnessId,
        credentialProfileId: profile.profile_id,
        models: known.map((entry) =>
          typeof entry === "string"
            ? { id: entry, label: null, context_window: null, routes: null }
            : { id: entry.id, label: null, context_window: null, routes: entry.routes },
        ),
        source: "manifest" as const,
        verifiedAgainst: manifest.capabilities.known_models_verified_against,
        observedAt: null,
        provenance: "manifest",
      };
    },
  });
  return ControlHarnessAccountModelsResponse.parse({
    harnessId: input.harnessId,
    accounts,
    partial: accounts.some((entry) => entry.catalog === null),
  });
}
