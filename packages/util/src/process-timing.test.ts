import { describe, expect, expectTypeOf, it } from "vitest";
import { LatencyHistogram, ProcessTiming, measureSync, processTiming } from "./process-timing.js";

describe("bounded process timing", () => {
  it("records every worker kind without an attention kind in its input contract", () => {
    const kinds = ["cursor", "detail", "summary", "event-replay", "artifact"] as const;
    expectTypeOf<Parameters<ProcessTiming["recordBulk"]>[0]>().toEqualTypeOf<
      (typeof kinds)[number]
    >();
    const timing = new ProcessTiming();
    for (const kind of kinds) timing.recordBulk(kind, 1, 2);
    expect(timing.facts().bulk.map((entry) => entry.kind)).toEqual(kinds);
  });

  it("keeps approximate percentiles and exact count/max without storing samples", () => {
    const latency = new LatencyHistogram();
    expect(latency.facts()).toEqual({ count: 0, p50Ms: null, p99Ms: null, maxMs: null });
    for (let i = 1; i <= 100; i++) latency.record(i);
    expect(latency.facts()).toMatchObject({ count: 100, maxMs: 100 });
    expect(latency.facts().p50Ms!).toBeCloseTo(50, 0);
    expect(latency.facts().p99Ms!).toBeCloseTo(99, 0);
    latency.reset();
    latency.record(0);
    expect(latency.facts()).toEqual({ count: 1, p50Ms: 0, p99Ms: 0, maxMs: 0 });
  });

  it("preserves lifetime totals while closing independent windows, including empty ones", () => {
    const timing = new ProcessTiming();
    timing.recordRequest("GET", "/v2/runs/:id", 4);
    expect(timing.facts().routes[0]!.window).toBeNull();
    timing.roll(10_000, "2026-10-20T00:00:00.000Z");
    timing.recordRequest("GET", "/v2/runs/:id", 12);
    timing.recordRequest("POST", "/v2/runs", 8);
    const first = timing.facts();
    expect(first.routes[0]).toMatchObject({
      lifetime: { count: 2, maxMs: 12 },
      window: { count: 1, maxMs: 4 },
    });
    expect(first.routes[1]!.window).toMatchObject({ count: 0, maxMs: null });
    timing.roll(10_100, "2026-10-20T00:00:10.100Z");
    expect(timing.facts().routes[0]!.window).toMatchObject({ count: 1, maxMs: 12 });
    timing.roll(10_000, "2026-10-20T00:00:20.100Z");
    expect(timing.facts().routes[0]).toMatchObject({
      lifetime: { count: 2 },
      window: { count: 0, p99Ms: null },
    });
    expect(first.routes[0]!.window!.maxMs).toBe(4);
  });

  it("caps route cardinality and retains only the 32 worst sections as independent snapshots", () => {
    const timing = new ProcessTiming();
    for (let i = 0; i < 1_000; i++) {
      timing.recordRequest("GET", `/template-${i}`, i);
      timing.recordSync("store.commit", i);
    }
    const facts = timing.facts();
    expect(facts.routes).toHaveLength(256);
    expect(facts.routes.at(-1)).toMatchObject({
      method: "OTHER",
      route: "<unmatched>",
      lifetime: { count: 745 },
    });
    expect(facts.worstSync).toHaveLength(32);
    expect(facts.worstSync.map((s) => s.durationMs)).toEqual(
      Array.from({ length: 32 }, (_, i) => 999 - i),
    );
    facts.worstSync[0]!.durationMs = 0;
    expect(timing.facts().worstSync[0]!.durationMs).toBe(999);
  });

  it("reports whether a section became one of the 32 worst", () => {
    const timing = new ProcessTiming();
    for (let i = 0; i < 32; i++) expect(timing.recordSync("store.commit", 100 + i)).toBe(true);
    expect(timing.recordSync("store.external_write", 99)).toBe(false);
    expect(timing.recordSync("store.external_write", 100)).toBe(true);
    expect(timing.recordSync("store.external_write", Number.NaN)).toBe(false);
    expect(timing.facts().worstSync.at(-1)).toMatchObject({
      operation: "store.external_write",
      durationMs: 100,
    });
  });

  it("preserves return values and thrown errors, recording both synchronous outcomes", () => {
    const result = {};
    expect(measureSync("scope.persist", () => result)).toBe(result);
    const failure = new Error("fixture");
    expect(() =>
      measureSync("control.run_detail", () => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(processTiming.facts().worstSync.map((s) => s.operation)).toEqual(
      expect.arrayContaining(["scope.persist", "control.run_detail"]),
    );
  });
});

it("keeps queue residence separate from worker projection and route outcomes", () => {
  const timing = new ProcessTiming();
  timing.recordRequest("GET", "/v2/runs/:id", 2, "not_found");
  timing.recordRequest("GET", "/v2/runs/:id", 100, "served");
  timing.recordBulk("detail", 75, 25);
  expect(timing.facts().routes).toMatchObject([
    {
      lifetime: { count: 2 },
      outcomes: [
        { outcome: "not_found", lifetime: { count: 1, maxMs: 2 } },
        { outcome: "served", lifetime: { count: 1, maxMs: 100 } },
      ],
    },
  ]);
  expect(timing.facts().bulk).toMatchObject([
    { kind: "detail", queue: { count: 1, maxMs: 75 }, projection: { count: 1, maxMs: 25 } },
  ]);
  expect(timing.facts().worstSync).toEqual([]);
});
