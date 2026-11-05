/** Thread-turn creation and refused-turn retry over the existing journal authority. */
import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import {
  ControlRunStartInfo,
  ControlRunStartRequest,
  RunExecution,
  ControlThreadTurnResponse,
} from "@claudexor/schema";
import type { ResourceAttachmentRef, TurnEnqueueProblem } from "@claudexor/schema";
import type { DaemonFacadeClient, DaemonRunRecord } from "./daemon-server.js";
import { delegatedThreadExecution } from "./thread-delegated-execution.js";
import {
  errStatus,
  preStartRefusalStatus,
  problemFromError,
  turnEnqueueProblemResponse,
} from "./thread-turn-problems.js";
import type { RunStartNormalizationOptions } from "./run-start.js";
import { servingStore } from "./run-start-receipt.js";
import {
  assertLatestThreadTurn,
  assertThreadAdmitsWork,
  inspectThreadTurnCreateReplay,
} from "./thread-recovery.js";
import { chainThreadMutation } from "./thread-mutation.js";
import { assertActiveThreadAccessOverride } from "./thread-access-migration.js";
import {
  assertPlanAnswerQuestionsArtifact,
  assertPlanAnswerSubmission,
} from "./thread-plan-answer.js";

/** `heldBy`: the accepted turn reading its own refs (a released ID it holds still resolves). */
type TurnRequirementsPreflight = (
  request: ControlRunStartRequest,
  heldBy?: { owner: "turn"; id: string },
) => Promise<void>;

export interface ThreadTurnRouteCtx {
  json(res: ServerResponse, status: number, body: unknown): void;
  storeId?: () => string | undefined;
  /** The request opted in to `storeId`; the strict queued receipt must not surprise older clients. */
  wantsStoreId?: boolean;
  waitForRunStart(jobId: string): Promise<DaemonRunRecord>;
  readRunArtifactText(runId: string, relPath: string): Promise<string | null>;
  resolveRunArtifactPath(runId: string, relPath: string): Promise<string | null>;
  /** The server's single run-start normalizer (scope/prompt/policy validation). */
  normalizeStart(
    parsed: ControlRunStartRequest,
    options?: RunStartNormalizationOptions,
  ): ControlRunStartRequest;
  preflightRunRequirements?: TurnRequirementsPreflight;
  /** Non-durable request checks for a thread turn; Git runs inside its daemon job. */
  preflightThreadRunRequirements?: TurnRequirementsPreflight;
  /** True for terminal job states (the server's TERMINAL_STATES set). */
  isTerminalState(state: string): boolean;
  daemon: DaemonFacadeClient;
  threadDetail(id: string): Promise<{ thread: unknown; sessions: unknown[]; turns: unknown[] }>;
  createThreadTurn(
    id: string,
    prompt: string,
    opts: {
      parentRunId?: string | null;
      answersPlanRunId?: string | null;
      planRunId?: string | null;
      planHash?: string | null;
      planOverridden?: boolean;
      attachments?: ResourceAttachmentRef[];
      idempotency?: { key: string; client: string; request: unknown };
    },
  ): Promise<unknown>;
  findThreadTurnByIdempotency?: (
    id: string,
    idempotency: { key: string; client: string; request: unknown },
  ) => Promise<{ id: string } | null>;
  setTurnEnqueueError?: (turnId: string, problem: TurnEnqueueProblem) => void;
  threadTurnChains: Map<string, Promise<void>>;
}

async function respondToTurnJob(
  ctx: ThreadTurnRouteCtx,
  res: ServerResponse,
  jobId: string,
  threadId: string,
  turnId: string,
): Promise<void> {
  let rec: DaemonRunRecord;
  try {
    rec = await ctx.waitForRunStart(jobId);
  } catch (error) {
    return ctx.json(res, 500, {
      error: `job ${jobId} was accepted but its start could not be observed: ${error instanceof Error ? error.message : String(error)}`,
      jobId,
      turnId,
      threadId,
    });
  }
  const store = ctx.wantsStoreId ? servingStore(ctx.storeId) : {};
  if (rec.runId && rec.runDir) {
    return ctx.json(
      res,
      200,
      ControlThreadTurnResponse.parse({
        ...ControlRunStartInfo.parse({
          ...store,
          jobId: rec.id,
          runId: rec.runId,
          taskId: rec.taskId,
          runDir: rec.runDir,
        }),
        turnId,
        threadId,
      }),
    );
  }
  if (ctx.isTerminalState(rec.state)) {
    // A pre-start terminal carrying a TYPED refusal code (e.g. the trust gate's
    // trust_full_access_required) is a client-actionable 4xx, not a 500: the
    // inline turn card keys its one-click remedy on the CODE, and a 500 would
    // make embedders retry an unretryable refusal. Infra terminals (no typed
    // code) stay 5xx so genuine transient failures are still retried.
    const { storeId: _store, ...errorContext } = rec.errorContext ?? {};
    return ctx.json(res, preStartRefusalStatus(rec.errorCode, rec.errorStatus), {
      jobId: rec.id,
      turnId,
      threadId,
      state: rec.state,
      error: rec.error ?? `run ended pre-start: ${rec.state}`,
      ...(rec.errorCode ? { code: rec.errorCode } : {}),
      retryable: rec.errorRetryable ?? true,
      requiredActions: rec.errorRequiredActions ?? [],
      context: {
        ...errorContext,
        jobId: rec.id,
        turnId,
        threadId,
        ...store,
      },
    });
  }
  return ctx.json(
    res,
    202,
    ControlThreadTurnResponse.parse({
      ...store,
      jobId: rec.id,
      turnId,
      threadId,
      state: rec.state,
    }),
  );
}

