import { timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { join } from "node:path";

export interface DaemonRunRecord {
  id: string;
  state: string;
  runId?: string;
  taskId?: string;
  runDir?: string;
  error?: string;
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
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

function hostIsLoopback(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const h = hostHeader.trim();
  const host = h.startsWith("[") ? h.slice(1, h.indexOf("]")) : (h.split(":")[0] ?? "");
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function originIsLoopback(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname.toLowerCase());
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
      let params: unknown;
      try {
        params = await this.readBody(req);
      } catch (err) {
        const status = err && typeof err === "object" && "status" in err ? Number((err as { status: number }).status) : 400;
        return this.json(res, status, { error: err instanceof Error ? err.message : "bad request" });
      }
      const job = await this.opts.daemon.enqueue(params);
      const rec = await this.waitForRunStart(job.id);
      if (rec.runId && rec.runDir) {
        return this.json(res, 200, { jobId: rec.id, runId: rec.runId, taskId: rec.taskId, runDir: rec.runDir });
      }
      // Long-queued jobs remain canonical in the daemon. Don't fail the request
      // while leaving an orphaned queued job behind; return the job id for polling.
      const status = TERMINAL_STATES.has(rec.state) ? 500 : 202;
      return this.json(res, status, { jobId: rec.id, state: rec.state, error: rec.error });
    }

    if (method === "GET" && path === "/runs") {
      const runs = await this.opts.daemon.list();
      return this.json(res, 200, {
        runs: runs.map((r) => ({ jobId: r.id, runId: r.runId ?? r.id, state: r.state, runDir: r.runDir, error: r.error })),
      });
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
