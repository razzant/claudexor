import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

export type PreparationStep =
  | "payloadRead"
  | "payloadParse"
  | "admission"
  | "loginProbe"
  | "catalogRead"
  | "catalogTransport"
  | "selection"
  | "reserve"
  | "adapterAuth"
  | "adapterBody";
type Samples = { count: number; totalMs: number; maxMs: number };
type Timing = {
  totalMs: number;
  steps: Partial<Record<PreparationStep, Samples>>;
  process: {
    eventLoopActiveMs: number;
    eventLoopIdleMs: number;
    childLaunches: number;
    childLaunchMs: number;
  };
};
const active = new AsyncLocalStorage<ModelPreparationTiming>();
let launches = 0;
let launchMs = 0;

/** Cumulative process counters; no per-child retention, body or identity. */
export function recordChildLaunch(milliseconds: number): void {
  launches += 1;
  launchMs += Math.max(0, milliseconds);
}

/** Operation wall-clock spans can overlap. Process deltas include concurrent
 * operations, like loop-facts: they are never attributed CPU cost. */
export class ModelPreparationTiming {
  private readonly started = performance.now();
  private readonly loop = performance.eventLoopUtilization();
  private readonly launches = launches;
  private readonly launchMs = launchMs;
  private readonly steps: Timing["steps"] = {};
  private finished?: Timing;

  run<T>(work: () => T): T {
    return active.run(this, work);
  }
  record(step: PreparationStep, milliseconds: number): void {
    if (this.finished) return;
    const sample = (this.steps[step] ??= { count: 0, totalMs: 0, maxMs: 0 });
    sample.count += 1;
    sample.totalMs += milliseconds;
    sample.maxMs = Math.max(sample.maxMs, milliseconds);
  }
  finish(): Timing {
    if (!this.finished) {
      const loop = performance.eventLoopUtilization(this.loop);
      this.finished = {
        totalMs: performance.now() - this.started,
        steps: structuredClone(this.steps),
        process: {
          eventLoopActiveMs: Math.max(0, loop.active),
          eventLoopIdleMs: Math.max(0, loop.idle),
          childLaunches: launches - this.launches,
          childLaunchMs: Math.max(0, launchMs - this.launchMs),
        },
      };
    }
    return structuredClone(this.finished);
  }
}

export async function measureModelPreparation<T>(
  step: PreparationStep,
  work: () => Promise<T>,
): Promise<T> {
  const owner = active.getStore();
  if (!owner) return work();
  const start = performance.now();
  try {
    return await work();
  } finally {
    owner.record(step, performance.now() - start);
  }
}

export function measureModelPreparationSync<T>(step: PreparationStep, work: () => T): T {
  const owner = active.getStore();
  if (!owner) return work();
  const start = performance.now();
  try {
    return work();
  } finally {
    owner.record(step, performance.now() - start);
  }
}
