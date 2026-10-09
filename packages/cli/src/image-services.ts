import { credentialProfilePolicyState, type AdapterRegistry } from "@claudexor/core";
import { loadConfig } from "@claudexor/config";
import {
  ImageOperations,
  type CredentialUnusableLedger,
  type DaemonClient,
  type ImageOperationDependencies,
  type JobRecord,
  type RunnerFn,
} from "@claudexor/daemon";
import { invokeCodexImage, createCodexAdapter } from "@claudexor/harness-codex";
import {
  probeCredentialProfileStatus,
  resolveAccountForRun,
  resolveCredentialProfile,
} from "@claudexor/orchestrator";
import {
  GlobalConfig,
  ImageCallResult,
  isImageOperation,
  isModelOperation,
  type CredentialProfile,
  type ImageCallRequest,
} from "@claudexor/schema";
import { noProjectRepoRoot } from "@claudexor/util";
import { accountsMigrationGate } from "./accounts-unified-migration.js";
import { credentialUnusableLedger } from "./run-orchestrator.js";
import type { RetentionRunner } from "./retention-service.js";
import type { createModelServices } from "./model-services.js";

interface Dependencies extends Pick<ImageOperationDependencies, "commands" | "resources" | "warn"> {
  client: Pick<DaemonClient, "enqueue" | "cancel">;
  config?: () => GlobalConfig;
  unusable?: CredentialUnusableLedger;
  migrationGate?: typeof accountsMigrationGate;
  registry?: AdapterRegistry;
  invoke?: typeof invokeCodexImage;
}

function imageError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, status: 409, retryable: false });
}

/**
 * Selects a managed Codex subscription, not a text-model catalog entry. Image
 * entitlement and its independent quota are proven by the image backend, not
 * inferred from /codex/models or the text allowance. The ordinary profile
 * policy and local authentication probe still apply; pins never rotate.
 */
export function createImageServices(deps: Dependencies) {
  const config = deps.config ?? (() => loadConfig(noProjectRepoRoot()).global);
  const unusable = deps.unusable ?? credentialUnusableLedger;
  const adapter = deps.registry?.get("codex") ?? createCodexAdapter();
  const selectProfile = async (
    request: ImageCallRequest,
    signal: AbortSignal,
  ): Promise<CredentialProfile> => {
    signal.throwIfAborted();
    const migration = (deps.migrationGate ?? accountsMigrationGate)("codex");
    if (migration) throw imageError("accounts_migration_incomplete", migration.reason);
    const cfg = config();
    const harness = cfg.harnesses.codex;
    if (harness?.enabled === false)
      throw imageError("image_source_unavailable", "Codex is disabled in settings");
    const profiles = cfg.credential_profiles.filter(
      (profile) => profile.credential_kind === "config_dir_login",
    );
    const choice = request.account ?? { mode: "auto" as const };
    let pinned: CredentialProfile | null = null;
    if (choice.mode === "pin") {
      try {
        pinned = resolveCredentialProfile(profiles, choice.profileId, "codex");
      } catch {
        throw imageError(
          "image_account_unavailable",
          "The pinned managed Codex account is unavailable",
        );
      }
    }
    // No text snapshot/cooldown decides the separate image bucket. Retain
    // observed auth revocation; the fresh managed-login probe is authoritative
    // for the selected profile. Neither branch touches the text quota ledger.
    const authUnusable = unusable.live().filter((row) => row.code === "auth_revoked");
    const emptyImageQuota = { snapshots: [], absences: [], honored: [] };
    const selected = await resolveAccountForRun({
      harnessId: "codex",
      registry: profiles,
      policy:
        harness?.profile_policy ??
        GlobalConfig.parse({ harnesses: { codex: {} } }).harnesses.codex!.profile_policy,
      profileCardinality: credentialProfilePolicyState({ adapter, registry: profiles }),
      snapshots: [],
      quota: emptyImageQuota,
      unusable: authUnusable,
      probe: adapter.probeCredentialProfile
        ? (profile) =>
            probeCredentialProfileStatus(profile, adapter.probeCredentialProfile!.bind(adapter))
        : undefined,
      pinnedProfile: pinned,
      boundProfileId: choice.mode === "auto" ? (choice.preferredProfileId ?? null) : null,
      threadId: null,
      model: null,
      defaultRoute: null,
      nativeCredentialsDisabled: true,
      authPreference: "subscription",
      notePoolApiKeyRoute: () => {},
      emit: () => {},
    });
    if (!selected)
      throw imageError("image_account_unavailable", "Connect a managed Codex subscription");
    signal.throwIfAborted();
    return selected;
  };
  const operations = new ImageOperations({
    commands: deps.commands,
    resources: deps.resources,
    warn: deps.warn,
    enqueue: ({ request, ...options }) => deps.client.enqueue(request, options),
    cancel: (id, reason) => deps.client.cancel(id, reason),
    resolve: async (request, signal) => ({
      profile: await selectProfile(request, signal),
      invoke: async (input, context) => {
        const observed = await (deps.invoke ?? invokeCodexImage)(input, context);
        // The transport's dispatch evidence is recorded by onDispatch before
        // its sole POST. Only the provider result crosses into daemon custody.
        return ImageCallResult.parse({
          outcome: observed.outcome,
          route: observed.route,
          data: observed.response?.data ?? null,
          usage: observed.response?.usage ?? null,
          problem: observed.problem,
        });
      },
    }),
  });
  return {
    operations,
    routes: {
      createImageOperation: operations.create.bind(operations),
      getImageOperation: async (id: string) => operations.inspect(id),
      readImageResult: async (id: string) => operations.readResult(id),
      acknowledgeImageResult: async (id: string, sha256: string) =>
        operations.acknowledge(id, sha256),
      cancelImageOperation: operations.cancel.bind(operations),
    },
    withRetention:
      (run: RetentionRunner): RetentionRunner =>
      async (request) => {
        const receipt = await run(request);
        const imagePayloads = operations.reconcileResources(request.dry_run);
        receipt.errors.push(...imagePayloads.errors);
        return receipt;
      },
    close: () => {
      operations.close();
    },
  };
}

/** One daemon composition seam keeps Agent/model/image commands on one queue,
 * one terminal callback, and the same control and retention owners. */
export function bindImageServices(
  models: ReturnType<typeof createModelServices>,
  images: ReturnType<typeof createImageServices>,
  agentRunner: RunnerFn,
) {
  return {
    onCommandTerminal(record: JobRecord) {
      models.operations.onCommandTerminal(record);
      images.operations.onCommandTerminal(record);
    },
    runner: ((params, ctx) =>
      isModelOperation(params)
        ? models.operations.execute(params, ctx)
        : isImageOperation(params)
          ? images.operations.execute(params, ctx)
          : agentRunner(params, ctx)) satisfies RunnerFn,
    close() {
      models.close();
      images.close();
    },
    bindRoutes(services: { runRetention: RetentionRunner }) {
      services.runRetention = images.withRetention(models.withRetention(services.runRetention));
      Object.assign(services, models.routes, images.routes);
    },
  };
}
