/**
 * Thread-turn write routes: POST /threads/:id/turns (create + enqueue) and
 * POST /threads/:id/turns/:turnId/retry (re-enqueue a REFUSED turn).
 *
 * Extracted from daemon-server.ts (INV-124 ratchet). The server passes a thin
 * ctx of bound helpers; these functions own the per-thread serialization and
 * the refused-turn honesty rules (persist the refusal ON the turn, INV-093).
 */
import type { ServerResponse } from "node:http";
import { ControlRunStartInfo, ControlRunStartRequest } from "@claudexor/schema";
import type { AttachmentInput } from "@claudexor/schema";
import type { DaemonFacadeClient, DaemonRunRecord } from "./daemon-server.js";

export interface ThreadTurnRouteCtx {
  json(res: ServerResponse, status: number, body: unknown): void;
  waitForRunStart(jobId: string): Promise<DaemonRunRecord>;
  readRunArtifactText(runId: string, relPath: string): Promise<string | null>;
  /** The server's single run-start normalizer (scope/prompt/policy validation). */
  normalizeStart(parsed: ControlRunStartRequest): ControlRunStartRequest;
  /** True for terminal job states (the server's TERMINAL_STATES set). */
  isTerminalState(state: string): boolean;
  daemon: DaemonFacadeClient;
  threadDetail(id: string): Promise<{ thread: unknown; sessions: unknown[]; turns: unknown[] }>;
  createThreadTurn(
    id: string,
    prompt: string,
    opts: { parentRunId?: string | null; planRunId?: string | null; attachments?: AttachmentInput[] },
  ): Promise<unknown>;
  setTurnEnqueueError?: (turnId: string, message: string, code: string | null, retryable?: boolean) => void;
  /** Per-thread promise chain (owned by the server; shared with turn creation). */
  threadTurnChains: Map<string, Promise<void>>;
}

/**
 * Chain `work` onto the thread's serialization chain and drop the entry once
 * settled so the Map cannot grow unbounded across a thread's lifetime.
 */
function chainOnThread(ctx: ThreadTurnRouteCtx, threadId: string, work: () => Promise<void>): Promise<void> {
  const previous = ctx.threadTurnChains.get(threadId) ?? Promise.resolve();
  const chained = previous.catch(() => undefined).then(work);
  const entry: Promise<void> = chained.then(() => undefined, () => undefined).finally(() => {
    if (ctx.threadTurnChains.get(threadId) === entry) ctx.threadTurnChains.delete(threadId);
  });
  ctx.threadTurnChains.set(threadId, entry);
  return chained;
}

function errStatus(err: unknown, fallback = 400): number {
  return err && typeof err === "object" && "status" in err ? Number((err as { status: number }).status) : fallback;
}

/** A typed throw's machine code (e.g. the trust gate's), null when absent or
 * non-string (a numeric errno-style `code` must not leak into the typed
 * refusal contract). ONE owner — daemon-server's refusal recorder reuses it. */
