import {
  DaemonLocalClient,
  DaemonServer,
  RunEventBus,
  type DaemonOptions,
  type RunnerFn,
  type JobRecord,
  type createSqlDaemonServices,
} from "@claudexor/daemon";
import type { AuthReadinessService } from "@claudexor/gateway";
import {
  isModelOperation,
  type JobAdmission,
  type RuntimeConcurrencyCaps,
  type TurnEnqueueProblem,
} from "@claudexor/schema";
import type { DelegationBudgetAuthority } from "@claudexor/orchestrator";
import { createDaemonAgentRunner } from "./daemon-agent-runner.js";
import { createDelegationDaemonBinding } from "./delegation-daemon-binding.js";
import { createHarnessMaintenance } from "./harness-maintenance-service.js";
import { createModelServices } from "./model-services.js";
import { createDeferredStartPreparation } from "./deferred-start-preparation.js";

import { bindLaterScopeSettlements } from "./run-scope-later-record.js";
import { daemonRunScopeIndex } from "./run-scope-index.js";
import { afterRetention, type RetentionRunner } from "./retention-lifetime.js";
import { readLastRetention, recordLastRetention } from "./retention-last-pass.js";

type SqlServices = ReturnType<typeof createSqlDaemonServices>;
type ModelOptions = Pick<
  Parameters<typeof createModelServices>[0],
  "sources" | "registry" | "config" | "migrationGate"
>;
/** Later settlements of finished runs (#613); the daemon's run-scope index by default. */
type LaterScopes = Parameters<typeof bindLaterScopeSettlements>[0];

/** Compose the existing queue and runners with one SQL graph. This factory
 * neither opens storage nor starts a listener; the startup owner admits it
 * only after import and recovery have finished. */
export function createSqlDaemonRuntime(
  graph: SqlServices,
  options: {
    server: Omit<
      DaemonOptions,
      | "commands"
      | "runner"
      | "delegationAuthority"
      | "onCommandTerminal"
      | "onRunTerminal"
      | "onTurnEnqueueFailed"
    >;
    authReadiness: () => Pick<AuthReadinessService, "invalidate">;
    models?: ModelOptions;
    bus?: RunEventBus;
    agent?: typeof createDaemonAgentRunner;
    warn?: (message: string) => void;
    laterScopes?: LaterScopes;
  },
) {
  const bus = options.bus ?? new RunEventBus();
  const { authority, bind } = createDelegationDaemonBinding();
  const client = new DaemonLocalClient(() => server);
  const executors = createSqlDaemonExecutors(graph, {
    ...options,
    client,
    authority,
    bus,
    admission: (id) => server.admission(id),
    deferred: () => server.deferred,
    runtimeConcurrencyCaps: options.server.runtimeConcurrencyCaps,
  });
  const server = new DaemonServer({
    ...options.server,
    storeFacts: options.server.storeFacts ?? (() => graph.store.facts()),
    commands: graph.commands,
    delegationAuthority: authority,
    onCommandTerminal: executors.onCommandTerminal,
    onRunTerminal: executors.onRunTerminal,
    onTurnEnqueueFailed: executors.onTurnEnqueueFailed,
    runner: executors.runner,
    deferredStart: options.server.deferredStart ?? (() => executors.deferredStart),
  });
  bind(server);
  return {
    server,
    client,
    ...executors,
    bus,
    terminalFilesPending: (id: string) => graph.terminalFiles.pending(id),
    async stop() {
      executors.close();
      await server.stop();
    },
  };
}

/** Storage-dependent executors bind after import; the already listening server
 * keeps its one queue, cancellation owner and in-process client throughout. This
 * is the one composition the daemon entrypoint and the runtime factory share, so
 * what must live and end with a store's graph belongs here, behind `close`. */
