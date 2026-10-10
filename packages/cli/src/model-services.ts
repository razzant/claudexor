import type { AdapterRegistry, ModelAdapter } from "@claudexor/core";
import { credentialProfilePolicyState } from "@claudexor/core";
import { loadConfigCached } from "@claudexor/config";
import {
  ModelOperations,
  ModelSubstitutionLedger,
  type CredentialUnusableLedger,
  type DaemonClient,
  type ModelOperationDependencies,
  type QuotaRegistry,
} from "@claudexor/daemon";
import { createCodexModelAdapter, describeCodexClientVersion } from "@claudexor/harness-codex";
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
  type ModelAccountChoice,
  type ModelCallResult,
} from "@claudexor/schema";
import { errorCode, noProjectRepoRoot, redactSecrets } from "@claudexor/util";
import { accountsMigrationGate } from "./accounts-unified-migration.js";
import { buildRegistry } from "./registry.js";
import { credentialUnusableLedger } from "./run-orchestrator.js";
import type { RetentionRunner } from "./retention-service.js";
import { catalogProfiles, enumerateAccountCatalogs } from "./account-catalog.js";
import { bindModelAccountEvidence } from "./model-account-evidence.js";

/**
 * Daemon-lifetime model-substitution observations: in-memory and bounded, like
 * the unusable-credential ledger, and cleared at the same credential-generation
 * call sites. Model operations are their only producer and consumer.
 */
export const modelSubstitutionLedger = new ModelSubstitutionLedger();

interface ModelSource {
  adapter: ModelAdapter;
  label: string;
  credentialHarness: string;
}

interface Dependencies extends Pick<ModelOperationDependencies, "commands" | "resources" | "warn"> {
  client: Pick<DaemonClient, "enqueue" | "cancel">;
  quota: () => QuotaRegistry;
  config?: () => GlobalConfig;
  registry?: AdapterRegistry;
  sources?: readonly ModelSource[];
  unusable?: CredentialUnusableLedger;
  substitutions?: ModelSubstitutionLedger;
  migrationGate?: typeof accountsMigrationGate;
}

function modelError(code: string, message: string, status = 409): Error {
  return Object.assign(new Error(message), { code, status, retryable: false });
}

/** Model transport composition shares account, quota, command, and retention owners
 * with Agents. It never starts an Agent Run or creates another routing ledger. */
