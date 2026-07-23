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
import { assertPlanImplementReady } from "./plan-implement-readiness.js";
import { Orchestrator } from "@claudexor/orchestrator";
import { buildDelegationBeltDescriptor } from "./delegation-belt-descriptor.js";
import { loadConfig, sweepRetiredConfigKeysAtStartup } from "@claudexor/config";
import { ensureThreadWorktree } from "@claudexor/workspace";
import { noProjectRepoRoot, redactSecrets } from "@claudexor/util";
import { type QuotaSubject, type ResourceAttachmentRef } from "@claudexor/schema";
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

/** The registered quota-subject UNIVERSE (release cut V11a): for each harness,
 * the engine-default credential (subject null) plus one subject per enabled
 * config_dir_login profile. A subject the refreshers never report on still
 * surfaces a typed "no_source" absence instead of vanishing. Pure derivation
 * of the current config — recomputed every refresh cycle. */
export function quotaSubjectUniverse(): QuotaSubject[] {
  const profiles = loadConfig(noProjectRepoRoot()).global.credential_profiles;
  const subjects: QuotaSubject[] = [];
  for (const harness of ["claude", "codex"] as const) {
    subjects.push({
      harness,
      credential_route: "vendor_native",
      plan_label: null,
      subject_id: null,
    });
    for (const profile of profiles) {
      if (profile.harness_id !== harness || !profile.enabled) continue;
      if (profile.credential_kind !== "config_dir_login") continue;
      subjects.push({
        harness,
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: profile.profile_id,
      });
    }
  }
  return subjects;
}

async function main(): Promise<void> {
  ensureDaemonRuntimeRoot();
  const socketPath = defaultSocketPath();
  const writerLease = acquireDaemonWriterLease(socketPath);
  let shutdownRuntime: DaemonRuntimeShutdown | null = null;
  // Release wave round-12 BLOCK: the single-writer lease may only be released
  // after a CLEAN shutdown — a failed/partial shutdown keeps components that
  // can still write, and releasing would let a successor acquire ownership
  // beside them. On failure the lease dies with the process instead.
  let releaseWriterLease = true;
  let lifecycle: ReturnType<typeof armDaemonLifecycle> | null = null;
  let quotaPollTimer: NodeJS.Timeout | null = null;
  try {
    const token = ensureToken();

    if (await socketAlive(socketPath)) {
      throw new Error(`a claudexor daemon is already listening on ${socketPath}; stop it first`);
    }
    await runStartupCrashGc({ daemonDir: daemonDir(), logPath: logPath() });
    // Same-root config evolution hygiene (B9): strip + persist any known-retired
    // keys an OLDER version wrote into the global config, before any strict
    // parse can trip on them (mirrors the crash-GC startup sweep). Unknown keys
    // NOT on the retired registry still fail loud at parse (INV-021).
    for (const sweep of sweepRetiredConfigKeysAtStartup()) {
      logLine(
        logPath(),
        `swept retired config keys from ${sweep.path}: ${sweep.removed.join(", ")}`,
      );
    }

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
      quotaProjection(
        [refreshCodexQuota, refreshClaudeStatuslineQuota, () => refreshClaudeOauthUsageQuota()],
        quotaSubjectUniverse,
      ),
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
      onTurnEnqueueFailed: (turnId, error, code, retryable) =>
        threads.setTurnEnqueueError(turnId, error, code, retryable),
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
        // thread's sticky profile beats the engine default — and an explicit
        // NULL forces the default ladder past the sticky profile (release
        // wave round-11). The winner scopes BOTH the run spec and the
        // resume-session lookup (resume never crosses profiles).
        const requestedProfileId =
          p.credentialProfileId === null
            ? null
            : typeof p.credentialProfileId === "string" && p.credentialProfileId
              ? p.credentialProfileId
              : threadId
                ? (threads.getThread(threadId)?.credential_profile_id ?? null)
                : null;
        // Continuity context (INV-137): prior turns (for the delta packet) and
        // every lane checkpoint of the thread. Only a bound thread turn carries
        // it — a non-thread one-shot has no conversation to continue.
        const continuityContext =
          threadId && turnId
            ? (() => {
                const current = threads.getTurn(turnId);
                const currentCreatedAt = current?.created_at ?? "";
                const priorTurns = threads
                  .turnsFor(threadId)
                  .filter(
                    (t) =>
                      t.id !== turnId &&
                      t.run_id != null &&
                      (!currentCreatedAt || t.created_at < currentCreatedAt),
                  )
                  .map((t) => ({ id: t.id, prompt: t.prompt, runId: t.run_id }));
                return {
                  turnId,
                  profileId: requestedProfileId,
                  priorTurns,
                  laneCheckpoints: threads.laneCheckpointsForThread(threadId).map((c) => ({
                    harness: c.harness_id,
                    profileId: c.profile_id ?? null,
                    turnId: c.turn_id,
                  })),
                };
              })()
            : undefined;
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
              ? (harnessId, nativeSessionId, observedModel, profileId) => {
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
                  );
                  // The lane (thread, harness, effective profile) has now SEEN
                  // this turn: its native session holds up to here (INV-137).
                  // Keyed by the SAME effective profile as the session so the
                  // next turn's packet math (checkpoint vs head) is exact.
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
            deepScan: p.deepScan === true,
            create: p.create === true,
            council: p.council === true,
            delegate: p.delegate === true,
            // Belt descriptor (D32): built once per delegate run with the parent
            // budget snapshot; injected into agent lanes whose adapter can host
            // MCP servers. Null when delegate is off (no belt).
            delegationBelt:
              p.delegate === true ? buildDelegationBeltDescriptor(p.paidBudget) : null,
            synthesis: p.synthesis,
            paidBudget: p.paidBudget,
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
        onCredentialStateMayHaveChanged: (harness) => {
          authReadiness.invalidate(harness);
          // Drop the quota absence backoff too (wave-1): a fresh login must
          // not wait out up to 15 minutes of logged-out pacing.
          quotaStoreSlot.current().noteCredentialChange();
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
      // F2 ghost-cleanup: retire projects auto-registered from an
      // envelope worktree (root inside the Claudexor runtime tree) or whose
      // root is permanently gone, so a dead root can never poison listings.
      try {
        const retired = threads.quarantineGhostProjects();
        for (const ghost of retired) {
          logLine(
            logPath(),
            `projects: quarantined ghost ${ghost.projectId} (${ghost.reason}): ${ghost.root}`,
          );
        }
      } catch (error) {
        logLine(
          logPath(),
          `projects: ghost sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
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
        releaseWriterLease = false;
        throw new AggregateError(
          [error, shutdownError],
          "claudexord failed and could not complete shutdown",
        );
      }
    }
    throw error;
  } finally {
    if (quotaPollTimer) clearInterval(quotaPollTimer);
    if (releaseWriterLease) writerLease.release();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`claudexord: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
