import { mkdirSync } from "node:fs";
import type {
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

/** Agent commands alone own projects, tool execution, and conversation continuity.
 * Model commands are dispatched before entering this run-normalization boundary. */
export function createDaemonAgentRunner(deps: {
  delegationBudgetAuthority: DelegationBudgetAuthority;
  quotaStore: () => QuotaRegistry;
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
    const p = restoreRecordedRunReviewRequest(
      normalizeRunStartRequest(params, { deferExecutionWorkspaceAvailability: threadBound }),
    );
    const continuation = continuationForRun(p, deps.commands);
    const mode = p.mode;
    const noProjectAsk = mode === "ask" && p.scope.kind === "none";
    const repoRoot = p.scope.kind === "project" ? p.scope.root : NO_PROJECT_ROOT;
    const runConfig = loadConfig(repoRoot);
    if (p.council) assertCouncilWidth(p.n, runtimeConcurrencyCaps.max_council_members);
    if (noProjectAsk) mkdirSync(NO_PROJECT_ROOT, { recursive: true, mode: 0o700 });
    const orchestrator = buildRunOrchestrator({
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
      deadlineTimer = setTimeout(() => deadline.abort("wall_clock_exceeded"), maxSeconds * 1000);
      deadlineTimer.unref?.();
      runSignal = ctx.signal ? AbortSignal.any([ctx.signal, deadline.signal]) : deadline.signal;
    }
    const delegationBelt = delegationBeltForRun(p.delegate === true, p.paidBudget);
    return orchestrator
      .run({
        onTerminalPersist: deps.terminalPersistence?.(ctx.jobId),
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
        review: p.review,
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
        processingPreference: p.processingPreference,
        tests: Array.isArray(p.tests) ? p.tests : undefined,
        protectedPathApprovals: Array.isArray(p.protectedPathApprovals)
          ? p.protectedPathApprovals
          : undefined,
        inPlace,
        delegated: p.execution.delegated,
        workspaceKind: p.execution.workspaceKind,
        scopePaths: p.execution.scopePaths,
        signal: runSignal,
        onRunStart,
      })
      .finally(() => {
        if (deadlineTimer) clearTimeout(deadlineTimer);
      });
  };
}