export function createModelServices(deps: Dependencies) {
  const sources = deps.sources ?? [
    { adapter: createCodexModelAdapter(), label: "Codex", credentialHarness: "codex" },
  ];
  const registry = deps.registry ?? buildRegistry({ includeFakes: false });
  const config = deps.config ?? (() => loadConfigCached(noProjectRepoRoot()).global);
  const unusable = deps.unusable ?? credentialUnusableLedger;
  const substitutions = deps.substitutions ?? modelSubstitutionLedger;
  const quotaEvidence = () => ({ ...deps.quota().read(), honored: unusable.honored() });
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
  ): Promise<{ profile: CredentialProfile; catalog: ControlModelCatalogResponse }> => {
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
    const excluded = new Set<string>();
    const catalogRefusals = new Map<string, ControlProblem>();
    // Exact-account discovery follows the raw source's absence declaration.
    // Actual catalog failures retain their causes; this loop never generates.
    while (true) {
      signal.throwIfAborted();
      const currentQuota = quotaEvidence();
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
          quota: currentQuota,
          unusable: unusable.live(),
          substitutions: substitutions.live(),
          probe,
          pinnedProfile,
          boundProfileId: account.mode === "auto" ? (account.preferredProfileId ?? null) : null,
          threadId: null,
          model,
          excludedProfileIds: excluded,
          defaultRoute: null,
          // Model calls cannot borrow an unregistered/default login or a paid route.
          nativeCredentialsDisabled: true,
          authPreference: "subscription",
          notePoolApiKeyRoute: () => {},
          emit: () => {},
        });
      } catch (error) {
        if (errorCode(error) === "credential_pool_exhausted") {
          const provided = ControlProblem.safeParse(
            error && typeof error === "object" && "problem" in error ? error.problem : null,
          );
          const recordedCauses = provided.success ? provided.data.context.poolCauses : null;
          const causes = new Set(Array.isArray(recordedCauses) ? recordedCauses : []);
          const resets: Array<string | null> = causes.has("quota")
            ? [
                provided.success && typeof provided.data.context.resetsAt === "string"
                  ? provided.data.context.resetsAt
                  : null,
              ]
            : [];
          for (const refusal of catalogRefusals.values()) {
            causes.add(
              refusal.code === "auth_required"
                ? "auth"
                : refusal.code === "subscription_window_exhausted"
                  ? "quota"
                  : refusal.code === "model_unavailable"
                    ? "model"
                    : "unavailable",
            );
            if (refusal.code === "subscription_window_exhausted")
              resets.push(
                typeof refusal.context.resetsAt === "string" ? refusal.context.resetsAt : null,
              );
          }
          const poolCause =
            causes.size === 1 && causes.has("quota")
              ? "quota"
              : causes.size === 1 && causes.has("auth")
                ? "auth"
                : causes.size === 2 && causes.has("auth") && causes.has("quota")
                  ? "mixed"
                  : "unavailable";
          const code =
            poolCause === "quota"
              ? "subscription_window_exhausted"
              : poolCause === "auth"
                ? "auth_required"
                : causes.size === 1 && causes.has("model")
                  ? "model_unavailable"
                  : "credential_pool_exhausted";
          const message =
            poolCause === "quota"
              ? "Every available model account is blocked by subscription quota"
              : poolCause === "auth"
                ? "Every available model account requires sign-in"
                : "No managed account can currently serve this model request";
          const resetsAt =
            poolCause !== "unavailable" &&
            resets.length > 0 &&
            resets.every((at): at is string => at !== null && Number.isFinite(Date.parse(at)))
              ? resets.reduce((earliest, at) =>
                  Date.parse(at) < Date.parse(earliest) ? at : earliest,
                )
              : null;
          throw Object.assign(modelError(code, message), {
            problem: ControlProblem.parse({
              code,
              message,
              retryable: false,
              context: { source: source.adapter.id, poolCause, resetsAt },
            }),
          });
        }
        throw error;
      }
      if (!profile)
        throw modelError("model_account_unavailable", "Connect a managed account for model calls");
      signal.throwIfAborted();
      let catalog: ControlModelCatalogResponse;
      const evidence = bindModelAccountEvidence({
        harnessId,
        profileId: profile.profile_id,
        model,
        unusable,
        quota: deps.quota,
      });
      try {
        catalog = ControlModelCatalogResponse.parse(
          await source.adapter.catalog({ profile, signal }),
        );
      } catch (error) {
        const problem = ControlProblem.safeParse(
          error && typeof error === "object" && "problem" in error ? error.problem : null,
        );
        if (!problem.success) throw error;
        const refusal = {
          ...problem.data,
          context: {
            ...problem.data.context,
            source: source.adapter.id,
            credentialProfileId: profile.profile_id,
          },
        };
        catalogRefusals.set(profile.profile_id, refusal);
        // One selection epoch visits a rejected account at most once, even if
        // evidence maintenance fails or a concurrent refresh retires its block.
        excluded.add(profile.profile_id);
        try {
          evidence.observe(refusal);
        } catch (error) {
          deps.warn?.(`Model quota evidence was not recorded: ${redactSecrets(String(error))}`);
        }
        if (account.mode === "pin")
          throw Object.assign(modelError(refusal.code, refusal.message), { problem: refusal });
        continue;
      } finally {
        try {
          evidence.finish();
        } catch (error) {
          deps.warn?.(
            `Model account evidence finalization failed: ${redactSecrets(String(error))}`,
          );
        }
      }
      if (
        catalog.source !== source.adapter.id ||
        catalog.credentialProfileId !== profile.profile_id
      )
        throw modelError(
          "model_catalog_identity_mismatch",
          "The model catalog does not identify the selected account",
        );
      if (catalog.provenance === "provider_http" && catalog.observedAt)
        evidence.honorCatalog(catalog.observedAt);
      if (
        model === null ||
        source.adapter.inventoryAbsence === "advisory" ||
        catalog.models.some((entry) => entry.id === model)
      )
        return { profile, catalog };
      const refusal = ControlProblem.parse({
        code: "model_unavailable",
        message: `The selected account does not advertise the requested model in its catalog as served to ${describeCodexClientVersion(catalog)}`,
        retryable: false,
        context: {
          source: source.adapter.id,
          credentialProfileId: profile.profile_id,
          requestedModel: model,
          clientVersion: catalog.clientVersion,
          clientVersionSource: catalog.clientVersionSource,
        },
      });
      if (account.mode === "pin")
        throw Object.assign(modelError(refusal.code, refusal.message), { problem: refusal });
      catalogRefusals.set(profile.profile_id, refusal);
      excluded.add(profile.profile_id);
    }
  };

  const operations = new ModelOperations({
    commands: deps.commands,
    resources: deps.resources,
    warn: deps.warn,
    enqueue: ({ request, ...options }) => deps.client.enqueue(request, options),
    cancel: (id, reason) => deps.client.cancel(id, reason),
    resolve: async (request, signal) => {
      const source = getSource(request.source);
      const { profile, catalog } = await resolve(source, request.account, request.model, signal);
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
              return result;
            } finally {
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
            ? { processingPreferences: ["standard", "fast", "economy"], accountCatalog: true }
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
            const catalog = ControlModelCatalogResponse.parse(
              await source.adapter.catalog({ profile, signal: lifetime.signal }),
            );
            if (catalog.source !== sourceId || catalog.credentialProfileId !== profile.profile_id)
              throw modelError(
                "model_catalog_identity_mismatch",
                "The model catalog does not identify the requested account",
              );
            return catalog;
          },
        });
        return ControlModelAccountCatalogResponse.parse({
          source: sourceId,
          accounts,
          partial: accounts.some((entry) => entry.catalog === null),
        });
      },
      createModelOperation: operations.create.bind(operations),
      getModelOperation: async (id: string) => operations.inspect(id),
      readModelResult: async (id: string) => operations.readResult(id),
      acknowledgeModelResult: async (id: string, sha256: string) =>
        operations.acknowledge(id, sha256),
      cancelModelOperation: operations.cancel.bind(operations),
    },
    withRetention:
      (run: RetentionRunner): RetentionRunner =>
      async (request) => {
        const receipt = await run(request);
        const modelPayloads = operations.reconcileResources(request.dry_run);
        receipt.errors.push(...modelPayloads.errors);
        if (request.model_payload_report) receipt.model_payloads = modelPayloads;
        return receipt;
      },
    close: () => {
      lifetime.abort("host_cancelled");
      operations.close();
    },
  };
}
