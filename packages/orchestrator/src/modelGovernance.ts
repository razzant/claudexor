/**
 * STRICT run-preflight model gate (INV-104): every route that resolved an
 * explicit model (per-run map or per-harness settings default) must pass its
 * harness's model truth source — the live `models()` inventory when the
 * adapter has one, else the manifest `known_models` list. A violation throws
 * a typed error BEFORE any vendor CLI spawns; the orchestrator surfaces it
 * through the routing-failure path, so failure.yaml names harness, model, and
 * truth source.
 *
 * Two rules keep the gate honest about WHICH account answered:
 * - The inventory is asked of the account the run will actually use. A
 *   profile-pinned route derives its auth route from that profile's credential
 *   kind, and the query carries the profile's own state HOME, so model truth
 *   can never come from the default credential store.
 * - Nothing about the spawned spec is rewritten to make the two agree. A
 *   profile-less `auto` run is enumerated with the same `auto` preference the
 *   adapter will resolve, so preflight and spawn share one resolution instead
 *   of the gate freezing a route the adapter would then be unable to disclose.
 *
 * A fallback model is checked by the authoritative per-spawn gate only after
 * its own quota/profile preflight; checking it against the primary profile
 * here would reject a valid cross-profile fallback.
 *
 * What a list may refuse with is the HARNESS's declaration: where the adapter
 * declared `model_inventory_absence: "advisory"`, its live inventory and its
 * manifest hints alike prove presence but not absence, so an unlisted explicit
 * model is forwarded to the vendor unchanged and disclosed once by the
 * per-spawn gate. An authoritative harness (the declaration a silent manifest
 * gets) refuses as before, and no gate ever swaps one list for another to
 * admit a model. A live read that FAILED is not a list at all (#393, owner
 * decision A): a missing or rejected credential refuses the explicit model at
 * both gates with the read's typed cause (`ModelCatalogUnavailableError`, core
 * `validateModelOnUnreadCatalog`); any other failure forwards it unverified on
 * the same key, disclosed once by the per-spawn gate. A declared refused
 * variant is refused either way.
 *
 * A failure never erases what this run already read: the route keeps its most
 * recent successful read, and a later failed read at the SAME credential
 * identity is answered by that earlier read (its rows, presence and windows),
 * disclosed as such. That identity is the profile AND the key: both reads must
 * carry the producer's same key fingerprint, because a stored secret or key
 * variable replaced mid-run keeps its profile id. Nothing is read again for it
 * and nothing outlives the route; another identity, a read that names no key,
 * or a credential failure never borrows it.
 *
 * The per-spawn gate reads the catalog ONCE per spawn, at the identity the
 * vendor process receives, and that one read serves every consumer of the
 * spawn: the explicit model, the size of a RawContextPacket the request inlines
 * (#147) and the adapter's own disclosures (#146), so none of them can judge
 * the request by another read. Where the producer binds its key to the read
 * (`credential`), the request sends that same key: one replaced while the
 * packet is prepared is first read, and sent, by the next spawn.
 *
 * A route that must name a model and has none refuses here too (#395), for any
 * dispatch that did not come through run admission: nothing is read or sent. When
 * the model it sends is the instance's own choice, the run says where that came from.
 */
