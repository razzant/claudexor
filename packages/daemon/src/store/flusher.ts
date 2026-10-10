import { Worker } from "node:worker_threads";
import { StoreFlushUnavailableError } from "./errors.js";
import {
  FLUSH_INTERVAL_MS,
  STORE_WORKER_DATA_KEY,
  resolveStoreWorkerEntry,
  type FlusherCommand,
  type FlusherCounters,
  type FlusherEvent,
  type FlusherHooks,
  type FlusherPassReport,
  type FlusherWorkerData,
} from "./flusher-protocol.js";
// Static import: the worker module must be part of this module graph so the
// single-file daemon bundle embeds it (its self-start is inert on the main thread).
import "./flusher-worker.js";

export interface FlusherFacts {
  state: "starting" | "up" | "down";
  interval_ms: number;
  generation: number;
  acknowledged_generation: number;
  pending_registrations: number;
  pending_waiters: number;
  /** Age of the oldest outstanding registration or waiter; 0 when nothing waits. */
  flush_lag_ms: number;
  last_barrier_at: string | null;
  last_pass: {
    at: string;
    pass_ms: number;
    barrier_ms: number | null;
    dirty: boolean;
    barrier: boolean;
    wal_bytes: number | null;
    checkpoint: FlusherPassReport["checkpoint"];
  } | null;
  counters: FlusherCounters & { restarts: number; deaths: number };
}

export interface FlusherControllerOptions {
  dbPath: string;
  workerEntry?: string;
  hooks?: FlusherHooks;
  log?: (line: string) => void;
  onSynced?: (generation: number, report: FlusherPassReport) => void;
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  since: number;
}

interface Outstanding {
  g: number;
  since: number;
  command: FlusherCommand;
}

/**
 * Main-thread side of the flusher (SYNTHESIS_R5 §4.3): owns the monotonic
 * generation `g`, hands one to every external-file registration and every
 * `flushed()` call, forwards them to the worker in order, and resolves them
 * on `synced(G)`. Unacknowledged registrations live here and are replayed to
 * a restarted worker; waiters that predate a worker death are rejected typed
 * (`store_flush_unavailable`) — the commit is intact, only the power-loss
 * barrier is unproven until the next worker proves one.
 */
export class FlusherController {
  private readonly entry: string;
  private worker: Worker | null = null;
  private state: FlusherFacts["state"] = "starting";
  private generation = 0;
  private acknowledged = 0;
  private readonly outstanding: Outstanding[] = [];
  private readonly waiters = new Map<number, Waiter[]>();
  private lastReport: FlusherPassReport | null = null;
  private lastBarrierAt: number | null = null;
  private counters: FlusherCounters = {
    passes: 0,
    barriers: 0,
    dirSyncs: 0,
    busyPassive: 0,
    walReopens: 0,
  };
  private restarts = 0;
  private deaths = 0;
  private closing = false;
  private readyInThisLife = false;
  private restartTimer: NodeJS.Timeout | NodeJS.Immediate | null = null;

  constructor(private readonly options: FlusherControllerOptions) {
    this.entry =
      options.workerEntry ?? resolveStoreWorkerEntry(import.meta.url, "flusher-worker.js");
  }

