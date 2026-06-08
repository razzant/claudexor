import { timingSafeEqual } from "node:crypto";
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { basename, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { checkPatch, deliver } from "@claudex/delivery";
import {
  AccessProfile,
  ControlApplyCheckRequest,
  ControlApplyRequest,
  ControlHarnessSetupRequest,
  ControlHarnessSetupResponse,
  ControlHarnessListResponse,
  ControlSecretListResponse,
  ControlRunStartRequest,
  ControlRunStartInfo,
  ControlQueuedRunInfo,
  ControlRunControlRequest,
  ControlRunControlResponse,
  ControlRunInputRequest,
  type ControlArtifactInfo,
  ControlRunDetail,
  ControlRunSummary,
  ControlSettingsSnapshot,
  ControlSettingsUpdateRequest,
  DecisionRecord,
  ModeKind,
  Portfolio,
  ReviewFinding,
  RunEvent,
  RunFailure,
  WorkProduct,
} from "@claudex/schema";
import { assertNoInlineSecretValues, containsSecretLikeToken, noProjectRepoRoot, nowIso, redactSecrets, sha256 } from "@claudex/util";
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
  runStartTimeoutMs?: number;
  services?: {
    harnesses?: () => Promise<unknown>;
    setupHarness?: (input: unknown) => Promise<unknown>;
    settings?: () => Promise<unknown>;
    updateSettings?: (patch: unknown) => Promise<unknown>;
    auth?: () => Promise<unknown>;
    listSecrets?: () => Promise<unknown>;
    setSecret?: (input: unknown) => Promise<unknown>;
    deleteSecret?: (name: string) => Promise<unknown>;
    specQuestions?: (input: unknown) => Promise<unknown>;
    specFreeze?: (input: unknown) => Promise<unknown>;
  };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "interrupted", "exhausted", "not_converged"]);
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
 * the canonical `.claudex/runs/<runId>/events.jsonl` file.
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
      if (!res.headersSent) this.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
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
        runs: runs.map((r) => summarizeRun(r)),
      });
    }

    const runDetailMatch = /^\/runs\/([^/]+)$/.exec(path);
    if (method === "GET" && runDetailMatch) {
      const rec = await this.findRun(decodeURIComponent(runDetailMatch[1] as string));
      if (!rec) return this.json(res, 404, { error: "no such run" });
      return this.json(res, 200, detailFor(rec));
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
      const applyableError = validateApplyableRun(rec);
      if (applyableError) return this.json(res, 409, { error: applyableError });
      const patchBindingError = validatePatchBinding(rec, patch);
      if (patchBindingError) return this.json(res, 409, { error: patchBindingError });
      const repoRoot = body.repoRoot ?? runRepoRoot(rec);
      if (!repoRoot) return this.json(res, 400, { error: "repoRoot is required for apply check" });
      const absoluteRepoError = validateAbsoluteRepoRoot(repoRoot);
      if (absoluteRepoError) return this.json(res, 400, { error: absoluteRepoError });
      const repoError = validateApplyRepo(rec, repoRoot);
      if (repoError) return this.json(res, 409, { error: repoError });
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
      const applyableError = validateApplyableRun(rec);
      if (applyableError) return this.json(res, 409, { error: applyableError });
      const patchBindingError = validatePatchBinding(rec, patch);
      if (patchBindingError) return this.json(res, 409, { error: patchBindingError });
      const repoRoot = body.repoRoot ?? runRepoRoot(rec);
      if (!repoRoot) return this.json(res, 400, { error: "repoRoot is required for apply" });
      const absoluteRepoError = validateAbsoluteRepoRoot(repoRoot);
      if (absoluteRepoError) return this.json(res, 400, { error: absoluteRepoError });
      const repoError = validateApplyRepo(rec, repoRoot);
      if (repoError) return this.json(res, 409, { error: repoError });
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
    if (method === "GET" && path === "/auth") return this.service(res, "auth");
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
        const body = await this.readBody(req);
        assertNoSpecBodySecrets(body);
        return this.service(res, "specQuestions", body);
      } catch (err) {
        const status = err && typeof err === "object" && "status" in err ? Number((err as { status: number }).status) : 400;
        return this.json(res, status, { error: err instanceof Error ? err.message : "bad request" });
      }
    }
    if (method === "POST" && path === "/spec/freeze") {
      try {
        const body = await this.readBody(req);
        assertNoSpecBodySecrets(body);
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
      if (body.control.kind === "cancel" || body.control.kind === "interrupt") {
        appendRunAuditEvent(rec, "control.requested", { control: body.control });
        await this.opts.daemon.cancel(rec.id);
        appendRunAuditEvent(rec, "control.applied", { control: body.control });
        return this.json(res, 200, ControlRunControlResponse.parse({
          accepted: true,
          status: "applied",
          runId: rec.runId ?? rec.id,
          message: `${body.control.kind} requested`,
        }));
      }
      appendRunAuditEvent(rec, "control.rejected", { control: body.control, reason: "unsupported" });
      return this.json(res, 409, ControlRunControlResponse.parse({
        accepted: false,
        status: "unsupported",
        runId: rec.runId ?? rec.id,
        message: `control '${body.control.kind}' is not supported by this run yet`,
      }));
    }

    const inputMatch = /^\/runs\/([^/]+)\/input$/.exec(path);
    if (method === "POST" && inputMatch) {
      const rec = await this.findRun(decodeURIComponent(inputMatch[1] as string));
      if (!rec) return this.json(res, 404, { error: "no such run" });
      try {
        const raw = await this.readBody(req);
        assertNoInlineSecretValues(raw);
        const body = ControlRunInputRequest.parse(raw);
        appendRunAuditEvent(rec, "input.received", { input: body.input });
      } catch (err) {
        const status = err && typeof err === "object" && "status" in err ? Number((err as { status: number }).status) : 400;
        return this.json(res, status, { error: err instanceof Error ? err.message : "bad request" });
      }
      appendRunAuditEvent(rec, "control.rejected", { input: true, reason: "unsupported" });
      return this.json(res, 409, ControlRunControlResponse.parse({
        accepted: false,
        status: "unsupported",
        runId: rec.runId ?? rec.id,
        message: "live input is not supported by this run yet",
      }));
    }

    const cancelMatch = /^\/runs\/([^/]+)\/cancel$/.exec(path);
    if (method === "POST" && cancelMatch) {
      const rec = await this.findRun(decodeURIComponent(cancelMatch[1] as string));
      if (!rec) return this.json(res, 404, { error: "no such run" });
      await this.opts.daemon.cancel(rec.id);
      return this.json(res, 200, { runId: rec.runId ?? rec.id, jobId: rec.id, cancelled: true });
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
      return this.json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
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

    let lineSeq = 0;
    let offset = 0;
    let carry = "";
    let closed = false;
    const cleanup = () => {
      closed = true;
      clearInterval(timer);
      this.sseClients.delete(res);
    };
    const writeAvailable = async () => {
      if (closed || !existsSync(eventsPath)) return;
      const { lines, nextOffset, rest } = readNewLines(eventsPath, offset, carry);
      offset = nextOffset;
      carry = rest;
      for (const raw of lines) {
        const seq = ++lineSeq;
        if (seq <= lastEventId) continue;
        let type = "run";
        try {
          type = String((JSON.parse(raw) as { type?: string }).type ?? "run");
        } catch {
          type = "malformed";
        }
        res.write(`id: ${seq}\nevent: ${type}\ndata: ${raw}\n\n`);
        if (type === "run.completed" || type === "run.failed") {
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
    };
    const timer = setInterval(() => void writeAvailable(), this.opts.pollMs ?? 250);
    timer.unref?.();
    req.on("close", cleanup);
    res.on("close", cleanup);
    await writeAvailable();
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
  const repoRoot = parsed.repoRoot?.trim();
  if (repoRoot) {
    const absoluteRepoError = validateAbsoluteRepoRoot(repoRoot);
    if (absoluteRepoError) throw Object.assign(new Error(absoluteRepoError), { status: 400 });
    if (parsed.contextMode === "off") {
      throw Object.assign(new Error("contextMode 'off' is only supported for Ask without a repoRoot"), { status: 400 });
    }
    return { ...parsed, repoRoot, contextMode: parsed.contextMode ?? "auto" };
  }
  if (mode === "ask") {
    mkdirSync(NO_PROJECT_ROOT, { recursive: true, mode: 0o700 });
    return { ...parsed, repoRoot: NO_PROJECT_ROOT, contextMode: "off" };
  }
  throw Object.assign(new Error(`repoRoot is required for mode '${mode}'`), { status: 400 });
}

function projectMetadata(rec: DaemonRunRecord): { repoRoot: string | null; projectName: string | null; contextMode: "off" | "auto" | "deep" } {
  const p = paramsRecord(rec);
  const repoRoot = typeof p["repoRoot"] === "string" ? p["repoRoot"] : runRepoRoot(rec);
  const contextMode = p["contextMode"] === "off" || p["contextMode"] === "deep" || p["contextMode"] === "auto" ? p["contextMode"] : "auto";
  const noProject = contextMode === "off" && repoRoot === NO_PROJECT_ROOT;
  return {
    repoRoot: noProject ? null : repoRoot,
    projectName: noProject || !repoRoot ? null : basename(repoRoot),
    contextMode,
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

function appendRunAuditEvent(rec: DaemonRunRecord, type: string, payload: Record<string, unknown>): void {
  if (!rec.runDir) return;
  try {
    const redactedPayload = JSON.parse(redactSecrets(JSON.stringify(payload))) as Record<string, unknown>;
    const event = RunEvent.parse({
      ts: nowIso(),
      run_id: rec.runId ?? rec.id,
      task_id: rec.taskId ?? "unknown",
      type,
      payload: redactedPayload,
    });
    appendFileSync(join(rec.runDir, "events.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 });
  } catch {
    /* audit append must not change control behavior */
  }
}

function summarizeRun(rec: DaemonRunRecord): ControlRunSummary {
  const p = paramsRecord(rec);
  const parsedMode = typeof p["mode"] === "string" ? ModeKind.parse(p["mode"]) : undefined;
  const parsedPortfolio = typeof p["portfolio"] === "string" ? Portfolio.parse(p["portfolio"]) : undefined;
  const parsedAccess = typeof p["access"] === "string" ? AccessProfile.parse(p["access"]) : undefined;
  return ControlRunSummary.parse({
    jobId: rec.id,
    runId: rec.runId ?? rec.id,
    taskId: rec.taskId,
    state: rec.state,
    runDir: rec.runDir,
    error: rec.error,
    failure: readFailure(rec),
    project: projectMetadata(rec),
    mode: parsedMode,
    prompt: typeof p["prompt"] === "string" ? redactPrompt(p["prompt"]) : undefined,
    harnesses: Array.isArray(p["harnesses"]) ? p["harnesses"].filter((x): x is string => typeof x === "string") : undefined,
    primaryHarness: typeof p["primaryHarness"] === "string" ? p["primaryHarness"] : undefined,
    portfolio: parsedPortfolio,
    model: typeof p["model"] === "string" ? p["model"] : undefined,
    n: typeof p["n"] === "number" ? p["n"] : undefined,
    maxUsd: typeof p["maxUsd"] === "number" || p["maxUsd"] === null ? (p["maxUsd"] as number | null) : undefined,
    access: parsedAccess,
    tests: Array.isArray(p["tests"]) ? p["tests"].filter((x): x is string => typeof x === "string") : undefined,
    specId: typeof p["specId"] === "string" ? p["specId"] : undefined,
    specHash: typeof p["specHash"] === "string" ? p["specHash"] : undefined,
    createdAt: rec.createdAt,
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
  });
}

function detailFor(rec: DaemonRunRecord): ControlRunDetail {
  const failure = readFailure(rec);
  return ControlRunDetail.parse({
    summary: summarizeRun(rec),
    artifacts: rec.runDir ? listArtifacts(rec.runDir) : [],
    finalSummary: readTextArtifact(rec, "final/summary.md"),
    decision: safeReadStructuredArtifact(rec, "arbitration/decision.yaml", DecisionRecord),
    workProduct: safeReadStructuredArtifact(rec, "final/work_product.yaml", WorkProduct),
    reviewFindings: readReviewFindings(rec),
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
  if (typeof p["repoRoot"] === "string") return p["repoRoot"];
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

function validateApplyableRun(rec: DaemonRunRecord): string | null {
  if (rec.state !== "succeeded") return `run is not applyable while state is ${rec.state}`;
  const decision = safeReadStructuredArtifact(rec, "arbitration/decision.yaml", DecisionRecord);
  if (!decision) return "decision record is required before apply";
  if (decision.status !== "success") return `decision status is ${decision.status}; refusing apply`;
  const workProduct = safeReadStructuredArtifact(rec, "final/work_product.yaml", WorkProduct);
  if (!workProduct) return "work product is required before apply";
  if (workProduct.kind !== "patch") return `work product kind ${workProduct.kind} is not applyable as a patch`;
  return null;
}

function validatePatchBinding(rec: DaemonRunRecord, patch: string): string | null {
  const workProduct = safeReadStructuredArtifact(rec, "final/work_product.yaml", WorkProduct);
  const recorded = workProduct?.meta?.["patch_sha256"];
  if (typeof recorded !== "string" || recorded.length === 0) return "work product patch hash is required before apply";
  return recorded === sha256(patch) ? null : "patch artifact hash does not match the reviewed work product";
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

function validateApplyRepo(rec: DaemonRunRecord, repoRoot: string): string | null {
  const original = runRepoRoot(rec);
  if (!original) return "run original project is unknown; refusing apply";
  const originalAbsoluteError = validateAbsoluteRepoRoot(original);
  if (originalAbsoluteError) return "run original project is not an absolute path; refusing apply";
  try {
    const a = realpathSync(original);
    const b = realpathSync(repoRoot);
    return a === b ? null : "repoRoot does not match the run's original project";
  } catch {
    return "repoRoot cannot be verified";
  }
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
  return isAbsolute(repoRoot) ? null : "repoRoot must be an absolute path";
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