import { RoutingPreflightError, billingKnowledgeForAuthRoute } from "@claudexor/budget";
import type { AuthVerification, EffortResolution, PaidFallback } from "@claudexor/schema";
import type {
  HarnessAdapter,
  ModelCatalogFailure,
  ModelCatalogObservation,
  RawRequestCapacity,
} from "@claudexor/core";
import {
  HarnessUnavailableError,
  ModelCatalogUnavailableError,
  ModelSelectionRequiredError,
  RawContextRefusalError,
  abortSignalFromSpec,
  effortResolutionEvent,
  modelCatalogFailureRefuses,
  modelCatalogFailureText,
  missingRouteModel,
  readModelCatalog,
  resolveEffortEvidence,
  validateModel,
  validateModelOnUnreadCatalog,
  hasModelInventoryForRoute,
  prepareHarnessProcessing,
  admitPreparedProcessing,
  observeCredentialExecution,
  observedModelCatalogMatch,
  withDispatchModelCatalog,
} from "@claudexor/core";
import {
  knownModelIdsForRoute,
  type CredentialProfile,
  type HarnessCapabilities,
  type HarnessEvent,
  type HarnessModel,
  type HarnessRunSpec,
  type KnownModelEntry,
  type ModelInventoryAbsence,
  type ProcessingReceipt,
  type RawContextPacket,
} from "@claudexor/schema";
import { nowIso } from "@claudexor/util";
import { ProcessingBudgetAdmissionError } from "./processing-dispatch.js";

export interface ModelGovernedRoute {
  adapter: HarnessAdapter;
  /** Manifest model truth source (used when the adapter has no live models()). */
  knownModels: readonly KnownModelEntry[];
  /** The adapter's declared live-inventory contract, read from its manifest:
   * WHICH credential routes its `models()` producer answers for, WHAT its
   * answer proves about a model it does not list (`model_inventory_absence`;
   * omitted = `authoritative` = today's refusal), and which request-time
   * routing suffixes a listed row admits (#145). They travel together so a
   * caller cannot supply one and silently lose another. */
  modelInventory?: Readonly<
    Pick<
      HarnessCapabilities,
      | "model_inventory_routes"
      | "model_inventory_absence"
      | "model_routing_variants"
      | "model_refused_variants"
    >
  >;
  /** The most recent successful typed catalog read on this route, and the
   * credential identity it was read under (profile id, null = the engine
   * default; the producer's key fingerprint, null = it named none). Written by
   * the gates of this run only (see the file comment). */
  lastListedCatalog?: {
    profileId: string | null;
    credentialFingerprint: string | null;
    models: HarnessModel[];
    observedAt: string;
  };
  /** Pre-spawn credential-route estimate: route-annotated manifest models are
   * filtered by it, and stay EXCLUDED when it is null (fail-closed — a
   * route-scoped model never passes the gate on an undecidable route). */
  authRouteEstimate: "local_session" | "api_key" | null;
  /** Effective account after profile preflight/rotation. Model truth must come
   * from this same identity, never the default credential store. */
  quotaAdmission: { profile: CredentialProfile | null };
  billingVerificationForProfile?: (profile: CredentialProfile) => Promise<AuthVerification>;
  paidFallback?: PaidFallback;
  settings: { defaultModel: string | null; fallbackModel: string | null } | null;
  /** Speed the lane chose without a preference (see RoutedAdapter). */
  processingIntent?: ProcessingReceipt;
}

type ModelCandidate = { role: string; model: string };
type ModelTruth = {
  list: readonly string[];
  source: "api" | "manifest";
  route: "local_session" | "api_key" | null;
  /** The harness's own declaration (INV-104), honoured for the live list and
   * the manifest hints alike; no list is ever substituted to admit a model. */
  absence: ModelInventoryAbsence;
  /** Set when the live read failed: `list` is then empty and proves nothing. */
  failure?: ModelCatalogFailure;
  /** The list is a typed successful read (its [] is an empty catalog). */
  catalogRead: boolean;
  /** That typed read itself, rows with their metadata or its failure; absent
   * for a manifest list or a fail-soft producer. */
  observation?: ModelCatalogObservation;
  /** This read failed and the route's earlier successful read at the same
   * identity answers instead: the failure, and when that earlier read was. */
  earlierRead?: { failure: ModelCatalogFailure; observedAt: string };
};

/** A pinned profile decides the route by its credential kind; without one the
 * pre-spawn estimate stands (and stays fail-closed when undecidable). */