/**
 * POST /threads/:id/turns — create the turn record FIRST (single-writer), then
 * enqueue its run. Per-thread serialization: concurrent turns on one thread
 * would race the head_run_id lineage (check-then-act across awaits).
 */
export function handleThreadTurnCreate(
  ctx: ThreadTurnRouteCtx,
  res: ServerResponse,
  threadId: string,
  body: import("@claudexor/schema").ControlThreadTurnRequest,
  idempotencyKey: string,
): Promise<void> {
  return chainThreadMutation(ctx.threadTurnChains, threadId, async () => {
    // Once the turn record exists, any later failure in this handler must
    // land ON the turn (honest inline refusal) — not only in one HTTP
    // response that a reloading client never sees.
    let createdTurnId: string | null = null;
    try {
      const idempotency = {
        key: idempotencyKey,
        client: "control-api",
        request: { threadId, body },
      };
      const replay = await inspectThreadTurnCreateReplay(ctx.daemon, ctx, threadId, idempotency);
      const detail = replay.detail;
      if (replay.accepted && replay.existingId) {
        return respondToTurnJob(ctx, res, replay.accepted.id, threadId, replay.existingId);
      }
      assertThreadAdmitsWork(threadId, detail.thread);
      const thread = detail.thread as {
        repo: { root: string } | null;
        mode: string;
        auth_preference: string;
        access?: string | null;
        head_run_id: string | null;
        primary_harness: string | null;
        eligible_harnesses?: string[];
        run_ids?: string[];
        workspace?: { mode?: string; workspace_root?: string | null };
      };
      assertActiveThreadAccessOverride(thread.access, body["access"]);
      const turns = detail.turns as Array<Record<string, unknown>>;
      let prompt = String(body["prompt"] ?? "");
      let mode = typeof body["mode"] === "string" ? (body["mode"] as string) : thread.mode;
      const answersPlanRunId =
        typeof body["answersPlanRunId"] === "string" ? (body["answersPlanRunId"] as string) : null;
      const planRunId =
        typeof body["planRunId"] === "string" ? (body["planRunId"] as string) : null;
      assertPlanAnswerSubmission({
        sourcePlanRunId: answersPlanRunId,
        implementPlanRunId: planRunId,
        mode,
        headRunId: thread.head_run_id,
        threadRunIds: thread.run_ids ?? [],
        turns,
      });
      if (answersPlanRunId) {
        assertPlanAnswerQuestionsArtifact(
          await ctx.readRunArtifactText(answersPlanRunId, "final/questions.json"),
        );
      }
      // "Implement plan" (D17/D27): the plan is FROZEN at implement time
      // (sha256 of final/plan.md recorded on the turn and delivered to the
      // executor as a server-owned planRef file reference) — never
      // re-embedded into the prompt text, so the visible turn stays a
      // compact card and an in-place native session cannot see the plan
      // twice. The plan run must belong to THIS thread.
      let planRef: { runId: string; sha256: string; path: string } | null = null;
      let planHash: string | null = null;
      let planOverridden = false;
      if (planRunId) {
        if (!(thread.run_ids ?? []).includes(planRunId)) {
          throw Object.assign(new Error(`planRunId ${planRunId} is not a turn of this thread`), {
            status: 400,
          });
        }
        const planText = await ctx.readRunArtifactText(planRunId, "final/plan.md");
        if (!planText || !planText.trim()) {
          // Fail loudly: "Implement plan" with an unreadable plan must NOT
          // silently run the bare prompt as agent (review r2 #7).
          throw Object.assign(
            new Error(`plan run ${planRunId} has no readable final/plan.md to implement`),
            { status: 400 },
          );
        }
        // Readiness gate (D17) is enforced at RUN-START by the daemon runner,
        // NOT with a bespoke early return here (QA-045). A pre-create throw
        // left NO turn, no idempotency handle, and no replayable refusal — it
        // violated the honest-refused-turn invariant (INV-093) that every other
        // pre-run refusal honors. We only record the operator's explicit
        // override on the turn for provenance; the turn is still created and the
        // run enqueued. When open questions remain and the override is absent,
        // the runner refuses the run PRE-START with a typed `plan_not_ready`,
        // riding the SAME durable mechanism as the trust gate: the daemon
        // persists `enqueue_error` on the turn (retryable — a job was recorded)
        // and POST .../retry replays the recorded params through that fresh
        // preflight once the plan is ready.
        planOverridden = body["overridePlanReadiness"] === true;
        const digest = createHash("sha256").update(planText, "utf8").digest("hex");
        planHash = digest;
        const planPath = await ctx.resolveRunArtifactPath(planRunId, "final/plan.md");
        if (!planPath) {
          throw Object.assign(
            new Error(`plan run ${planRunId} artifact path could not be resolved`),
            { status: 400 },
          );
        }
        planRef = { runId: planRunId, sha256: digest, path: planPath };
        const extra = prompt.trim();
        prompt =
          `Implement the approved plan of this thread (delivered as a plan file in your run context; the engine appends its exact path). Re-read it as needed; deviate only where the code contradicts it, and say so.` +
          (extra && extra !== "Implement this plan."
            ? `\n\n## Additional instruction\n${extra}`
            : "");
        mode = "agent";
      }
      // Agent turns run "live" in the execution tree (in-place project or the
      // thread worktree — the runner resolves which from thread.workspace).
      const isolation =
        body.execution?.workspaceKind === "directory"
          ? (body.execution.isolation ?? (mode === "agent" ? "live" : "envelope"))
          : mode === "agent"
            ? "live"
            : "envelope";
      // A delegated thread records its effective execution in the immutable
      // command params, so Retry, Run Again, continuation, /produced and
      // revert read the same caller-owned address the process actually used.
      const delegatedExecution = delegatedThreadExecution(thread.workspace, mode, body.execution);
      // Sticky routing inheritance (thin gateway — pure DTO passthrough, the
      // engine's orderPool/resolveCandidateAdapters owns all ordering): pool/
      // primary precedence is per-turn body > thread sticky > omit (engine then
      // auto-pools doctor-OK defaults plus exact-profile-ready account rows / falls back to config primary).
      // The pool THIS turn routes/races over: a per-turn override, else the
      // thread's sticky pool, else omit.
      const turnPool = Array.isArray(body["harnesses"])
        ? (body["harnesses"] as string[])
        : thread.eligible_harnesses && thread.eligible_harnesses.length > 0
          ? thread.eligible_harnesses
          : undefined;
      // Inherit the sticky primary ONLY when it stays valid in that pool. If the
      // pool (per-turn OR the inherited thread pool) does not contain the primary
      // — e.g. the user dropped the primary harness from the pool via the "⋯"
      // chips — drop the bias rather than drag it along; the engine would
      // otherwise reject the turn with "primary not in pool".
      const inheritPrimary =
        body["primaryHarness"] === undefined &&
        thread.primary_harness &&
        (!turnPool || turnPool.includes(thread.primary_harness))
          ? thread.primary_harness
          : undefined;
      // `overridePlanReadiness` belongs only to ControlThreadTurnRequest. Its
      // effect is recorded on the turn and honored by the run-start readiness
      // gate; strip it before strict run-start parsing or "Implement anyway" fails.
      const {
        overridePlanReadiness: _overrideConsumed,
        answersPlanRunId: _answersPlanRunIdConsumed,
        ...runStartBody
      } = body;
      const params = ctx.normalizeStart(
        ControlRunStartRequest.parse({
          ...runStartBody,
          prompt,
          scope: thread.repo ? { kind: "project", root: thread.repo.root } : { kind: "none" },
          mode,
          execution: {
            ...RunExecution.parse(runStartBody.execution ?? {}),
            isolation,
            ...delegatedExecution,
          },
          threadId,
          parentRunId: thread.head_run_id ?? undefined,
          planRunId: planRunId ?? undefined,
          authPreference:
            typeof body["authPreference"] === "string"
              ? body["authPreference"]
              : (thread.auth_preference as "auto"),
          // Sticky write scope (D26): per-turn body > thread sticky > omit
          // (the engine then falls back to the repo trust access_default and
          // clamps read-only modes to readonly regardless).
          ...(body["access"] === undefined && thread.access ? { access: thread.access } : {}),
          ...(inheritPrimary ? { primaryHarness: inheritPrimary } : {}),
          ...(planRef ? { planRef } : {}),
          ...(body["harnesses"] === undefined &&
          thread.eligible_harnesses &&
          thread.eligible_harnesses.length > 0
            ? { harnesses: thread.eligible_harnesses }
            : {}),
        }),
        // The bound root's existence is revalidated inside the durable job.
        { deferExecutionWorkspaceAvailability: true },
      );
      // Single-writer: create the turn (run_id=null) BEFORE enqueue and pass
      // its id in the params; the daemon runner binds the started run to it.
      // This means a queued-but-not-yet-started turn is still recorded, so we
      // NEVER cancel the job on a wait timeout (the old #18 race).
      const turn = (await ctx.createThreadTurn(threadId, prompt, {
        // No explicit kind: the store auto-detects initial vs followup so the
        // FIRST turn of a thread is "initial", not "followup" (review #4).
        parentRunId: thread.head_run_id ?? null,
        answersPlanRunId,
        planHash,
        planOverridden,
        planRunId,
        attachments: params.attachments,
        idempotency,
      })) as { id: string };
      createdTurnId = turn.id;
      // Preflight AFTER the turn exists (W19/INV-093): a browser/requirements
      // refusal now has a turnId to land on, so the outer catch persists it via
      // setTurnEnqueueError and the app renders an inline refusal card instead
      // of raw JSON with no turn to attach to.
      // The accepted turn already holds its resolved refs (#249): its own dispatch
      // reads them as that holder, so a release during this await never refuses it.
      await (ctx.preflightThreadRunRequirements ?? ctx.preflightRunRequirements)?.(params, {
        owner: "turn",
        id: turn.id,
      });
      // The turn stores resolved immutable resources; enqueue carries no duplicate refs.
      const { attachments: _att, ...enqueueParams } = params;
      // ENQUEUE phase: a typed refusal recorded no job (retryable:false); a lost
      // answer (retryable 503) may hide an accepted job, so /retry reads the journal.
      let job: { id: string };
      try {
        job = await ctx.daemon.enqueue(
          { ...enqueueParams, turnId: turn.id },
          {
            idempotencyKey,
            clientId: "control-api",
            operation: "thread.turn.create",
            idempotencyRequest: { threadId, body },
          },
        );
      } catch (err) {
        const problem = problemFromError(err, Object(err).retryable === true);
        try {
          ctx.setTurnEnqueueError?.(turn.id, problem);
        } catch {
          /* recording the refusal must not mask the original error */
        }
        // Untyped enqueue throws are INFRA failures (daemon socket down) —
        // 500, matching POST /runs; typed statuses pass through.
        return ctx.json(
          res,
          errStatus(err, 500),
          turnEnqueueProblemResponse(problem, { threadId, turnId: turn.id }),
        );
      }
      return respondToTurnJob(ctx, res, job.id, threadId, turn.id);
    } catch (err) {
      // PRE-ENQUEUE failures only reach here (plan read, param validation,
      // turn creation) — the enqueue and status-wait phases return from
      // their own catches above. When the turn was already recorded, persist
      // the refusal so a thread reload still shows it (no silent orphan);
      // no job exists -> retryable:false.
      const problem = problemFromError(err, false);
      if (createdTurnId) {
        try {
          ctx.setTurnEnqueueError?.(createdTurnId, problem);
        } catch {
          /* recording the refusal must not mask the original error */
        }
      }
      // Pre-enqueue failures are client errors (validation, preflight refusal) —
      // errStatus keeps its 400 default; the inline card keys its remedy on the
      // typed `code` when one is present.
      return ctx.json(
        res,
        errStatus(err),
        turnEnqueueProblemResponse(problem, {
          threadId,
          ...(createdTurnId ? { turnId: createdTurnId } : {}),
        }),
      );
    }
  });
}

