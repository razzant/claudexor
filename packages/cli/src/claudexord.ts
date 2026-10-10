#!/usr/bin/env node
import { accountResetServices } from "./account-reset-services.js";
import { join } from "node:path";
import {
  DaemonLocalClient,
  commandActivityRecords,
  commandProjection,
  commandExecutionRoots,
  commandScopeRoots,
  interactionProjection,
  operatorDecisionProjection,
  runEventProjection,
  JournalManager,
  JournalMaintenance,
  DaemonServer,
  InteractionRegistry,
  ProjectPartitions,
  projectProjection,
  RunEventBus,
  ResourceStore,
  quotaPacerFileStore,
  quotaProjection,
  daemonDir,
  defaultSocketPath,
  acquireRootAuthority,
  ensureToken,
  ensureDaemonRuntimeRoot,
  logPath,
  socketAlive,
  LiveInputRegistry,
  legacyCommandBackend,
} from "@claudexor/daemon";
import { DaemonControlApiServer } from "@claudexor/control-api";
import {
  createDaemonQuotaPoller,
  createStartupAdmissionRuntime,
  openStartupDiagnostics,
  registerDaemonThreadProjection,
} from "./daemon-admission-runtime.js";
import { armDaemonLifecycle, logLine } from "./daemon-lifecycle.js";
import {
  bindRecoveryTransport,
  controlApiEnabledForStartup,
  DaemonStartupAdmission,
  proveRecoveryTransport,
  quarantineGhostProjectsAtStartup,
  recoveryBlockedPartitions,
} from "./daemon-startup.js";
import { engineBuildIdentity, noProjectRepoRoot, redactSecrets } from "@claudexor/util";
import { loadConfig } from "@claudexor/config";
import { runtimeConcurrencyCaps } from "@claudexor/schema";
import { scheduleStartupRetention } from "./retention-service.js";
import { controlServices } from "./control-services.js";
import { AuthReadinessService } from "@claudexor/gateway";
import { bindCredentialMutationWindow } from "@claudexor/core";
import { buildGateway } from "./registry.js";
import { createSetupJobManager } from "./setup-jobs.js";
import { bustLoginCredentialState } from "./credential-status-invalidation.js";
import { SetupJobStore } from "./setup-job-store.js";
import { SetupLifecycleBinding } from "./setup-lifecycle-binding.js";
import { DaemonRuntimeShutdown } from "./daemon-runtime-shutdown.js";
import { quotaRefreshers } from "./quota-refreshers.js";
import {
  dispatchClaudexordEntry,
  runIfDirectEntry,
  runProbeIfRequested,
} from "./claudexord-entry.js";
import { createDelegationDaemonBinding } from "./delegation-daemon-binding.js";
import { quotaSubjectUniverseFromConfig } from "./quota-subject-universe.js";
import { runStartupAccountsMigration } from "./accounts-unified-migration.js";
import { runStopIfRequested } from "./runtime-replacement-stop.js";
import { createDaemonAgentRunner } from "./daemon-agent-runner.js";
import { createModelServices } from "./model-services.js";
import { daemonHarnessMaintenance } from "./harness-maintenance-service.js";
import { isModelOperation } from "@claudexor/schema";