export function errCode(err: unknown): string | null {
  const code = err && typeof err === "object" && "code" in err ? (err as { code: unknown }).code : null;
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
  setTurnEnqueueError: ((turnId: string, message: string, code: string | null, retryable?: boolean) => void) | undefined,
  turnId: string | undefined,
  err: unknown,
): void {
  if (!turnId || !setTurnEnqueueError) return;
  try {
    setTurnEnqueueError(turnId, err instanceof Error ? err.message : String(err), errCode(err), false);
  } catch {
    /* recording the refusal must not mask the original error */
  }
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
  body: Record<string, unknown>,
): Promise<void> {
  return chainOnThread(ctx, threadId, async () => {
    // Once the turn record exists, any later failure in this handler must
    // land ON the turn (honest inline refusal) — not only in one HTTP
    // response that a reloading client never sees.
    let createdTurnId: string | null = null;
    try {
      const detail = await ctx.threadDetail(threadId);
      const thread = detail.thread as { repo: { root: string } | null; mode: string; auth_preference: string; head_run_id: string | null; primary_harness: string | null; eligible_harnesses?: string[]; run_ids?: string[]; workspace?: { mode?: string } };
      let prompt = String(body["prompt"] ?? "");
      let mode = typeof body["mode"] === "string" ? (body["mode"] as string) : thread.mode;
      const planRunId = typeof body["planRunId"] === "string" ? (body["planRunId"] as string) : null;
      // "Implement plan": prefix the approved plan from an earlier turn into
      // the prompt and force agent mode. The plan run must belong to THIS
      // thread (no cross-thread artifact reads).
      if (planRunId) {
        if (!(thread.run_ids ?? []).includes(planRunId)) {
          throw Object.assign(new Error(`planRunId ${planRunId} is not a turn of this thread`), { status: 400 });
        }
        const planText = await ctx.readRunArtifactText(planRunId, "final/plan.md");
        if (!planText || !planText.trim()) {
          // Fail loudly: "Implement plan" with an unreadable plan must NOT
          // silently run the bare prompt as agent (review r2 #7).
          throw Object.assign(new Error(`plan run ${planRunId} has no readable final/plan.md to implement`), { status: 400 });
        }
        prompt = `Implement the following approved plan. Deviate only where the code contradicts it, and say so.\n\n${planText}\n\n## Additional instruction\n${prompt}`.trim();
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
        : (thread.eligible_harnesses && thread.eligible_harnesses.length > 0 ? thread.eligible_harnesses : undefined);
      // Inherit the sticky primary ONLY when it stays valid in that pool. If the
      // pool (per-turn OR the inherited thread pool) does not contain the primary
      // — e.g. the user dropped the primary harness from the pool via the "⋯"
      // chips — drop the bias rather than drag it along; the engine would
      // otherwise reject the turn with "primary not in pool".
      const inheritPrimary =
        body["primaryHarness"] === undefined && thread.primary_harness
          && (!turnPool || turnPool.includes(thread.primary_harness))
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
          authPreference: typeof body["authPreference"] === "string" ? body["authPreference"] : (thread.auth_preference as "auto"),
          ...(inheritPrimary ? { primaryHarness: inheritPrimary } : {}),
          ...(body["harnesses"] === undefined && thread.eligible_harnesses && thread.eligible_harnesses.length > 0
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
        planRunId,
        attachments: params.attachments,
      })) as { id: string };
      createdTurnId = turn.id;
      // Strip base64 attachment bytes from the enqueued params: jobs.json must
      // never carry the bytes (the turn holds the resolved scoped paths, and
      // the run reads them back from the turn at start).
      const { attachments: _att, ...enqueueParams } = params;
      // ENQUEUE phase: a throw here means NO job was recorded — persist the
      // refusal as retryable:false (nothing to replay).
      let job: { id: string };
      try {
        job = await ctx.daemon.enqueue({ ...enqueueParams, turnId: turn.id });
      } catch (err) {
        const message = err instanceof Error ? err.message : "enqueue failed";
        try {
          ctx.setTurnEnqueueError?.(turn.id, message, errCode(err), false);
        } catch {
          /* recording the refusal must not mask the original error */
        }
        // Untyped enqueue throws are INFRA failures (daemon socket down) —
        // 500, matching POST /runs; typed statuses pass through.
        return ctx.json(res, errStatus(err, 500), { error: message, turnId: turn.id, retryable: false });
      }
      // POST-ENQUEUE phase: the job EXISTS now. A status-poll throw here is
      // transient observation loss, NOT a refusal — record nothing on the
      // turn (the run may be starting fine; the runner hook records real
      // pre-start deaths) and never claim retryable:false.
      let rec: DaemonRunRecord;
      try {
        rec = await ctx.waitForRunStart(job.id);
      } catch (err) {
        return ctx.json(res, 500, {
          error: `job ${job.id} was accepted but its start could not be observed: ${err instanceof Error ? err.message : String(err)}`,
          jobId: job.id,
          turnId: turn.id,
          threadId,
        });
      }
      if (rec.runId && rec.runDir) {
        return ctx.json(res, 200, {
          ...ControlRunStartInfo.parse({ jobId: rec.id, runId: rec.runId, taskId: rec.taskId, runDir: rec.runDir }),
          turnId: turn.id,
          threadId,
        });
      }
      // A job that went TERMINAL without ever binding a run is a pre-start
      // failure (trust/preflight refusal inside the runner): report it as one
      // (mirrors POST /runs' 500), never as an accepted queued turn. The
      // daemon hook has already persisted the refusal on the turn record.
      if (ctx.isTerminalState(rec.state)) {
        return ctx.json(res, 500, { jobId: rec.id, turnId: turn.id, threadId, state: rec.state, error: rec.error ?? `run ended pre-start: ${rec.state}` });
      }
      // The turn IS recorded (turnId) and the job is canonical in the daemon;
      // the runner binds the run when it starts. Return 202 without cancelling.
      return ctx.json(res, 202, { jobId: rec.id, turnId: turn.id, threadId, state: rec.state });
    } catch (err) {
      const message = err instanceof Error ? err.message : "bad request";
      // PRE-ENQUEUE failures only reach here (plan read, param validation,
      // turn creation) — the enqueue and status-wait phases return from
      // their own catches above. When the turn was already recorded, persist
      // the refusal so a thread reload still shows it (no silent orphan);
      // no job exists -> retryable:false.
      if (createdTurnId) {
        try {
          ctx.setTurnEnqueueError?.(createdTurnId, message, errCode(err), false);
        } catch {
          /* recording the refusal must not mask the original error */
        }
      }
      return ctx.json(res, errStatus(err), {
        error: message,
        ...(createdTurnId ? { turnId: createdTurnId, retryable: false } : {}),
      });
    }
  });
}

