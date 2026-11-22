import { processTiming } from "@claudexor/util";
import {
  type EventLoopUtilization,
  type IntervalHistogram,
  PerformanceObserver,
  monitorEventLoopDelay,
  performance,
} from "node:perf_hooks";
import type { DaemonLoopFacts } from "@claudexor/schema";

/** How often the daemon closes a measurement window. */
export const LOOP_FACTS_WINDOW_MS = 10_000;
/** A window is reported as delayed only when a measured fact reaches this. */
export const LOOP_STALL_THRESHOLD_MS = 1_000;
/** Event-loop delay sampling interval (the Node default). */
const RESOLUTION_MS = 10;

const ms = (nanoseconds: number) => Math.round(nanoseconds / 1_000) / 1_000;
/** A zero-length window has neither busy nor idle time (0/0): no fact, not 0. */
const busyShare = (share: number) =>
  Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : null;

/**
 * One window of event-loop measurements: delay samples from
 * `monitorEventLoopDelay`, the `eventLoopUtilization` delta, and the GC pauses
 * a `PerformanceObserver` reports. `roll()` closes the window, returns its
 * facts and starts the next one from zero, so a stall shows in the window it
 * happened in and never sticks to later ones.
 */
export class LoopFactsWindow {
  private readonly delay: IntervalHistogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  private readonly gc = { count: 0, totalMs: 0, maxMs: 0 };
  private readonly observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      this.gc.count += 1;
      this.gc.totalMs += entry.duration;
      this.gc.maxMs = Math.max(this.gc.maxMs, entry.duration);
    }
  });
  private startedAt = performance.now();
  private utilization: EventLoopUtilization = performance.eventLoopUtilization();

  constructor() {
    this.delay.enable();
    this.observer.observe({ entryTypes: ["gc"] });
  }

  roll(): DaemonLoopFacts {
    const now = performance.now();
    const utilization = performance.eventLoopUtilization();
    const samples = this.delay.count;
    const facts: DaemonLoopFacts = {
      windowMs: Math.round((now - this.startedAt) * 1_000) / 1_000,
      windowEndedAt: new Date().toISOString(),
      // An empty histogram reports placeholder percentiles; no sample is no fact.
      delay:
        samples > 0
          ? {
              resolutionMs: RESOLUTION_MS,
              samples,
              p50Ms: ms(this.delay.percentile(50)),
              p99Ms: ms(this.delay.percentile(99)),
              maxMs: ms(this.delay.max),
            }
          : null,
      utilization: busyShare(
        performance.eventLoopUtilization(utilization, this.utilization).utilization,
      ),
      gc: {
        count: this.gc.count,
        totalMs: Math.round(this.gc.totalMs * 1_000) / 1_000,
        maxMs: Math.round(this.gc.maxMs * 1_000) / 1_000,
      },
    };
    this.delay.reset();
    Object.assign(this.gc, { count: 0, totalMs: 0, maxMs: 0 });
    this.startedAt = now;
    this.utilization = utilization;
    return facts;
  }

  close(): void {
    this.delay.disable();
    this.observer.disconnect();
  }
}

let running: {
  window: LoopFactsWindow;
  timer: NodeJS.Timeout;
  last: DaemonLoopFacts | null;
} | null = null;

/**
 * Whether a closed window measured a held loop: one delay sample of at least
 * `thresholdMs`, or the window itself closing that late. A missing delay
 * histogram is unknown, never evidence either way.
 */
export function isDelayedLoopWindow(
  facts: DaemonLoopFacts,
  expectedMs: number,
  thresholdMs: number = LOOP_STALL_THRESHOLD_MS,
): boolean {
  return (facts.delay?.maxMs ?? 0) >= thresholdMs || facts.windowMs - expectedMs >= thresholdMs;
}

/**
 * Start the process's windowed loop facts; idempotent. Returns the stop for
 * this start (a no-op when facts were already running). `onWindow` sees each
 * closed window on the same timer; its failure never stops the facts.
 */
export function startLoopFacts(
  windowMs: number = LOOP_FACTS_WINDOW_MS,
  onWindow?: (facts: DaemonLoopFacts) => void,
): () => void {
  if (running) return () => {};
  const window = new LoopFactsWindow();
  const state = {
    window,
    last: null as DaemonLoopFacts | null,
    timer: setInterval(() => {
      state.last = window.roll();
      processTiming.roll(state.last.windowMs, state.last.windowEndedAt);
      try {
        onWindow?.(state.last);
      } catch {
        /* an observer never owns the measurement */
      }
    }, windowMs),
  };
  state.timer.unref?.();
  running = state;
  return () => {
    if (running !== state) return;
    clearInterval(state.timer);
    window.close();
    running = null;
  };
}

/** The last completed window; null before one completes or when not measured. */
export function loopFacts(): DaemonLoopFacts | null {
  return running?.last ?? null;
}
