import { type Server, type Socket, createServer } from "node:net";
import { rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { newId, nowIso } from "@claudex/util";

export type RunnerFn = (params: unknown) => Promise<unknown>;

export interface DaemonOptions {
  socketPath: string;
  token: string;
  runner: RunnerFn;
}

export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface JobRecord {
  id: string;
  state: JobState;
  params: unknown;
  result?: unknown;
  error?: string;
  createdAt: string;
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
  private working = false;
  private readonly startedAt = Date.now();
  private onClosed?: () => void;

  constructor(private readonly opts: DaemonOptions) {}

  async start(): Promise<void> {
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
          running: this.working,
          jobs: this.records.size,
        };
      case "claudex.enqueue": {
        const id = newId("job");
        this.records.set(id, { id, state: "queued", params, createdAt: nowIso() });
        this.queue.push(id);
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
        return { id: jid, cancelled: true };
      }
      case "claudex.shutdown":
        setTimeout(() => void this.stop(), 10);
        return { ok: true };
      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  private async drain(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length > 0) {
        const id = this.queue.shift() as string;
        const rec = this.records.get(id);
        if (!rec) continue;
        if (this.cancelled.has(id)) {
          rec.state = "cancelled";
          continue;
        }
        rec.state = "running";
        try {
          rec.result = await this.opts.runner(rec.params);
          rec.state = "succeeded";
        } catch (err) {
          rec.state = "failed";
          rec.error = err instanceof Error ? err.message : String(err);
        }
      }
    } finally {
      this.working = false;
    }
  }
}
