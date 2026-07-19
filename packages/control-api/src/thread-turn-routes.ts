/**
 * Thread-turn write routes: POST /threads/:id/turns (create + enqueue) and
 * POST /threads/:id/turns/:turnId/retry (re-enqueue a REFUSED turn).
 *
 * Extracted from daemon-server.ts (INV-124 ratchet). The server passes a thin
 * ctx of bound helpers; these functions own the per-thread serialization and
 * the refused-turn honesty rules (persist the refusal ON the turn, INV-093).
 */
import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import {
  PlanQuestionsArtifact,
  derivePlanReadiness,
  ControlRunStartInfo,
  ControlRunStartRequest,
  ControlThreadTurnResponse,
  TRUST_FULL_ACCESS_CODE,
} from "@claudexor/schema";
import type { ResourceAttachmentRef } from "@claudexor/schema";
import type { DaemonFacadeClient, DaemonRunRecord } from "./daemon-server.js";

export interface ThreadTurnRouteCtx {
  json(res: ServerResponse, status: number, body: unknown): void;
  waitForRunStart(jobId: string): Promise<DaemonRunRecord>;
  readRunArtifactText(runId: string, relPath: string): Promise<string | null>;
  resolveRunArtifactPath(runId: string, relPath: string): Promise<string | null>;
  /** The server's single run-start normalizer (scope/prompt/policy validation). */
  normalizeStart(parsed: ControlRunStartRequest): ControlRunStartRequest;
  preflightRunRequirements?: (request: ControlRunStartRequest) => Promise<void>;
  /** True for terminal job states (the server's TERMINAL_STATES set). */
  isTerminalState(state: string): boolean;
  daemon: DaemonFacadeClient;
  threadDetail(id: string): Promise<{ thread: unknown; sessions: unknown[]; turns: unknown[] }>;
  createThreadTurn(
    id: string,
    prompt: string,
    opts: {
      parentRunId?: string | null;
      planRunId?: string | null;
      planHash?: string | null;
      planOverridden?: boolean;
      attachments?: ResourceAttachmentRef[];
      idempotency?: { key: string; client: string; request: unknown };
    },
  ): Promise<unknown>;
  setTurnEnqueueError?: (
    turnId: string,
    message: string,
    code: string | null,
    retryable?: boolean,
  ) => void;
  /** Per-thread promise chain (owned by the server; shared with turn creation). */
  threadTurnChains: Map<string, Promise<void>>;
}

/**
 * Chain `work` onto the thread's serialization chain and drop the entry once
 * settled so the Map cannot grow unbounded across a thread's lifetime.
 */
export function chainThreadMutation<T>(
  ctx: Pick<ThreadTurnRouteCtx, "threadTurnChains">,
  threadId: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = ctx.threadTurnChains.get(threadId) ?? Promise.resolve();
  const chained = previous.catch(() => undefined).then(work);
  const entry: Promise<void> = chained
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      if (ctx.threadTurnChains.get(threadId) === entry) ctx.threadTurnChains.delete(threadId);
    });
  ctx.threadTurnChains.set(threadId, entry);
  return chained;
}

function errStatus(err: unknown, fallback = 400): number {
  return err && typeof err === "object" && "status" in err
    ? Number((err as { status: number }).status)
    : fallback;
}

/**
 * HTTP status for a pre-start terminal turn (W24). Refusal semantics are born
 * AT THE THROW: a typed refusal carries its status (trust=403,
 * requirements=400, journal recovery=503) and the daemon persists it onto the
 * job record — that persisted status wins. Without one, only the known trust
 * code keeps its legacy 403; any OTHER bare `code` (an errno like ENOENT, an
 * ABORT_ERR) is an infra failure and stays 500 so genuine transient failures
 * are still retried — a string code alone never proves a client-actionable
 * refusal.
 */
function preStartRefusalStatus(errorCode: string | undefined, errorStatus?: number): number {
  if (typeof errorStatus === "number" && errorStatus >= 400 && errorStatus <= 599) {
    return errorStatus;
  }
  if (errorCode === TRUST_FULL_ACCESS_CODE) return 403;
  return 500;
}

/** A typed throw's machine code (e.g. the trust gate's), null when absent or
 * non-string (a numeric errno-style `code` must not leak into the typed
 * refusal contract). ONE owner — daemon-server's refusal recorder reuses it. */
export function errCode(err: unknown): string | null {
  const code =
    err && typeof err === "object" && "code" in err ? (err as { code: unknown }).code : null;
  return typeof code === "string" && code ? code : null;
}

