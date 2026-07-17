#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
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
  acquireDaemonWriterLease,
  ensureToken,
  ensureDaemonRuntimeRoot,
  logPath,
  socketAlive,
} from "@claudexor/daemon";
import { DaemonControlApiServer, normalizeRunStartRequest } from "@claudexor/control-api";
import { armDaemonLifecycle, logLine, runStartupCrashGc } from "./daemon-lifecycle.js";
import { Orchestrator } from "@claudexor/orchestrator";
import { loadConfig } from "@claudexor/config";
import { ensureThreadWorktree } from "@claudexor/workspace";
import { noProjectRepoRoot, redactSecrets } from "@claudexor/util";
import { type ResourceAttachmentRef } from "@claudexor/schema";
import { scheduleStartupRetention } from "./retention-service.js";
import { controlServices } from "./control-services.js";
import { AuthReadinessService } from "@claudexor/gateway";
import { buildGateway, buildRegistry } from "./registry.js";
import { createSetupJobManager } from "./setup-jobs.js";
import { SetupJobStore } from "./setup-job-store.js";
import { SetupLifecycleBinding } from "./setup-lifecycle-binding.js";
import { DaemonRuntimeShutdown } from "./daemon-runtime-shutdown.js";
import { refreshCodexQuota } from "./codex-quota-source.js";
import { refreshClaudeStatuslineQuota } from "./claude-statusline.js";
import { refreshClaudeOauthUsageQuota } from "./claude-oauth-usage.js";
const NO_PROJECT_ROOT = noProjectRepoRoot();

