import { createHistogram } from "node:perf_hooks";

const roundedMs = (value: number): number => Math.round(value * 1_000) / 1_000;

/** Fixed-capacity HDR histogram: no samples or caller data are retained. */
export class LatencyHistogram {
  private readonly histogram = createHistogram({ figures: 2 });
  private maximum: number | null = null;

  record(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.histogram.record(
      Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.round(durationMs * 1_000))),
    );
    this.maximum = Math.max(this.maximum ?? 0, durationMs);
  }

  facts() {
    const maxMs = this.maximum === null ? null : roundedMs(this.maximum);
    return {
      count: this.histogram.count,
      p50Ms: maxMs === null ? null : Math.min(maxMs, this.histogram.percentile(50) / 1_000),
      p99Ms: maxMs === null ? null : Math.min(maxMs, this.histogram.percentile(99) / 1_000),
      maxMs,
    };
  }

  reset(): void {
    this.histogram.reset();
    this.maximum = null;
  }
}

export type SyncOperation =
  | "store.begin_immediate"
  | "store.commit"
  | "store.external_write"
  | "control.run_detail"
  | "control.run_summary"
  | "scope.persist"
  // Synchronous work that deliberately stays on the main thread (#688):
  | "process.identity_capture"
  | "run.telemetry_write"
  | "metrics.harness_write"
  | "file.write_text"
  | "file.capture_write"
  | "daemon.log_line";
/** Classes of main-thread work the daemon attributes (`timing.work`). */
export type WorkClass =
  | "control.handler"
  | "run.stream"
  | "journal.append"
  | "store.commit"
  | "catalog.read"
  | "process.launch";
type WorkTotals = { count: number; totalMs: number; maxMs: number };
const noWork = (): WorkTotals => ({ count: 0, totalMs: 0, maxMs: 0 });
const roundedWork = (totals: WorkTotals): WorkTotals => ({
  count: totals.count,
  totalMs: roundedMs(totals.totalMs),
  maxMs: roundedMs(totals.maxMs),
});
type LatencyFacts = ReturnType<LatencyHistogram["facts"]>;
type SyncSample = { operation: SyncOperation; durationMs: number; at: string };
export type RequestOutcome =
  "served" | "not_found" | "disconnected_at_entry" | "disconnected" | "failed";
const empty = (): LatencyFacts => ({ count: 0, p50Ms: null, p99Ms: null, maxMs: null });

/** Shared by the in-process HTTP and daemon owners, without a dependency cycle. */
export class ProcessTiming {
  private readonly routes = new Map<
    string,
    {
      method: string;
      route: string;
      outcomes: Map<
        RequestOutcome,
        { lifetime: LatencyHistogram; current: LatencyHistogram; window: LatencyFacts | null }
      >;
      lifetime: LatencyHistogram;
      current: LatencyHistogram;
      window: LatencyFacts | null;
    }
  >();
  private readonly worst: SyncSample[] = [];
  private readonly bulk = new Map<
    string,
    { queue: LatencyHistogram; projection: LatencyHistogram }
  >();
  private readonly work = new Map<
    string,
    {
      kind: WorkClass;
      harness: string | null;
      lifetime: WorkTotals;
      current: WorkTotals;
      window: WorkTotals | null;
    }
  >();
  private windowMs: number | null = null;
  private windowEndedAt: string | null = null;

