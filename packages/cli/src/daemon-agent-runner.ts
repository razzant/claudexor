import { runCredentialProfileId } from "./run-credential-profile.js";
import { mkdirSync } from "node:fs";
import type {
  AccountEvidence,
  InteractionRegistry,
  LiveInputRegistry,
  ProjectThreadPort,
  CommandQueries,
  QuotaRegistry,
  ResourceStorePort,
  RunEventBus,
  RunnerFn,
} from "@claudexor/daemon";
import { assertCouncilWidth, type DelegationBudgetAuthority } from "@claudexor/orchestrator";
import { normalizeRunStartRequest } from "@claudexor/control-api";
import { loadConfig } from "@claudexor/config";
import { noProjectRepoRoot } from "@claudexor/util";
import {
  restoreRecordedRunReviewRequest,
  type ResourceAttachmentRef,
  RuntimeConcurrencyCaps,
  CapturedRunStart,
} from "@claudexor/schema";
import { assertPlanImplementReady } from "./plan-implement-readiness.js";
import { buildRunOrchestrator } from "./run-orchestrator.js";
import { delegationBeltForRun } from "./delegation-belt-descriptor.js";
import { accountsMigrationGate } from "./accounts-unified-migration.js";
import { preflightRunGitRequirement } from "./request-preflight.js";
import {
  assertThreadExecutionBinding,
  resolveThreadExecutionWorkspace,
  threadRunStartRequiresGit,
} from "./thread-execution-workspace.js";
import { threadRunResumeInputs, threadContinuityContext } from "./thread-continuity-context.js";
import { continuationForRun } from "./continue-from-run.js";
import { createRunTimeLimit } from "./run-time-limit.js";
import { exactRetryProcessingIntent } from "./retry-processing.js";
import { oneShotRunInput } from "./one-shot-run-input.js";

/** Agent commands alone own projects, tool execution, and conversation continuity.
 * Model commands are dispatched before entering this run-normalization boundary. */