export function createSqlDaemonExecutors(
  graph: SqlServices,
  options: {
    client: DaemonLocalClient;
    authority: DelegationBudgetAuthority;
    admission: (id: string) => JobAdmission | null;
    /** The serving daemon's deferred owner, read when a settlement arrives. */
    deferred: () => Pick<DaemonServer["deferred"], "processScopeSettled">;
    authReadiness: () => Pick<AuthReadinessService, "invalidate">;
    bus: RunEventBus;
    runtimeConcurrencyCaps?: RuntimeConcurrencyCaps;
    models?: ModelOptions;
    agent?: typeof createDaemonAgentRunner;
    warn?: (message: string) => void;
    laterScopes?: LaterScopes;
  },
) {
  const models = createModelServices({
    ...options.models,
    unusable: graph.accounts.unusable,
    substitutions: graph.accounts.substitutions,
    refusals: graph.accounts.refusals,
    capabilities: graph.accounts.capabilities,
    lastService: graph.accounts.services,
    commands: graph.commands,
    resourceQueries: graph.commands.queries,
    resources: () => graph.resources,
    quota: () => graph.quota,
    client: options.client,
    admission: options.admission,
    warn: options.warn,
  });
  const harnessMaintenance = createHarnessMaintenance({
    commands: graph.commands,
    maintenanceQueries: graph.commands.queries,
    client: options.client,
    readiness: options.authReadiness,
  });
  const agent = (options.agent ?? createDaemonAgentRunner)({
    delegationBudgetAuthority: options.authority,
    quotaStore: () => graph.quota,
    accounts: graph.accounts,
    threads: graph.threads,
    commands: graph.commands.queries,
    interactions: graph.interactions,
    liveInputs: graph.liveInputs,
    resources: () => graph.resources,
    bus: options.bus,
    runtimeConcurrencyCaps: options.runtimeConcurrencyCaps,
    terminalPersistence: (jobId) => (event, telemetry) =>
      graph.threads.persistTerminal(jobId, event, telemetry),
    terminalStaging: (jobId) => (event, telemetry) =>
      graph.threads.stageTerminal(jobId, event, telemetry),
  });
  const unbindLaterScopes = bindLaterScopeSettlements(
    options.laterScopes ?? daemonRunScopeIndex(),
    {
      run: (runId) => graph.commands.queries.getByRunId(runId),
      settled: (jobId) => options.deferred().processScopeSettled(jobId),
    },
  );
  return {
    /** Ends what reads this graph, before its store closes. Repeating it changes nothing. */
    close() {
      unbindLaterScopes();
      models.close();
    },
    deferredStart: createDeferredStartPreparation({
      resources: graph.resources,
      accounts: graph.accounts,
      commands: graph.commands.queries,
      authority: options.authority,
      quota: () => graph.quota,
      runtimeConcurrencyCaps: options.runtimeConcurrencyCaps,
    }),
    models,
    // Keep the bounded-pass signal through model cleanup and upload pruning.
    retention: (runner: RetentionRunner): RetentionRunner => {
      const wrapped = models.withRetention(runner);
      return recordLastRetention(
        afterRetention(wrapped, (request) => {
          if (!request.dry_run) graph.resources.pruneUploadBindings();
        }),
        graph.store,
      );
    },
    controlRoutes: {
      ...models.routes,
      lastRetention: async () => {
        let diagnostic: string | undefined;
        const last = readLastRetention(graph.store, (message) => {
          diagnostic = message;
        });
        return { last, ...(diagnostic ? { diagnostic } : {}) };
      },
    },
    harnessMaintenance,
    onCommandTerminal: (record: JobRecord) => models.operations.onCommandTerminal(record),
    onRunTerminal: (runId: string, threadId?: string) => {
      graph.interactions.dropForRun(runId);
      graph.liveInputs.dropForRun(runId);
      if (threadId) graph.threads.pingThreadHead(threadId);
    },
    onTurnEnqueueFailed: (turnId: string, problem: TurnEnqueueProblem) =>
      graph.threads.setTurnEnqueueError(turnId, problem),
    runner: ((params, ctx) =>
      isModelOperation(params)
        ? models.operations.execute(params, ctx)
        : harnessMaintenance.owns(params)
          ? harnessMaintenance.execute(params, ctx)
          : agent(params, ctx)) satisfies RunnerFn,
  };
}
