import { timingSafeEqual } from "node:crypto";
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { basename, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { checkPatch, deliver, validateApplyGate } from "@claudexor/delivery";
import { appendRunEvent, lastSeqInFile } from "@claudexor/event-log";
import {
  AccessProfile,
  ControlWebEvidence,
  ControlApplyCheckRequest,
  ControlApplyRequest,
  ControlHarnessSetupRequest,
  ControlHarnessSetupResponse,
  ControlHarnessListResponse,
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
  type ControlArtifactInfo,
  ControlRunDetail,
  ControlRunSummary,
  ControlPrimaryOutput,
  ControlTimelineEvent,
  ControlBudgetSnapshot,
  ControlSettingsSnapshot,
  ControlSettingsUpdateRequest,
  ControlInteractionAnswerRequest,
  ControlInteractionAnswerResponse,
  type ControlPendingInteraction,
  type ControlRouteInfo,
  DecisionRecord,
  ModeKind,
  Portfolio,
  ReviewFinding,
  RunEventType,
  RunFailure,
  RunTelemetry,
  TaskContract,
  WorkProduct,
} from "@claudexor/schema";
import { assertNoInlineSecretValues, containsSecretLikeToken, noProjectRepoRoot, nowIso, redactSecrets } from "@claudexor/util";
import { parse as parseYaml } from "yaml";

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
    setupHarness?: (input: unknown) => Promise<unknown>;
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
  };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const TERMINAL_STATES = new Set(["succeeded", "no_op", "ungated", "review_not_run", "blocked", "failed", "cancelled", "interrupted", "exhausted", "not_converged"]);