export function createDaemonAgentRunner(deps: {
  delegationBudgetAuthority: DelegationBudgetAuthority;
  quotaStore: () => QuotaRegistry;
  /** The store's account evidence graph: every run binds and reads the same one. */
  accounts: AccountEvidence;
  threads: ProjectThreadPort;
  commands: Pick<CommandQueries, "getByRunId">;
  interactions: InteractionRegistry;
  liveInputs: LiveInputRegistry;
  resources: () => ResourceStorePort;
  bus: RunEventBus;
  runtimeConcurrencyCaps?: RuntimeConcurrencyCaps;
  terminalPersistence?: (
    jobId: string,
  ) => NonNullable<
    Parameters<ReturnType<typeof buildRunOrchestrator>["run"]>[0]["onTerminalPersist"]
  >;
  terminalStaging?: (
    jobId: string,
  ) => NonNullable<
    Parameters<ReturnType<typeof buildRunOrchestrator>["run"]>[0]["onTerminalStage"]
  >;
}): RunnerFn {
  const {
    delegationBudgetAuthority,
    quotaStore,
    threads,
    interactions,
    liveInputs,
    resources,
    bus,
    runtimeConcurrencyCaps = RuntimeConcurrencyCaps.parse({}),
  } = deps;
  const NO_PROJECT_ROOT = noProjectRepoRoot();
  return async (params, ctx) => {
    // A thread-bound run's caller-owned root is revalidated by the thread
    // resolver below as a durable, retryable refusal on the exact turn.
    const threadBound = typeof (params as { threadId?: unknown } | null)?.threadId === "string";
    const { deferredDefaults, ...request } = CapturedRunStart.parse(params);
    const p = {
      ...restoreRecordedRunReviewRequest(
        normalizeRunStartRequest(request, { deferExecutionWorkspaceAvailability: threadBound }),
      ),
      deferredDefaults,
    };
    const continuation = continuationForRun(p, deps.commands);
    const mode = p.mode;
    const noProjectAsk = mode === "ask" && p.scope.kind === "none";
    const repoRoot = p.scope.kind === "project" ? p.scope.root : NO_PROJECT_ROOT;
    const runConfig = loadConfig(repoRoot);
    if (p.council) assertCouncilWidth(p.n, runtimeConcurrencyCaps.max_council_members);
    if (noProjectAsk) mkdirSync(NO_PROJECT_ROOT, { recursive: true, mode: 0o700 });
    const orchestrator = buildRunOrchestrator({
      accounts: deps.accounts,
      p,
      delegationBudgetAuthority,
      quotaStore: () => quotaStore(),
      // Typed per-harness refusal while a unified-accounts migration is
      // incomplete (a crash between phases) — other harnesses keep working.
      accountsMigrationGate,
      runtimeConcurrencyCaps,
    });
    const { threadId, turnId } = threads.assertKnownIds(p.threadId, p.turnId);
    assertThreadExecutionBinding(threadId ? threads.getThread(threadId) : undefined, p);
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
      workspaceKind: p.execution.workspaceKind,
      protectedPaths: runConfig.project.constraints.protected_paths,
      threads,
    });
    const executionRoot = p.execution.workspaceRoot ?? threadExecutionRoot;
    const onRunStart = (info: { runId: string; taskId: string; runDir: string }): void => {
      ctx.onRunStart?.(info);
      timeLimit.started(info);
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
    // INV-135 precedence: explicit per-turn profile > thread sticky >
    // unpinned; an explicit NULL forces unpinned (release wave round-11).
    const requestedProfileId = runCredentialProfileId(
      p,
      (id) => threads.getThread(id)?.credential_profile_id,
    );
    const continuityContext = threadContinuityContext({
      threads,
      threadId,
      turnId,
      profileId: requestedProfileId,
    });
    const delegationBelt = delegationBeltForRun(p.delegate === true, p.paidBudget);
    const timeLimit = createRunTimeLimit(p, ctx);
    return orchestrator
      .run({
        ...oneShotRunInput(p),
        onTerminalPersist: deps.terminalPersistence?.(ctx.jobId),
        onTerminalStage: deps.terminalStaging?.(ctx.jobId),
        onEventPersist: (event) => {
          // The owning journal partition is the durable terminal
          // authority. EventLog runs this before committing RunFacts.
          threads.recordRunEvent(p, event);
        },
        onEvent: (event) => {
          // Native quota intake belongs to the dispatch-bound observer. A
          // presentation event is not a second, profile-less observation.
          // Live listeners observe only after journal + RunFacts commit;
          // durable replay stays authoritative if publish throws.
          try {
            bus.publish(event);
          } catch {}
        },
        onInteraction: (ctx2) => interactions.register(ctx2, p),
        interactionTimeoutMs: runConfig.global.interaction_timeout_ms,
        // Live messages (POST /v2/runs/:id/messages): each agent attempt is a
        // steering target for its own lifetime; the registry answers typed.
        onLiveAttempt: (attempt) => liveInputs.register(attempt),
        threadId,
        executionRoot,
        continuation,
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
        credentialProfileId: requestedProfileId,
        parentRunId: p.parentRunId ?? null,
        delegatedFromRunId: p.delegatedFromRunId ?? null,
        delegationAdmissionId: ctx.jobId,
        attachments: turnId
          ? (threads.getTurn(turnId)?.attachments ?? [])
          : resources().resolve((p as { attachments?: ResourceAttachmentRef[] }).attachments, {
              owner: "command",
              id: ctx.jobId,
            }),
        // Belt descriptor (D32): built once per delegate run with the parent
        // budget snapshot; injected into agent lanes whose adapter can host
        // MCP servers. Null when delegate is off (no belt).
        delegationBelt,
        processingIntent: exactRetryProcessingIntent(p, deps.commands, repoRoot),
        inPlace,
        signal: timeLimit.signal,
        onRunStart,
      })
      .finally(() => {
        timeLimit.dispose();
      });
  };
}
