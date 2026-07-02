import { type Server, type Socket, connect, createServer } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { appendRunEvent } from "@claudexor/event-log";
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

export const JOB_STATES = [
  "queued",
  "running",
  "blocked",
  "succeeded",
  "no_op",
  "ungated",
  "review_not_run",
  "failed",
  "cancelled",
  "interrupted",
  "exhausted",
  "not_converged",
  "stuck_no_progress",
] as const;

export type JobState = (typeof JOB_STATES)[number];

/**
 * Per-record validation for the persisted registry: one hand-edited or
 * version-skewed record must not wipe the whole run history, and a record
 * with a state outside the enum must never reach the strict control-api
 * DTOs (where it would 500 the entire GET /runs list).
 */
function salvageJobRecord(raw: unknown): JobRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec["id"] !== "string" || rec["id"].length === 0) return null;
  if (typeof rec["state"] !== "string" || !(JOB_STATES as readonly string[]).includes(rec["state"])) return null;
  if (typeof rec["createdAt"] !== "string") return null;
  const optionalString = (key: string): string | undefined =>
    typeof rec[key] === "string" ? (rec[key] as string) : undefined;
  return {
    id: rec["id"],
    state: rec["state"] as JobState,
    params: rec["params"],
    error: optionalString("error"),
    createdAt: rec["createdAt"],
    runId: optionalString("runId"),
    taskId: optionalString("taskId"),
    runDir: optionalString("runDir"),
    startedAt: optionalString("startedAt"),
    finishedAt: optionalString("finishedAt"),
  };
}

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
    // Refuse to clobber a LIVE daemon: deleting its socket would orphan it and
    // turn jobs.json into a last-writer-wins race between two processes.
    if (pathExists(this.opts.socketPath) && (await socketAlive(this.opts.socketPath))) {
      throw new Error(`a claudexor daemon is already listening on ${this.opts.socketPath}; stop it first`);
    }
    this.load();
    try {
      rmSync(this.opts.socketPath, { force: true });
    } catch {
      /* nothing to clean */
    }
    await new Promise<void>((resolve, reject) => {
      this.server = createServer((sock) => this.onConnection(sock));
      this.server.once("error", reject);
      this.server.listen(this.opts.socketPath, () => {
        // Owner-only socket (T5#23): the bearer token is the auth layer, but a
        // world-connectable socket needlessly exposes the RPC surface to every
        // local user; chmod narrows it to the owning account.
        try {
          chmodSync(this.opts.socketPath, 0o600);
        } catch {
          /* best-effort on exotic filesystems */
        }
        resolve();
      });
    });
    // Resume any queued jobs re-enqueued from a previous session (see load()).
    void this.drain();
  }

  async stop(): Promise<void> {
    // Graceful shutdown: abort in-flight runs so the runner cancels their harness
    // children and settles each job (no orphaned processes / "running" zombies in
    // jobs.json), then WAIT (bounded) for the cancellations to settle. Without
    // the wait, the process could exit before the SIGKILL escalation timers
    // fire, leaving a SIGTERM-ignoring harness child alive in its group.
    for (const controller of this.controllers.values()) {
      try {
        controller.abort();
      } catch {
        /* already gone */
      }
    }
    const deadline = Date.now() + 5_000;
    while (this.active > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    this.persist();
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
    if (!tokenMatches(typeof token === "string" ? token : "", this.opts.token)) {
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

  /** Bound memory/disk: prune the oldest terminal jobs beyond maxHistory.
   * `blocked` runs are NEVER pruned — they are the needs-human inbox awaiting an
   * operator decision; dropping one would silently lose a pending action. */
  private pruneHistory(): void {
    const cap = this.opts.maxHistory ?? 500;
    const terminal = [...this.records.values()].filter(
      (r) => r.state !== "running" && r.state !== "queued" && r.state !== "blocked",
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
    const path = this.opts.persistPath;
    if (!path || !pathExists(path)) return;
    const saved = readJsonSafe<unknown>(path);
    if (saved === null || !Array.isArray(saved)) {
      // A corrupt registry must not be silently wiped: the run history includes
      // the blocked needs-human inbox. Back the raw bytes up, start empty, and
      // say so loudly (ThreadStore discipline).
      this.backupCorruptRegistry(path, "registry file is not a JSON array");
      return;
    }
    let dropped = 0;
    for (const raw of saved) {
      const rec = salvageJobRecord(raw);
      if (!rec) {
        dropped += 1;
        continue;
      }
      // A fresh process cannot resume an in-memory RUN, so a `running` job becomes
      // interrupted (honest). `blocked` is a TERMINAL outcome (NEEDS_HUMAN / web
      // policy) the review queue must keep across restarts.
      if (rec.state === "running") {
        rec.state = "interrupted";
        // Stamp the orphaned event log with a TERMINAL event (T3.1#5d): the
        // canonical events.jsonl must agree with jobs.json, or SSE tailers and
        // `follow` wait forever on a log that will never terminate.
        if (rec.runDir && rec.runId) {
          try {
            appendRunEvent(join(rec.runDir, "events.jsonl"), rec.runId, rec.taskId ?? "", "run.failed", {
              status: "interrupted",
              error: "daemon restarted while the run was in flight",
            });
          } catch {
            /* best-effort: a missing/corrupt log must not block startup */
          }
        }
      }
      this.records.set(rec.id, rec);
      // A `queued` job never started; its params are persisted, so RE-ENQUEUE it
      // on restart (drain() runs after start()) instead of silently dropping
      // pending work to interrupted.
      if (rec.state === "queued") this.queue.push(rec.id);
    }
    if (dropped > 0) {
      this.backupCorruptRegistry(path, `${dropped} unparseable job record(s) dropped`);
    }
  }

  /** Preserve the raw bytes of a damaged registry and report the loss loudly. */
  private backupCorruptRegistry(path: string, reason: string): void {
    try {
      copyFileSync(path, `${path}.bak`);
      console.error(`[claudexor] jobs store: ${reason}; original backed up to ${path}.bak`);
    } catch {
      console.error(`[claudexor] jobs store: ${reason}; backup to ${path}.bak FAILED`);
    }
  }

  private threadIdOf(rec: JobRecord): string | undefined {
    const p = rec.params as { threadId?: unknown } | null | undefined;
    return p && typeof p.threadId === "string" ? p.threadId : undefined;
  }

  /**
   * Schedule queued jobs up to the concurrency limit (non-blocking).
   *
   * One active run per thread: a thread is a linear conversation and an in-place
   * turn mutates the live tree, so two concurrent turns on the same thread would
   * race the same files. We pick the first queued job whose thread is idle rather
   * than always taking the head; thread-less jobs (CLI/MCP) keep running in
   * parallel as before. drain() re-runs on every completion, so a thread's next
   * turn starts as soon as its previous one settles.
   */
  private drain(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const busyThreads = new Set(
        [...this.records.values()]
          .filter((r) => r.state === "running")
          .map((r) => this.threadIdOf(r))
          .filter((t): t is string => !!t),
      );
      let pickIdx = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const rec = this.records.get(this.queue[i]);
        const tid = rec ? this.threadIdOf(rec) : undefined;
        if (!rec || !tid || !busyThreads.has(tid)) {
          pickIdx = i;
          break;
        }
      }
      if (pickIdx === -1) break; // every queued job waits on a busy thread
      const id = this.queue.splice(pickIdx, 1)[0];
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
      // Only failure-shaped terminals carry an error string. no_op / ungated /
      // review_not_run / blocked are HONEST terminals: fabricating an error here
      // would make the control facade render a failure that never happened.
      if (rec.state === "failed" || rec.state === "exhausted" || rec.state === "not_converged" || rec.state === "stuck_no_progress") {
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
    case "stuck_no_progress":
      return "stuck_no_progress";
    case "failed":
      return "failed";
    default:
      // Fail loudly: a runner result without a recognizable status is NOT a
      // success — success-by-default would mask malformed results forever.
      return "failed";
  }
}

/** Constant-time token comparison (parity with the HTTP control facade). */
function tokenMatches(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** True when something is actively accepting connections on the socket path. */
/** Is a daemon already listening on this socket? Exported so the claudexord
 * entrypoint can refuse BEFORE running crash GC — a second daemon must never
 * reap the live daemon's children or sweep envelopes its jobs still own. */
export function socketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(socketPath);
    const done = (alive: boolean) => {
      sock.destroy();
      resolve(alive);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    setTimeout(() => done(false), 500).unref();
  });
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