/**
 * POST /threads/:id/turns/:turnId/retry — re-enqueue a REFUSED turn (same
 * prompt/options/attachment refs: the command journal is the SSOT of enqueue
 * params, replayed verbatim). No duplicate bubble: the run binds to the SAME
 * turn, which also clears enqueue_error.
 */
export function handleThreadTurnRetry(
  ctx: ThreadTurnRouteCtx,
  res: ServerResponse,
  threadId: string,
  turnId: string,
  idempotencyKey: string,
): Promise<void> {
  // Same per-thread serialization as turn creation: a retry racing a new
  // turn would otherwise interleave lineage bookkeeping.
  return chainThreadMutation(ctx.threadTurnChains, threadId, async () => {
    try {
      const detail = await ctx.threadDetail(threadId);
      const turns = detail.turns as Array<Record<string, unknown>>;
      const turn = turns.find((t) => t["id"] === turnId);
      if (!turn)
        throw Object.assign(new Error(`no such turn on this thread: ${turnId}`), { status: 404 });
      const recorded = turn["enqueue_error"] as { retryable?: unknown } | null | undefined;
      if (!turn["run_id"] && recorded?.retryable === false) {
        // No job exists to replay, and a purged thread takes no new message either.
        assertThreadAdmitsWork(threadId, detail.thread);
        throw Object.assign(
          new Error(
            `turn ${turnId} has no recorded enqueue attempt to replay; send a new message instead`,
          ),
          { status: 409 },
        );
      }
      const jobs = (await ctx.daemon.list({ turnId }))
        .filter((record) => {
          const params = record.params as { turnId?: unknown } | null | undefined;
          return Boolean(params && typeof params === "object" && params.turnId === turnId);
        })
        .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
      const last = jobs[jobs.length - 1];
      if (last && ctx.daemon.findAccepted) {
        const prior = await ctx.daemon.findAccepted(last.params, {
          idempotencyKey,
          clientId: "control-api",
          operation: "thread.turn.retry",
        });
        if (prior) return respondToTurnJob(ctx, res, prior.id, threadId, turnId);
      }
      assertThreadAdmitsWork(threadId, detail.thread);
      if (turn["run_id"]) {
        throw Object.assign(
          new Error(`turn ${turnId} already has a run; retry only repairs refused turns`),
          { status: 409 },
        );
      }
      if (!recorded) {
        throw Object.assign(
          new Error(
            `turn ${turnId} has no recorded refusal; its job may still be queued or starting`,
          ),
          { status: 409 },
        );
      }
      // Retry repairs the TAIL of the conversation only. Re-running an OLDER
      // refused turn would bind its run as the thread's new head (bindTurnRun
      // advances head_run_id unconditionally) and silently reorder lineage
      // that later turns already advanced — refuse loudly instead.
      assertLatestThreadTurn(turns, turnId);
      if (!last) {
        // The refusal happened before any job existed (enqueue itself threw):
        // there are no recorded params to replay faithfully — honest refusal.
        throw Object.assign(
          new Error(
            `turn ${turnId} has no recorded enqueue attempt to replay; send a new message instead`,
          ),
          { status: 409 },
        );
      }
      if (last.state === "queued" || last.state === "running") {
        throw Object.assign(new Error(`turn ${turnId} already has an active job (${last.state})`), {
          status: 409,
        });
      }
      // REPLAY-ENQUEUE phase. Deliberately NO eager clear of the old refusal:
      // the daemon hook (a fast-failing replay) can write a FRESH refusal at
      // ANY point after enqueue, and no timestamp compare can fully close
      // that race (same-millisecond writes). The stale refusal stays visible
      // for the queued window; truth converges on the next transition —
      // bindTurnRun clears it when the run starts, the hook replaces it when
      // the replay fails. Honest, ordering-independent, no lost refusals.
      let job: { id: string };
      try {
        job = await ctx.daemon.enqueue(last.params, {
          idempotencyKey,
          clientId: "control-api",
          operation: "thread.turn.retry",
          idempotencyRequest: last.params,
        });
      } catch (err) {
        // A failed replay ENQUEUE is a fresh refusal — but the ORIGINAL job
        // params remain in the registry, so the turn STAYS replayable.
        // Untyped throws are infra failures — 500 (matching POST /runs).
        const problem = problemFromError(err, true);
        try {
          ctx.setTurnEnqueueError?.(turnId, problem);
        } catch {
          /* recording the refusal must not mask the original error */
        }
        return ctx.json(
          res,
          errStatus(err, 500),
          turnEnqueueProblemResponse(problem, { threadId, turnId }),
        );
      }
      return respondToTurnJob(ctx, res, job.id, threadId, turnId);
    } catch (err) {
      // Guard refusals only (404/409): never overwrite the original recorded
      // refusal with bookkeeping noise. The same typed problem as turn creation.
      return ctx.json(
        res,
        errStatus(err),
        turnEnqueueProblemResponse(problemFromError(err, Object(err).retryable === true), {
          threadId,
          turnId,
        }),
      );
    }
  });
}
