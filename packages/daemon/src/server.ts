import { type Server, type Socket, createServer } from "node:net";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { assertNoInlineSecretValues, newId, nowIso, pathExists, readJsonSafe, redactSecrets } from "@claudexor/util";

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
  /** Max retained terminal jobs (older ones are pruned to bound memory/disk). Default 500. */
  maxHistory?: number;
}

export type JobState =
  | "queued"
  | "running"
  | "blocked"
  | "succeeded"
  | "no_op"
  | "ungated"
  | "review_not_run"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "exhausted"
  | "not_converged";

export interface JobRecord {
  id: string;
  state: JobState;
  params: unknown;
  result?: unknown;
  error?: string;
  createdAt: string;
  /** Surfaced as soon as the run starts so a client can tail .claudexor/runs/<runId>/events.jsonl. */
  runId?: string;
  taskId?: string;
  runDir?: string;
  startedAt?: string;
  finishedAt?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Local daemon: Unix-socket JSON-RPC with token auth + a bounded-concurrency
 * worker pool (up to maxConcurrent jobs in parallel) backed by an optional
 * durable, atomically-written job registry. It does NOT contain a second
 * scheduler — it calls the injected runner (the same Orchestrator the CLI uses).
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
      this.send(sock, { id, error: { message: redactSecrets(err instanceof Error ? err.message : String(err)) } });
    }
  }

  private async dispatch(method: string, params: any): Promise<unknown> {
    switch (method) {
      case "claudexor.health":
        return {
          ok: true,
          uptime_ms: Date.now() - this.startedAt,
          queue: this.queue.length,
          running: this.active > 0,
          active: this.active,
          jobs: this.records.size,
        };
      case "claudexor.enqueue": {
        assertNoInlineSecretValues(params, "$", "daemon job params");
        const id = newId("job");
        this.records.set(id, { id, state: "queued", params, createdAt: nowIso() });
        this.queue.push(id);
        this.persist();
        void this.drain();
        return { id, state: "queued" };
      }
      case "claudexor.status": {
        const rec = this.records.get(String(params?.id));
        if (!rec) throw new Error(`no such job: ${params?.id}`);
        return publicJobRecord(rec);
      }
      case "claudexor.list":
        return [...this.records.values()].map(publicJobRecord);
      case "claudexor.cancel": {
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
      case "claudexor.shutdown":
        setTimeout(() => void this.stop(), 10);
        return { ok: true };
      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  private get maxConcurrent(): number {
    return this.opts.maxConcurrent ?? 4;
  }

  /**
   * Best-effort durable persistence of the job registry. Writes atomically
   * (temp file + rename) so a crash mid-write cannot corrupt/drop the registry.
   * The raw run `result` is intentionally NOT persisted: canonical output lives
   * in .claudexor/runs (redacted), and result.summary can contain raw model text —
   * keeping it out of jobs.json upholds the redaction-at-persistence invariant.
   */
  private persist(): void {
    const path = this.opts.persistPath;
    if (!path) return;
    try {
      const view = [...this.records.values()].map(persistedJobRecord);
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(view, null, 2) + "\n", { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
      chmodSync(path, 0o600);
    } catch {
      /* best-effort; never break a run on a persistence failure */
    }
  }

  /** Bound memory/disk: prune the oldest terminal jobs beyond maxHistory. */
  private pruneHistory(): void {
    const cap = this.opts.maxHistory ?? 500;
    const terminal = [...this.records.values()].filter(
      (r) => r.state !== "running" && r.state !== "queued",
    );
    if (terminal.length <= cap) return;
    terminal.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    for (const r of terminal.slice(0, terminal.length - cap)) {
      this.records.delete(r.id);
      this.cancelled.delete(r.id);
    }
  }

  /** Reload the registry on startup; a fresh process cannot resume in-memory runs. */
  private load(): void {
    if (!this.opts.persistPath || !pathExists(this.opts.persistPath)) return;
    const saved = readJsonSafe<JobRecord[]>(this.opts.persistPath);
    if (!saved) return;
    for (const rec of saved) {
      if (rec.state === "running" || rec.state === "queued" || rec.state === "blocked") rec.state = "interrupted";
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
          rec.taskId = info.taskId;
          rec.runDir = info.runDir;
          // Persist the pointer immediately so a mid-run crash still reloads with
          // runId/runDir to locate .claudexor/runs/<runId> (the recovery path).
          this.persist();
        },
      });
      rec.state = jobStateFromResult(rec.result, controller.signal.aborted);
      if (rec.state !== "succeeded" && rec.state !== "cancelled") {
        rec.error = resultSummary(rec.result) ?? `run ended with status ${rec.state}`;
      }
    } catch (err) {
      rec.state = controller.signal.aborted ? "cancelled" : "failed";
      rec.error = redactSecrets(err instanceof Error ? err.message : String(err));
    } finally {
      rec.finishedAt = nowIso();
      this.controllers.delete(id);
      this.active -= 1;
      this.pruneHistory();
      this.persist();
      this.drain();
    }
  }
}

function jobStateFromResult(result: unknown, aborted: boolean): JobState {
  if (aborted) return "cancelled";
  const status = resultStatus(result);
  switch (status) {
    case "success":
      return "succeeded";
    case "no_op":
      return "no_op";
    case "ungated":
      return "ungated";
    case "review_not_run":
      return "review_not_run";
    case "blocked":
      return "blocked";
    case "cancelled":
      return "cancelled";
    case "exhausted":
      return "exhausted";
    case "not_converged":
      return "not_converged";
    case "failed":
      return "failed";
    default:
      return status === null ? "succeeded" : "failed";
  }
}

function resultStatus(result: unknown): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const status = (result as Record<string, unknown>)["status"];
  return typeof status === "string" ? status : null;
}

function resultSummary(result: unknown): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const summary = (result as Record<string, unknown>)["summary"];
  return typeof summary === "string" ? redactSecrets(summary) : null;
}

function publicJobRecord(rec: JobRecord): JobRecord {
  return {
    ...rec,
    error: rec.error ? redactSecrets(rec.error) : undefined,
    params: redactParams(rec.params),
  };
}

function persistedJobRecord(rec: JobRecord): Omit<JobRecord, "result"> {
  return {
    id: rec.id,
    state: rec.state,
    params: redactParams(rec.params),
    error: rec.error ? redactSecrets(rec.error) : undefined,
    createdAt: rec.createdAt,
    runId: rec.runId,
    taskId: rec.taskId,
    runDir: rec.runDir,
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
  };
}

function redactParams(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactParams);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = key === "prompt" && typeof child === "string" ? redactSecrets(child) : redactParams(child);
  }
  return out;
}
