import { type Server, type Socket, connect, createServer } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  assertNoInlineSecretValues,
  errorCode,
  newId,
  nowIso,
  pathExists,
  redactSecrets,
} from "@claudexor/util";
import {
  commandStoreForId,
  commandStoreForRequest,
  commandStores,
  type CommandAuthority,
} from "./command-authority.js";
import { productCommandRecords, prunableCommandIds } from "./command-retention.js";

export interface RunContext {
  signal: AbortSignal;
  onRunStart: (info: { runId: string; taskId: string; runDir: string }) => void;
}

export type RunnerFn = (params: unknown, ctx: RunContext) => Promise<unknown>;

export interface DaemonOptions {
  socketPath: string;
  token: string;
  runner: RunnerFn;
  maxConcurrent?: number;
  commands: CommandAuthority;
  maxHistory?: number;
  idempotencyRetentionMs?: number;
  now?: () => Date;
  /** Called when a job reaches a terminal state (any path) with its runId —
   * used to drop pending interactions so a dead run never advertises
   * waiting_on_user. */
  onRunTerminal?: (runId: string, threadId?: string) => void;
  /** Called when a job that carried a pre-created thread turn (params.turnId)
   * settles failure-shaped WITHOUT ever binding a run — i.e. the refusal
   * happened before the run materialized (trust gate, preflight validation).
   * The observer persists the reason on the turn so it is never a silent
   * orphan bubble. `code` is the typed throw's machine code (null if none). */
  onTurnEnqueueFailed?: (turnId: string, error: string, code: string | null) => void;
  /** Composition-root shutdown hook. When present, RPC shutdown must drain
   * every daemon-owned subsystem, not only this socket queue. */
  onShutdownRequested?: () => Promise<void>;
  /** Test-only barriers around command authority acquisition. */
  startupBarrier?: (
    barrier: "before_registry_load" | "after_registry_load",
  ) => void | Promise<void>;
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
  "interrupted_unknown",
  "cost_unverifiable",
  "exhausted_overshoot",
  "exhausted",
  "not_converged",
  "stuck_no_progress",
] as const;

export type JobState = (typeof JOB_STATES)[number];

export interface JobRecord {
  id: string;
  state: JobState;
  params: unknown;
  result?: unknown;
  error?: string;
  /** Machine-readable code carried by a typed throw (e.g. the trust gate's
   * trust_full_access_required) — lets surfaces key remedies on the CODE,
   * never on substring-matching the human message. */
  errorCode?: string;
  createdAt: string;
  /** Surfaced as soon as the run starts so a client can tail the external run's events.jsonl. */
  runId?: string;
  taskId?: string;
  runDir?: string;
  startedAt?: string;
  finishedAt?: string;
}

/** Unix-socket worker pool; scheduling stays in the injected Orchestrator. */
export class DaemonServer {
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  private readonly queue: string[] = [];
  private readonly cancelled = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly activeTasks = new Set<Promise<void>>();
  private readonly taskFailures: unknown[] = [];
  private active = 0;
  private readonly startedAt = Date.now();
  private stopping = false;
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private resolveShutdown!: () => void;
  private readonly shutdownPromise = new Promise<void>((resolve) => {
    this.resolveShutdown = resolve;
  });

  constructor(private readonly opts: DaemonOptions) {}

  async start(): Promise<void> {
    if (this.stopping) {
      throw Object.assign(new Error("daemon is stopping and cannot be started"), {
        code: "daemon_stopping",
        status: 503,
      });
    }
    this.startPromise ??= this.startOnce();
    await this.startPromise;
    if (this.stopping) {
      await this.stop();
      throw Object.assign(new Error("daemon startup was cancelled by shutdown"), {
        code: "daemon_stopping",
        status: 503,
      });
    }
  }

