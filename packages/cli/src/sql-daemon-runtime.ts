import {
  DaemonLocalClient,
  DaemonServer,
  RunEventBus,
  type DaemonOptions,
  type createSqlDaemonServices,
} from "@claudexor/daemon";
import type { AuthReadinessService } from "@claudexor/gateway";
import { isModelOperation } from "@claudexor/schema";
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
  const models = createModelServices({
    ...options.models,
    commands: graph.commands,
    resourceQueries: graph.commands.queries,
    resources: () => graph.resources,
    quota: () => graph.quota,
    client,
    warn: options.warn,
  });
  const harnessMaintenance = createHarnessMaintenance({
    commands: graph.commands,
    maintenanceQueries: graph.commands.queries,
    client,
    readiness: options.authReadiness,
  });
  const agent = (options.agent ?? createDaemonAgentRunner)({
    delegationBudgetAuthority: authority,
    quotaStore: () => graph.quota,
    threads: graph.threads,
    commands: graph.commands.queries,
    interactions: graph.interactions,
    liveInputs: graph.liveInputs,
    resources: () => graph.resources,
    bus,
    runtimeConcurrencyCaps: options.server.runtimeConcurrencyCaps,
    terminalPersistence: (jobId) => (event, telemetry) =>
      graph.threads.persistTerminal(jobId, event, telemetry),
  });
  const server = new DaemonServer({
    ...options.server,
    storeFacts: options.server.storeFacts ?? (() => graph.store.facts()),
    commands: graph.commands,
    delegationAuthority: authority,
    onCommandTerminal: (record) => models.operations.onCommandTerminal(record),
    onRunTerminal: (runId, threadId) => {
      graph.interactions.dropForRun(runId);
      graph.liveInputs.dropForRun(runId);
      if (threadId) graph.threads.pingThreadHead(threadId);
    },
    onTurnEnqueueFailed: (turnId, problem) => graph.threads.setTurnEnqueueError(turnId, problem),
    runner: (params, ctx) =>
      isModelOperation(params)
        ? models.operations.execute(params, ctx)
        : harnessMaintenance.owns(params)
          ? harnessMaintenance.execute(params, ctx)
          : agent(params, ctx),
  });
  bind(server);
  return {
    server,
    client,
    models,
    harnessMaintenance,
    bus,
    terminalFilesPending: (id: string) => graph.terminalFiles.pending(id),
    async stop() {
      models.close();
      await server.stop();
    },
  };
}
