import { describe, expect, it } from "vitest";
import {
  ProcessTiming,
  measureWork,
  processTiming,
  recordWorkSection,
  type WorkClass,
} from "./process-timing.js";
import { ModelPreparationTiming } from "./model-preparation-timing.js";

/** Busy-wait: a synchronous section of at least `ms`. */
const spin = (ms: number) => {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* hold the thread */
  }
};
const total = (kind: WorkClass, harness?: string) =>
  processTiming.facts().work.find((entry) => entry.kind === kind && entry.harness === harness)
    ?.lifetime ?? {
    count: 0,
    totalMs: 0,
    maxMs: 0,
  };

describe("main-thread work by class (timing.work)", () => {
  it("counts each section net of the sections nested in it, so classes add up once", () => {
    const handler = total("control.handler").totalMs;
    const commit = total("store.commit").totalMs;
    const launch = total("process.launch").totalMs;
    const outer = performance.now();
    let committed = 0;
    const value = measureWork("control.handler", () => {
      spin(5);
      const started = performance.now();
      spin(4); // a commit measured by its own owner
      committed = performance.now() - started;
      recordWorkSection("store.commit", committed);
      measureWork("process.launch", () => spin(5));
      return 7;
    });
    const elapsed = performance.now() - outer;
    expect(value).toBe(7);
    const handlerMs = total("control.handler").totalMs - handler;
    const launchMs = total("process.launch").totalMs - launch;
    expect(total("store.commit").totalMs - commit).toBeCloseTo(committed, 3);
    expect(launchMs).toBeGreaterThanOrEqual(5);
    expect(handlerMs).toBeGreaterThanOrEqual(5);
    // The commit and the launch are not counted again inside the handler.
    expect(handlerMs + launchMs + committed).toBeLessThanOrEqual(elapsed + 0.01);
    expect(handlerMs).toBeLessThan(elapsed - committed - launchMs + 0.01);
  });

  it("ends a section when its body returns a promise, and still records a throwing one", async () => {
    const before = total("journal.append").count;
    await measureWork("journal.append", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(total("journal.append").count).toBe(before + 1);
    expect(total("journal.append").maxMs).toBeLessThan(20);
    expect(() =>
      measureWork("journal.append", () => {
        throw new Error("refused");
      }),
    ).toThrow("refused");
    expect(total("journal.append").count).toBe(before + 2);
  });

  it("keeps run streams per harness, folds past 64 keys into other, and closes windows", () => {
    const timing = new ProcessTiming();
    timing.recordWork("run.stream", 2, "claude");
    timing.recordWork("run.stream", 3, "claude");
    timing.recordWork("catalog.read", 1);
    expect(timing.facts().work).toEqual([
      {
        kind: "run.stream",
        harness: "claude",
        lifetime: { count: 2, totalMs: 5, maxMs: 3 },
        window: null,
      },
      { kind: "catalog.read", lifetime: { count: 1, totalMs: 1, maxMs: 1 }, window: null },
    ]);
    timing.roll(10_000, new Date(0).toISOString());
    timing.recordWork("run.stream", 4, "claude");
    expect(timing.facts().work[0]).toMatchObject({
      lifetime: { count: 3, totalMs: 9 },
      window: { count: 2, totalMs: 5, maxMs: 3 },
    });
    for (let i = 0; i < 70; i += 1) timing.recordWork("run.stream", 1, `harness-${i}`);
    for (const kind of ["control.handler", "journal.append", "store.commit", "process.launch"])
      timing.recordWork(kind as WorkClass, 1);
    const work = timing.facts().work;
    expect(work.length).toBeLessThanOrEqual(64);
    expect(work.find((entry) => entry.harness === "other")?.lifetime.count).toBeGreaterThan(0);
  });
});

describe("preparation process deltas", () => {
  it("attributes only the measured process deltas to preparation", () => {
    const receipt = new ModelPreparationTiming().finish().process;
    expect(Object.keys(receipt).sort()).toEqual([
      "childLaunchMs",
      "childLaunches",
      "eventLoopActiveMs",
      "eventLoopIdleMs",
    ]);
  });
});
