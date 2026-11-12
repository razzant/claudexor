import type { AdapterRegistry, ModelAdapter } from "@claudexor/core";
import { credentialProfilePolicyState } from "@claudexor/core";
import { loadConfigCached } from "@claudexor/config";
import {
  ModelOperations,
  ModelCapabilityLedger,
  type PreProgressRefusalLedger,
  type AccountServiceEvidence,
  type ModelSubstitutionLedger,
  type CredentialUnusableLedger,
  type DaemonClient,
  type ModelOperationDependencies,
  type ModelOperationPersistence,
  type QuotaRegistry,
} from "@claudexor/daemon";
import { createCodexModelAdapter } from "@claudexor/harness-codex";
import { resolveAccountForRun } from "@claudexor/orchestrator";
import {
  ControlModelCatalogResponse,
  ControlModelAccountCatalogResponse,
  ControlProblem,
  GlobalConfig,
  type CredentialProfile,
  type ImageCallRequest,
  type QuotaRequestKind,
  type ModelAccountChoice,
  type ModelCallResult,
  type ModelRoutingEvidence,
  type JobAdmission,
} from "@claudexor/schema";
import {
  errorCode,
  noProjectRepoRoot,
  redactSecrets,
  measureModelPreparation,
  measureModelPreparationSync,
} from "@claudexor/util";
import { accountsMigrationGate } from "./accounts-unified-migration.js";
import { buildRegistry } from "./registry.js";
import { afterRetention, type RetentionRunner } from "./retention-lifetime.js";
import { catalogProfiles, enumerateAccountCatalogs } from "./account-catalog.js";
import { bindModelAccountEvidence, withImageAccountEvidence } from "./model-account-evidence.js";
import { modelOperationControlServices } from "./model-operation-control.js";
import { selectModelCatalog } from "./model-catalog-selection.js";
import { historyBoundTo, modelCapabilityOutcome } from "./model-capability-outcome.js";
import { admitModelAccount, liveAccountRefusal } from "./model-account-admission.js";
import { ModelLoginReadiness } from "./model-login-readiness.js";
import { modelCredentialRead } from "./model-credential-read.js";
import { modelError, poolExhausted } from "./model-service-refusals.js";

interface ModelSource {
  adapter: ModelAdapter;
  label: string;
  credentialHarness: string;
}

type Dependencies = ModelOperationPersistence &
  Pick<ModelOperationDependencies, "resources" | "warn"> & {
    client: Pick<DaemonClient, "enqueue" | "cancel">;
    admission?: (id: string) => JobAdmission | null;
    quota: () => QuotaRegistry;
    config?: () => GlobalConfig;
    registry?: AdapterRegistry;
    sources?: readonly ModelSource[];
    /** The store graph's ledgers (`createAccountEvidence`); model-substitution
     * observations are produced and consumed only by model operations. */
    unusable: CredentialUnusableLedger;
    substitutions: ModelSubstitutionLedger;
    capabilities?: ModelCapabilityLedger;
    refusals?: PreProgressRefusalLedger;
    /** The graph's durable last-served facts: read by the Auto pool choice,
     * never written here (only Agent and Ask tries serve). */
    lastService?: Pick<AccountServiceEvidence, "orders"> | null;
    migrationGate?: typeof accountsMigrationGate;
  };

/** Model transport composition shares account, quota, command, and retention owners
 * with Agents. It never starts an Agent Run or creates another routing ledger. */
