import { describe, expect, it } from "vitest";
import ts from "typescript-api";
import {
  benchmarkOptions,
  buildSummaries,
  instrumentSyncFunction,
  loopTail,
  runSummary,
  trialOrder,
} from "./daemon-load-bench.mjs";
import { measureSyncSection, SyncWindowObserver, syncWindows } from "./daemon-load-observer.mjs";

describe("daemon load comparison", () => {
  it("accepts both option spellings and more than four AB/BA pairs", () => {
    const spaced = benchmarkOptions(["--rounds", "6", "--seconds", "1", "--out", "a=b.json"]);
    expect(spaced).toEqual(benchmarkOptions(["--rounds=6", "--seconds=1", "--out=a=b.json"]));
    expect(benchmarkOptions([]).rounds).toBe(2);
    const order = [...trialOrder(spaced.rounds)];
    expect(order.map((run) => run.label)).toEqual(
      Array.from({ length: 3 }, () => ["base", "candidate", "candidate", "base"]).flat(),
    );
    expect(order.filter((run) => run.label === "base").map((run) => run.round)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect([...trialOrder(3)].slice(-2)).toEqual([
      { label: "base", round: 3 },
      { label: "candidate", round: 3 },
    ]);
  });

  it.each([
    ["--rounds", "0"],
    ["--rounds=-1"],
    ["--rounds=1.5"],
    ["--rounds=NaN"],
    ["--rounds=9007199254740992"],
    ["--rounds"],
    ["--seconds=0"],
    ["--seconds=121"],
    ["--round=2"],
    ["unrecognised"],
  ])("rejects invalid arguments %j", (...argv) => {
    expect(() => benchmarkOptions(argv)).toThrow();
  });

  it("keeps every window's own worst labels, including small later windows", () => {
    const observer = new SyncWindowObserver();
    for (let i = 0; i < 50; i++) observer.record("store.commit", i, 10_000);
    observer.record("store.external_write", 200, 10_000);
    const first = observer.roll({ windowEndedAt: "first", windowMs: 1_000 });
    expect(first.worstSync).toMatchObject({ operation: "store.external_write", durationMs: 200 });
    expect(first.syncSections).toHaveLength(2);
    observer.record("store.begin_immediate", 3, 11_000);
    const second = observer.roll({ windowEndedAt: "second", windowMs: 1_000 });
    expect(second.worstSync).toMatchObject({ operation: "store.begin_immediate", durationMs: 3 });
    expect(first.worstSync.durationMs).toBe(200);
    expect(observer.roll({}).worstSync).toBeNull();
    observer.record("store.commit", 100, 12_000);
    observer.reset(); // preparation before the measured workload is excluded
    expect(observer.roll({}).syncSections).toEqual([]);
  });

  it("instruments the function body while preserving returns, throws and lexical arguments", () => {
    const transformed = instrumentSyncFunction(
      `
      export function detailFor(this: { value: number }, fail: boolean): number {
        if (fail) throw new Error('projection failed');
        return this.value + arguments.length;
      }`,
      "detailFor",
      "control.run_detail",
    );
    const js = ts.transpileModule(transformed, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exported = {};
    const load = new Function("require", "exports", js);
    const observe = [];
    load(
      () => ({
        measureSyncSection: (label, body) => {
          observe.push(label);
          return body();
        },
      }),
      exported,
    );
    expect(exported.detailFor.call({ value: 7 }, false)).toBe(8);
    expect(() => exported.detailFor.call({ value: 7 }, true)).toThrow("projection failed");
    expect(observe).toEqual(["control.run_detail", "control.run_detail"]);
    for (const source of [
      "function renamed() {}",
      "async function detailFor() {}",
      "function* detailFor() {}",
    ])
      expect(() => instrumentSyncFunction(source, "detailFor", "control.run_detail")).toThrow(
        "exactly one synchronous function",
      );
    syncWindows.reset();
    expect(() =>
      measureSyncSection("control.run_detail", () => {
        throw new Error("failed");
      }),
    ).toThrow("failed");
    expect(syncWindows.roll({}).worstSync.operation).toBe("control.run_detail");
  });

  it("reports COMMIT and loop tails separately without averaging percentiles", () => {
    const window = (p99Ms, maxMs, operation) => ({
      windowEndedAt: "2026-10-20T00:00:10Z",
      windowMs: 10_000,
      delay: { p99Ms, maxMs },
      worstSync: { operation, durationMs: maxMs - 1 },
    });
    const row = {
      label: "base",
      round: 1,
      writes: 6_000,
      reads: 1_800,
      commit: { attempts: 6_001, failures: 0, p99_ms: 20, max_ms: 400 },
      loops: [window(40, 50, "store.commit"), window(10, 900, "store.external_write")],
    };
    const summary = runSummary(row);
    expect(summary.commit).toMatchObject({ p99Ms: 20, maxMs: 400 });
    expect(summary.eventLoop).toMatchObject({
      worstWindowP99Ms: 40,
      maxMs: 900,
      maxWindow: { worstSync: { operation: "store.external_write" } },
    });
    const second = {
      ...row,
      round: 2,
      commit: { p99_ms: 30, max_ms: 300 },
      loops: [window(25, 450, "store.begin_immediate")],
    };
    const builds = buildSummaries([row, second, { ...row, label: "candidate" }]);
    expect(builds[0]).toMatchObject({
      build: "base",
      runs: 2,
      commit: { worstRunP99Ms: 30, maxMs: 400 },
      eventLoop: { worstWindowP99Ms: 40, maxMs: 900 },
    });
    expect(builds[1].runs).toBe(1);
    expect(loopTail([{ delay: null }])).toEqual({
      worstWindowP99Ms: null,
      maxMs: null,
      maxWindow: null,
    });
  });
});
