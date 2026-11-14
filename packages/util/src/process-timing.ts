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
  private windowMs: number | null = null;
  private windowEndedAt: string | null = null;

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
      bulk: [...this.bulk].map(([kind, entry]) => ({
        kind,
        queue: entry.queue.facts(),
        projection: entry.projection.facts(),
      })),
    };
  }
}

export const processTiming = new ProcessTiming();

/** Only wrap synchronous work: including an await would mislabel wall time. */
export function measureSync<T>(operation: SyncOperation, body: () => T): T {
  const started = performance.now();
  try {
    return body();
  } finally {
    processTiming.recordSync(operation, performance.now() - started);
  }
}