function authRouteForProfile(
  profile: CredentialProfile | null,
  estimate: ModelGovernedRoute["authRouteEstimate"],
): ModelGovernedRoute["authRouteEstimate"] {
  if (!profile) return estimate;
  return profile.credential_kind === "api_key" ? "api_key" : "local_session";
}

async function modelTruthForRoute(
  routed: ModelGovernedRoute,
  query: {
    cwd: string;
    env?: HarnessRunSpec["env"];
    authPreference?: HarnessRunSpec["auth_preference"];
    profile: CredentialProfile | null;
  },
): Promise<ModelTruth> {
  const route = authRouteForProfile(query.profile, routed.authRouteEstimate);
  if (
    hasModelInventoryForRoute(routed.adapter, routed.modelInventory?.model_inventory_routes, route)
  ) {
    const read = await readModelCatalog(routed.adapter, {
      cwd: query.cwd,
      ...(query.env ? { env: query.env } : {}),
      ...(query.authPreference ? { authPreference: query.authPreference } : {}),
      ...(query.profile ? { credentialProfile: query.profile } : {}),
    });
    const profileId = query.profile?.profile_id ?? null;
    // The key this read sent travels with every observation the gate hands
    // on, so the spawn's request sends that key (see the file comment).
    const credential = read.credential;
    if (read.status === "listed" && !read.failSoft)
      routed.lastListedCatalog = {
        profileId,
        credentialFingerprint: credential?.fingerprint ?? null,
        models: read.models,
        observedAt: nowIso(),
      };
    const earlier = routed.lastListedCatalog;
    if (
      read.status === "unavailable" &&
      !modelCatalogFailureRefuses(read.failure) &&
      credential &&
      earlier?.profileId === profileId &&
      earlier.credentialFingerprint === credential.fingerprint
    )
      return {
        list: earlier.models.map((model) => model.id),
        source: "api",
        route,
        absence: routed.modelInventory?.model_inventory_absence ?? "authoritative",
        catalogRead: true,
        observation: { status: "listed", models: earlier.models, credential },
        earlierRead: { failure: read.failure, observedAt: earlier.observedAt },
      };
    return {
      list: read.status === "listed" ? read.models.map((model) => model.id) : [],
      source: "api",
      route,
      absence: routed.modelInventory?.model_inventory_absence ?? "authoritative",
      ...(read.status === "unavailable" ? { failure: read.failure, observation: read } : {}),
      catalogRead: read.status === "listed" && !read.failSoft,
      ...(read.status === "listed" && !read.failSoft
        ? { observation: { status: "listed" as const, models: read.models, credential } }
        : {}),
    };
  }
  // The manifest hint list is judged under the SAME declaration as the live
  // answer: it is one day's memory of the vendor menu that producer reads,
  // so it can refuse no more than the producer can (owner decision 2026-09-24).
  return {
    list: knownModelIdsForRoute(routed.knownModels, route),
    source: "manifest",
    route,
    absence: routed.modelInventory?.model_inventory_absence ?? "authoritative",
    catalogRead: false,
  };
}

/** Throws on a refused candidate; returns the notes of the candidates a truth
 * source admitted WITHOUT being able to verify them, so the caller that can
 * disclose does it once. */
