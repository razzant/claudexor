import { timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { newId, redactSecrets } from "@claudexor/util";
import { EventBus } from "./event-bus.js";

/** Context handed to the runner so a run can be observed live and cancelled. */
export interface RunContext {
  signal: AbortSignal;
  onRunStart: (info: { runId: string; taskId: string; runDir: string }) => void;
  onEvent: (event: unknown) => void;
  onHarnessEvent: (event: unknown) => void;
}

export type ControlRunner = (params: unknown, ctx: RunContext) => Promise<unknown>;

export interface ControlApiOptions {
  /** Per-user bearer token required on every request (loopback is not trusted alone). */
  token: string;
  /** Injected engine runner (the same Orchestrator the CLI uses) — no second scheduler. */
  runner: ControlRunner;
  /** Loopback host. Default 127.0.0.1. */
  host?: string;
  /** Port; 0 picks a free port (read it back via address()). Default 0. */
  port?: number;
  eventBus?: EventBus;
  /**
   * How long after a run completes to keep its in-memory handle + event buffer for
   * reconnecting clients before eviction (ms). Bounds memory for a long-lived service.
   * Default 5 min. Canonical history lives in .claudexor/runs; late clients get a `gap`.
   */
  runRetentionMs?: number;
}

interface RunHandle {
  runId: string;
  taskId: string;
  runDir: string;
  controller: AbortController;
  state: "running" | "succeeded" | "failed" | "cancelled";
  error?: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Host/Origin must be loopback — defends against DNS-rebinding from a browser. */
function hostIsLoopback(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const h = hostHeader.trim();
  // Bracketed IPv6 ("[::1]" or "[::1]:port") vs host:port.
  const host = h.startsWith("[") ? h.slice(1, h.indexOf("]")) : (h.split(":")[0] ?? "");
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function originIsLoopback(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser clients (Swift URLSession) omit Origin
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Loopback HTTP+SSE control surface. Commands are POSTs; live progress is an SSE
 * stream with Last-Event-ID replay. It binds to loopback, requires a bearer token,
 * and validates Host/Origin. It owns no scheduling logic — it calls the injected runner.
 *
 * Layering (decided during adversarial review): the daemon (packages/daemon) is the
 * DURABLE job scheduler (unix socket, crash-persistent registry, queue); this surface
 * is the LIVE observation viewport (HTTP/SSE, ephemeral in-memory fan-out). They are
 * complementary, not duplicates. `GET /runs` here lists only in-process live runs; the
 * durable cross-restart list is the daemon's. When control-api is wired into claudexord,
 * its injected runner will delegate to the daemon and the two `RunContext` shapes will
 * be unified into packages/schema.
 */
export class ControlApiServer {
  private server?: Server;
  private readonly bus: EventBus;
  private readonly runs = new Map<string, RunHandle>();
  private readonly evictTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly sseClients = new Set<ServerResponse>();

  constructor(private readonly opts: ControlApiOptions) {
    this.bus = opts.eventBus ?? new EventBus();
  }

  /** Evict a completed run's handle + event buffer after the retention window. */
  private scheduleEvict(runId: string): void {
    const ttl = this.opts.runRetentionMs ?? 5 * 60_000;
    const timer = setTimeout(() => {
      this.bus.evict(runId);
      this.runs.delete(runId);
      this.evictTimers.delete(timer);
    }, ttl);
    timer.unref?.();
    this.evictTimers.add(timer);
  }

  async start(): Promise<{ host: string; port: number }> {
    const host = this.opts.host ?? "127.0.0.1";
    const port = this.opts.port ?? 0;
    await new Promise<void>((resolve, reject) => {
      this.server = createServer((req, res) => this.onRequest(req, res));
      this.server.once("error", reject);
      this.server.listen(port, host, () => resolve());
    });
    const addr = this.server?.address();
    const boundPort = typeof addr === "object" && addr ? addr.port : port;
    return { host, port: boundPort };
  }

  async stop(): Promise<void> {
    for (const h of this.runs.values()) h.controller.abort();
    for (const timer of this.evictTimers) clearTimeout(timer);
    this.evictTimers.clear();
    // End open SSE streams so server.close() can drain instead of hanging on them.
    for (const res of this.sseClients) {
      try {
        res.end();
      } catch {
        /* already closed */
      }
    }
    this.sseClients.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  private authorized(req: IncomingMessage): boolean {
    if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin as string | undefined)) {
      return false;
    }
    const auth = req.headers.authorization ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    return this.tokenMatches(m?.[1]?.trim());
  }

  /** Constant-time bearer-token comparison (avoid leaking the token via timing). */
  private tokenMatches(provided: string | undefined): boolean {
    if (!provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(this.opts.token);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
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
      // Health is unauthenticated but still loopback-guarded; no run details leaked.
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
      return this.startRun(params, res);
    }

    const eventsMatch = /^\/runs\/([^/]+)\/events$/.exec(path);
    if (method === "GET" && eventsMatch) {
      return this.streamEvents(decodeURIComponent(eventsMatch[1] as string), req, res);
    }

    const cancelMatch = /^\/runs\/([^/]+)\/cancel$/.exec(path);
    if (method === "POST" && cancelMatch) {
      const runId = decodeURIComponent(cancelMatch[1] as string);
      const handle = this.runs.get(runId);
      if (!handle) return this.json(res, 404, { error: "no such run" });
      handle.controller.abort();
      return this.json(res, 200, { runId, cancelled: true });
    }

    if (method === "GET" && path === "/runs") {
      return this.json(res, 200, {
        runs: [...this.runs.values()].map((h) => ({ runId: h.runId, state: h.state, runDir: h.runDir })),
      });
    }

    return this.json(res, 404, { error: "not found" });
  }

  /** Start a run; respond with the runId as soon as it is known, then stream to the bus. */
  private startRun(params: unknown, res: ServerResponse): void {
    const controller = new AbortController();
    let responded = false;
    const provisionalId = newId("run");

    const respondOnce = (info: { runId: string; taskId: string; runDir: string }) => {
      if (responded) return;
      responded = true;
      this.runs.set(info.runId, { ...info, controller, state: "running" });
      this.json(res, 200, info);
    };

    // Holder (not a bare `let`) so TS keeps the narrowed type across the closures
    // that assign it inside the runner callbacks.
    const ref: { current: { runId: string; taskId: string; runDir: string } | null } = { current: null };

    void (async () => {
      try {
        await this.opts.runner(params, {
          signal: controller.signal,
          onRunStart: (info) => {
            // Single-assignment: the first runId is authoritative. A second call
            // must not split events/completion away from the id the client received.
            if (ref.current) return;
            ref.current = info;
            respondOnce(info);
          },
          onEvent: (event) => {
            if (ref.current) this.bus.publish(ref.current.runId, "run", redactEvent(event));
          },
          onHarnessEvent: (event) => {
            if (ref.current) this.bus.publish(ref.current.runId, "harness", redactEvent(event));
          },
        });
        if (ref.current) {
          const h = this.runs.get(ref.current.runId);
          if (h) h.state = controller.signal.aborted ? "cancelled" : "succeeded";
          this.bus.complete(ref.current.runId);
          this.scheduleEvict(ref.current.runId);
        }
        // A runner that resolves without ever calling onRunStart cannot give the
        // client a streamable runId — fail loudly instead of returning a dead id.
        if (!responded) {
          responded = true;
          this.json(res, 500, { error: "run did not start: runner never called onRunStart" });
        }
      } catch (err) {
        const message = redactSecrets(err instanceof Error ? err.message : String(err));
        if (ref.current) {
          const h = this.runs.get(ref.current.runId);
          if (h) {
            h.state = controller.signal.aborted ? "cancelled" : "failed";
            h.error = message;
          }
          this.bus.publish(ref.current.runId, "error", { message });
          this.bus.complete(ref.current.runId);
          this.scheduleEvict(ref.current.runId);
        }
        if (!responded) {
          responded = true;
          this.json(res, 500, { error: message, runId: provisionalId });
        }
      }
    })();
  }

  /** SSE stream for a run, honoring Last-Event-ID replay. */
  private streamEvents(runId: string, req: IncomingMessage, res: ServerResponse): void {
    // A client only learns a runId from POST /runs (which inserts it into `runs`
    // before responding), so an unknown id means an evicted/never-started run.
    if (!this.runs.has(runId)) {
      return this.json(res, 404, { error: "no such run" });
    }

    // Parse Last-Event-ID from the SSE header (preferred) or ?lastEventId=, handling
    // 0 correctly (header "0" is a valid resume point, not "absent").
    const rawHeader = req.headers["last-event-id"];
    const headerId = rawHeader !== undefined ? Number(rawHeader) : Number.NaN;
    const rawQuery = new URL(req.url ?? "/", "http://localhost").searchParams.get("lastEventId");
    const queryId = rawQuery !== null ? Number(rawQuery) : Number.NaN;
    const lastEventId = Number.isFinite(headerId) ? headerId : Number.isFinite(queryId) ? queryId : 0;

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    this.sseClients.add(res);

    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
    let ended = false;
    let unsubscribe = () => {};
    const finish = () => {
      if (ended) return;
      ended = true;
      clearInterval(heartbeat);
      unsubscribe();
      this.sseClients.delete(res);
      res.write(`event: end\ndata: {}\n\n`);
      res.end();
    };

    unsubscribe = this.bus.subscribe(runId, lastEventId, (env) => {
      res.write(`id: ${env.seq}\nevent: ${env.kind}\ndata: ${JSON.stringify(env.event)}\n\n`);
    });

    // If the run already finished, replay above is complete — close the stream now.
    if (this.bus.isDone(runId)) {
      finish();
      return;
    }

    const onComplete = this.bus.onComplete(runId, finish);
    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
      onComplete();
      this.sseClients.delete(res);
    };
    req.on("close", close);
    res.on("close", close);
  }
}

function redactEvent(event: unknown): unknown {
  try {
    return JSON.parse(redactSecrets(JSON.stringify(event)));
  } catch {
    return typeof event === "string" ? redactSecrets(event) : event;
  }
}
