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
import {
  probeCredentialProfileStatus,
  profileStatusAdmits,
  resolveAccountForRun,
  resolveCredentialProfile,
  composeCredentialProfileEvidence,
  applicableCredentialUnusable,
  vendorCredentialObservation,
} from "@claudexor/orchestrator";
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
import { errorCode, noProjectRepoRoot, redactSecrets } from "@claudexor/util";
import { accountsMigrationGate } from "./accounts-unified-migration.js";
import { buildRegistry } from "./registry.js";
import { afterRetention, type RetentionRunner } from "./retention-lifetime.js";
import { catalogProfiles, enumerateAccountCatalogs } from "./account-catalog.js";
import { bindModelAccountEvidence, withImageAccountEvidence } from "./model-account-evidence.js";
import { modelOperationControlServices } from "./model-operation-control.js";
import { selectModelCatalog } from "./model-catalog-selection.js";
import { historyBoundTo, modelCapabilityOutcome } from "./model-capability-outcome.js";
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
    const admitted = await admitAccount(source, account, model, signal);
    return resolveCatalog(source, account, model, signal, admitted, options);
  };

  /** Pin/pool admission shared by text and image selection: harness enabled,
   * managed-login rows only, strict pin revocation and probe checks. */
  const admitAccount = async (
    source: ModelSource,
    account: ModelAccountChoice,
    model: string | null,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const cfg = config();
    const harnessId = source.credentialHarness;
    const harness = cfg.harnesses[harnessId];
    if (harness?.enabled === false)
      throw modelError("model_source_unavailable", "This model source is disabled in settings");
    // The first model transport admits only the existing managed-login rows.
    // API-key and OAuth secret-reference rows remain Agent capabilities.
    const profiles = cfg.credential_profiles.filter(
      (row) => row.credential_kind === "config_dir_login",
    );
    let pinnedProfile: CredentialProfile | null = null;
    if (account.mode === "pin") {
      try {
        pinnedProfile = resolveCredentialProfile(profiles, account.profileId, harnessId);
      } catch {
        throw modelError(
          "model_account_unavailable",
          "The pinned managed model account is unknown, disabled, or incompatible",
        );
      }
    }
    const probe = registry.get(harnessId)?.probeCredentialProfile?.bind(registry.get(harnessId));
    const quota = quotaEvidence();
    if (pinnedProfile) {
      // Preserve a confirmed sign-in remedy across subsequent pinned calls.
      // Local probe failures and generic unavailability do not prove revocation.
      const evidence = { quota, unusable: unusable.live(), model, route: "vendor_native" as const };
      const refusal = applicableCredentialUnusable(pinnedProfile, evidence);
      const revoked = refusal?.code === "auth_revoked" ? refusal : null;
      const vendor = vendorCredentialObservation(quota, harnessId, pinnedProfile.profile_id);
      const revokedAt =
        revoked?.observed_at ?? (vendor?.outcome === "revoked" ? vendor.observed_at : null);
      if (revokedAt)
        throw Object.assign(
          modelError("auth_required", "The pinned managed model account requires sign-in"),
          {
            problem: ControlProblem.parse({
              code: "auth_required",
              message: "The pinned managed model account requires sign-in",
              retryable: false,
              context: {
                source: source.adapter.id,
                credentialProfileId: pinnedProfile.profile_id,
                observedAt: revokedAt,
              },
            }),
          },
        );
      const status = composeCredentialProfileEvidence(
        await probeCredentialProfileStatus(pinnedProfile, probe),
        evidence,
      );
      if (!profileStatusAdmits(pinnedProfile, status))
        throw modelError(
          "auth_unavailable",
          "The pinned model account has no verified current authentication",
        );
    }
    return { cfg, harnessId, harness, profiles, probe, pinnedProfile };
  };

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
    const { harnessId, harness, profiles, probe, pinnedProfile } = admitted;
    const currentQuota = admissionEvidence();
    let profile: CredentialProfile | null;
    try {
      profile = await resolveAccountForRun({
        harnessId,
        registry: profiles,
        policy:
          harness?.profile_policy ??
          GlobalConfig.parse({ harnesses: { [harnessId]: {} } }).harnesses[harnessId]!
            .profile_policy,
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
      if (errorCode(error) === "credential_pool_exhausted")
        throw poolExhausted(source.adapter.id, error, catalogRefusals);
      throw error;
    }
    if (!profile)
      throw modelError("model_account_unavailable", "Connect a managed account for model calls");
    return profile;
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
      refusals: deps.refusals?.live(),
      substitutions: substitutions.live(),
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
      while (request.account.mode === "auto" && !capabilities.reserve(binding, operationId)) {
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
      ) => {
        if (includeAdmission && !requestedModel)
          throw modelError("invalid_request", "Admission observation requires requestedModel", 400);
        const source = getSource(sourceId);
        const { catalog } = await resolve(
          source,
          credentialProfileId ? { mode: "pin", profileId: credentialProfileId } : { mode: "auto" },
          requestedModel ?? null,
          lifetime.signal,
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
      modelAccountCatalog: async (sourceId: string, credentialProfileId?: string) => {
        const source = getSource(sourceId);
        const context = { config: config(), quota: quotaEvidence(), unusable: unusable.live() };
        const accounts = await enumerateAccountCatalogs({
          observationKey: `model-source:${sourceId}`,
          context,
          adapter: registry.get(source.credentialHarness),
          profiles: catalogProfiles(context, source.credentialHarness, credentialProfileId, true),
          read: async (profile, canReadCatalog) => {
            lifetime.signal.throwIfAborted();
            if (!canReadCatalog) return null;
            const generation = capabilities.credentials.generation(
              source.credentialHarness,
              profile.profile_id,
            );
            const catalog = ControlModelCatalogResponse.parse(
              await source.adapter.catalog({ profile, signal: lifetime.signal }),
            );
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
      operations.close();
    },
  };
}