function assertModelsAllowed(
  routed: ModelGovernedRoute,
  candidates: readonly ModelCandidate[],
  truth: ModelTruth,
  profile: CredentialProfile | null,
): string[] {
  const unverified: string[] = [];
  const refusedVariants = routed.modelInventory?.model_refused_variants ?? [];
  for (const { role, model } of candidates) {
    const check = truth.failure
      ? validateModelOnUnreadCatalog(model, truth.failure, truth.absence, { refusedVariants })
      : validateModel(model, truth.list, truth.source, truth.absence, {
          catalogRead: truth.catalogRead,
          routingVariants: routed.modelInventory?.model_routing_variants ?? [],
          refusedVariants,
        });
    if (check.status === "ok") {
      if (check.unverified && check.message) unverified.push(check.message);
      continue;
    }
    if (check.catalogFailure)
      throw new ModelCatalogUnavailableError(
        `harness '${routed.adapter.id}' refused ${role} '${model}' (truth source: api): ${check.message}`,
        check.catalogFailure,
      );
    if (check.refusedVariant)
      throw new HarnessUnavailableError(
        `harness '${routed.adapter.id}' refused ${role} '${model}': ${check.message}`,
      );
    // A pinned profile OWNS this inventory: sending the operator to the
    // profile-less `claudexor models` would print a different account's list.
    // Observations only — which account supplied which list — never a cause
    // guess ("re-authenticate", "plan", "entitlement") the gate cannot know.
    const remedy = profile
      ? `the selected credential profile '${profile.profile_id}' supplied this ${truth.source === "api" ? "live inventory" : "manifest list"} (${truth.list.length} models); inspect that profile's own vendor model list`
      : `run \`claudexor models --harness ${routed.adapter.id}\``;
    throw new HarnessUnavailableError(
      `harness '${routed.adapter.id}' refused ${role} '${model}' (truth source: ${truth.source}${truth.source === "manifest" ? `, route: ${truth.route ?? "undecided"}` : ""}): ${check.message}; ` +
        remedy,
    );
  }
  return unverified;
}

/** True when the spawn's own model truth LISTS `model` as an id (never an
 * unverifiable forward): an attested model is pinned on a continued session
 * only then, so an observed display label is never sent as a model id. */
export async function routeListsModel(
  routed: ModelGovernedRoute,
  spec: HarnessRunSpec,
  model: string,
): Promise<boolean> {
  try {
    const truth = await modelTruthForRoute(routed, {
      cwd: spec.cwd,
      env: spec.env,
      ...(spec.auth_preference ? { authPreference: spec.auth_preference } : {}),
      profile: spec.credential_profile ?? null,
    });
    return truth.list.includes(model.trim());
  } catch {
    return false;
  }
}

export async function assertRouteModelsAllowed(
  routes: readonly ModelGovernedRoute[],
  models: Record<string, string> | undefined,
  cwd: string,
  /** The mutable state HOME the eventual spawn will receive for this harness,
   * so an account-scoped inventory is read from that same home. */
  routeStateEnvFor?: (harnessId: string) => Record<string, string> | undefined,
): Promise<void> {
  const checked = new Set<string>();
  for (const routed of routes) {
    const id = routed.adapter.id;
    if (checked.has(id)) continue;
    checked.add(id);
    const resolved = models?.[id] ?? routed.settings?.defaultModel ?? null;
    if (!resolved) continue;
    const profile = routed.quotaAdmission.profile;
    const routeStateEnv = routeStateEnvFor?.(id);
    const truth = await modelTruthForRoute(routed, {
      cwd,
      ...(routeStateEnv ? { env: routeStateEnv } : {}),
      profile,
    });
    assertModelsAllowed(routed, [{ role: "model", model: resolved }], truth, profile);
  }
}

/** Refresh account evidence and admit one send without replacing captured Processing. */
export async function admitCurrentProfileDispatch(
  routed: Pick<ModelGovernedRoute, "billingVerificationForProfile" | "paidFallback">,
  spec: HarnessRunSpec,
): Promise<void> {
  if (spec.credential_profile && routed.billingVerificationForProfile) {
    // The dispatched row can differ from admission after rotation/model fallback.
    // Default-store readiness and the original row's entitlement never follow it.
    spec.extra["routeBillingKnowledge"] = billingKnowledgeForAuthRoute({
      route:
        spec.credential_profile.credential_kind === "api_key" ? "managed_api_key" : "vendor_native",
      verification: await routed.billingVerificationForProfile(spec.credential_profile),
    });
  }
  spec.extra["paidFallback"] = routed.paidFallback;
  await admitPreparedProcessing(spec);
  const markStarted = spec.extra["markPhysicalDispatchStarted"];
  if (typeof markStarted === "function") (markStarted as () => void)();
}