/**
 * Persist an enqueue failure on a pre-created turn (refused-turn honesty,
 * INV-093). Shared by every pre-create-then-enqueue path OUTSIDE these
 * routes (direct POST /runs with threadId, rerun_with_feedback). Marked
 * retryable=false: these are enqueue-throw paths — no job was recorded, so
 * the retry endpoint has nothing to replay. Best-effort by
 * contract: recording must never mask the original error (callers always
 * return it), and errCode yields null for absent/non-string codes.
 */
export function recordTurnEnqueueFailure(
  setTurnEnqueueError:
    | ((turnId: string, message: string, code: string | null, retryable?: boolean) => void)
    | undefined,
  turnId: string | undefined,
  err: unknown,
): void {
  if (!turnId || !setTurnEnqueueError) return;
  try {
    setTurnEnqueueError(
      turnId,
      err instanceof Error ? err.message : String(err),
      errCode(err),
      false,
    );
  } catch {
    /* recording the refusal must not mask the original error */
  }
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
  if (rec.runId && rec.runDir) {
    return ctx.json(
      res,
      200,
      ControlThreadTurnResponse.parse({
        ...ControlRunStartInfo.parse({
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
    return ctx.json(res, preStartRefusalStatus(rec.errorCode, rec.errorStatus), {
      jobId: rec.id,
      turnId,
      threadId,
      state: rec.state,
      error: rec.error ?? `run ended pre-start: ${rec.state}`,
      ...(rec.errorCode ? { code: rec.errorCode } : {}),
    });
  }
  return ctx.json(
    res,
    202,
    ControlThreadTurnResponse.parse({ jobId: rec.id, turnId, threadId, state: rec.state }),
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
  return chainThreadMutation(ctx, threadId, async () => {
    // Once the turn record exists, any later failure in this handler must
    // land ON the turn (honest inline refusal) — not only in one HTTP
    // response that a reloading client never sees.
    let createdTurnId: string | null = null;
    try {
      const detail = await ctx.threadDetail(threadId);
      const thread = detail.thread as {
        repo: { root: string } | null;
        mode: string;
        auth_preference: string;
        access?: string | null;
        head_run_id: string | null;
        primary_harness: string | null;
        eligible_harnesses?: string[];
        run_ids?: string[];
        workspace?: { mode?: string };
      };
      let prompt = String(body["prompt"] ?? "");
      let mode = typeof body["mode"] === "string" ? (body["mode"] as string) : thread.mode;
      const planRunId =
        typeof body["planRunId"] === "string" ? (body["planRunId"] as string) : null;
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
        // Readiness gate (D17): open questions refuse implement with a typed
        // 409 unless the user explicitly overrides; the override is recorded
        // on the turn for provenance.
        const questions = await ctx.readRunArtifactText(planRunId, "final/questions.json");
        const readiness = planReadinessFromArtifactText(questions);
        planOverridden = body["overridePlanReadiness"] === true;
        if (readiness.state === "needs_answers" && !planOverridden) {
          throw Object.assign(
            new Error(
              `plan ${planRunId} is not ready: ${readiness.questionCount} open question(s) — answer them in a follow-up plan turn, or pass overridePlanReadiness:true`,
            ),
            { status: 409, code: "plan_not_ready" },
          );
        }
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
      const isolation = mode === "agent" ? "live" : "envelope";
      // Sticky routing inheritance (thin gateway — pure DTO passthrough, the
      // engine's orderPool/resolveCandidateAdapters owns all ordering): pool/
      // primary precedence is per-turn body > thread sticky > omit (engine then
      // auto-pools doctor-ok / falls back to config primary).
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
      const params = ctx.normalizeStart(
        ControlRunStartRequest.parse({
          ...body,
          prompt,
          scope: thread.repo ? { kind: "project", root: thread.repo.root } : { kind: "none" },
          mode,
          execution: { isolation },
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
      );
      // Single-writer: create the turn (run_id=null) BEFORE enqueue and pass
      // its id in the params; the daemon runner binds the started run to it.
      // This means a queued-but-not-yet-started turn is still recorded, so we
      // NEVER cancel the job on a wait timeout (the old #18 race).
      const turn = (await ctx.createThreadTurn(threadId, prompt, {
        // No explicit kind: the store auto-detects initial vs followup so the
        // FIRST turn of a thread is "initial", not "followup" (review #4).
        parentRunId: thread.head_run_id ?? null,
        planHash,
        planOverridden,
        planRunId,
        attachments: params.attachments,
        idempotency: {
          key: idempotencyKey,
          client: "control-api",
          request: { threadId, body },
        },
      })) as { id: string };
      createdTurnId = turn.id;
      // Preflight AFTER the turn exists (W19/INV-093): a browser/requirements
      // refusal now has a turnId to land on, so the outer catch persists it via
      // setTurnEnqueueError and the app renders an inline refusal card instead
      // of raw JSON with no turn to attach to.
      await ctx.preflightRunRequirements?.(params);
      // The turn stores resolved immutable resources; enqueue carries no duplicate refs.
      const { attachments: _att, ...enqueueParams } = params;
      // ENQUEUE phase: a throw here means NO job was recorded — persist the
      // refusal as retryable:false (nothing to replay).
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
        const message = err instanceof Error ? err.message : "enqueue failed";
        try {
          ctx.setTurnEnqueueError?.(turn.id, message, errCode(err), false);
        } catch {
          /* recording the refusal must not mask the original error */
        }
        // Untyped enqueue throws are INFRA failures (daemon socket down) —
        // 500, matching POST /runs; typed statuses pass through.
        return ctx.json(res, errStatus(err, 500), {
          error: message,
          turnId: turn.id,
          retryable: false,
        });
      }
      return respondToTurnJob(ctx, res, job.id, threadId, turn.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : "bad request";
      // PRE-ENQUEUE failures only reach here (plan read, param validation,
      // turn creation) — the enqueue and status-wait phases return from
      // their own catches above. When the turn was already recorded, persist
      // the refusal so a thread reload still shows it (no silent orphan);
      // no job exists -> retryable:false.
      const code = errCode(err);
      if (createdTurnId) {
        try {
          ctx.setTurnEnqueueError?.(createdTurnId, message, code, false);
        } catch {
          /* recording the refusal must not mask the original error */
        }
      }
      // Pre-enqueue failures are client errors (validation, preflight refusal) —
      // errStatus keeps its 400 default; the inline card keys its remedy on the
      // typed `code` when one is present.
      return ctx.json(res, errStatus(err), {
        error: message,
        ...(createdTurnId ? { turnId: createdTurnId, retryable: false } : {}),
        ...(code ? { code } : {}),
      });
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
  return chainThreadMutation(ctx, threadId, async () => {
    try {
      const detail = await ctx.threadDetail(threadId);
      const turns = detail.turns as Array<Record<string, unknown>>;
      const turn = turns.find((t) => t["id"] === turnId);
      if (!turn)
        throw Object.assign(new Error(`no such turn on this thread: ${turnId}`), { status: 404 });
      const recorded = turn["enqueue_error"] as { retryable?: unknown } | null | undefined;
      if (!turn["run_id"] && recorded?.retryable === false) {
        throw Object.assign(
          new Error(
            `turn ${turnId} has no recorded enqueue attempt to replay; send a new message instead`,
          ),
          { status: 409 },
        );
      }
      const jobs = (await ctx.daemon.list())
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
      const lastTurn = turns[turns.length - 1];
      if (lastTurn && lastTurn["id"] !== turnId) {
        throw Object.assign(
          new Error(
            `turn ${turnId} is not the latest turn of this thread; the conversation moved on — send a new message instead`,
          ),
          { status: 409 },
        );
      }
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
        const message = err instanceof Error ? err.message : "enqueue failed";
        try {
          ctx.setTurnEnqueueError?.(turnId, message, errCode(err), true);
        } catch {
          /* recording the refusal must not mask the original error */
        }
        return ctx.json(res, errStatus(err, 500), { error: message, turnId, threadId });
      }
      return respondToTurnJob(ctx, res, job.id, threadId, turnId);
    } catch (err) {
      // Guard refusals only (404/409): never overwrite the original recorded
      // refusal with bookkeeping noise.
      return ctx.json(res, errStatus(err), {
        error: err instanceof Error ? err.message : "bad request",
      });
    }
  });
}

/** Derive readiness from a raw final/questions.json body. Missing/corrupt
 * artifact (pre-v3 plan runs mid-branch) counts as unverified: implement is
 * allowed but never silently "ready". */
function planReadinessFromArtifactText(text: string | null): {
  state: "ready" | "needs_answers" | "unverified";
  questionCount: number;
} {
  if (!text) return { state: "unverified", questionCount: 0 };
  try {
    return derivePlanReadiness(PlanQuestionsArtifact.parse(JSON.parse(text)));
  } catch {
    return { state: "unverified", questionCount: 0 };
  }
}