  private async startOnce(): Promise<void> {
    if (pathExists(this.opts.socketPath) && (await socketAlive(this.opts.socketPath))) {
      throw new Error(
        `a claudexor daemon is already listening on ${this.opts.socketPath}; stop it first`,
      );
    }
    await this.opts.startupBarrier?.("before_registry_load");
    if (this.stopping) throw this.stoppingError("daemon startup was cancelled before listen");
    commandStores(this.opts.commands);
    await this.opts.startupBarrier?.("after_registry_load");
    if (this.stopping) throw this.stoppingError("daemon startup was cancelled after registry load");
    if (pathExists(this.opts.socketPath)) {
      const stale = lstatSync(this.opts.socketPath);
      if (!stale.isSocket() || (process.getuid && stale.uid !== process.getuid())) {
        throw Object.assign(new Error(`refusing to replace non-owned Unix socket path`), {
          code: "unsafe_daemon_socket_path",
        });
      }
      unlinkSync(this.opts.socketPath);
    }
    if (this.stopping) throw this.stoppingError("daemon startup was cancelled before listen");
    await new Promise<void>((resolve, reject) => {
      this.server = createServer((sock) => this.onConnection(sock));
      this.server.once("error", reject);
      this.server.listen(this.opts.socketPath, () => {
        try {
          chmodSync(this.opts.socketPath, 0o600);
        } catch {
          /* best-effort on exotic filesystems */
        }
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    this.stopping = true;
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    for (const controller of this.controllers.values()) {
      try {
        controller.abort(new Error("daemon shutdown"));
      } catch {
        /* already gone */
      }
    }

    const settled = await Promise.allSettled([...this.activeTasks]);
    const rejected = settled.filter(
      (entry): entry is PromiseRejectedResult => entry.status === "rejected",
    );
    if (rejected.length > 0 || this.taskFailures.length > 0 || this.active !== 0) {
      const first =
        rejected[0]?.reason ??
        this.taskFailures[0] ??
        new Error(`daemon still owns ${this.active} active runner(s)`);
      throw Object.assign(
        new Error(
          `daemon shutdown drain failed: ${first instanceof Error ? first.message : String(first)}`,
        ),
        {
          code: "daemon_shutdown_unconfirmed",
          status: 503,
          cause: first,
        },
      );
    }
    // A signal may have fenced shutdown while listen() was still resolving.
    // Wait for that raw startup attempt, then close whatever listener exists;
    // start() observes `stopping` and refuses to advertise readiness.
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        /* a failed startup has no usable listener to preserve */
      }
    }
    const serverClosed = new Promise<void>((resolve, reject) => {
      if (!this.server) return resolve();
      try {
        this.server.close((error) => (error ? reject(error) : resolve()));
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ERR_SERVER_NOT_RUNNING") resolve();
        else reject(error);
      }
    });

    // Existing local RPC sockets can otherwise keep server.close() pending
    // forever. They are destroyed only after every accepted command settled.
    for (const socket of this.sockets) socket.destroy();
    await serverClosed;
    this.resolveShutdown();
  }

  /** Resolves when the daemon is shut down via RPC. */
  waitForShutdown(): Promise<void> {
    return this.shutdownPromise;
  }

  private onConnection(sock: Socket): void {
    this.sockets.add(sock);
    const rl = createInterface({ input: sock });
    rl.on("line", (line) => {
      void this.handle(line, sock);
    });
    sock.on("error", () => rl.close());
    sock.on("close", () => this.sockets.delete(sock));
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
      const code = errorCode(err);
      this.send(sock, {
        id,
        error: {
          message: redactSecrets(err instanceof Error ? err.message : String(err)),
          ...(code ? { code } : {}),
          ...(err && typeof err === "object" && "status" in err
            ? { status: Number((err as { status: unknown }).status) }
            : {}),
        },
      });
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
          jobs: this.allRecords().length,
          stopping: this.stopping,
        };
      case "claudexor.enqueue": {
        if (this.stopping) {
          throw Object.assign(new Error("daemon is stopping; retry after reconnect"), {
            code: "daemon_stopping",
            status: 503,
          });
        }
        const envelope = params as {
          request?: unknown;
          idempotencyKey?: unknown;
          clientId?: unknown;
          idempotencyRequest?: unknown;
          operation?: unknown;
        };
        const request = envelope?.request;
        const idempotencyKey = String(envelope?.idempotencyKey ?? "");
        const clientId = String(envelope?.clientId ?? "daemon-client");
        assertNoInlineSecretValues(request, "$", "daemon job params");
        const accepted = this.acceptCommand(
          request,
          idempotencyKey,
          clientId,
          envelope.idempotencyRequest,
          typeof envelope.operation === "string" ? envelope.operation : undefined,
        );
        if (!accepted.reused) this.queue.push(accepted.record.id);
        void this.drain();
        return { id: accepted.record.id, state: accepted.record.state };
      }
      case "claudexor.status": {
        const rec = this.getRecord(String(params?.id));
        if (!rec) throw new Error(`no such job: ${params?.id}`);
        return publicJobRecord(rec);
      }
      case "claudexor.findAccepted": {
        const store = commandStoreForRequest(this.opts.commands, params?.request);
        const record = store.find({
          params: params?.request,
          idempotencyKey: String(params?.idempotencyKey ?? ""),
          clientId: String(params?.clientId ?? "daemon-client"),
          operation: typeof params?.operation === "string" ? params.operation : undefined,
        });
        return record ? publicJobRecord(record) : null;
      }
      case "claudexor.list":
        return productCommandRecords(this.allRecords()).map(publicJobRecord);
      case "claudexor.cancel": {
        const jid = String(params?.id);
        const rec = this.getRecord(jid);
        if (!rec) throw new Error(`no such job: ${jid}`);
        this.cancelled.add(jid);
        if (rec.state === "queued") this.updateRecord(rec, { state: "cancelled" });
        this.controllers.get(jid)?.abort();
        return { id: jid, cancelled: true };
      }
      case "claudexor.shutdown":
        setTimeout(() => {
          const operation = this.opts.onShutdownRequested?.() ?? this.stop();
          void operation.catch(() => {
            // Fail closed: the process and ownership lease remain alive. The
            // composition root records the detailed failure in its private log.
          });
        }, 10);
        return { ok: true };
      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  private get maxConcurrent(): number {
    return this.opts.maxConcurrent ?? 4;
  }

  private stoppingError(message: string): Error & { code: string; status: number } {
    return Object.assign(new Error(message), { code: "daemon_stopping", status: 503 });
  }

  private pruneHistory(): void {
    const removed = prunableCommandIds(
      this.allRecords(),
      this.opts.maxHistory ?? 500,
      this.opts.idempotencyRetentionMs ?? 30 * 24 * 60 * 60 * 1_000,
      (this.opts.now ?? (() => new Date()))().getTime(),
    );
    for (const store of commandStores(this.opts.commands)) {
      store.prune(removed.filter((id) => store.get(id)));
    }
    for (const id of removed) this.cancelled.delete(id);
  }

  private acceptCommand(
    params: unknown,
    idempotencyKey: string,
    clientId: string,
    idempotencyParams?: unknown,
    operation?: string,
  ) {
    const store = commandStoreForRequest(this.opts.commands, params);
    return store.accept({
      id: newId("job"),
      params,
      idempotencyKey,
      clientId,
      idempotencyParams,
      operation,
    });
  }

  private allRecords(): JobRecord[] {
    return commandStores(this.opts.commands).flatMap((store) => store.records());
  }

  private getRecord(id: string): JobRecord | undefined {
    return commandStoreForId(this.opts.commands, id)?.get(id);
  }

  private updateRecord(record: JobRecord, patch: Partial<JobRecord>): JobRecord {
    const store = commandStoreForId(this.opts.commands, record.id);
    if (!store) throw new Error(`command authority lost job ${record.id}`);
    return store.update(record.id, patch);
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
    if (this.stopping) return;
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const busyThreads = new Set(
        this.allRecords()
          .filter((r) => r.state === "running")
          .map((r) => this.threadIdOf(r))
          .filter((t): t is string => !!t),
      );
      let pickIdx = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const rec = this.getRecord(this.queue[i]);
        const tid = rec ? this.threadIdOf(rec) : undefined;
        if (!rec || !tid || !busyThreads.has(tid)) {
          pickIdx = i;
          break;
        }
      }
      if (pickIdx === -1) break; // every queued job waits on a busy thread
      const id = this.queue.splice(pickIdx, 1)[0];
      const rec = this.getRecord(id);
      if (!rec) continue;
      if (this.cancelled.has(id)) {
        this.updateRecord(rec, { state: "cancelled", finishedAt: nowIso() });
        continue;
      }
      this.active += 1;
      const task = this.runJob(id, rec);
      this.activeTasks.add(task);
      void task.then(
        () => this.activeTasks.delete(task),
        (error) => {
          this.activeTasks.delete(task);
          this.taskFailures.push(error);
        },
      );
    }
  }

