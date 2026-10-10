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

type SqlServices = ReturnType<typeof createSqlDaemonServices>;
type ModelOptions = Pick<
  Parameters<typeof createModelServices>[0],
  "sources" | "registry" | "config" | "unusable" | "substitutions" | "migrationGate"
>;

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
  });
  bind(server);
  return {
    server,
    client,
    ...executors,
    bus,
    terminalFilesPending: (id: string) => graph.terminalFiles.pending(id),
    async stop() {
      executors.models.close();
      await server.stop();
    },
  };
}

/** Storage-dependent executors bind after import; the already listening server
 * keeps its one queue, cancellation owner and in-process client throughout. */
export function createSqlDaemonExecutors(
  graph: SqlServices,
  options: {
    client: DaemonLocalClient;
    authority: DelegationBudgetAuthority;
    admission: (id: string) => JobAdmission | null;
    authReadiness: () => Pick<AuthReadinessService, "invalidate">;
    bus: RunEventBus;
    runtimeConcurrencyCaps?: RuntimeConcurrencyCaps;
    models?: ModelOptions;
    agent?: typeof createDaemonAgentRunner;
    warn?: (message: string) => void;
  },
) {
  const models = createModelServices({
    ...options.models,
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
    threads: graph.threads,
    commands: graph.commands.queries,
    interactions: graph.interactions,
    liveInputs: graph.liveInputs,
    resources: () => graph.resources,
    bus: options.bus,
    runtimeConcurrencyCaps: options.runtimeConcurrencyCaps,
    terminalPersistence: (jobId) => (event, telemetry) =>
      graph.threads.persistTerminal(jobId, event, telemetry),
  });
  return {
    models,
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
