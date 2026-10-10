#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  DaemonLocalClient,
  DaemonServer,
  RunEventBus,
  quotaPacerFileStore,
  daemonDir,
  defaultSocketPath,
  acquireRootAuthority,
  ensureToken,
  ensureDaemonRuntimeRoot,
  logPath,
  socketAlive,
  loadEngineRuntime,
  recordAdmissionMemory,
  processMemoryFields,
  recoveryOnlyRefusal,
  type createSqlDaemonServices,
} from "@claudexor/daemon";
import { DaemonControlApiServer, type DaemonControlApiOptions } from "@claudexor/control-api";
import { createDaemonQuotaPoller, openStartupDiagnostics } from "./daemon-admission-runtime.js";
import { armDaemonLifecycle, runStartupCrashGc } from "./daemon-lifecycle.js";
import {
  bindRecoveryTransport,
  DaemonStartupAdmission,
  proveRecoveryTransport,
  quarantineGhostProjectsAtStartup,
} from "./daemon-startup.js";
import { engineBuildIdentity, noProjectRepoRoot, redactSecrets } from "@claudexor/util";
import { loadRuntimeConcurrencyCaps, sweepRetiredConfigKeysAtStartup } from "@claudexor/config";
import { scheduleStartupRetention } from "./retention-service.js";
import { controlServices } from "./control-services.js";
import { AuthReadinessService } from "@claudexor/gateway";
import { bindCredentialMutationWindow } from "@claudexor/core";
import { buildGateway } from "./registry.js";
import { createSetupJobManager } from "./setup-jobs.js";
import { bustLoginCredentialState } from "./credential-status-invalidation.js";
import { SetupLifecycleBinding } from "./setup-lifecycle-binding.js";
import { SqlSetupLifecycleSlot } from "./sql-setup-lifecycle.js";
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
import { createSqlDaemonExecutors } from "./sql-daemon-runtime.js";
import { SqlDaemonStorage } from "./sql-daemon-storage.js";
import { deferredCommands, sqlActivityRecords, sqlStartupRoots } from "./sql-daemon-queries.js";
import { threadPurgeEffect } from "./thread-purge.js";
import { accountResetServices } from "./account-reset-services.js";

type Graph = ReturnType<typeof createSqlDaemonServices>;