export function createModelServices(deps: Dependencies) {
  const sources = deps.sources ?? [
    { adapter: createCodexModelAdapter(), label: "Codex", credentialHarness: "codex" },
  ];
  const registry = deps.registry ?? buildRegistry({ includeFakes: false });
  const config = deps.config ?? (() => loadConfigCached(noProjectRepoRoot()).global);
  const { unusable, substitutions } = deps;
  const capabilities = deps.capabilities ?? new ModelCapabilityLedger(unusable.credentials);
  const quotaEvidence = () => ({ ...deps.quota().read(), honored: unusable.honored() });
  // Selection judges each window at the decision, exactly like run admission (#457).
  const admissionEvidence = () => ({ ...quotaEvidence(), ...deps.quota().readAdmission() });
  const lifetime = new AbortController();
  const readiness = new ModelLoginReadiness(capabilities.credentials);
  const readSignal = (signal?: AbortSignal) =>
    signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  const getSource = (id: string): ModelSource => {
    const source = sources.find((entry) => entry.adapter.id === id);
    if (!source) throw modelError("model_source_unavailable", "No such model source", 404);
    const migration = (deps.migrationGate ?? accountsMigrationGate)(source.credentialHarness);
    if (migration) throw modelError("accounts_migration_incomplete", migration.reason, 503);
    return source;
  };

  const resolve = async (
    source: ModelSource,
    account: ModelAccountChoice,
    model: string | null,
    signal: AbortSignal,
    options: {
      excluded?: Set<string>;
      excludedFingerprint?: string | null;
      correlatedRetry?: boolean;
      unmarkedOnly?: boolean;
      seen?: { capable: boolean };
      poolEvents?: ModelRoutingEvidence["poolEvents"];
      boundHistory?: (profileId: string, fingerprint: string | null) => boolean;
    } = {},
  ) => {
    signal = readSignal(signal);
    return measureModelPreparation("selection", async () => {
      const admitted = await measureModelPreparation("admission", () =>
        admitAccount(source, account, model, signal),
      );
      return resolveCatalog(source, account, model, signal, admitted, options);
    });
  };

  const admitAccount = (
    source: ModelSource,
    account: ModelAccountChoice,
    model: string | null,
    signal: AbortSignal,
  ) =>
    admitModelAccount({
      source,
      account,
      model,
      signal,
      config,
      registry,
      readiness,
      quotaEvidence,
      unusable,
    });

  /** After a wait, only the picked account's own live facts decide again. */
  const recheck = (
    admitted: Awaited<ReturnType<typeof admitAccount>>,
    model: string | null,
    requestKind: QuotaRequestKind,
    profileId: string,
    quota = admissionEvidence(),
  ) =>
    liveAccountRefusal({
      ...admitted,
      profileId,
      model,
      requestKind,
      config: config(),
      quota,
      unusable: unusable.live(),
    });

  /** One pool pick for the given model, or a typed pool refusal. The resolver
   * never generates; an `excluded` set lets a selection epoch move on. */
  const pickAccount = async (
    source: ModelSource,
    account: ModelAccountChoice,
    model: string | null,
    admitted: Awaited<ReturnType<typeof admitAccount>>,
    excluded: Set<string>,
    catalogRefusals: Map<string, ControlProblem>,
    requestKind: QuotaRequestKind = "text",
    poolEvents: ModelRoutingEvidence["poolEvents"] = [],
  ): Promise<CredentialProfile> => {
    const { harnessId, policy, profiles, probe, pinnedProfile } = admitted;
    for (;;) {
      const currentQuota = admissionEvidence();
      let profile: CredentialProfile | null;
      try {
        profile = await resolveAccountForRun({
          harnessId,
          registry: profiles,
          policy,
          profileCardinality: credentialProfilePolicyState({
            adapter: registry.get(harnessId),
            registry: profiles,
          }),
          snapshots: currentQuota.snapshots,
          requestKind,
          quota: currentQuota,
          unusable: unusable.live(),
          substitutions: substitutions.live(),
          refusals: deps.refusals?.live(),
          lastService: deps.lastService,
          probe,
          pinnedProfile,
          boundProfileId:
            account.mode === "auto" &&
            !capabilities.state(harnessId, account.preferredProfileId ?? "", model) &&
            !deps.refusals
              ?.live()
              .some(
                (row) =>
                  row.harness_id === harnessId &&
                  row.profile_id === account.preferredProfileId &&
                  row.requested_model === model,
              )
              ? (account.preferredProfileId ?? null)
              : null,
          threadId: null,
          model,
          excludedProfileIds: excluded,
          defaultRoute: null,
          // Model calls cannot borrow an unregistered/default login or a paid route.
          nativeCredentialsDisabled: true,
          authPreference: "subscription",
          notePoolApiKeyRoute: () => {},
          emit: (type, payload) => {
            poolEvents.push({ type, payload });
          },
        });
      } catch (error) {
        admitted.signal.throwIfAborted();
        if (errorCode(error) !== "credential_pool_exhausted") throw error;
        // Causes of this decision: a live block outranks an earlier refusal.
        const causes = new Map(catalogRefusals);
        for (const [id, refusal] of causes) {
          const live = await recheck(admitted, model, requestKind, id, currentQuota);
          causes.set(id, live ?? refusal);
        }
        throw poolExhausted(source.adapter.id, error, causes);
      }
      if (!profile)
        throw modelError("model_account_unavailable", "Connect a managed account for model calls");
      // A pin was judged after its probe; a pool pick on facts read before them.
      if (pinnedProfile) return profile;
      const refusal = await recheck(admitted, model, requestKind, profile.profile_id);
      if (!refusal) return profile;
      catalogRefusals.set(profile.profile_id, refusal);
      excluded.add(profile.profile_id);
    }
  };

  const resolveCatalog = async (
    source: ModelSource,
    account: ModelAccountChoice,
    model: string | null,
    signal: AbortSignal,
    admitted: Awaited<ReturnType<typeof admitAccount>>,
    options: {
      excluded?: Set<string>;
      excludedFingerprint?: string | null;
      correlatedRetry?: boolean;
      unmarkedOnly?: boolean;
      seen?: { capable: boolean };
      poolEvents?: ModelRoutingEvidence["poolEvents"];
      boundHistory?: (profileId: string, fingerprint: string | null) => boolean;
    } = {},
  ) =>
    selectModelCatalog({
      adapter: source.adapter,
      harnessId: source.credentialHarness,
      account,
      model,
      signal,
      capabilities,
      unusable,
      quota: deps.quota,
      warn: deps.warn,
      refusals: () => deps.refusals?.live(),
      substitutions: () => substitutions.live(),
      recheck: (profile) => recheck(admitted, model, "text", profile.profile_id),
      ...options,
      pick: (excluded, refusals) =>
        pickAccount(
          source,
          account,
          model,
          admitted,
          excluded,
          refusals,
          "text",
          options.poolEvents,
        ),
    });

  /** Images share readiness, quota and credential generations, with explicit
   * request-kind scope and no text catalog membership requirement. */
  const resolveImage = async (
    request: ImageCallRequest,
    signal: AbortSignal,
  ): Promise<{ profile: CredentialProfile; adapter: ModelAdapter }> => {
    signal = readSignal(signal);
    const source = getSource(request.source);
    const image = source.adapter.image;
    if (!image)
      throw modelError(
        "model_source_unavailable",
        "This model source declares no image operations",
        404,
      );
    const admitted = await admitAccount(source, request.account, request.model, signal);
    const profile = await pickAccount(
      source,
      request.account,
      request.model,
      admitted,
      new Set<string>(),
      new Map<string, ControlProblem>(),
      "image",
    );
    return {
      profile,
      adapter: {
        ...source.adapter,
        image: withImageAccountEvidence(image, {
          sourceId: source.adapter.id,
          harnessId: source.credentialHarness,
          profileId: profile.profile_id,
          unusable,
          quota: deps.quota,
          warn: deps.warn,
        }),
      },
    };
  };

  const operations = new ModelOperations({
    commands: deps.commands,
    resourceQueries: deps.resourceQueries,
    resources: deps.resources,
    warn: deps.warn,
    enqueue: ({ request, ...options }) => deps.client.enqueue(request, options),
    cancel: (id, reason) => deps.client.cancel(id, reason),
    resolveImage,
    resolve: async (request, signal, operationId) => {
      const source = getSource(request.source);
      const retry = capabilities.claimRetry(request, operationId);
      const excluded = new Set(retry ? [retry.binding.profileId] : []);
      const poolEvents: ModelRoutingEvidence["poolEvents"] = [];
      const select = () =>
        resolve(source, request.account, request.model, signal, {
          excluded,
          excludedFingerprint: retry?.binding.fingerprint,
          correlatedRetry: retry !== null,
          poolEvents,
          boundHistory: (profileId, fingerprint) =>
            historyBoundTo(request, { profileId, fingerprint }),
        });
      let selected = await select();
      let binding = capabilities.bind(source.credentialHarness, selected.catalog, request.model);
      signal.throwIfAborted();
      while (
        request.account.mode === "auto" &&
        !measureModelPreparationSync("reserve", () => capabilities.reserve(binding, operationId))
      ) {
        excluded.add(selected.profile.profile_id);
        try {
          selected = await select();
        } catch (error) {
          const pool = ControlProblem.safeParse(
            error && typeof error === "object" && "problem" in error ? error.problem : null,
          );
          if (!pool.success || !pool.data.context.poolCause) throw error;
          // Another operation owns the probe, but a mark never excludes the
          // last eligible account. Dispatch without acquiring that probe.
          selected = { ...selected, reason: "marked_fallback" };
          break;
        }
        binding = capabilities.bind(source.credentialHarness, selected.catalog, request.model);
        signal.throwIfAborted();
      }
      if (capabilities.changed(binding))
        throw modelError(
          "auth_changed",
          "The selected account changed after catalog discovery; try a new operation.",
        );
      const { profile, catalog } = selected;
      const release = () => capabilities.release(binding, operationId);
      signal.addEventListener("abort", release, { once: true });
      const routing: ModelRoutingEvidence = {
        selectionReason: selected.reason,
        poolEvents,
        ...(request.retryOfOperationId ? { retryOfOperationId: request.retryOfOperationId } : {}),
      };
      return {
        profile,
        adapter: {
          ...source.adapter,
          invoke: async (input, context) => {
            const evidence = bindModelAccountEvidence({
              harnessId: source.credentialHarness,
              profileId: profile.profile_id,
              model: input.model,
              unusable,
              quota: deps.quota,
            });
            let dispatched = false;
            try {
              const served = await source.adapter.invoke(input, {
                ...context,
                signal: readSignal(context.signal),
                catalog,
                onDispatch: async (route) => {
                  await context.onDispatch(route);
                  dispatched = true;
                },
              });
              // A typed fact about this generation, never a changed outcome: set
              // only when a terminal response disclosed a model and its exact id
              // differs from the requested one. The caller decides what to do.
              const observed = served.route.model;
              const result: ModelCallResult =
                (served.outcome === "completed" || served.outcome === "incomplete") &&
                observed !== null &&
                observed !== input.model
                  ? { ...served, modelMismatch: { requested: input.model, observed } }
                  : served;
              // Evidence maintenance must not erase an already-received model result.
              try {
                // The next Auto selection for this model prefers other accounts.
                if (result.modelMismatch && evidence.current())
                  substitutions.record({
                    harness_id: source.credentialHarness,
                    profile_id: profile.profile_id,
                    requested_model: result.modelMismatch.requested,
                  });
                if (
                  result.route.source === source.adapter.id &&
                  result.route.credentialProfileId === profile.profile_id
                )
                  evidence.observe(
                    result.problem,
                    result.usage,
                    result.route.model,
                    dispatched && result.outcome === "failed",
                  );
              } catch (error) {
                deps.warn?.(
                  `Model account evidence was not recorded: ${redactSecrets(String(error))}`,
                );
              }
              try {
                return await modelCapabilityOutcome({
                  request: input,
                  result,
                  operationId,
                  binding,
                  retry,
                  ledger: capabilities,
                  refusals: deps.refusals,
                  routing,
                  dispatched,
                  hasAlternative: async () => {
                    const seen = { capable: false };
                    try {
                      await resolve(source, { mode: "auto" }, input.model, signal, {
                        excluded: new Set([profile.profile_id]),
                        excludedFingerprint: binding.fingerprint,
                        unmarkedOnly: true,
                        seen,
                      });
                      return { clean: true, capable: true };
                    } catch {
                      return { clean: false, capable: seen.capable };
                    }
                  },
                });
              } catch (error) {
                deps.warn?.(
                  `Model capability evidence was not recorded: ${redactSecrets(String(error))}`,
                );
                return { ...result, routing };
              }
            } finally {
              signal.removeEventListener("abort", release);
              release();
              try {
                evidence.finish();
              } catch (error) {
                deps.warn?.(
                  `Model account evidence finalization failed: ${redactSecrets(String(error))}`,
                );
              }
            }
          },
        },
      };
    },
  });
  return {
    operations,
    routes: {
      modelSources: async (view?: "accounts") => ({
        sources: sources.map(({ adapter, label, credentialHarness }) => ({
          id: adapter.id,
          label,
          credentialHarness,
          ...(view === "accounts"
            ? {
                processingPreferences: ["standard", "fast", "economy"],
                accountCatalog: true,
                // Structural declaration from the adapter; absent means no image operations.
                ...(adapter.image ? { imageGeneration: adapter.image.capability } : {}),
              }
            : {}),
        })),
      }),
      modelCatalog: async (
        sourceId: string,
        credentialProfileId?: string,
        requestedModel?: string,
        includeAdmission = false,
        signal?: AbortSignal,
      ) => {
        if (includeAdmission && !requestedModel)
          throw modelError("invalid_request", "Admission observation requires requestedModel", 400);
        const source = getSource(sourceId);
        const { catalog } = await resolve(
          source,
          credentialProfileId ? { mode: "pin", profileId: credentialProfileId } : { mode: "auto" },
          requestedModel ?? null,
          readSignal(signal),
        );
        return {
          ...catalog,
          ...(includeAdmission
            ? {
                admission: {
                  requestedModel: requestedModel!,
                  inventoryAbsence: source.adapter.inventoryAbsence ?? "authoritative",
                },
              }
            : {}),
          models: catalog.models.map(({ processing: _processing, ...model }) => model),
        };
      },
      modelAccountCatalog: async (
        sourceId: string,
        credentialProfileId?: string,
        signal?: AbortSignal,
      ) => {
        const source = getSource(sourceId);
        const context = { config: config(), quota: quotaEvidence(), unusable: unusable.live() };
        const adapter = registry.get(source.credentialHarness);
        const accounts = await enumerateAccountCatalogs({
          observationKey: `model-source:${sourceId}`,
          signal: readSignal(signal),
          context,
          adapter: adapter?.probeCredentialProfile
            ? {
                ...adapter,
                probeCredentialProfile: (profile, signal) =>
                  readiness.probe(profile, adapter, signal ?? lifetime.signal),
              }
            : adapter,
          profiles: catalogProfiles(context, source.credentialHarness, credentialProfileId, true),
          read: async (profile, canReadCatalog, physicalSignal) => {
            physicalSignal.throwIfAborted();
            if (!canReadCatalog) return null;
            const { value, generation } = await modelCredentialRead(
              capabilities.credentials,
              source.credentialHarness,
              profile,
              physicalSignal,
              (signal, credentialGeneration) =>
                source.adapter.catalog({ profile, signal, credentialGeneration }),
            );
            const catalog = ControlModelCatalogResponse.parse(value);
            if (catalog.source !== sourceId || catalog.credentialProfileId !== profile.profile_id)
              throw modelError(
                "model_catalog_identity_mismatch",
                "The model catalog does not identify the requested account",
              );
            capabilities.observeCatalog(source.credentialHarness, catalog, generation);
            return catalog;
          },
        });
        return ControlModelAccountCatalogResponse.parse({
          source: sourceId,
          accounts,
          partial: accounts.some((entry) => entry.catalog === null),
        });
      },
      ...modelOperationControlServices(operations, deps.admission),
    },
    withRetention: (run: RetentionRunner): RetentionRunner =>
      afterRetention(run, (request, receipt) => {
        const modelPayloads = operations.reconcileResources(request.dry_run);
        receipt.errors.push(...modelPayloads.errors);
        if (request.model_payload_report) receipt.model_payloads = modelPayloads;
      }),
    close: () => {
      lifetime.abort("host_cancelled");
      readiness.close();
      operations.close();
    },
  };
}