  private async runJob(id: string, rec: JobRecord): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    rec = this.updateRecord(rec, { state: "running", startedAt: nowIso() });
    try {
      const result = await this.opts.runner(rec.params, {
        signal: controller.signal,
        onRunStart: (info) => {
          rec = this.updateRecord(rec, info);
        },
      });
      const state = jobStateFromResult(result, controller.signal.aborted);
      if (
        state === "failed" ||
        state === "cost_unverifiable" ||
        state === "exhausted_overshoot" ||
        state === "exhausted" ||
        state === "not_converged" ||
        state === "stuck_no_progress"
      ) {
        rec = this.updateRecord(rec, {
          state,
          result,
          error: resultSummary(result) ?? `run ended with status ${state}`,
          finishedAt: nowIso(),
        });
      } else {
        rec = this.updateRecord(rec, { state, result, finishedAt: nowIso() });
      }
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as { code: unknown }).code
          : undefined;
      rec = this.updateRecord(rec, {
        state: controller.signal.aborted ? "cancelled" : "failed",
        error: redactSecrets(err instanceof Error ? err.message : String(err)),
        ...(typeof code === "string" && code ? { errorCode: code } : {}),
        finishedAt: nowIso(),
      });
    } finally {
      this.controllers.delete(id);
      this.active -= 1;
      if (rec.runId) {
        try {
          this.opts.onRunTerminal?.(rec.runId, this.threadIdOf(rec));
        } catch {
          /* observer failure must not corrupt terminal bookkeeping */
        }
      } else if (rec.error) {
        // Failure-shaped terminal with NO run ever bound: the refusal happened
        // before the run materialized. If this job carried a pre-created thread
        // turn, persist the reason on it (honest inline refusal, INV-093).
        const turnId = (rec.params as { turnId?: unknown } | null | undefined)?.turnId;
        if (typeof turnId === "string" && turnId) {
          try {
            this.opts.onTurnEnqueueFailed?.(turnId, rec.error, rec.errorCode ?? null);
          } catch {
            /* observer failure must not corrupt terminal bookkeeping */
          }
        }
      }
      this.pruneHistory();
      if (!this.stopping) this.drain();
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
    case "exhausted_overshoot":
    case "cost_unverifiable":
      return status;
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

function redactParams(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactParams);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      key === "prompt" && typeof child === "string" ? redactSecrets(child) : redactParams(child);
  }
  return out;
}