export async function main(): Promise<void> {
  if (runProbeIfRequested(process.argv.slice(2))) return;
  if (await runStopIfRequested(process.argv.slice(2))) return;
  // Refuse unsupported Node/SQLite before touching the root or lease.
  await loadEngineRuntime();
  const identity = engineBuildIdentity();
  ensureDaemonRuntimeRoot();
  const socketPath = defaultSocketPath();
  const authority = acquireRootAuthority({ socketPath, version: identity.version });
  const diagnostics = openStartupDiagnostics(identity);
  const log = (message: string) => diagnostics.log("sql_runtime", message);
  const admission = new DaemonStartupAdmission();
  const abort = new AbortController();
  let cleanShutdown = true;
  let shutdown: DaemonRuntimeShutdown | null = null;
  let lifecycle: ReturnType<typeof armDaemonLifecycle> | null = null;
  let control: DaemonControlApiServer | null = null;
  let opening: Promise<void> | null = null;
  let storage: SqlDaemonStorage | null = null;
  let setup: ReturnType<typeof setupFor> | null = null;
  let executors: ReturnType<typeof createSqlDaemonExecutors> | null = null;
  let server: DaemonServer;
  let listening = false;
  let admissionFlight: Promise<void> | null = null;
  let dutiesFor: Graph | null = null;
  const graph = () => {
    if (!storage) throw recoveryOnlyRefusal("engine store");
    return storage.graph();
  };
  const quotaPoller = createDaemonQuotaPoller(() => {
    if (admission.snapshot() !== "normal") return;
    try {
      void graph()
        .quota.pollStale()
        .catch((error) => log(`quota poll: ${String(error)}`));
    } catch (error) {
      log(`quota poll: ${String(error)}`);
    }
  });
  let readiness: AuthReadinessService;
  function setupFor(value: Graph) {
    return new SetupLifecycleBinding(new SqlSetupLifecycleSlot(daemonDir(), value), (store) =>
      createSetupJobManager({
        rootDir: daemonDir(),
        store,
        onCredentialStateMayHaveChanged: (harness) =>
          bustLoginCredentialState(() => value.quota, readiness, harness),
      }),
    );
  }
  try {
    readiness = new AuthReadinessService(buildGateway({ includeFakes: false }), {
      cwd: noProjectRepoRoot(),
    });
    const token = ensureToken();
    const caps = loadRuntimeConcurrencyCaps(noProjectRepoRoot());
    if (await socketAlive(socketPath))
      throw new Error(`a claudexor daemon is already listening on ${socketPath}; stop it first`);
    const bus = new RunEventBus();
    const delegation = createDelegationDaemonBinding();
    const selfClient = new DaemonLocalClient(() => server);
    const services: NonNullable<DaemonControlApiOptions["services"]> = {};
    const makeServer = () => {
      const next = new DaemonServer({
        socketPath,
        token,
        commands: deferredCommands(() => graph().commands),
        runtimeConcurrencyCaps: caps,
        servingMode: admission.snapshot,
        storeFacts: () => storage!.facts(),
        delegationAuthority: delegation.authority,
        runtimeIdentity: { version: identity.version, buildSha: identity.sha },
        runtimeLeaseOwner: authority.lease.owner,
        onCommandTerminal: (record) => executors?.onCommandTerminal(record),
        onRunTerminal: (runId, threadId) => executors?.onRunTerminal(runId, threadId),
        onTurnEnqueueFailed: (turnId, problem) => executors?.onTurnEnqueueFailed(turnId, problem),
        onShutdownRequested: () => shutdown!.beginShutdown("socket-rpc stop"),
        onRuntimeReplacementRequested: () => shutdown!.beginRuntimeReplacement(),
        runner: (params, ctx) => {
          if (!executors) throw recoveryOnlyRefusal("runner");
          return executors.runner(params, ctx);
        },
      });
      delegation.bind(next);
      return next;
    };
    server = makeServer();
    const partition = (name: string) => storage!.partition(name);
    const recoveryServices = () => ({
      journalEvents: async (name: string, cursor?: string) => partition(name).events(cursor),
      recoveryInspectPartition: async (name: string) => partition(name).inspect(),
      recoveryValidatePartition: async (name: string) => {
        const result = await partition(name).validate();
        if (result.status === "recovery_required" && name === "global")
          admission.enterRecoveryOnly();
        return result;
      },
      recoveryExportPartition: async (name: string) => partition(name).exportRecovery(),
      recoveryQuarantinePartition: async (name: string, input: unknown) => {
        const target = partition(name);
        const request = input as Parameters<typeof target.quarantineAndStartFresh>[0];
        let receipt;
        if (name === "global" && setup) {
          const preflight = target.preflightQuarantine(request);
          receipt =
            preflight.disposition === "completed" && setup.isBoundToCurrentGeneration()
              ? preflight.receipt
              : await setup.replaceAfter(() => target.quarantineAndStartFresh(request));
        } else receipt = await target.quarantineAndStartFresh(request);
        try {
          await completeAdmission();
        } catch (error) {
          admission.enterRecoveryOnly();
          log(`recovery completed; reopening failed: ${String(error)}`);
        }
        return receipt;
      },
    });
    const attach = (value: Graph) => {
      if (!listening) server = makeServer();
      setup = setupFor(value);
      executors = createSqlDaemonExecutors(value, {
        client: selfClient,
        authority: delegation.authority,
        admission: (id) => server.admission(id),
        authReadiness: () => readiness,
        bus,
        runtimeConcurrencyCaps: caps,
        warn: log,
      });
      const threads = Object.assign(value.threads, { journal: partition });
      const product = controlServices(
        value.interactions,
        value.liveInputs,
        () => value.projects,
        threads,
        setup,
        partition("global"),
        readiness,
        () => value.resources,
        () => value.quota,
        () => sqlActivityRecords(value.store),
        caps,
        value.purgeFiles,
      );
      const retention = executors.models.withRetention(product.runRetention);
      product.runRetention = async (request) => {
        const result = await retention(request);
        if (!request.dry_run) value.resources.pruneUploadBindings();
        return result;
      };
      executors.harnessMaintenance.bind(product);
      Object.assign(
        services,
        product,
        executors.models.routes,
        accountResetServices(
          { current: () => value.commands.current() },
          { current: () => value.quota },
        ),
        recoveryServices(),
      );
    };
    storage = new SqlDaemonStorage({
      rootDir: daemonDir(),
      advanceFloor: () => authority.advanceFloor(),
      graph: {
        purgeFiles: threadPurgeEffect(noProjectRepoRoot()),
        log,
        refreshers: quotaRefreshers((record) => log(`quota.observation ${JSON.stringify(record)}`)),
        subjects: quotaSubjectUniverseFromConfig,
        pacerStore: quotaPacerFileStore(daemonDir()),
      },
      log,
      onOpen: attach,
      onCorrupt: (error) => {
        admission.enterRecoveryOnly();
        quotaPoller.stop();
        log(`engine store recovery required: ${error.message}`);
        void ensureRecoveryControl().catch((problem) =>
          log(`recovery transport unavailable: ${String(problem)}`),
        );
      },
      beforeClose: async () => {
        admission.enterRecoveryOnly();
        quotaPoller.stop();
        setup?.beginDrain();
        executors?.models.close();
        await Promise.all([server.stopForStoreRecovery(), setup?.shutdown()]);
        listening = false;
        setup = null;
        executors = null;
        dutiesFor = null;
      },
    });
    Object.assign(services, recoveryServices());
    bindCredentialMutationWindow((harness) => {
      if (!setup) throw recoveryOnlyRefusal("setup");
      return setup.current().credentialMutationOpen(harness);
    });
    let address: { host: string; port: number } | null = null;
    let controlStarting: Promise<void> | null = null;
    const makeControl = () =>
      new DaemonControlApiServer({
        token,
        daemon: selfClient,
        port: Number(process.env.CLAUDEXOR_CONTROL_PORT ?? 0),
        servingMode: admission.snapshot,
        bus,
        services,
        terminalFilesPending: (id) => graph().terminalFiles.pending(id),
      });
    async function ensureRecoveryControl(): Promise<void> {
      if (shutdown?.requested()) return;
      if (controlStarting) return controlStarting;
      if (control) return;
      control = makeControl();
      log("recovery-required SQL state overrides CLAUDEXOR_NO_CONTROL_API=1 for recovery access");
      controlStarting = bindRecoveryTransport({
        server,
        control,
        requested: () => shutdown!.requested(),
        daemonDir: daemonDir(),
        logPath: logPath(),
        socketPath,
      }).then((value) => {
        address = value;
      });
      await controlStarting;
    }
    const importing =
      !existsSync(join(daemonDir(), "engine.sqlite")) && existsSync(join(daemonDir(), "journal"));
    if (process.env.CLAUDEXOR_NO_CONTROL_API !== "1" || importing) control = makeControl();
    shutdown = new DaemonRuntimeShutdown({
      daemon: {
        stop: async () => {
          abort.abort();
          executors?.models.close();
          await server.stop();
          await opening?.catch(() => {});
        },
      },
      setup: {
        hasActiveWork: () => {
          if (!setup) throw recoveryOnlyRefusal("setup activity");
          return setup.hasActiveWork();
        },
        beginDrain: () => setup?.beginDrain(),
        shutdown: async () => {
          await setup?.shutdown();
        },
      },
      control: () => control,
      journal: {
        close: async () => {
          quotaPoller.stop();
          await storage?.close();
        },
      },
      log,
    });
    lifecycle = armDaemonLifecycle({
      daemonDir: daemonDir(),
      logPath: logPath(),
      ...(diagnostics.diagnostics ? { diagnostics: diagnostics.diagnostics } : {}),
      beginShutdown: (reason) => shutdown!.beginShutdown(reason),
    });
    address = await bindRecoveryTransport({
      server,
      control,
      requested: () => shutdown!.requested(),
      daemonDir: daemonDir(),
      logPath: logPath(),
      socketPath,
    });
    listening = !shutdown.requested();
    async function completeAdmission(): Promise<void> {
      if (admissionFlight) return admissionFlight;
      if (shutdown!.requested() || admission.snapshot() === "normal") return;
      const value = graph();
      const blocked = storage!.blockedPartitions();
      if (blocked.length) {
        admission.enterRecoveryOnly();
        log(`recovery required: ${blocked.join(", ")}`);
        await ensureRecoveryControl();
        return;
      }
      const work = async () => {
        if (!listening) {
          await server.start();
          listening = true;
          await proveRecoveryTransport({ socketPath, identity, token, control: address });
        }
        if (dutiesFor !== value) {
          await value.recoverAfterStartup();
          const roots = sqlStartupRoots(value.store);
          await runStartupCrashGc({
            daemonDir: daemonDir(),
            logPath: logPath(),
            knownProjectRoots: roots.projects,
            knownExecutionRoots: roots.execution,
            ...(diagnostics.diagnostics ? { diagnostics: diagnostics.diagnostics } : {}),
          });
          if (shutdown!.requested()) return;
          for (const sweep of sweepRetiredConfigKeysAtStartup())
            log(`swept retired config keys from ${sweep.path}: ${sweep.removed.join(", ")}`);
          runStartupAccountsMigration(value.threads, value.quota, (message) =>
            log(redactSecrets(message)),
          );
          server.pruneHistory();
          await setup!.start();
          quarantineGhostProjectsAtStartup(value.threads, log);
          if (shutdown!.requested()) return;
          dutiesFor = value;
        }
        admission.openNormal();
        recordAdmissionMemory();
        quotaPoller.arm();
        lifecycle!.beginPidSnapshots();
        scheduleStartupRetention(services.runRetention!, {
          logPath: logPath(),
          shuttingDown: () => shutdown!.requested() || admission.snapshot() !== "normal",
        });
        void value.maintenance
          .integrityCheck()
          .then(async (result) => {
            if (result.ok && admission.snapshot() === "normal")
              await value.maintenance.sweepOrphans();
          })
          .catch((error) => log(`store maintenance: ${String(error)}`));
        log(`startup admission: normal product admission open (${processMemoryFields()})`);
      };
      admissionFlight = work();
      try {
        await admissionFlight;
      } finally {
        admissionFlight = null;
      }
    }
    if (!shutdown.requested()) {
      await proveRecoveryTransport({ socketPath, identity, token, control: address });
      opening = storage.open(abort.signal).then(completeAdmission);
      try {
        await opening;
      } catch (error) {
        admission.enterRecoveryOnly();
        log(`SQL startup remains recovery-only: ${redactSecrets(String(error))}`);
        diagnostics.recordFailure("SQL startup remains recovery-only", error);
        if (!shutdown.requested()) await ensureRecoveryControl();
      }
    }
    await shutdown.wait();
    await lifecycle.finalize();
    log("claudexord shut down");
    diagnostics.recordStage("shutdown_complete", "claudexord shut down");
  } catch (error) {
    log(`daemon lifecycle FAILED: ${redactSecrets(String(error))}`);
    diagnostics.recordFailure("daemon lifecycle FAILED", error);
    if (shutdown) {
      try {
        await shutdown.beginShutdown("startup failure");
        await lifecycle?.finalize();
      } catch (shutdownError) {
        cleanShutdown = false;
        throw new AggregateError(
          [error, shutdownError],
          "claudexord failed and could not complete shutdown",
        );
      }
    }
    throw error;
  } finally {
    quotaPoller.stop();
    diagnostics.close();
    if (cleanShutdown) authority.release();
  }
}

export function runClaudexordEntry(): void {
  dispatchClaudexordEntry(main);
}
runIfDirectEntry(import.meta.url, runClaudexordEntry);