/**
 * POST /threads/:id/turns/:turnId/retry — re-enqueue a REFUSED turn (same
 * prompt/options/attachment refs: the job registry is the SSOT of enqueue
 * params, replayed verbatim). No duplicate bubble: the run binds to the SAME
 * turn, which also clears enqueue_error.
 */
export function handleThreadTurnRetry(
  ctx: ThreadTurnRouteCtx,
  res: ServerResponse,
  threadId: string,
  turnId: string,
): Promise<void> {
  // Same per-thread serialization as turn creation: a retry racing a new
  // turn would otherwise interleave lineage bookkeeping.
  return chainOnThread(ctx, threadId, async () => {
    try {
      const detail = await ctx.threadDetail(threadId);
      const turns = detail.turns as Array<Record<string, unknown>>;
      const turn = turns.find((t) => t["id"] === turnId);
      if (!turn) throw Object.assign(new Error(`no such turn on this thread: ${turnId}`), { status: 404 });
      if (turn["run_id"]) {
        throw Object.assign(new Error(`turn ${turnId} already has a run; retry only repairs refused turns`), { status: 409 });
      }
      const recorded = turn["enqueue_error"] as { retryable?: unknown } | null | undefined;
      if (!recorded) {
        throw Object.assign(new Error(`turn ${turnId} has no recorded refusal; its job may still be queued or starting`), { status: 409 });
      }
      // Recorded as NOT replayable (the original enqueue threw before any
      // job existed): refuse immediately — no registry lookup can find
      // params that were never recorded.
      if (recorded.retryable === false) {
        throw Object.assign(new Error(`turn ${turnId} has no recorded enqueue attempt to replay; send a new message instead`), { status: 409 });
      }
      // Retry repairs the TAIL of the conversation only. Re-running an OLDER
      // refused turn would bind its run as the thread's new head (bindTurnRun
      // advances head_run_id unconditionally) and silently reorder lineage
      // that later turns already advanced — refuse loudly instead.
      const lastTurn = turns[turns.length - 1];
      if (lastTurn && lastTurn["id"] !== turnId) {
        throw Object.assign(
          new Error(`turn ${turnId} is not the latest turn of this thread; the conversation moved on — send a new message instead`),
          { status: 409 },
        );
      }
      const jobs = (await ctx.daemon.list())
        .filter((r) => {
          const p = r.params as { turnId?: unknown } | null | undefined;
          return Boolean(p && typeof p === "object" && p.turnId === turnId);
        })
        .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
      const last = jobs[jobs.length - 1];
      if (!last) {
        // The refusal happened before any job existed (enqueue itself threw):
        // there are no recorded params to replay faithfully — honest refusal.
        throw Object.assign(new Error(`turn ${turnId} has no recorded enqueue attempt to replay; send a new message instead`), { status: 409 });
      }
      if (last.state === "queued" || last.state === "running") {
        throw Object.assign(new Error(`turn ${turnId} already has an active job (${last.state})`), { status: 409 });
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
        job = await ctx.daemon.enqueue(last.params);
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
      // POST-ENQUEUE: the replay job exists; a status-poll throw is
      // observation loss, NOT a refusal — record nothing on the turn.
      let rec: DaemonRunRecord;
      try {
        rec = await ctx.waitForRunStart(job.id);
      } catch (err) {
        return ctx.json(res, 500, {
          error: `replay job ${job.id} was accepted but its start could not be observed: ${err instanceof Error ? err.message : String(err)}`,
          jobId: job.id,
          turnId,
          threadId,
        });
      }
      if (rec.runId && rec.runDir) {
        return ctx.json(res, 200, {
          ...ControlRunStartInfo.parse({ jobId: rec.id, runId: rec.runId, taskId: rec.taskId, runDir: rec.runDir }),
          turnId,
          threadId,
        });
      }
      // A job that went TERMINAL without ever binding a run is a pre-start
      // failure (trust/preflight refusal inside the runner) — report it as
      // one (mirrors POST /runs), never as an accepted queued turn. The
      // runner hook has already persisted the refusal on the turn.
      if (ctx.isTerminalState(rec.state)) {
        return ctx.json(res, 500, { jobId: rec.id, turnId, threadId, state: rec.state, error: rec.error ?? `run ended pre-start: ${rec.state}` });
      }
      return ctx.json(res, 202, { jobId: rec.id, turnId, threadId, state: rec.state });
    } catch (err) {
      // Guard refusals only (404/409): never overwrite the original recorded
      // refusal with bookkeeping noise.
      return ctx.json(res, errStatus(err), { error: err instanceof Error ? err.message : "bad request" });
    }
  });
}