async function main(): Promise<void> {
  ensureDaemonRuntimeRoot();
  const socketPath = defaultSocketPath();
  const writerLease = acquireDaemonWriterLease(socketPath);
  let shutdownRuntime: DaemonRuntimeShutdown | null = null;
  let lifecycle: ReturnType<typeof armDaemonLifecycle> | null = null;
  let quotaPollTimer: NodeJS.Timeout | null = null;
  try {
    const token = ensureToken();

    if (await socketAlive(socketPath)) {
      throw new Error(`a claudexor daemon is already listening on ${socketPath}; stop it first`);
    }
    await runStartupCrashGc({ daemonDir: daemonDir(), logPath: logPath() });

    const bus = new RunEventBus();
    const journalManager = new JournalManager(daemonDir());
    const commandStoreSlot = journalManager.registerProjection(commandProjection());
    const interactionStoreSlot = journalManager.registerProjection(interactionProjection());
    const operatorDecisionStoreSlot = journalManager.registerProjection(
      operatorDecisionProjection(),
    );
    const runEventStoreSlot = journalManager.registerProjection(runEventProjection());
    const projectStoreSlot = journalManager.registerProjection(projectProjection());
    const quotaStoreSlot = journalManager.registerProjection(
      quotaProjection([
        refreshCodexQuota,
        refreshClaudeStatuslineQuota,
        () => refreshClaudeOauthUsageQuota(),
      ]),
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
    journalManager.start();
    const pollQuota = () => {
      try {
        void quotaStoreSlot.current().pollStale();
      } catch {}
    };
    quotaPollTimer = setInterval(pollQuota, 60_000).unref();
    pollQuota();
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
    const interactions = new InteractionRegistry({
      forRequest: (params) => threads.interactionsForRequest(params),
      all: () => threads.interactionStores(),
    });
    const resources = new ResourceStore(join(daemonDir(), "resource-store"));

    const server = new DaemonServer({
      socketPath,
      token,
      commands: threads,
      onRunTerminal: (runId, threadId) => {
        interactions.dropForRun(runId);
        // Run-terminal is the one W12 path with no thread-store mutation to
        // ride — the terminal changes the thread's presented state, so ping.
        if (threadId) threads.pingThreadHead(threadId);
      },
      onTurnEnqueueFailed: (turnId, error, code) =>
        threads.setTurnEnqueueError(turnId, error, code),
      onShutdownRequested: () =>
        shutdownRuntime?.beginShutdown("socket-rpc stop") ??
        Promise.reject(new Error("daemon shutdown coordinator is not initialized")),
      runner: async (params, ctx) => {
        const p = normalizeRunStartRequest(params);
        const mode = p.mode;
        const noProjectAsk = mode === "ask" && p.scope.kind === "none";
        const repoRoot = p.scope.kind === "project" ? p.scope.root : NO_PROJECT_ROOT;
        if (noProjectAsk) mkdirSync(NO_PROJECT_ROOT, { recursive: true, mode: 0o700 });
        const orchestrator = new Orchestrator({
          registry: buildRegistry(),
          routingGoal: p.routingGoal,
          quotaSnapshots: () => quotaStoreSlot.current().read().snapshots,
          quotaEventSink: (harnessId, event) => quotaStoreSlot.current().ingest(harnessId, event),
          reviewerPanel: p.reviewerPanel,
          reviewerModels:
            p.reviewerModels && typeof p.reviewerModels === "object" ? p.reviewerModels : undefined,
          reviewerEfforts:
            p.reviewerEfforts && typeof p.reviewerEfforts === "object"
              ? p.reviewerEfforts
              : undefined,
        });
        const { threadId, turnId } = threads.assertKnownIds(p.threadId, p.turnId);
        let executionRoot: string | undefined;
        let inPlace = p.execution.isolation === "live";
        if (threadId && repoRoot !== NO_PROJECT_ROOT) {
          const thread = threads.getThread(threadId);
          if (thread?.workspace.mode === "isolated") {
            const wt = await ensureThreadWorktree(repoRoot, threadId);
            executionRoot = wt.path;
            // Only creation owns the base; apply advances it independently.
            if (wt.created) threads.setThreadWorktree(threadId, wt.path, wt.baseSha);
            inPlace = true; // isolated turns run in-place WITHIN the worktree
          }
        }
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
            ? // Defense in depth against a setTimeout 32-bit-ms overflow (the
              // schema already caps at 7 days for the control-API path).
              Math.min(p.maxSeconds, 604_800)
            : null;
        // INV-135 selection precedence: explicit per-turn profile beats the
        // thread's sticky profile beats the engine default. The winner scopes
        // BOTH the run spec and the resume-session lookup (resume never
        // crosses profiles).
        const requestedProfileId =
          typeof p.credentialProfileId === "string" && p.credentialProfileId
            ? p.credentialProfileId
            : threadId
              ? (threads.getThread(threadId)?.credential_profile_id ?? null)
              : null;
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
        return orchestrator
          .run({
            onEvent: (event) => {
              if (event.type === "harness.event") {
                const payload = event.payload as Record<string, unknown>;
                const harnessId =
                  typeof payload["harness_id"] === "string" ? payload["harness_id"] : "";
                if (harnessId) quotaStoreSlot.current().ingest(harnessId, payload);
              }
              threads.recordRunEvent(p, event);
              bus.publish(event);
            },
            onInteraction: (ctx2) => interactions.register(ctx2, p),
            interactionTimeoutMs: loadConfig(repoRoot).global.interaction_timeout_ms,
            threadId,
            executionRoot,
            resumeSessions: threadId ? threads.resumeMap(threadId, requestedProfileId) : undefined,
            onSessionObserved: threadId
              ? (harnessId, nativeSessionId, observedModel, profileId) =>
                  // The EVENT's profile is the cache truth (INV-135): rotation
                  // makes the effective profile differ from the requested one,
                  // and a mislabeled session would resume under the wrong
                  // account on the next turn.
                  threads.recordSession(
                    threadId,
                    harnessId,
                    nativeSessionId,
                    observedModel,
                    profileId ?? null,
                  )
              : undefined,
            authPreference: p.authPreference,
            credentialProfileId: requestedProfileId,
            autonomy: p.autonomy,
            answerInteraction: async (subRunId, interactionId, answers) =>
              interactions.answer(subRunId, interactionId, answers).status === "delivered",
            repoRoot,
            prompt: String(p.prompt ?? ""),
            instructions: typeof p.instructions === "string" ? p.instructions : undefined,
            denyPaths: Array.isArray(p.denyPaths) ? p.denyPaths : undefined,
            maxTurns: typeof p.maxTurns === "number" && p.maxTurns > 0 ? p.maxTurns : undefined,
            outputSchema:
              p.outputSchema && typeof p.outputSchema === "object" && !Array.isArray(p.outputSchema)
                ? (p.outputSchema as Record<string, unknown>)
                : undefined,
            attachments: turnId
              ? (threads.getTurn(turnId)?.attachments ?? [])
              : resources.resolve((p as { attachments?: ResourceAttachmentRef[] }).attachments),
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
            swarm: p.swarm === true,
            create: p.create === true,
            synthesis: p.synthesis,
            paidBudget: p.paidBudget,
            maxToolCalls: p.maxToolCalls ?? null,
            access: p.access,
            web: p.web ?? p.externalContextPolicy,
            externalContextPolicy: p.externalContextPolicy ?? p.web,
            model: p.model,
            models: p.models,
            effort: p.effort,
            tests: Array.isArray(p.tests) ? p.tests : undefined,
            protectedPathApprovals: Array.isArray(p.protectedPathApprovals)
              ? p.protectedPathApprovals
              : undefined,
            specId: typeof p.specId === "string" ? p.specId : undefined,
            specHash: typeof p.specHash === "string" ? p.specHash : undefined,
            specPath: typeof p.specPath === "string" ? p.specPath : undefined,
            inPlace,
            signal: runSignal,
            onRunStart,
          })
          .finally(() => {
            if (deadlineTimer) clearTimeout(deadlineTimer);
          });
      },
    });

    const authReadiness = new AuthReadinessService(buildGateway({ includeFakes: false }), {
      cwd: NO_PROJECT_ROOT,
    });
    const setupBinding = new SetupLifecycleBinding(setupStoreSlot, (store) =>
      createSetupJobManager({
        rootDir: daemonDir(),
        store,
        onCredentialStateMayHaveChanged: (harness) => authReadiness.invalidate(harness),
      }),
    );
    let control: DaemonControlApiServer | null = null;
    shutdownRuntime = new DaemonRuntimeShutdown({
      daemon: server,
      setup: setupBinding,
      control: () => control,
      journal: {
        close: () => {
          if (quotaPollTimer) clearInterval(quotaPollTimer);
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
    control =
      process.env.CLAUDEXOR_NO_CONTROL_API === "1"
        ? null
        : new DaemonControlApiServer({
            token,
            daemon: new DaemonClient(socketPath, token),
            port: Number(process.env.CLAUDEXOR_CONTROL_PORT ?? 0),
            bus,
            services,
          });
    lifecycle = armDaemonLifecycle({
      daemonDir: daemonDir(),
      logPath: logPath(),
      beginShutdown: (reason) => shutdownRuntime!.beginShutdown(reason),
    });

    await setupBinding.start();
    if (!shutdownRuntime.requested()) await server.start();
    if (!shutdownRuntime.requested()) {
      appendFileSync(
        logPath(),
        `[${new Date().toISOString()}] claudexord listening on ${socketPath}\n`,
      );
    }
    if (control && !shutdownRuntime.requested()) {
      const controlAddr = await control.start();
      if (!shutdownRuntime.requested()) {
        writeFileSync(
          join(daemonDir(), "control-api.json"),
          `${JSON.stringify({ ...controlAddr, tokenPath: join(daemonDir(), "token") }, null, 2)}\n`,
          { mode: 0o600 },
        );
        appendFileSync(
          logPath(),
          `[${new Date().toISOString()}] claudexor control-api listening on http://${controlAddr.host}:${controlAddr.port}\n`,
        );
      }
    } else if (!control && !shutdownRuntime.requested()) {
      appendFileSync(
        logPath(),
        `[${new Date().toISOString()}] claudexor control-api disabled by CLAUDEXOR_NO_CONTROL_API=1\n`,
      );
    }
    if (!shutdownRuntime.requested()) {
      scheduleStartupRetention(services.runRetention, {
        logPath: logPath(),
        shuttingDown: () => shutdownRuntime!.requested(),
      });
    }
    await shutdownRuntime.wait();
    lifecycle.finalize();
    appendFileSync(logPath(), `[${new Date().toISOString()}] claudexord shut down\n`);
  } catch (error) {
    try {
      appendFileSync(
        logPath(),
        `[${new Date().toISOString()}] daemon lifecycle FAILED: ${redactSecrets(
          error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        )}\n`,
      );
    } catch {
      /* preserve the lifecycle failure */
    }
    if (shutdownRuntime) {
      try {
        await shutdownRuntime.beginShutdown("startup failure");
        lifecycle?.finalize();
      } catch (shutdownError) {
        try {
          appendFileSync(
            logPath(),
            `[${new Date().toISOString()}] shutdown FAILED: ${redactSecrets(
              shutdownError instanceof Error ? shutdownError.message : String(shutdownError),
            )}\n`,
          );
        } catch {
          /* preserve the shutdown failure */
        }
        throw new AggregateError(
          [error, shutdownError],
          "claudexord failed and could not complete shutdown",
        );
      }
    }
    throw error;
  } finally {
    if (quotaPollTimer) clearInterval(quotaPollTimer);
    writerLease.release();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`claudexord: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