/** What `runModelGovernedRoute` refuses with BEFORE anything is sent: budget
 * or routing admission, no model on a route that must name one, an unreadable
 * catalog, an undeliverable packet. An
 * attempt records it as its declared failure, never as a crashed harness. */
export type DispatchRefusal =
  | ProcessingBudgetAdmissionError
  | RoutingPreflightError
  | ModelCatalogUnavailableError
  | ModelSelectionRequiredError
  | RawContextRefusalError;

export function isDispatchRefusal(err: unknown): err is DispatchRefusal {
  return (
    err instanceof ProcessingBudgetAdmissionError ||
    err instanceof RoutingPreflightError ||
    err instanceof ModelCatalogUnavailableError ||
    err instanceof ModelSelectionRequiredError ||
    err instanceof RawContextRefusalError
  );
}

/**
 * Authoritative per-spawn model gate. Admission validates the initially routed
 * account early; this guard rebinds the same strict truth contract to the
 * profile, auth preference, cwd, and mutable state HOME the vendor process will
 * actually receive. Every routed spawn funnels through this generator, so a
 * quota rotation or fallback-model preflight cannot reuse another account's
 * inventory. The gate reads the run's identity, it never rewrites it; what it
 * adds is this spawn's own catalog read and, for a `rawContext` caller, the
 * packet sized from it.
 */