export async function main(): Promise<void> {
  // Probe and identity-proven stop must run before any durable startup.
  if (runProbeIfRequested(process.argv.slice(2))) return;
  if (await runStopIfRequested(process.argv.slice(2))) return;
  const servingIdentity = engineBuildIdentity();
  ensureDaemonRuntimeRoot();
  const socketPath = defaultSocketPath();
  // D5 stage 1: permanent barrier (epoch/floor refusals) before ANY recovery.
  const rootAuthority = acquireRootAuthority({ socketPath, version: servingIdentity.version });
  // C8: private diagnostics open right after the authority win (never control lifecycle).
  const startupDiagnostics = openStartupDiagnostics(servingIdentity);
  let shutdownRuntime: DaemonRuntimeShutdown | null = null;
  // Release wave round-12 BLOCK: the single-writer lease may only be released
  // after a CLEAN shutdown — a failed/partial shutdown keeps components that
  // can still write, and releasing would let a successor acquire ownership
  // beside them. On failure the lease dies with the process instead.
  let releaseWriterLease = true;
  let lifecycle: ReturnType<typeof armDaemonLifecycle> | null = null;
  let quotaPoller: ReturnType<typeof createDaemonQuotaPoller> | null = null;
  // Maintenance failures, typed declines and `journal.records_retired`
  // receipts land in the daemon log and the startup diagnostics record.
  const journalMaintenance = new JournalMaintenance(daemonDir(), (message) =>
    startupDiagnostics.log("journal_maintenance", message),
  );
  try {
    const token = ensureToken();
    const startupConfig = loadConfig(noProjectRepoRoot()).global;
    const startupConcurrencyCaps = runtimeConcurrencyCaps(startupConfig);

    if (await socketAlive(socketPath)) {
      throw new Error(`a claudexor daemon is already listening on ${socketPath}; stop it first`);
    }

    const bus = new RunEventBus();
    const { authority: delegationBudgetAuthority, bind: bindDelegationDaemon } =
      createDelegationDaemonBinding();
    const journalManager = new JournalManager(daemonDir(), {
      requestMaintenance: journalMaintenance.request,
    });
    const commandStoreSlot = journalManager.registerProjection(commandProjection());
    const interactionStoreSlot = journalManager.registerProjection(interactionProjection());
    const operatorDecisionStoreSlot = journalManager.registerProjection(
      operatorDecisionProjection(),
    );
    const runEventStoreSlot = journalManager.registerProjection(runEventProjection());
    const projectStoreSlot = journalManager.registerProjection(projectProjection());
    const quotaStoreSlot = journalManager.registerProjection(
      quotaProjection(
        quotaRefreshers((record) =>
          logLine(logPath(), `quota.observation ${JSON.stringify(record)}`),
        ),
        quotaSubjectUniverseFromConfig,
        undefined,
        // Daemon-private subject and legacy vendor floors (never in the journal).
        quotaPacerFileStore(daemonDir()),
      ),
    );
    const { threadStoreSlot, threadHeadPing } = registerDaemonThreadProjection(journalManager, () =>
      commandStoreSlot.current().records(),
    );
    const setupStoreSlot = journalManager.registerProjection({
      name: "setup",
      create: (journal) => new SetupJobStore(daemonDir(), { journal }),
      validate: (store) => store.validateProjection(),
    });
    // D5 stage 2: read-only prepare + validate; zero recovery writes.
    const globalPreparation = journalManager.prepare();
    const admission = new DaemonStartupAdmission();
    quotaPoller = createDaemonQuotaPoller(() => {
      try {
        void quotaStoreSlot.current().pollStale();
      } catch {}
    });
    const threads = new ProjectPartitions(
      daemonDir(),
      projectStoreSlot,
      commandStoreSlot,
      interactionStoreSlot,
      operatorDecisionStoreSlot,
      runEventStoreSlot,
      threadStoreSlot,
      threadHeadPing,
      journalMaintenance.request,
    );
    const partitionsPreparation = threads.prepare();
    const startupBlockedPartitions = recoveryBlockedPartitions({
      globalPreparation,
      partitionsPreparation,
    });
    const interactions = new InteractionRegistry({
      forRequest: (params) => threads.interactionsForRequest(params),
      all: () => threads.interactionStores(),
    });
    // A pending owner question blocks live input (INV-048).
    const liveInputs = new LiveInputRegistry({
      pendingForRun: (runId) => interactions.pendingForRun(runId),
    });
    // Resource files materialize only on product use, never on the recovery plane.
    let resourceStore: ResourceStore | null = null;
    const resources = (): ResourceStore =>
      (resourceStore ??= new ResourceStore(join(daemonDir(), "resource-store")));

    const selfClient = new DaemonLocalClient(() => server);
    const models = createModelServices({
      commands: threads,
      resources,
      client: selfClient,
      quota: () => quotaStoreSlot.current(),
      warn: (message) => logLine(logPath(), message),
    });
    const maintenance = daemonHarnessMaintenance(threads, selfClient, () => authReadiness);
    const commands = legacyCommandBackend(threads);
    const agentRunner = createDaemonAgentRunner({
      delegationBudgetAuthority,
      quotaStore: () => quotaStoreSlot.current(),
      threads,
      commands: commands.queries,
      interactions,
      liveInputs,
      resources,
      bus,
      runtimeConcurrencyCaps: startupConcurrencyCaps,
    });

    const server = new DaemonServer({
      socketPath,
      token,
      commands,
      runtimeConcurrencyCaps: startupConcurrencyCaps,
      servingMode: admission.snapshot,
      delegationAuthority: delegationBudgetAuthority,
      onCommandTerminal: (record) => models.operations.onCommandTerminal(record),
      onRunTerminal: (runId, threadId) => {
        interactions.dropForRun(runId);
        liveInputs.dropForRun(runId);
        // Run-terminal is the one W12 path with no thread-store mutation to
        // ride — the terminal changes the thread's presented state, so ping.
        if (threadId) threads.pingThreadHead(threadId);
      },
      onTurnEnqueueFailed: (turnId, problem) => threads.setTurnEnqueueError(turnId, problem),
      onShutdownRequested: () =>
        shutdownRuntime?.beginShutdown("socket-rpc stop") ??
        Promise.reject(new Error("daemon shutdown coordinator is not initialized")),
      onRuntimeReplacementRequested: () => {
        if (!shutdownRuntime) {
          throw Object.assign(new Error("daemon shutdown coordinator is not initialized"), {
            code: "runtime_activity_unknown",
            status: 503,
            retryable: true,
          });
        }
        return shutdownRuntime.beginRuntimeReplacement();
      },
      runtimeIdentity: { version: servingIdentity.version, buildSha: servingIdentity.sha },
      runtimeLeaseOwner: rootAuthority.lease.owner,
      runner: (params, ctx) =>
        isModelOperation(params)
          ? models.operations.execute(params, ctx)
          : maintenance.owns(params)
            ? maintenance.execute(params, ctx)
            : agentRunner(params, ctx),
    });
    bindDelegationDaemon(server);

    const authReadiness = new AuthReadinessService(buildGateway({ includeFakes: false }), {
      cwd: noProjectRepoRoot(),
    });
    const setupBinding = new SetupLifecycleBinding(setupStoreSlot, (store) =>
      createSetupJobManager({
        rootDir: daemonDir(),
        store,
        onCredentialStateMayHaveChanged: (harness) =>
          bustLoginCredentialState(() => quotaStoreSlot.current(), authReadiness, harness),
      }),
    );
    // Credential observers use the bound setup window; unknown stays open (#363).
    bindCredentialMutationWindow((harness) =>
      setupBinding.current().credentialMutationOpen(harness),
    );
    let control: DaemonControlApiServer | null = null;
    shutdownRuntime = new DaemonRuntimeShutdown({
      daemon: {
        stop: async () => {
          const maintenanceDrain = journalMaintenance.stop();
          models.close();
          await Promise.all([server.stop(), maintenanceDrain]);
        },
      },
      setup: setupBinding,
      control: () => control,
      journal: {
        close: () => {
          quotaPoller?.stop();
          threads.close();
          journalManager.close();
        },
      },
      log: (message) => logLine(logPath(), message),
    });
    // Services and retention read all partition activity directly, without self-RPC.
    const services = controlServices(
      interactions,
      liveInputs,
      () => projectStoreSlot.current(),
      threads,
      setupBinding,
      journalManager,
      authReadiness,
      resources,
      () => quotaStoreSlot.current(),
      () => commandActivityRecords(threads.all().flatMap((store) => store.records())),
      startupConcurrencyCaps,
    );
    services.runRetention = models.withRetention(services.runRetention);
    const accountControls = accountResetServices(commandStoreSlot, quotaStoreSlot);
    Object.assign(services, models.routes, accountControls);
    maintenance.bind(services);
    control = !controlApiEnabledForStartup({
      disabledByEnv: process.env.CLAUDEXOR_NO_CONTROL_API === "1",
      blockedPartitions: startupBlockedPartitions,
      log: (message) => logLine(logPath(), message),
    })
      ? null
      : new DaemonControlApiServer({
          token,
          daemon: selfClient,
          port: Number(process.env.CLAUDEXOR_CONTROL_PORT ?? 0),
          servingMode: admission.snapshot,
          bus,
          services,
        });
    lifecycle = armDaemonLifecycle({
      daemonDir: daemonDir(),
      logPath: logPath(),
      ...(startupDiagnostics.diagnostics ? { diagnostics: startupDiagnostics.diagnostics } : {}),
      beginShutdown: (reason) => shutdownRuntime!.beginShutdown(reason),
    });

    const { runAdmissionCompletion, wrapQuarantineWithReopen } = createStartupAdmissionRuntime({
      admission,
      grant: rootAuthority,
      global: journalManager,
      partitions: threads,
      diagnostics: startupDiagnostics,
      knownProjectRoots: () => {
        const commands = commandStoreSlot.prepared();
        return [...commandScopeRoots(commands.records()), ...commands.prunedScopeRoots()];
      },
      // Delegated runs (thread turns live in project partitions) keep their
      // runtime scratch under the caller-owned execution root.
      knownExecutionRoots: () => [
        ...commandExecutionRoots(commandStoreSlot.prepared().records()),
        ...threads.preparedExecutionRoots(),
      ],
      normalPlane: {
        requested: () => shutdownRuntime!.requested(),
        armQuotaPolling: () => quotaPoller!.arm(),
        beginPidSnapshots: () => lifecycle!.beginPidSnapshots(),
        migrateAccounts: () =>
          runStartupAccountsMigration(threads, quotaStoreSlot.current(), (m) =>
            logLine(logPath(), redactSecrets(m)),
          ),
        startSetup: () => setupBinding.start(),
        quarantineGhosts: () =>
          quarantineGhostProjectsAtStartup(threads, (message) => logLine(logPath(), message)),
        scheduleRetention: () =>
          scheduleStartupRetention(services.runRetention, {
            logPath: logPath(),
            shuttingDown: () => shutdownRuntime!.requested(),
          }),
        pruneCommandHistory: () => server.pruneHistory(),
        armJournalMaintenance: () => journalMaintenance.arm(),
      },
    });
    services.recoveryQuarantinePartition = wrapQuarantineWithReopen(
      services.recoveryQuarantinePartition,
    );

    // D5 stage 3: bind the REAL transport with product admission CLOSED, then
    // prove self-health/exact identity through it before anything destructive.
    const controlAddr = await bindRecoveryTransport({
      server,
      control,
      requested: () => shutdownRuntime!.requested(),
      daemonDir: daemonDir(),
      logPath: logPath(),
      socketPath,
    });
    if (!shutdownRuntime.requested()) {
      await proveRecoveryTransport({
        socketPath,
        identity: servingIdentity,
        token,
        control: controlAddr,
      });
      // D5 stage 4: floor advance + destructive recovery + normal admission —
      // or stay recovery-only with the floor unchanged and cleanup off. The
      // normal-plane side effects run inside the single-flight completion.
      await runAdmissionCompletion(() => startupBlockedPartitions);
    }
    await shutdownRuntime.wait();
    await lifecycle.finalize();
    logLine(logPath(), "claudexord shut down");
    startupDiagnostics.recordStage("shutdown_complete", "claudexord shut down");
  } catch (error) {
    // logLine is already best-effort; a failed diagnostic write never masks
    // the lifecycle failure itself.
    logLine(
      logPath(),
      `daemon lifecycle FAILED: ${redactSecrets(
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      )}`,
    );
    startupDiagnostics.recordFailure("daemon lifecycle FAILED", error);
    if (shutdownRuntime) {
      try {
        await shutdownRuntime.beginShutdown("startup failure");
        await lifecycle?.finalize();
      } catch (shutdownError) {
        logLine(
          logPath(),
          `shutdown FAILED: ${redactSecrets(
            shutdownError instanceof Error ? shutdownError.message : String(shutdownError),
          )}`,
        );
        releaseWriterLease = false;
        throw new AggregateError(
          [error, shutdownError],
          "claudexord failed and could not complete shutdown",
        );
      }
    }
    throw error;
  } finally {
    await journalMaintenance.stop();
    quotaPoller?.stop();
    startupDiagnostics.close();
    // Drops only the live writer claim; the barrier itself persists (D1).
    if (releaseWriterLease) rootAuthority.release();
  }
}

/** Explicit entry preserves import-side-effect freedom for daemon probes. */
export function runClaudexordEntry(): void {
  dispatchClaudexordEntry(main);
}

runIfDirectEntry(import.meta.url, runClaudexordEntry);