/** Artifact fetch cap: large logs are read from disk, not streamed through the facade. */
const MAX_ARTIFACT_FETCH_BYTES = 4 * 1024 * 1024;
/** Timeline projection cap (with explicit truncation marker). */
const TIMELINE_EVENTS_MAX = 250;
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
      const job = await this.opts.daemon.enqueue(params);
      const rec = await this.waitForRunStart(job.id);
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
        runs: runs.map((r) => this.summarizeRunLive(r)),
      });
    }

    const runDetailMatch = /^\/runs\/([^/]+)$/.exec(path);
    if (method === "GET" && runDetailMatch) {
      const rec = await this.findRun(decodeURIComponent(runDetailMatch[1] as string));
      if (!rec) return this.json(res, 404, { error: "no such run" });
      return this.json(res, 200, detailFor(rec, this.pendingInteractionsFor(rec)));
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
      const stats = lstatSync(target);
      if (stats.size > MAX_ARTIFACT_FETCH_BYTES) {
        return this.json(res, 413, {
          error: `artifact is ${stats.size} bytes (limit ${MAX_ARTIFACT_FETCH_BYTES}); read it from disk at ${target}`,
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

    if (method === "GET" && path === "/harnesses") return this.service(res, "harnesses", undefined, ControlHarnessListResponse);
    if (method === "POST" && path === "/harnesses/setup") {
      let body: ControlHarnessSetupRequest;
      try {
        const raw = await this.readBody(req);
        assertNoInlineSecretValues(raw);
        body = ControlHarnessSetupRequest.parse(raw);
      } catch (err) {
        const status = err && typeof err === "object" && "status" in err ? Number((err as { status: number }).status) : 400;
        return this.json(res, status, { error: err instanceof Error ? err.message : "bad request" });
      }
      return this.service(res, "setupHarness", body, ControlHarnessSetupResponse);
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
      if (!validSecretSetBody(body)) return this.json(res, 400, { error: "secret name must be openai, anthropic, cursor, opencode, or raw" });
      return this.service(res, "setSecret", body);
    }
    const secretDeleteMatch = /^\/secrets\/([^/]+)$/.exec(path);
    if (method === "DELETE" && secretDeleteMatch) {
      const name = decodeURIComponent(secretDeleteMatch[1] as string);
      if (!isAllowedSecretName(name)) return this.json(res, 400, { error: "secret name must be openai, anthropic, cursor, opencode, or raw" });
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
    if (!rec?.runDir) return this.json(res, 404, { error: "no such run" });
    const eventsPath = join(rec.runDir, "events.jsonl");
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
      if (closed || draining || !existsSync(eventsPath)) return;
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

function paramsRecord(rec: DaemonRunRecord): Record<string, unknown> {
  return rec.params && typeof rec.params === "object" && !Array.isArray(rec.params) ? (rec.params as Record<string, unknown>) : {};
}

function normalizeRunStart(parsed: ControlRunStartRequest): ControlRunStartRequest {
  const mode = parsed.mode ?? "agent";
  // Validate BEFORE enqueue (ARCHITECTURE §5): a contradictory web policy must
  // 400 here, not persist a doomed job for the orchestrator to reject later.
  if (parsed.web && parsed.externalContextPolicy && parsed.web !== parsed.externalContextPolicy) {
    throw Object.assign(
      new Error(`contradictory web policy: web='${parsed.web}' vs externalContextPolicy='${parsed.externalContextPolicy}' (pass one, or equal values)`),
      { status: 400 },
    );
  }
  // Live (in-place) isolation is only honored by convergence modes; accepting
  // it elsewhere would silently run an envelope while claiming live semantics.
  if (parsed.execution?.isolation === "live" && mode !== "max_attempts" && mode !== "until_clean") {
    throw Object.assign(
      new Error(`execution.isolation='live' is only supported for convergence modes (max_attempts|until_clean), not '${mode}'`),
      { status: 400 },
    );
  }
  if (parsed.scope.kind === "project") {
    const repoRoot = parsed.scope.root.trim();
    const absoluteRepoError = validateAbsoluteRepoRoot(repoRoot);
    if (absoluteRepoError) throw Object.assign(new Error(absoluteRepoError), { status: 400 });
    // Existence is the only filesystem precondition here: a NON-GIT folder is
    // fine — write modes initialize the git boundary themselves (announced via
    // the project.git.initialized run event).
    if (!existsSync(repoRoot) || !lstatSync(repoRoot).isDirectory()) {
      throw Object.assign(new Error(`project root does not exist or is not a directory: ${repoRoot}`), { status: 400 });
    }
    return { ...parsed, scope: { kind: "project", root: repoRoot, context: parsed.scope.context ?? "auto" } };
  }
  if (mode === "ask") {
    mkdirSync(NO_PROJECT_ROOT, { recursive: true, mode: 0o700 });
    return parsed;
  }
  throw Object.assign(new Error(`project scope is required for mode '${mode}'`), { status: 400 });
}

/**
 * Single owner of run-start normalization. Both entry paths (HTTP control API
 * and the daemon socket runner) MUST use this so scope/secret/absolute-root
 * acceptance can never drift between surfaces.
 */
export function normalizeRunStartRequest(raw: unknown): ControlRunStartRequest {
  assertNoInlineSecretValues(raw);
  return normalizeRunStart(ControlRunStartRequest.parse(raw ?? {}));
}

function projectMetadata(rec: DaemonRunRecord): { kind: "project" | "none"; root: string | null; projectName: string | null; context: "off" | "auto" | "deep" } {
  const p = paramsRecord(rec);
  const scope = p["scope"];
  if (scope && typeof scope === "object" && !Array.isArray(scope)) {
    const s = scope as Record<string, unknown>;
    if (s["kind"] === "none") return { kind: "none", root: null, projectName: null, context: "off" };
    if (s["kind"] === "project" && typeof s["root"] === "string") {
      const context = s["context"] === "deep" ? "deep" : "auto";
      return { kind: "project", root: s["root"], projectName: basename(s["root"]), context };
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
  ].join("|");
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
    prompt: typeof p["prompt"] === "string" ? redactPrompt(p["prompt"]) : undefined,
    harnesses: Array.isArray(p["harnesses"]) ? p["harnesses"].filter((x): x is string => typeof x === "string") : undefined,
    primaryHarness: typeof p["primaryHarness"] === "string" ? p["primaryHarness"] : undefined,
    portfolio: parsedPortfolio.success ? parsedPortfolio.data : undefined,
    model: typeof p["model"] === "string" ? p["model"] : undefined,
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
    route: controlRoute(telemetry, p),
    tests: Array.isArray(p["tests"]) ? p["tests"].filter((x): x is string => typeof x === "string") : undefined,
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
    requestedModel: typeof p["model"] === "string" ? p["model"] : null,
    observedModel: observed,
    harnessId,
    verified: observed !== null,
  };
}

function detailFor(rec: DaemonRunRecord, pendingInteractions: ControlPendingInteraction[] = []): ControlRunDetail {
  const failure = readFailure(rec);
  const decision = safeReadStructuredArtifact(rec, "arbitration/decision.yaml", DecisionRecord);
  const summary = summarizeRun(rec);
  return ControlRunDetail.parse({
    summary: { ...summary, waitingOnUser: pendingInteractions.length > 0 },
    // Snapshot fence: every event with seq <= lastSeq is reflected above, so a
    // client subscribing from this cursor gets gap-free, duplicate-free state.
    lastSeq: rec.runDir ? lastSeqInFile(join(rec.runDir, "events.jsonl")) : 0,
    artifacts: rec.runDir ? listArtifacts(rec.runDir) : [],
    primaryOutput: primaryOutput(rec),
    timeline: timelineEvents(rec),
    budget: budgetSnapshot(rec, decision),
    finalSummary: readTextArtifact(rec, "final/summary.md"),
    decision,
    workProduct: safeReadStructuredArtifact(rec, "final/work_product.yaml", WorkProduct),
    reviewFindings: readReviewFindings(rec),
    pendingInteractions,
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
        : mode === "explore"
          ? [{ kind: "report" as const, path: "final/explore.md" }, { kind: "summary" as const, path: "final/summary.md" }]
          : mode === "readonly_audit"
            ? [{ kind: "report" as const, path: "final/report.md" }, { kind: "summary" as const, path: "final/summary.md" }]
            : [
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
const WARNING_EVENT_TYPES = new Set([
  "route.fallback.started",
  "route.fallback.exhausted",
  "policy.web.upgraded",
  "run.blocked",
]);
const ERROR_EVENT_TYPES = new Set(["run.failed", "reviewer.failed", "reviewer.timed_out"]);

function timelineEvents(rec: DaemonRunRecord): ControlTimelineEvent[] {
  const out: ControlTimelineEvent[] = [];
  for (const ev of readRunEvents(rec)) {
    const payload = eventPayload(ev);
    const type = String(ev["type"] ?? "event");
    // Typed tool info travels on the normalized HarnessEvent `tool` field.
    const tool = payload["tool"] && typeof payload["tool"] === "object" && !Array.isArray(payload["tool"])
      ? (payload["tool"] as Record<string, unknown>)
      : {};
    const harnessId = stringOrNull(payload["harness_id"] ?? payload["harness"]);
    const attemptId = stringOrNull(payload["attempt_id"] ?? payload["attemptId"]);
    const title = stringOrNull(payload["title"] ?? payload["message"] ?? payload["summary"] ?? payload["text"] ?? payload["error"]) ?? prettyEventType(type);
    const errorSummary = stringOrNull(tool["error_summary"] ?? payload["error"]);
    const detail = stringOrNull(payload["detail"] ?? payload["text"] ?? payload["error"]) ?? stringOrNull(tool["content_summary"]) ?? errorSummary;
    const toolName = stringOrNull(tool["name"]);
    const target = stringOrNull(tool["target"]);
    const severity = payload["error"] || tool["status"] === "error" || ERROR_EVENT_TYPES.has(type)
      ? "error"
      : WARNING_EVENT_TYPES.has(type)
        ? "warning"
        : "info";
    out.push(ControlTimelineEvent.parse({
      type,
      ts: typeof ev["ts"] === "string" ? ev["ts"] : undefined,
      harnessId,
      attemptId,
      title,
      detail,
      severity,
      toolName,
      target,
      errorSummary,
      rawRef: "events.jsonl",
    }));
  }
  // Bounded projection with an EXPLICIT truncation marker — no silent truncation.
  if (out.length > TIMELINE_EVENTS_MAX) {
    const omitted = out.length - TIMELINE_EVENTS_MAX;
    const tail = out.slice(-TIMELINE_EVENTS_MAX);
    tail.unshift(
      ControlTimelineEvent.parse({
        type: "timeline.truncated",
        title: `${omitted} earlier event(s) omitted from this projection`,
        detail: "Full history remains in events.jsonl.",
        severity: "info",
        rawRef: "events.jsonl",
      }),
    );
    return tail;
  }
  return out;
}

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

function readRunEvents(rec: DaemonRunRecord): Record<string, unknown>[] {
  const raw = readRawTextArtifact(rec, "events.jsonl");
  if (!raw) return [];
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) out.push(obj as Record<string, unknown>);
    } catch {
      /* malformed line remains in events.jsonl; omit from projections */
    }
  }
  return out;
}

function eventPayload(ev: Record<string, unknown>): Record<string, unknown> {
  return ev["payload"] && typeof ev["payload"] === "object" && !Array.isArray(ev["payload"])
    ? (ev["payload"] as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? redactSecrets(value) : null;
}

function prettyEventType(type: string): string {
  return type.replace(/\./g, " · ").replace(/_/g, " ");
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
      out.push({ path: rel, kind: st.isDirectory() ? "directory" : "file", bytes: st.isDirectory() ? undefined : st.size });
      if (st.isDirectory()) walk(abs);
    }
  };
  walk(safeRoot);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function safeArtifactPath(root: string, requested: string): string | null {
  if (requested.includes("\0")) return null;
  const parts = requested.split(/[\\/]+/).filter(Boolean);
  if (parts.includes("..")) return null;
  const base = safeArtifactRoot(root);
  if (!base) return null;
  const clean = normalize(parts.join(sep));
  const abs = resolve(base, clean);
  if (!existsSync(abs)) return null;
  const lst = lstatSync(abs);
  if (lst.isSymbolicLink()) return null;
  const real = realpathSync(abs);
  return real === base || real.startsWith(base + sep) ? real : null;
}

function safeArtifactRoot(root: string): string | null {
  if (!root || !existsSync(root)) return null;
  const st = lstatSync(root);
  if (st.isSymbolicLink() || !st.isDirectory()) return null;
  return realpathSync(root);
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
  });
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
  switch (extname(path)) {
    case ".json": return "application/json; charset=utf-8";
    case ".md":
    case ".txt":
    case ".jsonl":
    case ".log":
    case ".diff":
    case ".patch":
    case ".yaml":
    case ".yml": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

function isPatchArtifact(path: string): boolean {
  const ext = extname(path);
  return ext === ".diff" || ext === ".patch";
}

function isTextArtifact(path: string): boolean {
  const type = contentType(path);
  return type.startsWith("text/plain") || type.startsWith("application/json");
}

function validateAbsoluteRepoRoot(repoRoot: string): string | null {
  return isAbsolute(repoRoot) ? null : "project root must be an absolute path";
}

const ALLOWED_SECRET_NAMES = new Set(["openai", "anthropic", "cursor", "opencode", "raw"]);

function isAllowedSecretName(name: string): boolean {
  return ALLOWED_SECRET_NAMES.has(name);
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