export async function* runModelGovernedRoute(
  routed: ModelGovernedRoute,
  spec: HarnessRunSpec,
  /** `rawContext` builds this spawn's RawContextPacket for the capacity of the
   * gate's own catalog read (#147); the caller keeps the packet it returns. */
  dispatch: {
    rawContext?: (capacity: RawRequestCapacity | null) => Promise<RawContextPacket>;
  } = {},
): AsyncIterable<HarnessEvent> {
  const missingModel = missingRouteModel(routed.adapter, spec.model_hint);
  if (missingModel) throw new ModelSelectionRequiredError(missingModel);
  let nativeModel: string | null = null;
  let preparedEffort: EffortResolution | undefined;
  let catalog: readonly HarnessModel[] = [];
  if (spec.processing_preference || routed.adapter.prepareProcessing) {
    // The lane's own intent (an Exact Retry original included); a copied
    // retry/rotation spec otherwise still carries the first account's choice.
    const chosen = routed.processingIntent ?? spec.processing;
    const prepared = await prepareHarnessProcessing(routed.adapter, {
      preference: spec.processing_preference,
      model: spec.model_hint,
      effort: spec.effort_hint,
      credentialProfile: spec.credential_profile,
      cwd: spec.cwd,
      env: spec.env,
      authPreference: spec.auth_preference,
      allowPaid: spec.processing_allow_paid,
      ...(spec.processing_preference === undefined && chosen ? { chosen } : {}),
    });
    nativeModel = prepared.model;
    preparedEffort = prepared.effort;
    catalog = prepared.catalog ?? [];
    spec = { ...spec, processing: prepared.receipt, processing_cost_basis: prepared.costBasis };
  }
  const model = spec.model_hint?.trim();
  const unverified: string[] = [];
  const instanceChoice = routed.adapter.modelRequirement?.instanceChoice;
  if (instanceChoice && instanceChoice.model === spec.model_hint)
    unverified.push(`model "${instanceChoice.model}" is set by ${instanceChoice.source}`);
  const profile = spec.credential_profile ?? null;
  const truth =
    model || dispatch.rawContext
      ? await modelTruthForRoute(routed, {
          cwd: spec.cwd,
          env: spec.env,
          authPreference: spec.auth_preference,
          profile,
        })
      : null;
  // Said before any model note: which read the notes and the packet stand on.
  if (truth?.earlierRead)
    unverified.push(
      `${modelCatalogFailureText(truth.earlierRead.failure)} at dispatch; this run's earlier ` +
        `catalog read with the same credentials (${truth.earlierRead.observedAt}) answers for ` +
        "the model and its limits",
    );
  if (model && truth) {
    unverified.push(...assertModelsAllowed(routed, [{ role: "model", model }], truth, profile));
    if (nativeModel && nativeModel !== model) {
      unverified.push(
        ...assertModelsAllowed(
          routed,
          [{ role: "native processing model", model: nativeModel }],
          truth,
          profile,
        ),
      );
    }
  }
  if (dispatch.rawContext) {
    // Sized before admission: a packet that cannot be delivered spends nothing.
    const rows = truth?.observation?.status === "listed" ? truth.observation.models : [];
    const capacity = routed.adapter.rawRequestCapacity?.(spec, rows) ?? null;
    spec = { ...spec, raw_context_packet: await dispatch.rawContext(capacity) };
  }
  await admitCurrentProfileDispatch(routed, spec);
  if (spec.processing?.reason === "processing_control_unavailable") {
    yield {
      type: "status",
      ts: new Date().toISOString(),
      session_id: spec.session_id,
      processing: spec.processing,
      text: "Processing preference is unavailable; using ordinary native execution.",
    };
  }
  // A model this gate could not verify is DISCLOSED once, here, instead of
  // refused: the run log and the receipt say the vendor, not the gate, decided.
  // Preflight stays silent so one spawn speaks once.
  if (unverified.length > 0) {
    yield {
      type: "status",
      ts: new Date().toISOString(),
      session_id: spec.session_id,
      text: unverified.join("; "),
    };
  }
  // ONE effort receipt per spawn. A model-id carrier (Cursor, Antigravity)
  // produced it in the same preparation that chose `processing.submittedNative`,
  // so the id sent, the level and this disclosure cannot disagree; a route with
  // no effort carrier at all records the preference as omitted here; a flag
  // adapter (Claude, Codex, ACP) emits its own receipt at its final route.
  if (preparedEffort) yield effortResolutionEvent(spec.session_id, preparedEffort, spec);
  else if (!routed.adapter.effortParameter) {
    yield effortResolutionEvent(
      spec.session_id,
      resolveEffortEvidence(spec.effort_hint, [], [], "adapter", null),
    );
  }
  // The disclosures above are yields; a run stopped at one of them is not
  // dispatched when its consumer keeps reading to drain teardown evidence.
  if (abortSignalFromSpec(spec)?.aborted) return;
  const sent = truth?.observation ? withDispatchModelCatalog(spec, truth.observation) : spec;
  const events = stampObservedModelCatalogMatch(
    routed.adapter.run(sent),
    catalog,
    sent.credential_profile?.profile_id ?? null,
  );
  yield* observeCredentialExecution(routed.adapter.id, sent, events);
}

/**
 * The gate is the only author of `observed_model_catalog_match`: it
 * resolves each disclosed model string against THIS spawn's catalog, and only
 * on events of the profile that catalog was read for. Whatever it did not
 * compute is stripped, so no stale or adapter-supplied proof travels on.
 */
async function* stampObservedModelCatalogMatch(
  events: AsyncIterable<HarnessEvent>,
  catalog: readonly HarnessModel[],
  profileId: string | null,
): AsyncIterable<HarnessEvent> {
  for await (const event of events) {
    if (!event.observed_model && event.observed_model_catalog_match === undefined) {
      yield event;
      continue;
    }
    const match =
      event.observed_model && (event.credential_profile_id ?? null) === profileId
        ? observedModelCatalogMatch(event.observed_model, catalog, profileId)
        : null;
    const { observed_model_catalog_match: _stripped, ...rest } = event;
    yield match ? { ...rest, observed_model_catalog_match: match } : rest;
  }
}
