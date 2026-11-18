import { performance } from "node:perf_hooks";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { DaemonLoopFacts } from "@claudexor/schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  isDelayedLoopWindow,
  LOOP_STALL_THRESHOLD_MS,
  LoopFactsWindow,
  loopFacts,
  startLoopFacts,
} from "./loop-facts.js";

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

const turn = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function blockLoop(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* hold the event loop */
  }
}

describe("LoopFactsWindow", () => {
  it("reports a stall in the window it happened in, then starts the next window from zero", async () => {
    const window = new LoopFactsWindow();
    stops.push(() => window.close());
    await turn(30);
    blockLoop(150);
    await turn(40); // let the delay sampler observe the stall
    const stalled = DaemonLoopFacts.parse(window.roll());
    // A lower bound the stall guarantees, not a timing expectation.
    expect(stalled.delay?.maxMs).toBeGreaterThanOrEqual(150);
    expect(stalled.delay?.p99Ms).toBeLessThanOrEqual(stalled.delay?.maxMs ?? 0);
    expect(stalled.delay?.resolutionMs).toBe(10);
    expect(stalled.delay?.samples).toBeGreaterThan(0);
    expect(stalled.windowMs).toBeGreaterThanOrEqual(150);
    expect(stalled.utilization).not.toBeNull();
    // No event-loop turn between two rolls: the reset window holds no sample
    // and no GC entry, so nothing from the stall carries over.
    const next = DaemonLoopFacts.parse(window.roll());
    expect(next.delay).toBeNull();
    expect(next.gc).toEqual({ count: 0, totalMs: 0, maxMs: 0 });
  });

  it("counts garbage-collection pauses per window", async () => {
    const window = new LoopFactsWindow();
    stops.push(() => window.close());
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    window.roll();
    gc();
    await turn(20); // GC entries reach the observer asynchronously
    const facts = DaemonLoopFacts.parse(window.roll());
    expect(facts.gc.count).toBeGreaterThanOrEqual(1);
    expect(facts.gc.totalMs).toBeGreaterThanOrEqual(facts.gc.maxMs);
    expect(window.roll().gc.count).toBe(0);
  });
});

describe("startLoopFacts / loopFacts", () => {
  it("is null until a window completes, serves the last window, and stops cleanly", async () => {
    expect(loopFacts()).toBeNull();
    const stop = startLoopFacts(20);
    stops.push(stop);
    expect(loopFacts()).toBeNull();
    // A second start while running neither restarts nor stops the first.
    startLoopFacts(20)();
    for (let i = 0; i < 250 && loopFacts() === null; i += 1) await turn(20);
    const facts = DaemonLoopFacts.parse(loopFacts());
    expect(facts.windowMs).toBeGreaterThan(0);
    stop();
    expect(loopFacts()).toBeNull();
  });
});

describe("delayed loop windows (#707)", () => {
  const facts = (windowMs: number, maxMs: number | null): DaemonLoopFacts => ({
    windowMs,
    windowEndedAt: "2026-11-17T12:00:00.000Z",
    delay:
      maxMs === null ? null : { resolutionMs: 10, samples: 3, p50Ms: 10, p99Ms: maxMs, maxMs },
    utilization: null,
    gc: { count: 0, totalMs: 0, maxMs: 0 },
  });

  it("counts a long delay sample or a late close, never a missing histogram", () => {
    const at = LOOP_STALL_THRESHOLD_MS;
    expect(isDelayedLoopWindow(facts(10_000, at), 10_000)).toBe(true);
    expect(isDelayedLoopWindow(facts(10_000 + at, null), 10_000)).toBe(true);
    expect(isDelayedLoopWindow(facts(10_000 + at - 1, at - 1), 10_000)).toBe(false);
    expect(isDelayedLoopWindow(facts(10_000, null), 10_000)).toBe(false);
  });

  it("hands each closed window to the observer, whose failure never stops the facts", async () => {
    const seen: DaemonLoopFacts[] = [];
    const stop = startLoopFacts(20, (window) => {
      seen.push(window);
      throw new Error("observer failed");
    });
    stops.push(stop);
    for (let i = 0; i < 250 && seen.length < 2; i += 1) await turn(20);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(loopFacts()).toBe(seen.at(-1));
  });
});
