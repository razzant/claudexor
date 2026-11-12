import { loadConfig } from "@claudexor/config";
import { inheritContinuationBody, prepareRunStart } from "@claudexor/control-api";
import {
  captureRunDefaults,
  executionRunConfig,
  registryInstanceModel,
  resolveRunInputDefaults,
  type DelegationBudgetAuthority,
} from "@claudexor/orchestrator";
import {
  CapturedRunStart,
  resolveRunAccess,
  resolveRunReviewRequested,
  type RuntimeConcurrencyCaps,
} from "@claudexor/schema";
import type {
  AccountEvidence,
  CommandQueries,
  DeferredStartPreparation,
  QuotaRegistry,
  ResourceStorePort,
} from "@claudexor/daemon";
import { noProjectRepoRoot } from "@claudexor/util";
import { buildRegistry } from "./registry.js";
import { createRunRequirementsPreflight } from "./request-preflight.js";
import { oneShotRunInput } from "./one-shot-run-input.js";
import { buildRunOrchestrator } from "./run-orchestrator.js";
import { continuationForRun } from "./continue-from-run.js";
import { readContinuationEvidence } from "@claudexor/workspace";

/** Production producer of the immutable capsule, shared with ordinary start
 * normalization and the engine's execution-default and route admission owners. */
export function createDeferredStartPreparation(deps: {
  resources: ResourceStorePort;
  accounts: AccountEvidence;
  commands: CommandQueries;
  authority: DelegationBudgetAuthority;
  quota: () => QuotaRegistry;
  runtimeConcurrencyCaps?: RuntimeConcurrencyCaps;
}): DeferredStartPreparation {
  const registry = buildRegistry();
  const services = {
    validateResources: async (refs: Parameters<ResourceStorePort["resolve"]>[0]) => {
      deps.resources.resolve(refs);
    },
    preflightRunRequirements: createRunRequirementsPreflight(deps.resources, noProjectRepoRoot()),
  };
  return {
    async capture(predecessor, input) {
      const request = await prepareRunStart(
        inheritContinuationBody(predecessor, {
          ...input.controls,
          prompt: input.prompt,
          attachments: input.attachments,
        }),
        services,
      );
      const root = request.scope.kind === "project" ? request.scope.root : noProjectRepoRoot();
      const config = loadConfig(root);
      const resolved = resolveRunInputDefaults(oneShotRunInput(request), {
        config,
        registryIds: registry.keys(),
        instanceModel: registryInstanceModel(registry),
      });
      return CapturedRunStart.parse({
        ...request,
        // The capsule freezes defaults without converting default/Auto intent
        // into explicit caller pins (in particular primaryHarnessExplicit).
        harnesses: request.harnesses,
        primaryHarness: request.primaryHarness,
        model: undefined,
        models: resolved.models,
        effort: undefined,
        efforts: resolved.efforts,
        routingGoal: resolved.routingGoal,
        access: resolveRunAccess(request, config.trust.access_default).effective,
        web: resolved.web,
        externalContextPolicy: resolved.externalContextPolicy,
        ...(request.mode === "agent" ? { review: resolveRunReviewRequested(request) } : {}),
        credentialProfileId: request.credentialProfileId ?? null,
        paidBudget: request.paidBudget ?? config.global.budget.paid_budget_per_run,
        timeLimitMode: request.timeLimitMode ?? (request.maxSeconds ? "hard" : "soft"),
        deferredDefaults: captureRunDefaults(config),
      });
    },
    async validate(captured, heldBy) {
      const { deferredDefaults: _snapshot, ...request } = captured;
      // The accepted draft reads its own refs: a released ID it holds still resolves.
      const held = {
        resolve: (refs: Parameters<ResourceStorePort["resolve"]>[0]) =>
          deps.resources.resolve(refs, heldBy),
      };
      const normalized = await prepareRunStart(request, {
        validateResources: async (refs) => {
          held.resolve(refs);
        },
        preflightRunRequirements: createRunRequirementsPreflight(held, noProjectRepoRoot(), {
          config: (root) => executionRunConfig(root, captured.deferredDefaults),
        }),
      });
      const orchestrator = buildRunOrchestrator({
        accounts: deps.accounts,
        p: captured,
        delegationBudgetAuthority: deps.authority,
        quotaStore: deps.quota,
        runtimeConcurrencyCaps: deps.runtimeConcurrencyCaps,
      });
      const continuation = continuationForRun(normalized, deps.commands);
      if (continuation.from) {
        const evidence = readContinuationEvidence(continuation.from.runDir);
        if (!evidence.held && !evidence.resumable && !evidence.hasEvidence)
          throw Object.assign(new Error("the predecessor's continuation evidence is unavailable"), {
            code: "continuation_evidence_unavailable",
            status: 409,
            retryable: false,
          });
      }
      await orchestrator.preflightOneShot({
        ...oneShotRunInput(normalized),
        attachments: held.resolve(normalized.attachments),
        continuation,
      });
    },
  };
}
