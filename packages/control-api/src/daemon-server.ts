import { timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { basename, extname, join, relative, sep } from "node:path";
import { checkPatch, deliver, revertInPlace, validateApplyGate } from "@claudexor/delivery";
import { appendRunEvent, lastSeqInFile } from "@claudexor/event-log";
import { safeArtifactPath, safeArtifactRoot } from "./artifact-paths.js";
import { eventPayload, latestPlanProgress, readRunEvents, timelineEvents } from "./run-timeline.js";
import { projectSession, projectThread, projectTurn, turnRunCard } from "./thread-projection.js";
import { handleThreadTurnCreate, handleThreadTurnRetry, recordTurnEnqueueFailure, type ThreadTurnRouteCtx } from "./thread-turn-routes.js";
import { normalizeRunStart, validateAbsoluteRepoRoot, validateDirectRunAttachments } from "./run-start.js";
export { normalizeRunStartRequest } from "./run-start.js";
import { candidatesFor } from "./candidates.js";
import {
  AccessProfile,
  AttachmentInput,
  ControlWebEvidence,
  ControlApplyCheckRequest,
  ControlApplyRequest,
  ControlHarnessListResponse,
  ControlHarnessModelsResponse,
  ControlSetupJob,
  ControlSetupJobConfirmRequest,
  ControlSetupJobCreateRequest,
  ControlSetupJobEvent,
  ControlSetupJobListResponse,
  ControlSpecFreezeRequest,
  ControlSpecQuestionsRequest,
  ControlSecretListResponse,
  ControlRunStartRequest,
  ControlRunStartInfo,
  ControlQueuedRunInfo,
  ControlRunControlRequest,
  ControlRunControlResponse,
  ControlReviewerPanelEntry,
  type ControlArtifactInfo,
  ControlRunDetail,
  ControlRunSummary,
  ControlRunResult,
  ControlPrimaryOutput,
  ControlBudgetSnapshot,
  ControlSettingsSnapshot,
  ControlSettingsUpdateRequest,
  ControlTrustListResponse,
  ControlTrustState,
  ControlTrustUpdateRequest,
  ControlInteractionAnswerRequest,
  ControlInteractionAnswerResponse,
  type ControlPendingInteraction,
  type ControlRouteInfo,
  ControlRunDecisionRequest,
  ControlRunDecisionResponse,
  ControlThreadCreateRequest,
  ControlThreadUpdateRequest,
  ControlThreadApplyRequest,
  ControlThreadApplyResponse,
  ControlThreadDetail,
  ControlThreadListResponse,
  ControlTurnRunCard,
  DecisionRecord,
  ModeKind,
  OrchestratePlanProgress,
  Portfolio,
  ReviewFinding,
  RunEventType,
  RunFailure,
  RunTelemetry,
  TaskContract,
  ProtectedPathApproval,
  WorkProduct,
} from "@claudexor/schema";
import { assertNoInlineSecretValues, containsSecretLikeToken, noProjectRepoRoot, nowIso, redactSecrets, sha256 } from "@claudexor/util";
import { MANAGED_SECRET_NAMES, isManagedSecretName } from "@claudexor/secrets";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface DaemonRunRecord {
  id: string;
  state: string;
  runId?: string;
  taskId?: string;
  runDir?: string;
  error?: string;
  params?: unknown;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface DaemonFacadeClient {
  enqueue(params: unknown): Promise<{ id: string; state: string }>;
  status(id: string): Promise<DaemonRunRecord>;
  list(): Promise<DaemonRunRecord[]>;
  cancel(id: string): Promise<unknown>;
}

export interface DaemonControlApiOptions {
  token: string;
  daemon: DaemonFacadeClient;
  host?: string;
  port?: number;
  pollMs?: number;
  /** SSE comment-ping cadence so quiet phases are distinguishable from dead connections. */
  heartbeatMs?: number;
  runStartTimeoutMs?: number;
  /**
   * In-process run-event push source (the daemon's RunEventBus). The events
   * FILE stays the canonical ordered log: a push only pokes the tailer so SSE
   * latency drops from poll cadence to immediate, with the poll as fallback.
   */
  bus?: { subscribe(listener: (event: { run_id: string }) => void): () => void };
  services?: {
    harnesses?: () => Promise<unknown>;
    /** Enumerable models for one harness (ADP4); thin projection over the adapter's optional models(). */
    harnessModels?: (input: { harnessId: string }) => Promise<unknown>;
    createSetupJob?: (input: unknown) => Promise<unknown>;
    listSetupJobs?: () => Promise<unknown>;
    setupJobStatus?: (input: unknown) => Promise<unknown>;
    cancelSetupJob?: (input: unknown) => Promise<unknown>;
    confirmSetupJob?: (input: unknown) => Promise<unknown>;
    settings?: () => Promise<unknown>;
    updateSettings?: (patch: unknown) => Promise<unknown>;
    listSecrets?: () => Promise<unknown>;
    setSecret?: (input: unknown) => Promise<unknown>;
    deleteSecret?: (name: string) => Promise<unknown>;
    specQuestions?: (input: unknown) => Promise<unknown>;
    specFreeze?: (input: unknown) => Promise<unknown>;
    /** Live waiting_on_user state (daemon InteractionRegistry projections). */
    pendingInteractions?: (runId: string) => ControlPendingInteraction[];
    answerInteraction?: (runId: string, interactionId: string, answers: unknown) => { status: string; message?: string };
    /** Thread/session SSOT (chat/session-first). */
    createThread?: (input: unknown) => Promise<unknown>;
    listThreads?: () => Promise<{ threads: unknown[] }>;
    threadDetail?: (id: string) => Promise<{ thread: unknown; sessions: unknown[]; turns: unknown[] }>;
    /** Single-writer turn creation (run_id bound later by the daemon runner). */
    createThreadTurn?: (id: string, prompt: string, opts: { kind?: unknown; parentRunId?: string | null; planRunId?: string | null; attachments?: AttachmentInput[] }) => Promise<unknown>;
    /** Rename / archive a thread or switch its sticky primary/pool. */
    updateThread?: (id: string, patch: { title?: string; state?: string; primaryHarness?: string | null; eligibleHarnesses?: string[] }) => Promise<unknown>;
    /** Deliver an isolated thread's accumulated worktree diff to the project. */
    applyThread?: (id: string, opts: { mode: string; branch?: string; message?: string }) => Promise<unknown>;
    /** Persist why a turn's run could not be enqueued (runless-turn honesty).
     * `code` is the typed throw's machine code (null if none); `retryable`
     * false marks refusals with no recorded job to replay. */
    setTurnEnqueueError?: (turnId: string, message: string, code: string | null, retryable?: boolean) => void;
    /** User-level trust: enumerate per-repo trust files (Settings projection). */
    listTrust?: () => Promise<unknown>;
    /** NARROW trust write: grant/revoke full access for ONE repo — the same
     * user-level file `claudexor trust` owns; every other trust field stays
     * CLI-only. */
    updateTrust?: (input: { repoRoot: string; allowFullAccess: boolean }) => Promise<unknown>;
  };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const TERMINAL_STATES = new Set(["succeeded", "no_op", "ungated", "review_not_run", "blocked", "failed", "cancelled", "interrupted", "exhausted", "not_converged", "stuck_no_progress"]);
/** Artifact fetch cap: large logs are read from disk, not streamed through the facade. */
const MAX_ARTIFACT_FETCH_BYTES = 4 * 1024 * 1024;
/** Larger cap for binary artifacts (images, etc.): they are naturally bounded and
 * the small cap exists to protect the event loop from multi-MB text logs, not binaries. */
const MAX_ARTIFACT_BINARY_FETCH_BYTES = 32 * 1024 * 1024;
const NO_PROJECT_ROOT = noProjectRepoRoot();

function hostIsLoopback(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const h = hostHeader.trim();
  const host = h.startsWith("[") ? h.slice(1, h.indexOf("]")) : (h.split(":")[0] ?? "");
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function originIsLoopback(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
    return LOOPBACK_HOSTS.has(host);
  } catch {
    return false;
  }
}

/**
 * HTTP/SSE facade over the durable daemon. Canonical run/job state comes from the
 * daemon (`jobs.json` over the unix-socket JSON-RPC API). This server is a live
 * viewport only: POST/GET/cancel delegate to daemon, and event streams replay/tail
 * the canonical `.claudexor/runs/<runId>/events.jsonl` file.
 */
export class DaemonControlApiServer {
  private server?: Server;
  private readonly sseClients = new Set<ServerResponse>();
  /** Per-thread turn submission chains (serialize head_run_id lineage updates). */
  private readonly threadTurnChains = new Map<string, Promise<void>>();

  constructor(private readonly opts: DaemonControlApiOptions) {}

  async start(): Promise<{ host: string; port: number }> {
    const host = this.opts.host ?? "127.0.0.1";
    const port = this.opts.port ?? 0;
    await new Promise<void>((resolve, reject) => {
      this.server = createServer((req, res) => this.onRequest(req, res));
      this.server.once("error", reject);
      this.server.listen(port, host, () => resolve());
    });
    const addr = this.server?.address();
    return { host, port: typeof addr === "object" && addr ? addr.port : port };
  }

  async stop(): Promise<void> {
    for (const res of this.sseClients) {
      try {
        res.end();
      } catch {
        /* closed */
      }
    }
    this.sseClients.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  private tokenMatches(provided: string | undefined): boolean {
    if (!provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(this.opts.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private authorized(req: IncomingMessage): boolean {
    if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin as string | undefined)) return false;
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
    return this.tokenMatches(m?.[1]?.trim());
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 10 * 1024 * 1024) throw Object.assign(new Error("request body too large"), { status: 413 });
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) return {};
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw Object.assign(new Error("invalid JSON body"), { status: 400 });
    }
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    void this.handle(req, res).catch((err) => {
      if (!res.headersSent) {
        const status = typeof (err as { status?: unknown }).status === "number" ? Number((err as { status: number }).status) : 500;
        const message = err instanceof Error ? err.message : String(err);
        this.json(res, status, { error: redactSecrets(message) });
      }
      else res.end();
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/healthz") {
      if (!hostIsLoopback(req.headers.host)) return this.json(res, 403, { error: "forbidden" });
      return this.json(res, 200, { ok: true });
    }
    if (!this.authorized(req)) return this.json(res, 401, { error: "unauthorized" });

    if (method === "POST" && path === "/runs") {
      let params: ControlRunStartRequest;
      try {
        const body = await this.readBody(req);
        assertNoInlineSecretValues(body);
        const parsed = ControlRunStartRequest.parse(body);
        params = normalizeRunStart(parsed);
      } catch (err) {
        const status = err && typeof err === "object" && "status" in err ? Number((err as { status: number }).status) : 400;
        return this.json(res, status, { error: err instanceof Error ? err.message : "bad request" });
      }
      // 202-queued lineage race: a thread-anchored direct enqueue is a TURN
      // of that conversation. The daemon runner binds the turn only at onRunStart,
      // so a run that sits QUEUED (another turn on the thread is active) would be
      // observable headless (GET /runs, GET /threads) with NO turn record and a
      // stale head_run_id until it starts. Mirror the rerun_with_feedback / turns
      // ordering: single-writer — pre-create the turn (run_id=null) BEFORE enqueue
      // and pass its id, so the queued run is recorded on its thread deterministically
      // before it can be seen. A pre-created turnId (the /threads/:id/turns path)
      // already did this, so we only fill the gap for a bare threadId.
      const directThreadId = typeof params.threadId === "string" && params.threadId ? params.threadId : null;
      // turnId is the INTERNAL single-writer handoff (control-api pre-creates
      // the turn, the daemon runner binds the run to it). A client-supplied
      // turnId could rebind any thread's turn lineage to an unrelated run
      // — reject it at the boundary; the /threads/:id/turns path is
      // the public way to create a turn.
      if (params.turnId) {
        return this.json(res, 400, {
          error: "turnId is not accepted on POST /runs; create the turn via POST /threads/:id/turns",
        });
      }
      // planRunId only has an owner on thread turns: POST /threads/:id/turns
      // reads final/plan.md, prefixes it into the prompt, and forces agent
      // mode. A direct POST /runs — WITH OR WITHOUT a threadId — skips that
      // pipeline, so the turn would record a plan contract the run never
      // consumed. Reject unconditionally.
      if (params.planRunId) {
        return this.json(res, 400, {
          error: "planRunId is not accepted on POST /runs; use POST /threads/:id/turns (the turn pipeline implements the plan)",
        });
      }
      let enqueueParams: ControlRunStartRequest & { turnId?: string } = params;
      if (directThreadId && !params.turnId) {
        const createTurnSvc = this.opts.services?.createThreadTurn;
        if (createTurnSvc) {
          const detailSvc = this.opts.services?.threadDetail;
          // Validate the thread exists (404) BEFORE enqueue: the daemon runner
          // swallows a failed createTurn, so an enqueue against a missing thread
          // would otherwise orphan the run. Fail loudly here instead.
          if (detailSvc) {
            try {
              await detailSvc(directThreadId);
            } catch (err) {
              const status = err && typeof err === "object" && "status" in err ? Number((err as { status: number }).status) : 404;
              return this.json(res, status, { error: err instanceof Error ? err.message : `no such thread: ${directThreadId}` });
            }
          }
          const turn = (await createTurnSvc(directThreadId, String(params.prompt ?? ""), {
            parentRunId: params.parentRunId ?? null,
            planRunId: params.planRunId ?? null,
            // Resolve inbound attachment bytes onto the turn (scoped 0600 paths),
            // same as the /threads/:id/turns path — so the base64 `data` below is
            // stripped from the enqueued params and never persists in jobs.json.
            attachments: params.attachments,
          })) as { id: string };
          const { attachments: _att, ...rest } = params;
          enqueueParams = { ...rest, turnId: turn.id };
        }
      }
      // Every failure UP TO a successful enqueue must land ON the pre-created
      // turn (if any): a validation/enqueue throw would otherwise orphan it as
      // the exact silent empty bubble the refusal record exists to eliminate.
      // retryable=false — no job exists to replay, so clients keep drafts.
      const preCreatedTurnId = (enqueueParams as { turnId?: string }).turnId;
      let job: { id: string };
      try {
        enqueueParams = validateDirectRunAttachments(enqueueParams);
        job = await this.opts.daemon.enqueue(enqueueParams);
      } catch (err) {
        recordTurnEnqueueFailure(this.opts.services?.setTurnEnqueueError, preCreatedTurnId, err);
        // Untyped throws here are INFRA failures (daemon socket down mid-
        // enqueue) — 500, not a client "bad request". Validation paths attach
        // their own typed 400 status.
        const status = err && typeof err === "object" && "status" in err ? Number((err as { status: number }).status) : 500;
        return this.json(res, status, {
          error: err instanceof Error ? err.message : "enqueue failed",
          ...(preCreatedTurnId ? { turnId: preCreatedTurnId, retryable: false } : {}),
        });
      }
      // POST-ENQUEUE: the job EXISTS. A status-poll throw is observation
      // loss, NOT a refusal — record nothing (the runner hook records real
      // pre-start deaths) and never claim retryable:false.
      let rec: DaemonRunRecord;
      try {
        rec = await this.waitForRunStart(job.id);
      } catch (err) {
        return this.json(res, 500, {
          error: `job ${job.id} was accepted but its start could not be observed: ${err instanceof Error ? err.message : String(err)}`,
          jobId: job.id,
          ...(preCreatedTurnId ? { turnId: preCreatedTurnId } : {}),
        });
      }
      if (rec.runId && rec.runDir) {
        return this.json(res, 200, ControlRunStartInfo.parse({ jobId: rec.id, runId: rec.runId, taskId: rec.taskId, runDir: rec.runDir }));
      }
      // Long-queued jobs remain canonical in the daemon. Don't fail the request
      // while leaving an orphaned queued job behind; return the job id for polling.
      const status = TERMINAL_STATES.has(rec.state) ? 500 : 202;
      return this.json(res, status, ControlQueuedRunInfo.parse({ jobId: rec.id, state: rec.state, error: rec.error }));
    }

    if (method === "GET" && path === "/runs") {
      const runs = await this.opts.daemon.list();
      return this.json(res, 200, {
        // One unprojectable record degrades to a diagnostic row; it must not
        // 500 the whole list (the app's main screen and the blocked inbox).
        runs: runs.map((r) => {
          try {
            return this.summarizeRunLive(r);
          } catch (err) {
            return ControlRunSummary.parse({
              jobId: r.id,
              runId: r.runId ?? r.id,
              state: "failed",
              error: `unprojectable job record: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }),
      });
    }

    const runDetailMatch = /^\/runs\/([^/]+)$/.exec(path);
    if (method === "GET" && runDetailMatch) {
      const rec = await this.findRun(decodeURIComponent(runDetailMatch[1] as string));
      if (!rec) return this.json(res, 404, { error: "no such run" });
      // Fence order: cursor FIRST, every projection (pending interactions
      // included) after it — see the detailFor doc comment.
      const lastSeq = rec.runDir ? lastSeqInFile(join(rec.runDir, "events.jsonl")) : 0;
      return this.json(res, 200, detailFor(rec, this.pendingInteractionsFor(rec), lastSeq));
    }

    const interactionAnswerMatch = /^\/runs\/([^/]+)\/interactions\/([^/]+)\/answer$/.exec(path);
    if (method === "POST" && interactionAnswerMatch) {
      const rec = await this.findRun(decodeURIComponent(interactionAnswerMatch[1] as string));
      if (!rec) return this.json(res, 404, { error: "no such run" });
      const answerService = this.opts.services?.answerInteraction;
      if (!answerService) return this.json(res, 501, { error: "interaction answers are not supported by this engine build" });
      let body: ControlInteractionAnswerRequest;
      try {
        const raw = await this.readBody(req);
        assertNoInlineSecretValues(raw);
        body = ControlInteractionAnswerRequest.parse(raw);
      } catch (err) {
        const status = err && typeof err === "object" && "status" in err ? Number((err as { status: number }).status) : 400;
        return this.json(res, status, { error: err instanceof Error ? err.message : "bad request" });
      }
      const interactionId = decodeURIComponent(interactionAnswerMatch[2] as string);
      const answerSet = {
        interaction_id: interactionId,
        answers: body.answers.map((a) => ({
          question_id: a.questionId,
          selected_labels: a.selectedLabels,
          free_text: a.freeText,
        })),
      };
      const result = answerService(rec.runId ?? rec.id, interactionId, answerSet);
      const accepted = result.status === "delivered";
      return this.json(
        res,
        accepted ? 200 : result.status === "not_found" ? 404 : 409,
        ControlInteractionAnswerResponse.parse({ accepted, status: result.status, message: result.message }),
      );
    }

    if (method === "GET" && path === "/events") {
      return this.streamGlobalEvents(req, res);
    }

    // ---- Threads (chat/session-first): the Thread is the conversation SSOT;
    // runs are turns inside it; native CLI sessions resume across turns. ----
    if (method === "POST" && path === "/threads") {
      const svc = this.opts.services?.createThread;
      if (!svc) return this.json(res, 501, { error: "threads are not supported by this engine build" });
      try {
        const body = await this.readBody(req);
        assertNoInlineSecretValues(body);
        const parsed = ControlThreadCreateRequest.parse(body);
        // Same project-root boundary validation as run start: a durable thread
        // with a relative/nonexistent root would only fail at its first turn.
        let repoRoot: string | null = null;
        if (parsed.scope.kind === "project") {
          repoRoot = parsed.scope.root.trim();
          const absoluteRepoError = validateAbsoluteRepoRoot(repoRoot);
          if (absoluteRepoError) throw Object.assign(new Error(absoluteRepoError), { status: 400 });
          if (!existsSync(repoRoot) || !lstatSync(repoRoot).isDirectory()) {
            throw Object.assign(new Error(`project root does not exist or is not a directory: ${repoRoot}`), { status: 400 });
          }
        }
        const thread = await svc({
          title: parsed.title,
          repoRoot,
          mode: parsed.mode,
          workspace: parsed.workspace,
          authPreference: parsed.authPreference,
          primaryHarness: parsed.primaryHarness ?? null,
          eligibleHarnesses: parsed.eligibleHarnesses,
        });
        return this.json(res, 200, projectThread(thread, false));
      } catch (err) {
        const status = err && typeof err === "object" && "status" in err ? Number((err as { status: number }).status) : 400;
        return this.json(res, status, { error: err instanceof Error ? err.message : "bad request" });
      }
    }

    if (method === "GET" && path === "/threads") {
      const svc = this.opts.services?.listThreads;
      if (!svc) return this.json(res, 501, { error: "threads are not supported by this engine build" });
      const { threads } = await svc();
      const runs = await this.opts.daemon.list();
      // needs-human clears once the operator has decided: a blocked run with a
      // persisted operator_decision is no longer in the "needs me" inbox.
      const blocked = new Set(
        runs.filter((r) => r.state === "blocked" && readValidOperatorDecision(r) === null).map((r) => r.runId ?? r.id),
      );
      return this.json(res, 200, ControlThreadListResponse.parse({
        threads: threads.map((t) => projectThread(t, blocked.has((t as { head_run_id?: string | null }).head_run_id ?? ""))),
      }));
    }

    const threadDetailMatch = /^\/threads\/([^/]+)$/.exec(path);
    if (method === "GET" && threadDetailMatch) {
      const svc = this.opts.services?.threadDetail;
      if (!svc) return this.json(res, 501, { error: "threads are not supported by this engine build" });
      try {
        const detail = await svc(decodeURIComponent(threadDetailMatch[1] as string));
        const runs = await this.opts.daemon.list();
        const byRun = new Map(runs.map((r) => [r.runId ?? r.id, r]));
        const thread = detail.thread as { head_run_id?: string | null };
        // Build a run card per turn so the chat renders the conversation (state +
        // honest outcome) from this one response — no N+1 run-detail fetch.
        const cards = new Map<string, ControlTurnRunCard>();
        for (const turn of detail.turns as { run_id?: string | null }[]) {
          const runId = turn.run_id ?? null;
          if (runId && !cards.has(runId)) {
            const rec = byRun.get(runId);
            if (rec) cards.set(runId, turnRunCard(this.summarizeRunLive(rec)));
          }
        }
        const headRec = byRun.get(thread.head_run_id ?? "");
        const headNeedsHuman = headRec?.state === "blocked" && readValidOperatorDecision(headRec) === null;
        return this.json(res, 200, ControlThreadDetail.parse({
          thread: projectThread(detail.thread, headNeedsHuman),
          sessions: detail.sessions.map(projectSession),
          turns: detail.turns.map((t) => projectTurn(t, cards)),
        }));
      } catch (err) {
        const status = err && typeof err === "object" && "status" in err ? Number((err as { status: number }).status) : 400;
        return this.json(res, status, { error: err instanceof Error ? err.message : "bad request" });
      }
    }

    // PATCH /threads/:id — rename / archive; ThreadState is active|closed.
    if (method === "PATCH" && threadDetailMatch) {
      const svc = this.opts.services?.updateThread;
      if (!svc) return this.json(res, 501, { error: "threads are not supported by this engine build" });
      try {
        const raw = await this.readBody(req);
        assertNoInlineSecretValues(raw);
        const patch = ControlThreadUpdateRequest.parse(raw);
        const thread = await svc(decodeURIComponent(threadDetailMatch[1] as string), {
          title: patch.title,
          state: patch.state,
          primaryHarness: patch.primaryHarness,
          eligibleHarnesses: patch.eligibleHarnesses,
        });
        return this.json(res, 200, projectThread(thread, false));
      } catch (err) {
        const status = err && typeof err === "object" && "status" in err ? Number((err as { status: number }).status) : 400;
        return this.json(res, status, { error: err instanceof Error ? err.message : "bad request" });
      }
    }

    // POST /threads/:id/apply — deliver an isolated thread's accumulated worktree
    // diff to the project (in-place threads write the live tree directly, so they
    // never need this).
    const threadApplyMatch = /^\/threads\/([^/]+)\/apply$/.exec(path);
    if (method === "POST" && threadApplyMatch) {
      const detailSvc = this.opts.services?.threadDetail;
      const applySvc = this.opts.services?.applyThread;
      if (!detailSvc || !applySvc) return this.json(res, 501, { error: "threads are not supported by this engine build" });
      try {
        const raw = await this.readBody(req);
        assertNoInlineSecretValues(raw);
        const body = ControlThreadApplyRequest.parse(raw);
        const threadId = decodeURIComponent(threadApplyMatch[1] as string);
        // Head-run state gate (INV-113): the cumulative thread
        // diff spans turns, so there is no single WorkProduct to hash-bind —
        // but a thread whose HEAD run is blocked (NEEDS_HUMAN) or failed must
        // NOT deliver with one POST unless a typed operator decision exists.
        // This closes the last undocumented bypass of the apply-gate doctrine.
        const detail = await detailSvc(threadId);
        const headRunId = (detail.thread as { head_run_id?: string | null }).head_run_id ?? null;
        if (headRunId) {
          const headRec = (await this.opts.daemon.list()).find((r) => (r.runId ?? r.id) === headRunId);
          // A recorded head run whose record was PRUNED from jobs.json
          // (maxHistory) has an unknowable state — the gate must fail closed,
          // not silently wave the apply through.
          if (!headRec) {
            return this.json(res, 409, {
              error: `thread head run ${headRunId} is no longer in the daemon history; its state cannot be verified — rerun the turn before applying the thread diff`,
            });
          }
          if (headRec.state === "blocked" || headRec.state === "failed") {
            const decision = readValidOperatorDecision(headRec);
            if (!decision) {
              appendRunAuditEvent(headRec, "control.rejected", {
                control: "thread_apply",
                thread_id: threadId,
                reason: `head run is ${headRec.state} without a typed operator decision`,
              });
              return this.json(res, 409, {
                // State-specific remediation: decisions unblock only BLOCKED
                // runs; a failed head needs a fixing rerun, not an override.
                error:
                  headRec.state === "blocked"
                    ? `thread head run ${headRunId} is blocked; apply requires a typed operator decision first (POST /runs/${headRunId}/decision)`
                    : `thread head run ${headRunId} failed; rerun the turn (rerun_with_feedback) or fix the failure before applying the thread diff`,
              });
            }
          }
        }
        const result = await applySvc(threadId, { mode: body.mode, branch: body.branch, message: body.message });
        return this.json(res, 200, ControlThreadApplyResponse.parse(result));
      } catch (err) {
        const status = err && typeof err === "object" && "status" in err ? Number((err as { status: number }).status) : 400;
        return this.json(res, status, { error: err instanceof Error ? err.message : "bad request" });
      }
    }

    const threadTurnMatch = /^\/threads\/([^/]+)\/turns$/.exec(path);
    if (method === "POST" && threadTurnMatch) {
      if (!this.opts.services?.threadDetail || !this.opts.services?.createThreadTurn) {
        return this.json(res, 501, { error: "threads are not supported by this engine build" });
      }
      const threadId = decodeURIComponent(threadTurnMatch[1] as string);
      // Read the body BEFORE chaining: a request body is a one-shot stream, so
      // reading it inside the chain would block on the previous turn and could
      // time out. Parse/secret-scan eagerly, then serialize the rest.
      let body: Record<string, unknown>;
      try {
        body = ((await this.readBody(req)) ?? {}) as Record<string, unknown>;
        assertNoInlineSecretValues(body);
      } catch (err) {
        const status = err && typeof err === "object" && "status" in err ? Number((err as { status: number }).status) : 400;
        return this.json(res, status, { error: err instanceof Error ? err.message : "bad request" });
      }
      return handleThreadTurnCreate(this.threadTurnRouteCtx(), res, threadId, body);
    }

    const turnRetryMatch = /^\/threads\/([^/]+)\/turns\/([^/]+)\/retry$/.exec(path);
    if (method === "POST" && turnRetryMatch) {
      if (!this.opts.services?.threadDetail) return this.json(res, 501, { error: "threads are not supported by this engine build" });
      return handleThreadTurnRetry(
        this.threadTurnRouteCtx(),
        res,
        decodeURIComponent(turnRetryMatch[1] as string),
        decodeURIComponent(turnRetryMatch[2] as string),
      );
    }

    const artifactsRootMatch = /^\/runs\/([^/]+)\/artifacts$/.exec(path);
    if (method === "GET" && artifactsRootMatch) {
      const rec = await this.findRun(decodeURIComponent(artifactsRootMatch[1] as string));
      if (!rec?.runDir) return this.json(res, 404, { error: "no such run" });
      return this.json(res, 200, { runId: rec.runId ?? rec.id, artifacts: listArtifacts(rec.runDir) });
    }

    const artifactFetchMatch = /^\/runs\/([^/]+)\/artifacts\/(.+)$/.exec(path);
    if (method === "GET" && artifactFetchMatch) {
      const rec = await this.findRun(decodeURIComponent(artifactFetchMatch[1] as string));
      if (!rec?.runDir) return this.json(res, 404, { error: "no such run" });
      const target = safeArtifactPath(rec.runDir, decodeURIComponent(artifactFetchMatch[2] as string));
      if (!target || !existsSync(target) || lstatSync(target).isDirectory()) return this.json(res, 404, { error: "no such artifact" });
      // Size cap: a multi-MB events.jsonl must not block the event loop or the
      // client; refuse loudly with the real size so callers can range/tail it.
      // Binary artifacts (images) are naturally bounded and get a larger cap —
      // the small cap only ever protected the event loop from huge text logs.
      const stats = lstatSync(target);
      const isText = isTextArtifact(target);
      const cap = isText ? MAX_ARTIFACT_FETCH_BYTES : MAX_ARTIFACT_BINARY_FETCH_BYTES;
      if (stats.size > cap) {
        return this.json(res, 413, {
          error: `artifact is ${stats.size} bytes (limit ${cap}); read it from disk at ${target}`,
          bytes: stats.size,
        });
      }
      let data = readFileSync(target);
      if (isPatchArtifact(target) && containsSecretLikeToken(data.toString("utf8"))) {
        return this.json(res, 409, { error: "artifact contains secret-like token; refusing to serve patch" });
      }
      if (isTextArtifact(target)) {
        data = Buffer.from(redactSecrets(data.toString("utf8")), "utf8");
      }
      res.writeHead(200, { "content-type": contentType(target), "content-length": data.length });
      res.end(data);
      return;
    }

    // Produced PROJECT files — the run's real OUTPUTS (the repo's `artifacts/`
    // convention dir where agents drop visuals like a rendered preview), distinct
    // from the orchestration tree served by /artifacts (decision.yaml, telemetry,
    // …) which belongs in Run Detail/Diagnostics. repoRoot comes from the TYPED
    // run scope (producedRepoRoot — null for no-project, never the home dir);
    // content is traversal-scoped to <repoRoot>/artifacts (never the whole repo).
    const producedRootMatch = /^\/runs\/([^/]+)\/produced$/.exec(path);
    if (method === "GET" && producedRootMatch) {
      const rec = await this.findRun(decodeURIComponent(producedRootMatch[1] as string));
      if (!rec?.runDir) return this.json(res, 404, { error: "no such run" });
      const repoRoot = producedRepoRoot(rec);
      const artifacts = repoRoot ? listArtifacts(join(repoRoot, "artifacts")) : [];
      return this.json(res, 200, { runId: rec.runId ?? rec.id, artifacts });
    }

    const producedFetchMatch = /^\/runs\/([^/]+)\/produced\/(.+)$/.exec(path);
    if (method === "GET" && producedFetchMatch) {
      const rec = await this.findRun(decodeURIComponent(producedFetchMatch[1] as string));
      if (!rec?.runDir) return this.json(res, 404, { error: "no such run" });
      const repoRoot = producedRepoRoot(rec);
      if (!repoRoot) return this.json(res, 404, { error: "no project root for run" });
      const target = safeArtifactPath(join(repoRoot, "artifacts"), decodeURIComponent(producedFetchMatch[2] as string));
      if (!target || !existsSync(target) || lstatSync(target).isDirectory()) return this.json(res, 404, { error: "no such artifact" });
      const stats = lstatSync(target);
      const cap = isTextArtifact(target) ? MAX_ARTIFACT_FETCH_BYTES : MAX_ARTIFACT_BINARY_FETCH_BYTES;
      if (stats.size > cap) return this.json(res, 413, { error: `artifact is ${stats.size} bytes (limit ${cap}); read it from disk at ${target}`, bytes: stats.size });
      let data = readFileSync(target);
      if (isPatchArtifact(target) && containsSecretLikeToken(data.toString("utf8"))) return this.json(res, 409, { error: "artifact contains secret-like token; refusing to serve patch" });
      if (isTextArtifact(target)) data = Buffer.from(redactSecrets(data.toString("utf8")), "utf8");
      res.writeHead(200, { "content-type": contentType(target), "content-length": data.length });
      res.end(data);
      return;
    }

    const applyCheckMatch = /^\/runs\/([^/]+)\/apply\/check$/.exec(path);
    if (method === "POST" && applyCheckMatch) {
      const rec = await this.findRun(decodeURIComponent(applyCheckMatch[1] as string));
      if (!rec?.runDir) return this.json(res, 404, { error: "no such run" });
      let body: ControlApplyCheckRequest;
      try {
        const raw = await this.readBody(req);
        assertNoInlineSecretValues(raw);
        body = ControlApplyCheckRequest.parse(raw);
      } catch (err) {
        const status = err && typeof err === "object" && "status" in err ? Number((err as { status: number }).status) : 400;
        return this.json(res, status, { error: err instanceof Error ? err.message : "bad request" });
      }
      const patch = readPatch(rec);
      if (patch === null) return this.json(res, 404, { error: "no patch artifact for this run" });
      if (containsSecretLikeToken(patch)) return this.json(res, 409, { error: "patch contains secret-like token; refusing apply check" });
      const repoRoot = applyTargetRoot(body.target, rec);
      if (!repoRoot) return this.json(res, 400, { error: "project root is required for apply check" });
      const absoluteRepoError = validateAbsoluteRepoRoot(repoRoot);
      if (absoluteRepoError) return this.json(res, 400, { error: absoluteRepoError });
      const gateError = applyGateError(rec, patch, repoRoot);
      if (gateError) return this.json(res, 409, { error: gateError });
      return this.json(res, 200, await checkPatch(repoRoot, patch));
    }

    const applyMatch = /^\/runs\/([^/]+)\/apply$/.exec(path);
    if (method === "POST" && applyMatch) {
      const rec = await this.findRun(decodeURIComponent(applyMatch[1] as string));
      if (!rec?.runDir) return this.json(res, 404, { error: "no such run" });
      let body: ControlApplyRequest;
      try {
        const raw = await this.readBody(req);
        assertNoInlineSecretValues(raw);
        body = ControlApplyRequest.parse(raw);
      } catch (err) {
        const status = err && typeof err === "object" && "status" in err ? Number((err as { status: number }).status) : 400;
        return this.json(res, status, { error: err instanceof Error ? err.message : "bad request" });
      }
      const patch = readPatch(rec);
      if (patch === null) return this.json(res, 404, { error: "no patch artifact for this run" });
      if (containsSecretLikeToken(patch)) return this.json(res, 409, { error: "patch contains secret-like token; refusing apply" });
      const repoRoot = applyTargetRoot(body.target, rec);
      if (!repoRoot) return this.json(res, 400, { error: "project root is required for apply" });
      const absoluteRepoError = validateAbsoluteRepoRoot(repoRoot);
      if (absoluteRepoError) return this.json(res, 400, { error: absoluteRepoError });
      const gateError = applyGateError(rec, patch, repoRoot);
      if (gateError) return this.json(res, 409, { error: gateError });
      return this.json(res, 200, await deliver(repoRoot, patch, { mode: body.mode, branch: body.branch, message: body.message }));
    }

    // Operator decision on a NEEDS_HUMAN-blocked run (review queue actions):
    // a typed, auditable unblock path instead of a read-only dead end.
    const decisionMatch = /^\/runs\/([^/]+)\/decision$/.exec(path);
    if (method === "POST" && decisionMatch) {
      const rec = await this.findRun(decodeURIComponent(decisionMatch[1] as string));
      if (!rec?.runDir) return this.json(res, 404, { error: "no such run" });
      let body: ControlRunDecisionRequest;
      try {
        const raw = await this.readBody(req);
        assertNoInlineSecretValues(raw);
        body = ControlRunDecisionRequest.parse(raw);
      } catch (err) {
        const status = err && typeof err === "object" && "status" in err ? Number((err as { status: number }).status) : 400;
        return this.json(res, status, { error: err instanceof Error ? err.message : "bad request" });
      }

      if (body.action === "accept_risk" || body.action === "override_needs_human") {
        // The override exists to unblock a BLOCKED run (the only state the
        // apply gate honors it for); recording one elsewhere would claim an
        // apply permission that does not exist.
        if (rec.state !== "blocked") {
          return this.json(res, 409, {
            error: rec.state === "succeeded"
              ? "run already succeeded; apply it directly (no risk override needed)"
              : `run is ${rec.state}; risk overrides only unblock blocked runs (use rerun_with_feedback instead)`,
          });
        }
        const patch = readPatch(rec);
        if (patch === null) return this.json(res, 409, { error: "no patch artifact; there is nothing to unblock for apply" });
        const written = writeOperatorDecision(rec, {
          action: body.action,
          finding_ids: body.findingIds,
          accepted_risks: body.acceptedRisks,
          patch_sha256: sha256(patch),
          decided_at: nowIso(),
        });
        if (!written) return this.json(res, 500, { error: "cannot resolve run artifact root" });
        appendRunAuditEvent(rec, "control.applied", { decision: body.action, finding_ids: body.findingIds, accepted_risks: body.acceptedRisks });
        return this.json(res, 200, ControlRunDecisionResponse.parse({ accepted: true, status: "applied", message: `${body.action} recorded; apply is now permitted for this exact patch` }));
      }

      if (body.action === "revert_run") {
        // Server-owned revert of an in-place turn's live mutation. Restores the
        // tree to the recorded pre-turn snapshot, refusing (fail loud) if the tree
        // has diverged from the recorded post-turn state (the user edited since).
        const result = controlRunResult(rec);
        if (!result.revertable || !result.preTurnSha || !result.postTurnSha) {
          return this.json(res, 409, { error: "this run produced no revertable in-place change" });
        }
        const repoRoot = applyTargetRoot({ kind: "original_project" }, rec);
        if (!repoRoot) return this.json(res, 400, { error: "cannot resolve the in-place project root to revert" });
        const absoluteRepoError = validateAbsoluteRepoRoot(repoRoot);
        if (absoluteRepoError) return this.json(res, 400, { error: absoluteRepoError });
        let revert;
        try {
          revert = await revertInPlace(repoRoot, result.preTurnSha, result.postTurnSha);
        } catch (err) {
          return this.json(res, 500, { error: `revert failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        if (!revert.reverted) {
          appendRunAuditEvent(rec, "control.rejected", { decision: "revert_run", reason: revert.reason ?? "revert refused" });
          return this.json(res, 409, ControlRunDecisionResponse.parse({ accepted: false, status: "rejected", message: revert.reason ?? "revert refused" }));
        }
        markRunReverted(rec);
        appendRunAuditEvent(rec, "control.applied", { decision: "revert_run", removed: revert.removed });
        return this.json(res, 200, ControlRunDecisionResponse.parse({
          accepted: true,
          status: "applied",
          message: `reverted to the pre-turn state${revert.removed.length ? ` (removed ${revert.removed.length} turn-added file(s))` : ""}`,
        }));
      }

      if (body.action === "accept_clean_patch") {
        const patch = readPatch(rec);
        if (patch === null) return this.json(res, 404, { error: "no patch artifact for this run" });
        if (containsSecretLikeToken(patch)) return this.json(res, 409, { error: "patch contains secret-like token; refusing apply" });
        const repoRoot = applyTargetRoot(body.target ?? { kind: "original_project" }, rec);
        if (!repoRoot) return this.json(res, 400, { error: "project root is required for apply" });
        const absoluteRepoError = validateAbsoluteRepoRoot(repoRoot);
        if (absoluteRepoError) return this.json(res, 400, { error: absoluteRepoError });
        const gateError = applyGateError(rec, patch, repoRoot);
        if (gateError) return this.json(res, 409, { error: gateError });
        const delivered = await deliver(repoRoot, patch, { mode: body.applyMode ?? "apply" });
        appendRunAuditEvent(rec, "control.applied", { decision: body.action, mode: body.applyMode ?? "apply", applied: delivered.applied });
        return this.json(res, 200, ControlRunDecisionResponse.parse({ accepted: delivered.applied, status: delivered.applied ? "applied" : "rejected", message: delivered.detail ?? undefined }));
      }

      // rerun_with_feedback: enqueue a follow-up run seeded with the reviewer feedback.
      if (!body.feedback || !body.feedback.trim()) {
        return this.json(res, 400, { error: "feedback is required for rerun_with_feedback" });
      }
      const p = paramsRecord(rec);
      const originalPrompt = typeof p["prompt"] === "string" ? p["prompt"] : "";
      let params: ControlRunStartRequest;
      try {
        params = normalizeRunStart(
          ControlRunStartRequest.parse({
            ...p,
            prompt: `${originalPrompt}\n\n## Reviewer feedback to address (operator decision)\n${body.feedback}`,
            parentRunId: rec.runId ?? rec.id,
          }),
        );
      } catch (err) {
        return this.json(res, 400, { error: `cannot rebuild run params for rerun: ${err instanceof Error ? err.message : String(err)}` });
      }
      // A thread-anchored rerun is a TURN of that conversation. Single-writer:
      // create the decision turn (run_id=null) BEFORE enqueue and pass its id, so
      // the daemon runner binds the rerun and head_run_id/needsHuman move off the
      // old blocked head — no post-hoc turn that could fail to reconcile.
      const threadId = typeof p["threadId"] === "string" ? p["threadId"] : null;
      const createTurnSvc = this.opts.services?.createThreadTurn;
      let rerunTurnId: string | undefined;
      if (threadId && createTurnSvc) {
        const turn = (await createTurnSvc(threadId, String(params.prompt ?? ""), {
          kind: "decision",
          parentRunId: rec.runId ?? rec.id,
        })) as { id: string };
        rerunTurnId = turn.id;
      }
      let rerunJob: { id: string };
      try {
        rerunJob = await this.opts.daemon.enqueue({ ...params, ...(rerunTurnId ? { turnId: rerunTurnId } : {}) });
      } catch (err) {
        // The decision turn was pre-created: a failed rerun ENQUEUE must be
        // an inline refusal on that turn, not a silent orphan bubble.
        // retryable=false mirrors the recorded refusal (no job to replay).
        recordTurnEnqueueFailure(this.opts.services?.setTurnEnqueueError, rerunTurnId, err);
        const status = err && typeof err === "object" && "status" in err ? Number((err as { status: number }).status) : 500;
        return this.json(res, status, {
          error: err instanceof Error ? err.message : "rerun enqueue failed",
          ...(rerunTurnId ? { turnId: rerunTurnId, retryable: false } : {}),
        });
      }
      // POST-ENQUEUE: observation loss is not a refusal — record nothing.
      let newRec: DaemonRunRecord;
      try {
        newRec = await this.waitForRunStart(rerunJob.id);
      } catch (err) {
        return this.json(res, 500, {
          error: `rerun job ${rerunJob.id} was accepted but its start could not be observed: ${err instanceof Error ? err.message : String(err)}`,
          jobId: rerunJob.id,
          ...(rerunTurnId ? { turnId: rerunTurnId } : {}),
        });
      }
      appendRunAuditEvent(rec, "control.applied", { decision: body.action, new_run_id: newRec.runId ?? newRec.id });
      return this.json(res, 200, ControlRunDecisionResponse.parse({
        accepted: true,
        status: "requeued",
        newRunId: newRec.runId ?? newRec.id,
        message: "follow-up run enqueued with reviewer feedback",
      }));
    }

    if (method === "GET" && path === "/harnesses") return this.service(res, "harnesses", undefined, ControlHarnessListResponse);
    const harnessModelsMatch = /^\/harnesses\/([^/]+)\/models$/.exec(path);
    if (method === "GET" && harnessModelsMatch) {
      return this.service(res, "harnessModels", { harnessId: decodeURIComponent(harnessModelsMatch[1] as string) }, ControlHarnessModelsResponse);
    }
    if (method === "GET" && path === "/setup/jobs") return this.service(res, "listSetupJobs", undefined, ControlSetupJobListResponse);
    if (method === "POST" && path === "/setup/jobs") {
      let body: ControlSetupJobCreateRequest;
      try {
        const raw = await this.readBody(req);
        assertNoInlineSecretValues(raw);
        body = ControlSetupJobCreateRequest.parse(raw);
      } catch (err) {
        const status = err && typeof err === "object" && "status" in err ? Number((err as { status: number }).status) : 400;
        return this.json(res, status, { error: err instanceof Error ? err.message : "bad request" });
      }
      return this.service(res, "createSetupJob", body, ControlSetupJob);
    }
    const setupJobMatch = /^\/setup\/jobs\/([^/]+)$/.exec(path);
    if (method === "GET" && setupJobMatch) {
      return this.service(res, "setupJobStatus", { jobId: decodeURIComponent(setupJobMatch[1] as string) }, ControlSetupJob);
    }
    const setupJobCancelMatch = /^\/setup\/jobs\/([^/]+)\/cancel$/.exec(path);
    if (method === "POST" && setupJobCancelMatch) {
      return this.service(res, "cancelSetupJob", { jobId: decodeURIComponent(setupJobCancelMatch[1] as string) }, ControlSetupJob);
    }
    const setupJobConfirmMatch = /^\/setup\/jobs\/([^/]+)\/confirm$/.exec(path);
    if (method === "POST" && setupJobConfirmMatch) {
      try {
        const raw = await this.readBody(req);
        assertNoInlineSecretValues(raw);
        const body = ControlSetupJobConfirmRequest.parse(raw);
        return this.service(res, "confirmSetupJob", { jobId: decodeURIComponent(setupJobConfirmMatch[1] as string), confirmed: body.confirmed }, ControlSetupJob);
      } catch (err) {
        const status = err && typeof err === "object" && "status" in err ? Number((err as { status: number }).status) : 400;
        return this.json(res, status, { error: err instanceof Error ? err.message : "bad request" });
      }
    }
    const setupJobEventsMatch = /^\/setup\/jobs\/([^/]+)\/events$/.exec(path);
    if (method === "GET" && setupJobEventsMatch) {
      return this.streamSetupJobEvents(decodeURIComponent(setupJobEventsMatch[1] as string), req, res);
    }
    // User-level trust (INV-122: sensitive powers live OUTSIDE versioned repo
    // config). GET lists per-repo trust files; POST is deliberately NARROW —
    // exactly {repoRoot, allowFullAccess} (strict), everything else CLI-only.
    if (method === "GET" && path === "/trust") return this.service(res, "listTrust", undefined, ControlTrustListResponse);
    if (method === "POST" && path === "/trust") {
      let body: ControlTrustUpdateRequest;
      try {
        const raw = await this.readBody(req);
        assertNoInlineSecretValues(raw);
        body = ControlTrustUpdateRequest.parse(raw);
      } catch (err) {
        const status = err && typeof err === "object" && "status" in err ? Number((err as { status: number }).status) : 400;
        return this.json(res, status, { error: err instanceof Error ? err.message : "bad request" });
      }
      return this.service(res, "updateTrust", body, ControlTrustState);
    }
    if (method === "GET" && path === "/settings") return this.service(res, "settings", undefined, ControlSettingsSnapshot);
    if (method === "POST" && path === "/settings") {
      let body: ControlSettingsUpdateRequest;
      try {
        const raw = await this.readBody(req);
        assertNoInlineSecretValues(raw);
        body = ControlSettingsUpdateRequest.parse(raw);
      } catch (err) {
        const status = err && typeof err === "object" && "status" in err ? Number((err as { status: number }).status) : 400;
        return this.json(res, status, { error: err instanceof Error ? err.message : "bad request" });
      }
      return this.service(res, "updateSettings", body);
    }
    // (legacy /auth alias removed: it duplicated GET /harnesses byte-for-byte)
    if (method === "GET" && path === "/secrets") return this.service(res, "listSecrets", undefined, ControlSecretListResponse);
    if (method === "POST" && path === "/secrets") {
      const body = await this.readBody(req);
      if (!validSecretSetBody(body)) return this.json(res, 400, { error: `secret name must be one of: ${MANAGED_SECRET_NAMES.join(", ")}` });
      return this.service(res, "setSecret", body);
    }
    const secretDeleteMatch = /^\/secrets\/([^/]+)$/.exec(path);
    if (method === "DELETE" && secretDeleteMatch) {
      const name = decodeURIComponent(secretDeleteMatch[1] as string);
      if (!isAllowedSecretName(name)) return this.json(res, 400, { error: `secret name must be one of: ${MANAGED_SECRET_NAMES.join(", ")}` });
      return this.service(res, "deleteSecret", name);
    }
    if (method === "POST" && path === "/spec/questions") {
      try {
        const raw = await this.readBody(req);
        assertNoSpecBodySecrets(raw);
        const body = ControlSpecQuestionsRequest.parse(raw);
        return this.service(res, "specQuestions", body);
      } catch (err) {
        const status = err && typeof err === "object" && "status" in err ? Number((err as { status: number }).status) : 400;
        return this.json(res, status, { error: err instanceof Error ? err.message : "bad request" });
      }
    }
    if (method === "POST" && path === "/spec/freeze") {
      try {
        const raw = await this.readBody(req);
        assertNoSpecBodySecrets(raw);
        const body = ControlSpecFreezeRequest.parse(raw);
        return this.service(res, "specFreeze", body);
      } catch (err) {
        const status = err && typeof err === "object" && "status" in err ? Number((err as { status: number }).status) : 400;
        return this.json(res, status, { error: err instanceof Error ? err.message : "bad request" });
      }
    }

    const controlMatch = /^\/runs\/([^/]+)\/control$/.exec(path);
    if (method === "POST" && controlMatch) {
      const rec = await this.findRun(decodeURIComponent(controlMatch[1] as string));
      if (!rec) return this.json(res, 404, { error: "no such run" });
      let body: ControlRunControlRequest;
      try {
        const raw = await this.readBody(req);
        assertNoInlineSecretValues(raw);
        body = ControlRunControlRequest.parse(raw);
      } catch (err) {
        const status = err && typeof err === "object" && "status" in err ? Number((err as { status: number }).status) : 400;
        return this.json(res, status, { error: err instanceof Error ? err.message : "bad request" });
      }
      appendRunAuditEvent(rec, "control.requested", { control: body.control });
      // Honesty: a control action on a TERMINAL job has no process to stop;
      // claiming "applied" would fabricate an effect that never happened.
      if (rec.state !== "queued" && rec.state !== "running") {
        appendRunAuditEvent(rec, "control.rejected", { control: body.control, reason: `run is terminal (${rec.state})` });
        return this.json(res, 409, { error: `run is ${rec.state}; ${body.control.kind} has nothing to stop` });
      }
      await this.opts.daemon.cancel(rec.id);
      appendRunAuditEvent(rec, "control.applied", { control: body.control });
      return this.json(res, 200, ControlRunControlResponse.parse({
        accepted: true,
        status: "applied",
        runId: rec.runId ?? rec.id,
        message: `${body.control.kind} requested`,
      }));
    }

    const eventsMatch = /^\/runs\/([^/]+)\/events$/.exec(path);
    if (method === "GET" && eventsMatch) {
      const id = decodeURIComponent(eventsMatch[1] as string);
      const last = this.lastEventId(req, url);
      return this.streamEvents(id, last, req, res);
    }

    return this.json(res, 404, { error: "not found" });
  }

  private async service(
    res: ServerResponse,
    name: keyof NonNullable<DaemonControlApiOptions["services"]>,
    arg?: unknown,
    schema?: { parse(value: unknown): unknown },
  ): Promise<void> {
    const fn = this.opts.services?.[name] as ((arg?: unknown) => Promise<unknown>) | undefined;
    if (!fn) return this.json(res, 501, { error: `${name} service is not configured` });
    try {
      const value = await fn(arg);
      return this.json(res, 200, schema ? schema.parse(value) : value);
    } catch (err) {
      // Honest status codes: services attach a typed `status` (e.g. 404 for a
      // missing setup job); a schema-invalid service RESULT is an internal 500.
      // Flattening everything to 400 made client-side error handling guesswork.
      const message = redactSecrets(err instanceof Error ? err.message : String(err));
      const typedStatus = err && typeof err === "object" && "status" in err ? Number((err as { status: unknown }).status) : Number.NaN;
      // A schema-invalid service RESULT is a server bug (500), cross-realm-safe via the error name.
      const status = Number.isFinite(typedStatus) ? typedStatus : err instanceof Error && err.name === "ZodError" ? 500 : 400;
      return this.json(res, status, { error: message });
    }
  }

  /**
   * Live setup-job lifecycle stream: emits a `status` event on every state or
   * message transition until the job reaches a terminal state. Backed by
   * polling the job service (the manager has no event bus), which is exactly
   * what the previous one-shot stub forced every client to reimplement.
   */
  private async streamSetupJobEvents(jobId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fn = this.opts.services?.setupJobStatus as ((arg?: unknown) => Promise<unknown>) | undefined;
    if (!fn) return this.json(res, 501, { error: "setupJobStatus service is not configured" });
    let job: ControlSetupJob;
    try {
      job = ControlSetupJob.parse(await fn({ jobId }));
    } catch (err) {
      return this.json(res, 404, { error: redactSecrets(err instanceof Error ? err.message : String(err)) });
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    this.sseClients.add(res);

    const TERMINAL_JOB_STATES = new Set(["succeeded", "failed", "cancelled", "not_supported"]);
    let seq = 0;
    let closed = false;
    let lastSnapshot = "";
    const cleanup = () => {
      closed = true;
      clearInterval(timer);
      clearInterval(heartbeat);
      this.sseClients.delete(res);
    };
    const emit = (current: ControlSetupJob): boolean => {
      const snapshot = JSON.stringify([current.state, current.message, current.firstOutputAt, current.lastOutputAt, current.finishedAt]);
      if (snapshot === lastSnapshot) return false;
      lastSnapshot = snapshot;
      seq += 1;
      const event = ControlSetupJobEvent.parse({
        jobId: current.jobId,
        seq,
        time: nowIso(),
        kind: "status",
        state: current.state,
        message: current.message,
      });
      res.write(`id: ${seq}\nevent: setup\ndata: ${JSON.stringify(event)}\n\n`);
      return true;
    };
    const finish = () => {
      if (closed) return;
      res.write("event: end\ndata: {}\n\n");
      res.end();
      cleanup();
    };
    const heartbeat = setInterval(() => {
      if (!closed) res.write(`: ping ${Date.now()}\n\n`);
    }, this.opts.heartbeatMs ?? 15_000);
    heartbeat.unref?.();
    const tick = async () => {
      if (closed) return;
      try {
        job = ControlSetupJob.parse(await fn({ jobId }));
      } catch {
        finish();
        return;
      }
      emit(job);
      if (TERMINAL_JOB_STATES.has(job.state)) finish();
    };
    const timer = setInterval(() => void tick(), this.opts.pollMs ?? 250);
    timer.unref?.();
    req.on("close", cleanup);
    res.on("close", cleanup);
    emit(job);
    if (TERMINAL_JOB_STATES.has(job.state)) finish();
  }

  private async waitForRunStart(jobId: string): Promise<DaemonRunRecord> {
    const pollMs = this.opts.pollMs ?? 50;
    const deadline = Date.now() + (this.opts.runStartTimeoutMs ?? 30_000);
    let last: DaemonRunRecord | null = null;
    for (;;) {
      const rec = await this.opts.daemon.status(jobId);
      last = rec;
      if (rec.runId && rec.runDir) return rec;
      if (TERMINAL_STATES.has(rec.state)) return rec;
      if (Date.now() > deadline) return last;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  private async findRun(id: string): Promise<DaemonRunRecord | null> {
    const runs = await this.opts.daemon.list();
    return runs.find((r) => r.id === id || r.runId === id) ?? null;
  }


  /** Bound helper context for the extracted thread-turn write routes.
   * Callers guard the required services (threadDetail/createThreadTurn)
   * before routing here. */
  private threadTurnRouteCtx(): ThreadTurnRouteCtx {
    const services = this.opts.services ?? {};
    return {
      json: (res, status, body) => this.json(res, status, body),
      waitForRunStart: (jobId) => this.waitForRunStart(jobId),
      readRunArtifactText: (runId, rel) => this.readRunArtifactText(runId, rel),
      normalizeStart: normalizeRunStart,
      isTerminalState: (state) => TERMINAL_STATES.has(state),
      daemon: this.opts.daemon,
      threadDetail: services.threadDetail as NonNullable<typeof services.threadDetail>,
      createThreadTurn: services.createThreadTurn as NonNullable<typeof services.createThreadTurn>,
      setTurnEnqueueError: services.setTurnEnqueueError,
      threadTurnChains: this.threadTurnChains,
    };
  }

  /** Read a run's text artifact (e.g. final/plan.md) for the "Implement plan" turn. */
  private async readRunArtifactText(runId: string, rel: string): Promise<string | null> {
    const rec = await this.findRun(runId);
    if (!rec) return null;
    try {
      return readRawTextArtifact(rec, rel);
    } catch {
      return null;
    }
  }

  private readonly summaryCache = new Map<string, { fingerprint: string; summary: ControlRunSummary }>();

  /**
   * GET /runs is the app's main screen and used to re-read every artifact for
   * every retained job on every poll (O(jobs x file size) sync I/O). Terminal
   * runs change only when their artifacts change, so summaries are cached on a
   * state+artifact-mtime fingerprint.
   */
  private summarizeRunCached(rec: DaemonRunRecord): ControlRunSummary {
    const fingerprint = summaryFingerprint(rec);
    const hit = this.summaryCache.get(rec.id);
    if (hit && hit.fingerprint === fingerprint) return hit.summary;
    const summary = summarizeRun(rec);
    if (this.summaryCache.size > 1_000) this.summaryCache.clear(); // bounded; repopulates on the next poll
    this.summaryCache.set(rec.id, { fingerprint, summary });
    return summary;
  }

  /**
   * Cached artifact projection + LIVE waiting_on_user overlay. Pending
   * interactions are in-process daemon state, not an artifact, so they must
   * never be frozen into the fingerprint cache.
   */
  private summarizeRunLive(rec: DaemonRunRecord): ControlRunSummary {
    const summary = this.summarizeRunCached(rec);
    const waiting = this.pendingInteractionsFor(rec).length > 0;
    return summary.waitingOnUser === waiting ? summary : { ...summary, waitingOnUser: waiting };
  }

  private lastEventId(req: IncomingMessage, url: URL): number {
    const rawHeader = req.headers["last-event-id"];
    const headerId = rawHeader !== undefined ? Number(rawHeader) : Number.NaN;
    const rawQuery = url.searchParams.get("lastEventId");
    const queryId = rawQuery !== null ? Number(rawQuery) : Number.NaN;
    return Number.isFinite(headerId) ? headerId : Number.isFinite(queryId) ? queryId : 0;
  }

  private async streamEvents(id: string, lastEventId: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rec = await this.findRun(id);
    if (!rec) return this.json(res, 404, { error: "no such run" });
    // A QUEUED job has no runDir yet — that is a wait, not a 404:
    // the stream opens with heartbeats and binds the events file once the
    // run starts, so `follow <jobId>` works from enqueue time. 404 stays for
    // truly unknown ids only.
    let eventsPath = rec.runDir ? join(rec.runDir, "events.jsonl") : null;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    this.sseClients.add(res);

    let lineNo = 0;
    let offset = 0;
    let carry = "";
    let closed = false;
    let unsubscribe: (() => void) | undefined;
    const cleanup = () => {
      closed = true;
      clearInterval(timer);
      clearInterval(heartbeat);
      unsubscribe?.();
      this.sseClients.delete(res);
    };
    // Heartbeat: a quiet harness phase (long tool call, slow model) must not be
    // indistinguishable from a dead connection — clients and proxies need bytes.
    const heartbeat = setInterval(() => {
      if (!closed) res.write(`: ping ${Date.now()}\n\n`);
    }, this.opts.heartbeatMs ?? 15_000);
    heartbeat.unref?.();
    let draining = false;
    const writeAvailable = async () => {
      if (closed || draining) return;
      if (!eventsPath) {
        // Still queued: poll the job until the run binds its dir (then tail
        // it) or the job goes terminal without one (validation failure — a
        // run that never materialized ends the stream honestly).
        const latest = await this.opts.daemon.status(rec.id).catch(() => rec);
        if (latest.runDir) {
          eventsPath = join(latest.runDir, "events.jsonl");
        } else if (TERMINAL_STATES.has(latest.state)) {
          res.write("event: end\ndata: {}\n\n");
          res.end();
          cleanup();
          return;
        } else {
          return;
        }
      }
      if (!existsSync(eventsPath)) return;
      draining = true;
      try {
        const { lines, nextOffset, rest } = readNewLines(eventsPath, offset, carry);
        offset = nextOffset;
        carry = rest;
        for (const raw of lines) {
          lineNo += 1;
          // Durable cursor: the event's own persisted seq. Legacy lines without
          // one fall back to their line number (matching EventLog's counter
          // init), so resume ids stay consistent either way.
          let seq = lineNo;
          let type = "run";
          try {
            const parsed = JSON.parse(raw) as { type?: string; seq?: number };
            type = String(parsed.type ?? "run");
            if (typeof parsed.seq === "number" && Number.isFinite(parsed.seq)) seq = parsed.seq;
          } catch {
            type = "malformed";
          }
          if (seq <= lastEventId) continue;
          res.write(`id: ${seq}\nevent: ${type}\ndata: ${redactedSseLine(raw)}\n\n`);
          if (type === "run.completed" || type === "run.failed" || type === "run.blocked") {
            res.write("event: end\ndata: {}\n\n");
            res.end();
            cleanup();
            return;
          }
        }
        const latest = await this.opts.daemon.status(rec.id).catch(() => rec);
        if (TERMINAL_STATES.has(latest.state)) {
          res.write("event: end\ndata: {}\n\n");
          res.end();
          cleanup();
        }
      } finally {
        draining = false;
      }
    };
    // Push: a bus event for this run pokes the tailer immediately; the file
    // remains the single ordered source so push and poll can never disagree.
    unsubscribe = this.opts.bus?.subscribe((event) => {
      if (!closed && event.run_id === (rec.runId ?? rec.id)) void writeAvailable();
    });
    const timer = setInterval(() => void writeAvailable(), this.opts.pollMs ?? 250);
    timer.unref?.();
    req.on("close", cleanup);
    res.on("close", cleanup);
    await writeAvailable();
  }

  /**
   * Global live-only event multiplex (GET /events): every run's events as they
   * happen, tagged with run_id, no replay. Documented asymmetry vs the per-run
   * stream: reconnecting clients re-snapshot /runs first, then resume per-run
   * streams (which DO replay via persisted seq) where they need gap-free state.
   */
  private streamGlobalEvents(req: IncomingMessage, res: ServerResponse): void {
    if (!this.opts.bus) {
      this.json(res, 501, { error: "global event stream requires the daemon event bus" });
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    this.sseClients.add(res);
    let closed = false;
    const heartbeat = setInterval(() => {
      if (!closed) res.write(`: ping ${Date.now()}\n\n`);
    }, this.opts.heartbeatMs ?? 15_000);
    heartbeat.unref?.();
    const unsubscribe = this.opts.bus.subscribe((event) => {
      if (closed) return;
      try {
        const raw = JSON.stringify(event);
        const type = String((event as { type?: string }).type ?? "run");
        const seq = (event as { seq?: number }).seq;
        res.write(`${typeof seq === "number" ? `id: ${seq}\n` : ""}event: ${type}\ndata: ${redactedSseLine(raw)}\n\n`);
      } catch {
        /* one bad event must not kill the stream */
      }
    });
    const cleanup = () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      this.sseClients.delete(res);
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  }

  private pendingInteractionsFor(rec: DaemonRunRecord): ControlPendingInteraction[] {
    try {
      return this.opts.services?.pendingInteractions?.(rec.runId ?? rec.id) ?? [];
    } catch {
      return [];
    }
  }
}

function redactedSseLine(raw: string): string {
  const redacted = redactSecrets(raw);
  try {
    return JSON.stringify(JSON.parse(redacted));
  } catch {
    return redacted;
  }
}

function readNewLines(path: string, offset: number, carry: string): { lines: string[]; nextOffset: number; rest: string } {
  const size = statSync(path).size;
  const start = size < offset ? 0 : offset; // file rotated/truncated; start over
  const len = size - start;
  if (len <= 0) return { lines: [], nextOffset: start, rest: carry };
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, start);
    const text = carry + buf.toString("utf8");
    const parts = text.split("\n");
    const rest = parts.pop() ?? "";
    return { lines: parts.filter(Boolean), nextOffset: size, rest };
  } finally {
    closeSync(fd);
  }
}

/* ---- Thread projections (engine snake_case -> control camelCase) ---- */

function paramsRecord(rec: DaemonRunRecord): Record<string, unknown> {
  return rec.params && typeof rec.params === "object" && !Array.isArray(rec.params) ? (rec.params as Record<string, unknown>) : {};
}

function projectMetadata(rec: DaemonRunRecord): { kind: "project" | "none"; root: string | null; projectName: string | null; context: "off" | "auto" } {
  const p = paramsRecord(rec);
  const scope = p["scope"];
  if (scope && typeof scope === "object" && !Array.isArray(scope)) {
    const s = scope as Record<string, unknown>;
    if (s["kind"] === "none") return { kind: "none", root: null, projectName: null, context: "off" };
    if (s["kind"] === "project" && typeof s["root"] === "string") {
      return { kind: "project", root: s["root"], projectName: basename(s["root"]), context: "auto" };
    }
  }
  const repoRoot = runRepoRoot(rec);
  const noProject = repoRoot === NO_PROJECT_ROOT;
  return {
    kind: noProject ? "none" : "project",
    root: noProject ? null : repoRoot,
    projectName: noProject || !repoRoot ? null : basename(repoRoot),
    context: noProject ? "off" : "auto",
  };
}

function readFailure(rec: DaemonRunRecord): RunFailure | null {
  const fromArtifact = safeReadStructuredArtifact(rec, "final/failure.yaml", RunFailure);
  if (fromArtifact) return fromArtifact;
  if (!rec.error) return null;
  return RunFailure.parse({
    category: "unknown",
    safeMessage: rec.error,
    runDir: rec.runDir ?? null,
  });
}

function appendRunAuditEvent(rec: DaemonRunRecord, type: RunEventType, payload: Record<string, unknown>): void {
  if (!rec.runDir) return;
  try {
    // Single-counter invariant: while the run is active its EventLog owns the
    // seq space, so audit records MUST route through it (appendRunEvent does;
    // file-tail stamping only applies once the run is terminal). A tail-read
    // here would duplicate ids and break SSE Last-Event-ID resume.
    appendRunEvent(join(rec.runDir, "events.jsonl"), rec.runId ?? rec.id, rec.taskId ?? "unknown", type, payload);
  } catch {
    /* audit append must not change control behavior */
  }
}

function summaryFingerprint(rec: DaemonRunRecord): string {
  const mtime = (rel: string): number => {
    if (!rec.runDir) return 0;
    const path = safeArtifactPath(rec.runDir, rel);
    if (!path) return 0;
    try {
      return statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  };
  return [
    rec.state,
    paramsFingerprint(rec),
    rec.finishedAt ?? "",
    rec.error ?? "",
    mtime("events.jsonl"),
    mtime("arbitration/decision.yaml"),
    mtime("final/telemetry.yaml"),
    mtime("final/failure.yaml"),
    mtime("final/summary.md"),
    // Primary outputs feed outputReadyState; a summary cached before the
    // answer/plan/report/patch landed must invalidate when it does.
    mtime("final/answer.md"),
    mtime("final/plan.md"),
    mtime("final/explore.md"),
    mtime("final/report.md"),
    mtime("final/patch.diff"),
    // Orchestrate output is the prose plan + the typed plan; a summary cached
    // before they land (or after a revert re-stamps work_product) must invalidate.
    mtime("final/orchestration.md"),
    mtime("final/orchestration.yaml"),
    // Executor progress (auto_safe/auto_full) lands after the plan; a detail
    // cached before steps ran (or as they advance) must invalidate.
    mtime("final/orchestration_progress.yaml"),
    // The honest outcome (result kind / diffstat / adopted / apply_state) is
    // projected from work_product.yaml; a summary cached before it landed (or
    // before a revert flipped apply_state) must invalidate.
    mtime("final/work_product.yaml"),
  ].join("|");
}

function paramsFingerprint(rec: DaemonRunRecord): string {
  try {
    return sha256(JSON.stringify(rec.params ?? null));
  } catch {
    return "unserializable-params";
  }
}

/** v0.9 strategy flags projected back so surfaces can tell a race from a repair loop. */
function strategyFromParams(p: Record<string, unknown>): "race" | "attempts" | "until_clean" | "swarm" | "create" | null {
  if (p["untilClean"] === true) return "until_clean";
  if (typeof p["attempts"] === "number" && p["attempts"] > 0) return "attempts";
  if (p["create"] === true) return "create";
  if (p["swarm"] === true) return "swarm";
  if (typeof p["n"] === "number" && p["n"] > 1) return "race";
  return null;
}

/**
 * Honest terminal outcome, projected from final/work_product.yaml's meta (the
 * orchestrator-owned record of what the turn produced). Answers the v0.9 "is the
 * game done?" gap: plan runs report kind=plan with a null diffStat (no files
 * changed), patches report a real diffStat, and a race-adopted patch reports
 * adopted=true.
 */
function controlRunResult(rec: DaemonRunRecord): ControlRunResult {
  const wp = safeReadStructuredArtifact(rec, "final/work_product.yaml", WorkProduct);
  const meta = (wp?.meta ?? {}) as Record<string, unknown>;
  const kindRaw = meta["result_kind"];
  const kind = kindRaw === "patch" || kindRaw === "answer" || kindRaw === "plan" || kindRaw === "report" ? kindRaw : "none";
  const ds = meta["diffstat"] as { files?: unknown; additions?: unknown; deletions?: unknown } | undefined;
  const diffStat =
    ds && typeof ds.files === "number"
      ? { files: ds.files, additions: typeof ds.additions === "number" ? ds.additions : 0, deletions: typeof ds.deletions === "number" ? ds.deletions : 0 }
      : null;
  const applyStateRaw = meta["apply_state"];
  const applyState =
    applyStateRaw === "applied" || applyStateRaw === "applied_review_blocked" || applyStateRaw === "reverted"
      ? applyStateRaw
      : "not_applied";
  const preTurnSha = typeof meta["pre_turn_sha"] === "string" ? meta["pre_turn_sha"] : null;
  const postTurnSha = typeof meta["post_turn_sha"] === "string" ? meta["post_turn_sha"] : null;
  // A run is revertable when it actually mutated the live tree this turn and the
  // pre/post snapshots needed for a safe restore exist. The daemon revert handler
  // still re-checks the tree hasn't diverged from post_turn_sha before acting.
  const revertable =
    (applyState === "applied" || applyState === "applied_review_blocked") && preTurnSha !== null && postTurnSha !== null;
  return ControlRunResult.parse({
    kind,
    diffStat,
    blockers: typeof meta["blockers"] === "number" ? meta["blockers"] : 0,
    adopted: typeof meta["adopted"] === "boolean" ? meta["adopted"] : null,
    applyState,
    preTurnSha,
    postTurnSha,
    revertable,
  });
}

/** Flip the persisted work_product apply_state to `reverted` after a successful
 * revert so the run stops advertising a Revert affordance (single source: the
 * work_product meta that controlRunResult projects). Best-effort: the revert
 * already happened; a metadata write failure must not 500 the response. */
function markRunReverted(rec: DaemonRunRecord): void {
  try {
    if (!rec.runDir) return;
    const root = safeArtifactRoot(rec.runDir);
    if (!root) return;
    const wpPath = join(root, "final", "work_product.yaml");
    if (!existsSync(wpPath)) return;
    const doc = (parseYaml(readFileSync(wpPath, "utf8")) ?? {}) as Record<string, unknown>;
    const meta = (doc["meta"] && typeof doc["meta"] === "object" ? doc["meta"] : {}) as Record<string, unknown>;
    meta["apply_state"] = "reverted";
    doc["meta"] = meta;
    // Atomic tmp+rename: a crash mid-write must never leave work_product.yaml
    // half-written (it would degrade the run projection to kind: none).
    const tmp = `${wpPath}.tmp-${process.pid}`;
    writeFileSync(tmp, stringifyYaml(doc), "utf8");
    renameSync(tmp, wpPath);
  } catch {
    /* best-effort: the revert succeeded regardless of this metadata flip */
  }
}

function summarizeRun(rec: DaemonRunRecord): ControlRunSummary {
  const p = paramsRecord(rec);
  // safeParse everywhere: one malformed job record (e.g. an old/foreign mode id)
  // must degrade to an unknown field, never 500 the whole run list forever.
  const parsedMode = ModeKind.safeParse(p["mode"]);
  const parsedPortfolio = Portfolio.safeParse(p["portfolio"]);
  const parsedAccess = parseAccessMaybe(p["access"]);
  const task = safeReadStructuredArtifact(rec, "context/task.yaml", TaskContract);
  const telemetry = safeReadStructuredArtifact(rec, "final/telemetry.yaml", RunTelemetry);
  // Access truth comes from engine artifacts ONLY (contract/telemetry); client
  // params can request but never assert what was effectively enforced.
  const requestedAccess = telemetry?.requested_access ?? task?.access.requested_profile ?? parsedAccess;
  const effectiveAccess = telemetry?.effective_access ?? task?.access.effective_profile;
  const externalContextPolicy = telemetry?.external_context_policy ?? task?.external_context.policy;
  const webEvidence = controlWebEvidence(telemetry, task);
  const decision = safeReadStructuredArtifact(rec, "arbitration/decision.yaml", DecisionRecord);
  const budget = budgetSnapshot(rec, decision);
  const parsedReviewerPanel = Array.isArray(p["reviewerPanel"])
    ? ControlReviewerPanelEntry.array().safeParse(p["reviewerPanel"])
    : null;
  const parsedProtectedPathApprovals = Array.isArray(p["protectedPathApprovals"])
    ? ProtectedPathApproval.array().safeParse(p["protectedPathApprovals"])
    : null;
  const requestTests = Array.isArray(p["tests"])
    ? p["tests"].filter((x): x is string => typeof x === "string")
    : undefined;
  const contractTests = task?.tests.commands
    .map((command) => command.command)
    .filter((command) => command.trim().length > 0);
  return ControlRunSummary.parse({
    jobId: rec.id,
    runId: rec.runId ?? rec.id,
    taskId: rec.taskId,
    state: rec.state,
    runDir: rec.runDir,
    error: rec.error,
    failure: readFailure(rec),
    project: projectMetadata(rec),
    mode: parsedMode.success ? parsedMode.data : undefined,
    strategy: strategyFromParams(p),
    prompt: typeof p["prompt"] === "string" ? redactPrompt(p["prompt"]) : undefined,
    harnesses: Array.isArray(p["harnesses"]) ? p["harnesses"].filter((x): x is string => typeof x === "string") : undefined,
    primaryHarness: typeof p["primaryHarness"] === "string" ? p["primaryHarness"] : undefined,
    portfolio: parsedPortfolio.success ? parsedPortfolio.data : undefined,
    model: typeof p["model"] === "string" ? p["model"] : undefined,
    reviewerPanel: parsedReviewerPanel?.success ? parsedReviewerPanel.data : undefined,
    protectedPathApprovals: parsedProtectedPathApprovals?.success
      ? parsedProtectedPathApprovals.data
      : undefined,
    n: typeof p["n"] === "number" ? p["n"] : undefined,
    // Engine-effective cap: the contract carries config-defaulted caps that
    // request params never knew about.
    maxUsd: typeof p["maxUsd"] === "number" ? p["maxUsd"] : task?.budget.max_usd ?? (p["maxUsd"] === null ? null : undefined),
    spendUsd: budget.spendUsd,
    spendEstimated: budget.estimated,
    access: effectiveAccess ?? parsedAccess,
    requestedAccess,
    effectiveAccess,
    externalContextPolicy,
    webRequired: telemetry?.web_required ?? task?.external_context.web_required,
    webMode: telemetry?.effective_web_mode ?? task?.external_context.effective_mode,
    webEvidence,
    toolPermissionPolicy: task?.tool_permission_policy,
    outputReadyState: outputReadyState(rec),
    toolWarningsTotal: telemetry?.tool_warnings_total ?? 0,
    result: controlRunResult(rec),
    route: controlRoute(telemetry, p),
    tests: requestTests ?? (contractTests?.length ? contractTests : undefined),
    specId: typeof p["specId"] === "string" ? p["specId"] : undefined,
    specHash: typeof p["specHash"] === "string" ? p["specHash"] : undefined,
    createdAt: rec.createdAt,
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
  });
}

/**
 * Project the orchestrator-owned telemetry artifact into the control DTO. The
 * control plane NEVER recomputes web evidence from raw events: a run without
 * `final/telemetry.yaml` (legacy or still running) renders `available: false`
 * so surfaces show "telemetry unavailable" instead of a recomputed guess.
 */
function controlWebEvidence(telemetry: RunTelemetry | null, task: TaskContract | null): ControlWebEvidence {
  if (!telemetry) {
    return ControlWebEvidence.parse({
      required: task?.external_context.web_required ?? false,
      mode: task?.external_context.policy ?? "auto",
      effectiveMode: task?.external_context.effective_mode ?? task?.external_context.policy ?? "auto",
      available: false,
    });
  }
  return ControlWebEvidence.parse({
    required: telemetry.web.required,
    mode: telemetry.web.policy,
    effectiveMode: telemetry.web.effective_mode,
    attempted: telemetry.web.attempted,
    satisfied: telemetry.web.satisfied,
    status: telemetry.web.status,
    tool: telemetry.web.tool,
    target: telemetry.web.target,
    errorSummary: telemetry.web.error_summary,
    rawDetailRef: "final/telemetry.yaml",
    available: true,
  });
}

/**
 * Run-level route evidence: observed model comes ONLY from telemetry (the
 * harness stream's own disclosure); the requested model from run params.
 * `verified` is never inferred from the request alone.
 */
function controlRoute(telemetry: RunTelemetry | null, p: Record<string, unknown>): ControlRouteInfo | null {
  if (!telemetry) return null;
  const finalAttempt = telemetry.final_attempt_id
    ? telemetry.attempts.find((a) => a.attempt_id === telemetry.final_attempt_id)
    : undefined;
  const observed = finalAttempt?.observed_model ?? telemetry.attempts.find((a) => a.observed_model)?.observed_model ?? null;
  const harnessId = finalAttempt?.harness_id ?? telemetry.attempts.find((a) => a.observed_model)?.harness_id ?? null;
  return {
    // Scalar-only by design until D13 (P4) adds per-candidate route evidence:
    // map-only pool members show requestedModel null here, honestly.
    requestedModel: typeof p["model"] === "string" ? p["model"] : null,
    observedModel: observed,
    harnessId,
    verified: observed !== null,
  };
}

function detailFor(rec: DaemonRunRecord, pendingInteractions: ControlPendingInteraction[] = [], cursor?: number): ControlRunDetail {
  // Snapshot fence: capture the event cursor BEFORE building any projection.
  // The fence promise is "every event with seq <= lastSeq is reflected" — a
  // cursor read AFTER the projections could skip an event that landed in
  // between (the projections would not reflect it, and a client resuming from
  // that cursor would never see it). A pre-projection cursor errs the other
  // way: an in-between event is both reflected AND replayed, which clients
  // absorb (event application is reconciled against the newer snapshot).
  const lastSeq = cursor ?? (rec.runDir ? lastSeqInFile(join(rec.runDir, "events.jsonl")) : 0);
  const failure = readFailure(rec);
  const decision = safeReadStructuredArtifact(rec, "arbitration/decision.yaml", DecisionRecord);
  // Project ONLY a VALID operator decision (action is an unblock AND patch-hash
  // matches the current patch) — same gate as the needs-human inbox — so a stale
  // or mutated operator_decision.yaml can't make a surface render an apply
  // affordance for a run the server still considers blocked.
  const operator = readValidOperatorDecision(rec);
  const operatorDecisionRaw = operator
    ? (() => {
        try {
          const doc = parseYaml(readTextArtifact(rec, "arbitration/operator_decision.yaml") ?? "") as Record<string, unknown> | null;
          return { action: operator.action, decidedAt: typeof doc?.["decided_at"] === "string" ? doc["decided_at"] : null };
        } catch {
          return { action: operator.action, decidedAt: null };
        }
      })()
    : null;
  const summary = summarizeRun(rec);
  return ControlRunDetail.parse({
    summary: { ...summary, waitingOnUser: pendingInteractions.length > 0 },
    lastSeq,
    artifacts: rec.runDir ? listArtifacts(rec.runDir) : [],
    primaryOutput: primaryOutput(rec),
    timeline: timelineEvents(rec),
    budget: budgetSnapshot(rec, decision),
    finalSummary: readTextArtifact(rec, "final/summary.md"),
    decision,
    operatorDecision: operatorDecisionRaw,
    workProduct: safeReadStructuredArtifact(rec, "final/work_product.yaml", WorkProduct),
    reviewFindings: readReviewFindings(rec),
    pendingInteractions,
    // Typed executor progress for an orchestrate auto_safe/auto_full run; null
    // for suggest / non-orchestrate runs. Thin projection of the engine artifact.
    orchestrate: safeReadStructuredArtifact(rec, "final/orchestration_progress.yaml", OrchestratePlanProgress),
    // Per-candidate evidence cards: projected from the run's attempt/
    // review artifacts; empty for single-envelope modes.
    candidates: rec.runDir ? candidatesFor(rec.runDir, decision) : [],
    // Live plan checklist: the winner's (else last) plan.progress items.
    planProgress: latestPlanProgress(rec, decision?.winner ?? null),
    failure,
  });
}

function readTextArtifact(rec: DaemonRunRecord, relPath: string, redact = true): string | null {
  const text = readRawTextArtifact(rec, relPath);
  return text === null ? null : redact ? redactSecrets(text) : text;
}

function readRawTextArtifact(rec: DaemonRunRecord, relPath: string): string | null {
  if (!rec.runDir) return null;
  const path = safeArtifactPath(rec.runDir, relPath);
  if (!path) return null;
  const st = lstatSync(path);
  if (st.isSymbolicLink() || st.isDirectory()) return null;
  return readFileSync(path, "utf8");
}

function primaryOutput(rec: DaemonRunRecord): ControlPrimaryOutput | null {
  const p = paramsRecord(rec);
  const mode = typeof p["mode"] === "string" ? p["mode"] : "";
  const candidates =
    mode === "ask"
      ? [{ kind: "answer" as const, path: "final/answer.md" }]
      : mode === "plan"
        ? [{ kind: "plan" as const, path: "final/plan.md" }]
        : mode === "audit"
          ? [
              { kind: "report" as const, path: "final/report.md" },
              { kind: "report" as const, path: "final/explore.md" },
              { kind: "summary" as const, path: "final/summary.md" },
            ]
          : mode === "orchestrate"
            ? [{ kind: "report" as const, path: "final/orchestration.md" }, { kind: "summary" as const, path: "final/summary.md" }]
            : [
                // An agent answer-only turn (empty diff + prose) writes final/answer.md;
                // it must win over the arbitration summary so the chat shows the answer,
                // not "# Run … no_op … Candidates …" (review #1).
                { kind: "answer" as const, path: "final/answer.md" },
                { kind: "summary" as const, path: "final/summary.md" },
                { kind: "patch" as const, path: "final/patch.diff" },
              ];
  for (const candidate of candidates) {
    const text = readTextArtifact(rec, candidate.path);
    if (text && text.trim()) {
      const bytes = Buffer.byteLength(text, "utf8");
      return ControlPrimaryOutput.parse({ ...candidate, text, bytes });
    }
  }
  const failure = readFailure(rec);
  if (failure) {
    return ControlPrimaryOutput.parse({
      kind: "diagnostic",
      path: failure.rawDetailRef ?? "final/failure.yaml",
      text: failure.safeMessage,
      bytes: Buffer.byteLength(failure.safeMessage, "utf8"),
    });
  }
  return null;
}

function outputReadyState(rec: DaemonRunRecord): "pending" | "finalizing" | "ready" | "diagnostic" {
  const primary = primaryOutput(rec);
  if (primary?.kind === "diagnostic") return "diagnostic";
  if (primary?.text && primary.text.trim()) return "ready";
  if (TERMINAL_STATES.has(rec.state)) return readFailure(rec) ? "diagnostic" : "finalizing";
  return "pending";
}

function parseAccessMaybe(value: unknown): AccessProfile | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = AccessProfile.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Typed severity per event type — no string matching over event names. */
function budgetSnapshot(rec: DaemonRunRecord, decision: DecisionRecord | null): ControlBudgetSnapshot {
  const p = paramsRecord(rec);
  // The ENGINE-EFFECTIVE cap lives in the immutable contract (request input,
  // surface default, or the configured global per-run default); request params
  // alone under-report a config-defaulted cap as "no cap".
  const contractCap = safeReadStructuredArtifact(rec, "context/task.yaml", TaskContract)?.budget.max_usd ?? null;
  const maxUsd = typeof p["maxUsd"] === "number" ? p["maxUsd"] : contractCap;
  let spendUsd = decision?.budget_summary?.spend_usd ?? null;
  let estimated = decision?.budget_summary?.estimated ?? false;
  let source: "decision" | "events" | "settings" | "unknown" = spendUsd === null ? "unknown" : "decision";
  if (spendUsd === null) {
    // budget.observation is the engine's authoritative spend stream (it covers
    // harness AND reviewer-panel spend, e.g. plan review which never writes a
    // decision record). Fall back to raw usage events only for legacy runs
    // that predate observations — never sum both (each usage cost is mirrored
    // as one observation).
    let observationSpend = 0;
    let sawObservation = false;
    let eventSpend = 0;
    let sawCost = false;
    let sawUsage = false;
    for (const ev of readRunEvents(rec)) {
      const payload = eventPayload(ev);
      if (ev["type"] === "budget.observation" && payload["kind"] === "spend") {
        const usd = payload["usd"];
        if (typeof usd === "number" && Number.isFinite(usd)) {
          observationSpend += usd;
          sawObservation = true;
        }
        if (payload["estimated"] === true) estimated = true;
        continue;
      }
      if (ev["type"] !== "harness.event") continue;
      const usage = payload["usage"];
      if (usage && typeof usage === "object" && !Array.isArray(usage)) {
        sawUsage = true;
        const cost = (usage as Record<string, unknown>)["cost_usd"];
        if (typeof cost === "number" && Number.isFinite(cost)) {
          eventSpend += cost;
          sawCost = true;
        }
        if ((usage as Record<string, unknown>)["estimated"] === true) estimated = true;
      }
    }
    if (sawObservation) {
      spendUsd = observationSpend;
      source = "events";
    } else if (sawCost) {
      spendUsd = eventSpend;
      source = "events";
    } else if (sawUsage) {
      source = "events";
    }
  }
  const remainingUsd = maxUsd !== null && spendUsd !== null ? Math.max(0, maxUsd - spendUsd) : null;
  return ControlBudgetSnapshot.parse({ maxUsd, spendUsd, remainingUsd, estimated, source });
}





function readStructured<T>(text: string | null, ext: string, schema: { parse(value: unknown): T }): T | null {
  if (text === null) return null;
  if (ext === ".json") {
    return schema.parse(JSON.parse(text));
  }
  if (ext === ".yaml" || ext === ".yml") {
    return schema.parse(parseYaml(text));
  }
  throw new Error(`unsupported structured artifact extension: ${ext}`);
}

function listArtifacts(root: string): ControlArtifactInfo[] {
  const safeRoot = safeArtifactRoot(root);
  if (!safeRoot) return [];
  const out: ControlArtifactInfo[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      const rel = relative(safeRoot, abs).split(sep).join("/");
      out.push({ path: rel, kind: st.isDirectory() ? "directory" : "file", bytes: st.isDirectory() ? undefined : st.size, mime: st.isDirectory() ? undefined : artifactMime(rel) });
      if (st.isDirectory()) walk(abs);
    }
  };
  walk(safeRoot);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}


/** A run's project root, taken from its TYPED scope — NOT by path-slicing the
 *  runDir. Slicing on `.claudexor` would resolve a no-project run (whose run dir
 *  is `~/.claudexor/runs/<id>`) to the user's HOME and let /produced list
 *  `~/artifacts` (review-flagged). Null for scope `none` ⇒ no produced outputs. */
export function producedRepoRoot(rec: DaemonRunRecord): string | null {
  const scope = (rec.params as { scope?: { kind?: string; root?: string } } | undefined)?.scope;
  return scope?.kind === "project" && typeof scope.root === "string" && scope.root.trim() ? scope.root : null;
}


function readPatch(rec: DaemonRunRecord): string | null {
  return readRawTextArtifact(rec, "final/patch.diff");
}

function runRepoRoot(rec: DaemonRunRecord): string | null {
  const p = paramsRecord(rec);
  const scope = p["scope"];
  if (scope && typeof scope === "object" && !Array.isArray(scope)) {
    const s = scope as Record<string, unknown>;
    if (s["kind"] === "project" && typeof s["root"] === "string") return s["root"];
    if (s["kind"] === "none") return NO_PROJECT_ROOT;
  }
  let task: unknown = null;
  try {
    task = readStructured(readRawTextArtifact(rec, "context/task.yaml"), ".yaml", { parse: (value: unknown) => value });
  } catch {
    task = null;
  }
  if (task && typeof task === "object" && !Array.isArray(task)) {
    const repo = (task as Record<string, unknown>)["repo"];
    if (repo && typeof repo === "object" && !Array.isArray(repo)) {
      const root = (repo as Record<string, unknown>)["root"];
      if (typeof root === "string") return root;
    }
  }
  return null;
}

function applyTargetRoot(target: ControlApplyCheckRequest["target"] | ControlApplyRequest["target"], rec: DaemonRunRecord): string | null {
  if (target.kind === "project") return target.root;
  return runRepoRoot(rec);
}

/** Project the run record into the delivery package's single-owner apply gate. */
function applyGateError(rec: DaemonRunRecord, patch: string, targetRepoRoot: string): string | null {
  return validateApplyGate({
    state: rec.state,
    decision: safeReadStructuredArtifact(rec, "arbitration/decision.yaml", DecisionRecord),
    workProduct: safeReadStructuredArtifact(rec, "final/work_product.yaml", WorkProduct),
    patch,
    originalRepoRoot: runRepoRoot(rec),
    targetRepoRoot,
    operatorDecision: readOperatorDecision(rec),
  });
}

/**
 * SINGLE writer of the operator unblock artifact. Every accept_risk /
 * override decision routes through here so the on-disk shape and the path
 * resolution (server-fixed name, validated run-dir root) exist in exactly one
 * place — the mirror of readOperatorDecision below. Returns false when the run
 * artifact root cannot be resolved (caller fails loudly). */
function writeOperatorDecision(
  rec: DaemonRunRecord,
  record: { action: string; finding_ids: string[]; accepted_risks: string[]; patch_sha256: string; decided_at: string },
): boolean {
  // The artifact name is server-fixed (no client path input); only the run dir
  // root needs validating before the write.
  const root = rec.runDir ? safeArtifactRoot(rec.runDir) : null;
  if (!root) return false;
  mkdirSync(join(root, "arbitration"), { recursive: true });
  writeFileSync(join(root, "arbitration", "operator_decision.yaml"), stringifyYaml(record), "utf8");
  return true;
}

/** The persisted operator unblock decision (accept_risk / override), if any. */
function readOperatorDecision(rec: DaemonRunRecord): { action: string; patch_sha256?: string } | null {
  try {
    const raw = readTextArtifact(rec, "arbitration/operator_decision.yaml");
    if (!raw) return null;
    const doc = parseYaml(raw) as Record<string, unknown> | null;
    if (!doc || typeof doc["action"] !== "string") return null;
    return { action: doc["action"], patch_sha256: typeof doc["patch_sha256"] === "string" ? doc["patch_sha256"] : undefined };
  } catch {
    return null;
  }
}

/**
 * A VALID operator unblock decision: the action is a genuine unblock
 * (accept_risk / override_needs_human) AND its recorded patch_sha256 still
 * matches the current final/patch.diff. Used to clear the needs-human inbox —
 * mirrors the apply gate (delivery validateApplyGate) so a mutated decision
 * artifact or a mutated patch can NEVER silently hide a blocked run from the
 * operator. Returns null when the decision is absent, the wrong action, or stale.
 */
function readValidOperatorDecision(rec: DaemonRunRecord): { action: string; patch_sha256?: string } | null {
  const decision = readOperatorDecision(rec);
  if (!decision) return null;
  if (decision.action !== "accept_risk" && decision.action !== "override_needs_human") return null;
  if (typeof decision.patch_sha256 !== "string" || decision.patch_sha256.length === 0) return null;
  const patch = readTextArtifact(rec, "final/patch.diff", false);
  if (patch === null || decision.patch_sha256 !== sha256(patch)) return null;
  return decision;
}

function safeReadStructuredArtifact<T>(rec: DaemonRunRecord, relPath: string, schema: { parse(value: unknown): T }): T | null {
  try {
    return readStructured(readTextArtifact(rec, relPath), extname(relPath), schema);
  } catch {
    return null;
  }
}

function readReviewFindings(rec: DaemonRunRecord): ReviewFinding[] {
  if (!rec.runDir) return [];
  const reviewsDir = safeArtifactPath(rec.runDir, "reviews");
  if (!reviewsDir || !lstatSync(reviewsDir).isDirectory()) return [];
  const out: ReviewFinding[] = [];
  for (const name of readdirSync(reviewsDir).sort()) {
    const ext = extname(name);
    if (ext !== ".yaml" && ext !== ".yml" && ext !== ".json") continue;
    try {
      const rel = `reviews/${name}`;
      const raw = readTextArtifact(rec, rel);
      if (!raw) continue;
      const doc = ext === ".json" ? JSON.parse(raw) : parseYaml(raw);
      const findings = doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>)["findings"] : [];
      if (!Array.isArray(findings)) continue;
      for (const finding of findings) out.push(ReviewFinding.parse(finding));
    } catch {
      /* malformed review artifact: omit from UI projection, artifact remains fetchable for diagnostics */
    }
  }
  return out;
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".json": return "application/json; charset=utf-8";
    case ".md":
    case ".txt":
    case ".jsonl":
    case ".log":
    case ".diff":
    case ".patch":
    case ".yaml":
    case ".yml": return "text/plain; charset=utf-8";
    case ".html":
    case ".htm": return "text/html; charset=utf-8";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    case ".pdf": return "application/pdf";
    default: return "application/octet-stream";
  }
}

/** Clean MIME (no charset) for the artifact listing DTO. */
function artifactMime(path: string): string {
  return contentType(path).split(";")[0] as string;
}

function isPatchArtifact(path: string): boolean {
  const ext = extname(path);
  return ext === ".diff" || ext === ".patch";
}

function isTextArtifact(path: string): boolean {
  const type = contentType(path);
  return type.startsWith("text/") || type.startsWith("application/json");
}

// Single allowlist shared with the CLI — includes claude_oauth, which
// the claude adapter reads for subscription-route auth.
function isAllowedSecretName(name: string): boolean {
  return isManagedSecretName(name);
}

function validSecretSetBody(body: unknown): boolean {
  return Boolean(
    body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      typeof (body as Record<string, unknown>)["name"] === "string" &&
      isAllowedSecretName(String((body as Record<string, unknown>)["name"])),
  );
}

function assertNoSpecBodySecrets(body: unknown): void {
  assertNoInlineSecretValues(body, "$", "spec body");
  const serialized = JSON.stringify(body ?? null);
  if (containsSecretLikeToken(serialized)) {
    throw Object.assign(new Error("secret-like value is not accepted in spec body; store secrets by ref and keep specs durable/sanitized"), { status: 400 });
  }
}

function redactPrompt(prompt: string): string {
  const redacted = redactSecrets(prompt);
  return redacted.length > 240 ? `${redacted.slice(0, 240)}...` : redacted;
}
