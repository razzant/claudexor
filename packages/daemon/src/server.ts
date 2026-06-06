import { type Server, type Socket, createServer } from "node:net";
import { rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { newId, nowIso, pathExists, readJsonSafe, writeJson } from "@claudex/util";

/** Context the daemon supplies to the runner so a job can be observed and cancelled. */
export interface RunContext {
  signal: AbortSignal;
  /** Called by the runner once the run id/dir are known (lets a client tail events.jsonl). */
  onRunStart: (info: { runId: string; taskId: string; runDir: string }) => void;
}

export type RunnerFn = (params: unknown, ctx: RunContext) => Promise<unknown>;

export interface DaemonOptions {
  socketPath: string;
  token: string;
  runner: RunnerFn;
  /** Max concurrently-running jobs (parallel projects/runs). Default 4. */
  maxConcurrent?: number;
  /** Optional JSON file to persist the job registry across restarts (durable run list). */
  persistPath?: string;
}

export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

export interface JobRecord {
  id: string;
  state: JobState;
  params: unknown;
  result?: unknown;
  error?: string;
  createdAt: string;
  /** Surfaced as soon as the run starts so a client can tail .claudex/runs/<runId>/events.jsonl. */
  runId?: string;
  runDir?: string;
  startedAt?: string;
  finishedAt?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Local daemon: Unix-socket JSON-RPC with token auth + a single-worker FIFO
 * queue. It does NOT contain a second scheduler — it calls the injected runner
 * (the same ExecutionEngine/Orchestrator the CLI uses).
 */
export class DaemonServer {
  private server?: Server;
  private readonly queue: string[] = [];
  private readonly records = new Map<string, JobRecord>();
  private readonly cancelled = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private active = 0;
  private readonly startedAt = Date.now();
  private onClosed?: () => void;

  constructor(private readonly opts: DaemonOptions) {}

  async start(): Promise<void> {
    this.load();
    try {
      rmSync(this.opts.socketPath, { force: true });
    } catch {
      /* nothing to clean */
    }
    await new Promise<void>((resolve, reject) => {
      this.server = createServer((sock) => this.onConnection(sock));
      this.server.once("error", reject);
      this.server.listen(this.opts.socketPath, () => resolve());
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.onClosed?.();
  }

  /** Resolves when the daemon is shut down via RPC. */
  waitForShutdown(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.onClosed = resolve;
    });
  }

  private onConnection(sock: Socket): void {
    const rl = createInterface({ input: sock });
    rl.on("line", (line) => {
      void this.handle(line, sock);
    });
    sock.on("error", () => rl.close());
  }

  private send(sock: Socket, obj: unknown): void {
    try {
      sock.write(JSON.stringify(obj) + "\n");
    } catch {
      /* socket closed */
    }
  }

  private async handle(line: string, sock: Socket): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    const { id, method, params, token } = msg;
    if (token !== this.opts.token) {
      this.send(sock, { id, error: { message: "unauthorized" } });
      return;
    }
    try {
      this.send(sock, { id, result: await this.dispatch(method, params) });
    } catch (err) {
      this.send(sock, { id, error: { message: err instanceof Error ? err.message : String(err) } });
    }
  }

  private async dispatch(method: string, params: any): Promise<unknown> {
    switch (method) {
      case "claudex.health":
        return {
          ok: true,
          uptime_ms: Date.now() - this.startedAt,
          queue: this.queue.length,
          running: this.active > 0,
          active: this.active,
          jobs: this.records.size,
        };
      case "claudex.enqueue": {
        const id = newId("job");
        this.records.set(id, { id, state: "queued", params, createdAt: nowIso() });
        this.queue.push(id);
        this.persist();
        void this.drain();
        return { id, state: "queued" };
      }
      case "claudex.status": {
        const rec = this.records.get(String(params?.id));
        if (!rec) throw new Error(`no such job: ${params?.id}`);
        return rec;
      }
      case "claudex.list":
        return [...this.records.values()];
      case "claudex.cancel": {
        const jid = String(params?.id);
        this.cancelled.add(jid);
        const rec = this.records.get(jid);
        if (rec && rec.state === "queued") rec.state = "cancelled";
        // Abort the in-flight run; the runner (Orchestrator) honors the signal,
        // cancels the harness, then settles this job as cancelled.
        this.controllers.get(jid)?.abort();
        this.persist();
        return { id: jid, cancelled: true };
      }
      case "claudex.shutdown":
        setTimeout(() => void this.stop(), 10);
        return { ok: true };
      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  private get maxConcurrent(): number {
    return this.opts.maxConcurrent ?? 4;
  }

  /** Best-effort persistence of the job registry. Canonical run state is .claudex/runs. */
  private persist(): void {
    if (!this.opts.persistPath) return;
    try {
      writeJson(this.opts.persistPath, [...this.records.values()]);
    } catch {
      /* best-effort; never break a run on a persistence failure */
    }
  }

  /** Reload the registry on startup; a fresh process cannot resume in-memory runs. */
  private load(): void {
    if (!this.opts.persistPath || !pathExists(this.opts.persistPath)) return;
    const saved = readJsonSafe<JobRecord[]>(this.opts.persistPath);
    if (!saved) return;
    for (const rec of saved) {
      if (rec.state === "running" || rec.state === "queued") rec.state = "interrupted";
      this.records.set(rec.id, rec);
    }
  }

  /** Schedule queued jobs up to the concurrency limit (non-blocking). */
  private drain(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift() as string;
      const rec = this.records.get(id);
      if (!rec) continue;
      if (this.cancelled.has(id)) {
        rec.state = "cancelled";
        continue;
      }
      this.active += 1;
      void this.runJob(id, rec);
    }
  }

  private async runJob(id: string, rec: JobRecord): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    rec.state = "running";
    rec.startedAt = nowIso();
    this.persist();
    try {
      rec.result = await this.opts.runner(rec.params, {
        signal: controller.signal,
        onRunStart: (info) => {
          rec.runId = info.runId;
          rec.runDir = info.runDir;
        },
      });
      rec.state = controller.signal.aborted ? "cancelled" : "succeeded";
    } catch (err) {
      rec.state = controller.signal.aborted ? "cancelled" : "failed";
      rec.error = err instanceof Error ? err.message : String(err);
    } finally {
      rec.finishedAt = nowIso();
      this.controllers.delete(id);
      this.active -= 1;
      this.persist();
      this.drain();
    }
  }
}