  /** Spawn the worker and wait until it opened its connection (or died trying). */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.spawn(resolve);
    });
  }

  nextGeneration(): number {
    this.generation += 1;
    return this.generation;
  }

  /** A directory whose entries changed (rename/link); fsynced in the covering pass. */
  register(dir: string): number {
    const g = this.nextGeneration();
    this.send({ g, since: performance.now(), command: { type: "register", g, dir } });
    return g;
  }

  /** A generation with no waiter: "everything up to now" for an obligation to clear on. */
  mark(): number {
    const g = this.nextGeneration();
    this.send({ g, since: performance.now(), command: { type: "flush", g } });
    return g;
  }

  /** Resolves once a pass that started after this call proved its barrier. */
  flushed(): Promise<void> {
    const g = this.nextGeneration();
    return new Promise<void>((resolve, reject) => {
      this.addWaiter(g, { resolve, reject, since: performance.now() });
      this.send({ g, since: performance.now(), command: { type: "flush", g } });
    });
  }

  /** Resolves once an already issued generation (a mark or registration) is acknowledged. */
  awaitGeneration(g: number): Promise<void> {
    if (g <= this.acknowledged) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.addWaiter(g, { resolve, reject, since: performance.now() });
    });
  }

  private addWaiter(g: number, waiter: Waiter): void {
    const list = this.waiters.get(g);
    if (list) list.push(waiter);
    else this.waiters.set(g, [waiter]);
  }

  private eachWaiter(fn: (g: number, waiter: Waiter) => void): void {
    for (const [g, list] of this.waiters) for (const waiter of list) fn(g, waiter);
  }

  facts(): FlusherFacts {
    const now = performance.now();
    let oldest: number | null = null;
    for (const entry of this.outstanding)
      oldest = oldest === null ? entry.since : Math.min(oldest, entry.since);
    this.eachWaiter((_g, waiter) => {
      oldest = oldest === null ? waiter.since : Math.min(oldest, waiter.since);
    });
    const last = this.lastReport;
    return {
      state: this.state,
      interval_ms: FLUSH_INTERVAL_MS,
      generation: this.generation,
      acknowledged_generation: this.acknowledged,
      pending_registrations: this.outstanding.filter((e) => e.command.type === "register").length,
      pending_waiters: [...this.waiters.values()].reduce((n, list) => n + list.length, 0),
      flush_lag_ms: oldest === null ? 0 : Math.round(now - oldest),
      last_barrier_at:
        this.lastBarrierAt === null ? null : new Date(this.lastBarrierAt).toISOString(),
      last_pass: last
        ? {
            at: new Date(last.at).toISOString(),
            pass_ms: last.passMs,
            barrier_ms: last.barrierMs,
            dirty: last.dirty,
            barrier: last.barrier,
            wal_bytes: last.walBytes,
            checkpoint: last.checkpoint,
          }
        : null,
      counters: { ...this.counters, restarts: this.restarts, deaths: this.deaths },
    };
  }

  /** Test seam: run one pass now (worker spawned with `manualTick`). */
  tick(): void {
    this.worker?.postMessage({ type: "tick" } satisfies FlusherCommand);
  }

  /** Test seam: make the worker exit (worker spawned with `allowExit`). */
  requestExit(code: number): void {
    this.worker?.postMessage({ type: "exit", code } satisfies FlusherCommand);
  }

  async stop(): Promise<void> {
    this.closing = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer as NodeJS.Timeout);
      clearImmediate(this.restartTimer as NodeJS.Immediate);
      this.restartTimer = null;
    }
    const worker = this.worker;
    this.worker = null;
    this.eachWaiter((g, waiter) =>
      waiter.reject(new StoreFlushUnavailableError(g, "engine store is closing")),
    );
    this.waiters.clear();
    if (!worker) return;
    const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
    worker.postMessage({ type: "stop" } satisfies FlusherCommand);
    await Promise.race([exited, new Promise<void>((r) => setTimeout(r, FLUSH_INTERVAL_MS * 5))]);
    await worker.terminate();
    this.state = "down";
  }

  private send(entry: Outstanding): void {
    this.outstanding.push(entry);
    this.worker?.postMessage(entry.command);
  }

  private spawn(onSettled?: () => void): void {
    if (this.closing) return;
    const data: FlusherWorkerData = {
      [STORE_WORKER_DATA_KEY]: "flusher",
      dbPath: this.options.dbPath,
      hooks: this.options.hooks ?? {},
    };
    const worker = new Worker(this.entry, { workerData: data, name: "claudexor-store-flusher" });
    this.worker = worker;
    this.state = "starting";
    this.readyInThisLife = false;
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      onSettled?.();
    };
    worker.on("message", (event: FlusherEvent) => {
      if (this.worker !== worker) return;
      if (event.type === "ready") {
        this.readyInThisLife = true;
        this.state = "up";
        settle();
        return;
      }
      if (event.type === "synced") this.onSynced(event.report);
    });
    worker.on("error", (error) => {
      this.options.log?.(`store flusher worker error: ${error.message}`);
    });
    worker.on("exit", (code) => {
      if (this.worker !== worker) return;
      this.worker = null;
      if (this.closing) return;
      this.onDeath(code);
      settle();
    });
    // Replay everything the previous life never acknowledged, in generation order.
    for (const entry of this.outstanding) worker.postMessage(entry.command);
  }

  private onSynced(report: FlusherPassReport): void {
    this.lastReport = report;
    this.counters = report.counters;
    if (report.barrier) this.lastBarrierAt = report.at;
    if (report.g > this.acknowledged) this.acknowledged = report.g;
    let kept = 0;
    for (const entry of this.outstanding) {
      if (entry.g > report.g) this.outstanding[kept++] = entry;
    }
    this.outstanding.length = kept;
    for (const [g, list] of this.waiters) {
      if (g <= report.g) {
        this.waiters.delete(g);
        for (const waiter of list) waiter.resolve();
      }
    }
    this.options.onSynced?.(report.g, report);
  }

  private onDeath(code: number): void {
    this.deaths += 1;
    this.state = "down";
    this.options.log?.(`store flusher worker exited with code ${code}; restarting`);
    // Waiters created before the death are rejected typed; their flush
    // commands are dropped, registrations stay outstanding for the replay.
    this.eachWaiter((g, waiter) =>
      waiter.reject(
        new StoreFlushUnavailableError(g, `the flusher worker exited with code ${code}`),
      ),
    );
    this.waiters.clear();
    let kept = 0;
    for (const entry of this.outstanding) {
      if (entry.command.type === "register") this.outstanding[kept++] = entry;
    }
    this.outstanding.length = kept;
    // A worker that never reported ready failed at startup; retry after one
    // interval instead of spinning on the next tick.
    const restart = (): void => {
      this.restartTimer = null;
      if (this.closing) return;
      this.restarts += 1;
      this.spawn();
      // Drive the new worker's g_target to the current generation so the next
      // pass covers every commit made during the gap.
      this.send({
        g: this.generation,
        since: performance.now(),
        command: { type: "flush", g: this.generation },
      });
    };
    this.restartTimer = this.readyInThisLife
      ? setImmediate(restart)
      : setTimeout(restart, FLUSH_INTERVAL_MS);
  }
}