  /** Main-thread time of one section of `kind`, by harness for run streams. Past
   * 57 keys a new harness folds into `other`, so with the six classes the facts
   * never exceed 64 keys. In memory only. */
  recordWork(kind: WorkClass, durationMs: number, harness: string | null = null): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    if (harness !== null && this.work.size >= 57 && !this.work.has(`${kind}\0${harness}`))
      harness = "other";
    const key = `${kind}\0${harness ?? ""}`;
    let entry = this.work.get(key);
    if (!entry) {
      const window = this.windowEndedAt === null ? null : noWork();
      entry = { kind, harness, lifetime: noWork(), current: noWork(), window };
      this.work.set(key, entry);
    }
    for (const totals of [entry.lifetime, entry.current]) {
      totals.count += 1;
      totals.totalMs += durationMs;
      totals.maxMs = Math.max(totals.maxMs, durationMs);
    }
  }

  recordRequest(method: string, route: string, durationMs: number, outcome?: RequestOutcome): void {
    let key = `${method} ${route}`;
    // Reserve one slot for unknown methods/routes and future catalog growth.
    if (!this.routes.has(key) && this.routes.size >= 255) {
      method = "OTHER";
      route = "<unmatched>";
      key = `${method} ${route}`;
    }
    let entry = this.routes.get(key);
    if (!entry) {
      entry = {
        method,
        route,
        outcomes: new Map(),
        lifetime: new LatencyHistogram(),
        current: new LatencyHistogram(),
        window: this.windowEndedAt === null ? null : empty(),
      };
      this.routes.set(key, entry);
    }
    entry.lifetime.record(durationMs);
    entry.current.record(durationMs);
    if (outcome) {
      let split = entry.outcomes.get(outcome);
      if (!split) {
        split = {
          lifetime: new LatencyHistogram(),
          current: new LatencyHistogram(),
          window: this.windowEndedAt === null ? null : empty(),
        };
        entry.outcomes.set(outcome, split);
      }
      split.lifetime.record(durationMs);
      split.current.record(durationMs);
    }
  }

  /** Queue residence and worker execution are wall time, never main-thread sync spans. */
  recordBulk(
    kind: "cursor" | "detail" | "summary" | "event-replay" | "artifact",
    queueMs: number,
    projectionMs: number,
  ): void {
    let entry = this.bulk.get(kind);
    if (!entry)
      this.bulk.set(
        kind,
        (entry = { queue: new LatencyHistogram(), projection: new LatencyHistogram() }),
      );
    entry.queue.record(queueMs);
    entry.projection.record(projectionMs);
  }

  /** True when the sample is now one of the 32 worst sections (`worstSync`). */
  recordSync(operation: SyncOperation, durationMs: number): boolean {
    if (!Number.isFinite(durationMs) || durationMs < 0) return false;
    const duration = roundedMs(durationMs);
    if (this.worst.length === 32 && duration < this.worst[31]!.durationMs) return false;
    const index = this.worst.findIndex((sample) => sample.durationMs <= duration);
    this.worst.splice(index < 0 ? this.worst.length : index, 0, {
      operation,
      durationMs: duration,
      at: new Date().toISOString(),
    });
    this.worst.length = Math.min(this.worst.length, 32);
    return true;
  }

  roll(windowMs: number, windowEndedAt: string): void {
    for (const entry of this.routes.values()) {
      entry.window = entry.current.facts();
      entry.current.reset();
      for (const split of entry.outcomes.values()) {
        split.window = split.current.facts();
        split.current.reset();
      }
    }
    for (const entry of this.work.values()) {
      entry.window = entry.current;
      entry.current = noWork();
    }
    this.windowMs = windowMs;
    this.windowEndedAt = windowEndedAt;
  }

  facts() {
    return {
      windowMs: this.windowMs,
      windowEndedAt: this.windowEndedAt,
      routes: [...this.routes.values()].map((entry) => ({
        method: entry.method,
        route: entry.route,
        ...(entry.outcomes.size
          ? {
              outcomes: [...entry.outcomes].map(([outcome, split]) => ({
                outcome,
                lifetime: split.lifetime.facts(),
                window: split.window && { ...split.window },
              })),
            }
          : {}),
        lifetime: entry.lifetime.facts(),
        window: entry.window && { ...entry.window },
      })),
      worstSync: this.worst.map((sample) => ({ ...sample })),
      work: [...this.work.values()].map(({ kind, harness, lifetime, window }) => ({
        kind,
        ...(harness === null ? {} : { harness }),
        lifetime: roundedWork(lifetime),
        window: window && roundedWork(window),
      })),
      bulk: [...this.bulk].map(([kind, entry]) => ({
        kind,
        queue: entry.queue.facts(),
        projection: entry.projection.facts(),
      })),
    };
  }
}

export const processTiming = new ProcessTiming();

/** Open work sections, innermost last: each excludes the sections nested in it. */
const openWork: Array<{ nestedMs: number }> = [];

/** Attribute a synchronous section measured elsewhere (a store commit, a child
 * launch) to `kind`, excluding it from the section it ran inside. */
export function recordWorkSection(kind: WorkClass, durationMs: number, harness?: string): void {
  processTiming.recordWork(kind, durationMs, harness ?? null);
  const parent = openWork.at(-1);
  if (parent && Number.isFinite(durationMs) && durationMs > 0) parent.nestedMs += durationMs;
}

/** Time a synchronous section as main-thread work of `kind`, net of nested
 * sections, so the classes add up without double counting. Never wrap an await:
 * a returned promise ends the section (its continuations are not counted). */
export function measureWork<T>(kind: WorkClass, body: () => T, harness?: string | null): T {
  const frame = { nestedMs: 0 };
  openWork.push(frame);
  const started = performance.now();
  try {
    return body();
  } finally {
    openWork.pop();
    const elapsed = performance.now() - started;
    processTiming.recordWork(kind, Math.max(0, elapsed - frame.nestedMs), harness ?? null);
    const parent = openWork.at(-1);
    if (parent) parent.nestedMs += elapsed;
  }
}

/** Only wrap synchronous work: including an await would mislabel wall time. */
export function measureSync<T>(operation: SyncOperation, body: () => T): T {
  const started = performance.now();
  try {
    return body();
  } finally {
    processTiming.recordSync(operation, performance.now() - started);
  }
}
