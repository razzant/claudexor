#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  DaemonClient,
  commandProjection,
  interactionProjection,
  operatorDecisionProjection,
  runEventProjection,
  JournalManager,
  DaemonServer,
  InteractionRegistry,
  ProjectPartitions,
  projectProjection,
  RunEventBus,
  ResourceStore,
  quotaProjection,
  threadHeadPingProjection,
  threadProjection,
  type ThreadHeadPingSink,
  daemonDir,
  defaultSocketPath,
  acquireRootAuthority,
  ensureToken,
  ensureDaemonRuntimeRoot,
  logPath,
  socketAlive,
} from "@claudexor/daemon";
import { DaemonControlApiServer, normalizeRunStartRequest } from "@claudexor/control-api";
import {
  createDaemonQuotaPoller,
  createStartupAdmissionRuntime,
  openStartupDiagnostics,
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
import { assertPlanImplementReady } from "./plan-implement-readiness.js";
import { buildRunOrchestrator } from "./run-orchestrator.js";
import { delegationBeltForRun } from "./delegation-belt-descriptor.js";
import { loadConfig } from "@claudexor/config";
import { engineBuildIdentity, noProjectRepoRoot, redactSecrets } from "@claudexor/util";
import { type ResourceAttachmentRef } from "@claudexor/schema";
import { scheduleStartupRetention } from "./retention-service.js";
import { controlServices } from "./control-services.js";
import { AuthReadinessService } from "@claudexor/gateway";
import { buildGateway } from "./registry.js";
import { createSetupJobManager } from "./setup-jobs.js";
import { bustGlobalCredentialStatusCaches } from "./credential-status-invalidation.js";
import { SetupJobStore } from "./setup-job-store.js";
import { SetupLifecycleBinding } from "./setup-lifecycle-binding.js";
import { DaemonRuntimeShutdown } from "./daemon-runtime-shutdown.js";
import { quotaRefreshers } from "./quota-refreshers.js";
import {
  resolveThreadExecutionWorkspace,
  threadRunStartRequiresGit,
} from "./thread-execution-workspace.js";
import { preflightRunGitRequirement } from "./request-preflight.js";
import {
  dispatchClaudexordEntry,
  runIfDirectEntry,
  runProbeIfRequested,
} from "./claudexord-entry.js";
import { createDelegationDaemonBinding } from "./delegation-daemon-binding.js";
import { quotaSubjectUniverseFromConfig } from "./quota-subject-universe.js";
import {
  accountsMigrationGate,
  runStartupAccountsMigration,
} from "./accounts-unified-migration.js";
import { threadRunResumeInputs } from "./thread-continuity-context.js";
import { runStopIfRequested } from "./runtime-replacement-stop.js";
import { threadContinuityContext } from "./thread-continuity-context.js";
const NO_PROJECT_ROOT = noProjectRepoRoot();

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
  try {
    const token = ensureToken();

    if (await socketAlive(socketPath)) {
      throw new Error(`a claudexor daemon is already listening on ${socketPath}; stop it first`);
    }

    const bus = new RunEventBus();
    const { authority: delegationBudgetAuthority, bind: bindDelegationDaemon } =
      createDelegationDaemonBinding();
    const journalManager = new JournalManager(daemonDir());
    const commandStoreSlot = journalManager.registerProjection(commandProjection());
    const interactionStoreSlot = journalManager.registerProjection(interactionProjection());
    const operatorDecisionStoreSlot = journalManager.registerProjection(
      operatorDecisionProjection(),
    );
    const runEventStoreSlot = journalManager.registerProjection(runEventProjection());
    const projectStoreSlot = journalManager.registerProjection(projectProjection());
    const quotaStoreSlot = journalManager.registerProjection(
      quotaProjection(quotaRefreshers(), quotaSubjectUniverseFromConfig),
    );
    // Sidebar invalidation ping (W12): a GLOBAL-partition emitter every
    // ThreadStore (global + per-project) writes through, so any thread
    // mutation reaches the app's single global stream. The ping is auxiliary
    // invalidation — it must never fail the mutation that triggered it
    // (mirrors the runner's turn-binding policy).
    const threadHeadPingSlot = journalManager.registerProjection(threadHeadPingProjection());
    const threadHeadPing: ThreadHeadPingSink = (ping) => {
      try {
        threadHeadPingSlot.current().ping(ping);
      } catch {
        /* invalidation ping must never fail the thread mutation */
      }
    };
    const threadStoreSlot = journalManager.registerProjection(threadProjection(threadHeadPing));
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
    // C5b: construction mkdirs under the daemon dir and the recovery plane
    // serves no resources — the store materializes on first product use.
    let resourceStore: ResourceStore | null = null;
    const resources = (): ResourceStore =>
      (resourceStore ??= new ResourceStore(join(daemonDir(), "resource-store")));

    const server = new DaemonServer({
      socketPath,
      token,
      commands: threads,
      servingMode: admission.snapshot,
      delegationAuthority: delegationBudgetAuthority,
      onRunTerminal: (runId, threadId) => {
        interactions.dropForRun(runId);
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
      runner: async (params, ctx) => {
        const p = normalizeRunStartRequest(params);
        const mode = p.mode;
        const noProjectAsk = mode === "ask" && p.scope.kind === "none";
        const repoRoot = p.scope.kind === "project" ? p.scope.root : NO_PROJECT_ROOT;
        const runConfig = loadConfig(repoRoot);
        if (noProjectAsk) mkdirSync(NO_PROJECT_ROOT, { recursive: true, mode: 0o700 });
        const orchestrator = buildRunOrchestrator({
          p,
          delegationBudgetAuthority,
          quotaStore: () => quotaStoreSlot.current(),
          // Typed per-harness refusal while a unified-accounts migration is
          // incomplete (a crash between phases) — other harnesses keep working.
          accountsMigrationGate,
        });
        const { threadId, turnId } = threads.assertKnownIds(p.threadId, p.turnId);
        // Plan readiness gate (QA-045 / D17): refuse an Implement whose frozen
        // plan still has open questions BEFORE any worktree, spawn, or spend —
        // so the refusal is a durable, replayable refused turn (the daemon
        // records enqueue_error=plan_not_ready on the turn; retry replays
        // through this fresh preflight). Skipped when the operator explicitly
        // overrode readiness (recorded on the turn at create time). The gate
        // lives at run-start, not in the control API, so retry re-runs it.
        if (p.planRef && typeof p.planRef === "object") {
          const overridden =
            turnId != null && threads.getTurn(turnId)?.plan_readiness_overridden === true;
          if (!overridden) {
            const planRef = p.planRef as { runId: string; path: string };
            assertPlanImplementReady(planRef.runId, planRef.path);
          }
        }
        // Thread turns own a durable job before this fresh Git check. A
        // missing/stub installation therefore records a replayable refusal on
        // the exact turn, and Retry re-runs this boundary without changing any
        // request fields. No worktree or provider exists yet.
        if (turnId) {
          await preflightRunGitRequirement(p, {
            requiresGit: (request) =>
              threadRunStartRequiresGit(
                request,
                threadId ? threads.getThread(threadId) : undefined,
                runConfig.project.constraints.protected_paths,
                runConfig.trust.access_default,
              ),
          });
        }
        const {
          executionRoot: threadExecutionRoot,
          inPlace,
          projectGitInitialization,
        } = await resolveThreadExecutionWorkspace({
          threadId,
          repoRoot,
          mode,
          access: p.access,
          accessDefault: runConfig.trust.access_default,
          requestedInPlace: p.execution.isolation === "live",
          protectedPaths: runConfig.project.constraints.protected_paths,
          threads,
        });
        const executionRoot = p.execution.workspaceRoot ?? threadExecutionRoot;
        const onRunStart = (info: { runId: string; taskId: string; runDir: string }): void => {
          ctx.onRunStart?.(info);
          if (!threadId) return;
          try {
            if (turnId) {
              threads.bindTurnRun(turnId, info.runId);
            } else {
              const turn = threads.createTurn(threadId, String(p.prompt ?? ""), {
                parentRunId: typeof p.parentRunId === "string" ? p.parentRunId : null,
              });
              threads.bindTurnRun(turn.id, info.runId);
            }
          } catch {
            /* turn binding must never fail the run */
          }
        };
        // maxSeconds: a hard wall-clock deadline for the WHOLE run (run-scoped,
        // never per-attempt). Combine the daemon's per-run cancel signal with a
        // deadline that aborts with a typed STRING reason so the terminal is
        // `cancelled` + wall_clock_exceeded rather than a bare user cancel.
        const maxSeconds =
          typeof p.maxSeconds === "number" && p.maxSeconds > 0
            ? // setTimeout 32-bit-ms overflow defense (schema caps at 7 days).
              Math.min(p.maxSeconds, 604_800)
            : null;
        // INV-135 precedence: explicit per-turn profile > thread sticky >
        // unpinned; an explicit NULL forces unpinned (release wave round-11).
        const requestedProfileId =
          p.credentialProfileId === null
            ? null
            : typeof p.credentialProfileId === "string" && p.credentialProfileId
              ? p.credentialProfileId
              : threadId
                ? (threads.getThread(threadId)?.credential_profile_id ?? null)
                : null;
        const continuityContext = threadContinuityContext({
          threads,
          threadId,
          turnId,
          profileId: requestedProfileId,
        });
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        let runSignal: AbortSignal | undefined = ctx.signal;
        if (maxSeconds !== null) {
          const deadline = new AbortController();
          deadlineTimer = setTimeout(
            () => deadline.abort("wall_clock_exceeded"),
            maxSeconds * 1000,
          );
          deadlineTimer.unref?.();
          runSignal = ctx.signal ? AbortSignal.any([ctx.signal, deadline.signal]) : deadline.signal;
        }
        const delegationBelt = delegationBeltForRun(p.delegate === true, p.paidBudget);
        return orchestrator
          .run({
            onEventPersist: (event) => {
              // The owning journal partition is the durable terminal
              // authority. EventLog runs this before committing RunFacts.
              threads.recordRunEvent(p, event);
            },
            onEvent: (event) => {
              if (event.type === "harness.event") {
                const payload = event.payload as Record<string, unknown>;
                const harnessId =
                  typeof payload["harness_id"] === "string" ? payload["harness_id"] : "";
                if (harnessId) quotaStoreSlot.current().ingest(harnessId, payload);
              }
              // Live listeners observe only after journal + RunFacts commit;
              // durable replay stays authoritative if publish throws.
              try {
                bus.publish(event);
              } catch {}
            },
            onInteraction: (ctx2) => interactions.register(ctx2, p),
            interactionTimeoutMs: runConfig.global.interaction_timeout_ms,
            threadId,
            executionRoot,
            retryOf: p.retryOf ?? null,
            projectGitInitialization,
            ...threadRunResumeInputs(threads, threadId, requestedProfileId),
            onSessionObserved: threadId
              ? (harnessId, nativeSessionId, observedModel, profileId) => {
                  // The EVENT's profile is the cache truth (INV-135): the
                  // effective account can differ from the requested one.
                  threads.recordSession(
                    threadId,
                    harnessId,
                    nativeSessionId,
                    observedModel,
                    profileId ?? null,
                  );
                  // The lane (thread, harness, effective profile) has SEEN
                  // this turn (INV-137); same key as the session record.
                  if (turnId)
                    threads.recordLaneCheckpoint(threadId, harnessId, profileId ?? null, turnId);
                }
              : undefined,
            // Continuity facts (INV-137): cheap thread-store data; the engine
            // reads prior outputs + git anchor itself and does the packet math.
            threadContinuity: continuityContext,
            onContinuityResolved: threadId
              ? (tid, disclosure) =>
                  threads.setTurnContinuity(tid, {
                    kind: disclosure.kind,
                    packet_turns: disclosure.packetTurns,
                    summarized: disclosure.summarized,
                    lane_switched_from: disclosure.laneSwitchedFrom
                      ? {
                          harness_id: disclosure.laneSwitchedFrom.harness,
                          profile_id: disclosure.laneSwitchedFrom.profileId,
                        }
                      : null,
                  })
              : undefined,
            authPreference: p.authPreference,
            credentialProfileId: requestedProfileId,
            parentRunId: p.parentRunId ?? null,
            delegatedFromRunId: p.delegatedFromRunId ?? null,
            delegationAdmissionId: ctx.jobId,
            repoRoot,
            prompt: String(p.prompt ?? ""),
            planRef:
              p.planRef && typeof p.planRef === "object"
                ? (p.planRef as { runId: string; sha256: string; path: string })
                : undefined,
            instructions: typeof p.instructions === "string" ? p.instructions : undefined,
            denyPaths: Array.isArray(p.denyPaths) ? p.denyPaths : undefined,
            maxTurns: typeof p.maxTurns === "number" && p.maxTurns > 0 ? p.maxTurns : undefined,
            outputSchema:
              p.outputSchema && typeof p.outputSchema === "object" && !Array.isArray(p.outputSchema)
                ? (p.outputSchema as Record<string, unknown>)
                : undefined,
            attachments: turnId
              ? (threads.getTurn(turnId)?.attachments ?? [])
              : resources().resolve((p as { attachments?: ResourceAttachmentRef[] }).attachments),
            browser: (p as { browser?: boolean }).browser === true,
            mode: p.mode,
            contextMode: noProjectAsk
              ? "off"
              : p.scope.kind === "project"
                ? p.scope.context
                : undefined,
            harnesses: p.harnesses,
            primaryHarness: p.primaryHarness,
            routingGoal: p.routingGoal,
            n: p.n,
            attempts: p.attempts ?? null,
            untilClean: p.untilClean === true,
            deepScan: p.deepScan === true,
            create: p.create === true,
            council: p.council === true,
            delegate: p.delegate === true,
            // Belt descriptor (D32): built once per delegate run with the parent
            // budget snapshot; injected into agent lanes whose adapter can host
            // MCP servers. Null when delegate is off (no belt).
            delegationBelt,
            synthesis: p.synthesis,
            paidBudget: p.paidBudget,
            access: p.access,
            web: p.web ?? p.externalContextPolicy,
            externalContextPolicy: p.externalContextPolicy ?? p.web,
            model: p.model,
            models: p.models,
            effort: p.effort,
            efforts: p.efforts,
            tests: Array.isArray(p.tests) ? p.tests : undefined,
            protectedPathApprovals: Array.isArray(p.protectedPathApprovals)
              ? p.protectedPathApprovals
              : undefined,
            inPlace,
            delegated: p.execution.delegated,
            signal: runSignal,
            onRunStart,
          })
          .finally(() => {
            if (deadlineTimer) clearTimeout(deadlineTimer);
          });
      },
    });
    bindDelegationDaemon(server);

    const authReadiness = new AuthReadinessService(buildGateway({ includeFakes: false }), {
      cwd: NO_PROJECT_ROOT,
    });
    const setupBinding = new SetupLifecycleBinding(setupStoreSlot, (store) =>
      createSetupJobManager({
        rootDir: daemonDir(),
        store,
        onCredentialStateMayHaveChanged: (harness) => {
          bustGlobalCredentialStatusCaches(() => quotaStoreSlot.current());
          authReadiness.invalidate(harness);
        },
      }),
    );
    let control: DaemonControlApiServer | null = null;
    shutdownRuntime = new DaemonRuntimeShutdown({
      daemon: server,
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
    // The daemon owns its services whether or not the HTTP surface is up —
    // the startup retention pass below consumes them directly.
    const selfClient = new DaemonClient(socketPath, token);
    const services = controlServices(
      interactions,
      () => projectStoreSlot.current(),
      threads,
      setupBinding,
      journalManager,
      authReadiness,
      resources,
      () => quotaStoreSlot.current(),
      () => selfClient.list(),
    );
    control = !controlApiEnabledForStartup({
      disabledByEnv: process.env.CLAUDEXOR_NO_CONTROL_API === "1",
      blockedPartitions: startupBlockedPartitions,
      log: (message) => logLine(logPath(), message),
    })
      ? null
      : new DaemonControlApiServer({
          token,
          daemon: new DaemonClient(socketPath, token),
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
        socket: selfClient,
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
    lifecycle.finalize();
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
        lifecycle?.finalize();
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
