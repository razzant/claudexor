import { describe, expect, it, vi } from "vitest";
import {
  ControlRunSummary,
  RunFailure,
  selectRunListPage,
  type RunListQuery,
} from "@claudexor/schema";
import {
  ROUTE_HEALTH_PAGE_LIMIT,
  ROUTE_HEALTH_SCAN_BOUND,
  aggregateRouteHealth,
  failureMessageLine,
  scanRouteHealth,
  type RouteHealthFactsCache,
  type RouteHealthRun,
} from "./route-health.js";
import type { DaemonRunRecord } from "./run-record.js";

const now = new Date("2026-10-28T12:00:00.000Z");
const from = "2026-10-21T12:00:00.000Z";
const scan = { from, generatedAt: now.toISOString(), complete: true, incompleteReason: null };

function summary(input: Record<string, unknown>): ControlRunSummary {
  return ControlRunSummary.parse({ jobId: "job", runId: "run", ...input });
}

function failure(input: Record<string, unknown>) {
  return RunFailure.parse({ safeMessage: "failed", ...input });
}

/** A run on an explicit route: telemetry-settled harness + effective access. */
function run(
  lifecycle: string,
  harnessId: string,
  effectiveAccess: string | undefined,
  extra: Record<string, unknown> = {},
): RouteHealthRun {
  return {
    lifecycle,
    facts: summary({
      state: lifecycle,
      route: { harnessId },
      ...(effectiveAccess === undefined ? {} : { effectiveAccess }),
      ...extra,
    }),
  };
}

const refused = failure({
  category: "harness_error",
  harnessId: "agy",
  safeMessage: "agy headless tool permission refused: read_file\nsecond line is dropped",
});

describe("route health aggregation", () => {
  it("counts every lifecycle per route, orders routes and ranks a route's failures", () => {
    const runs: RouteHealthRun[] = [
      ...Array.from({ length: 3 }, () => run("succeeded", "agy", "readonly")),
      ...Array.from({ length: 3 }, () => run("failed", "agy", "readonly", { failure: refused })),
      run("failed", "agy", "readonly", {
        failure: failure({ category: "auth", code: "subscription_window_exhausted" }),
      }),
      run("failed", "agy", "readonly", { failure: failure({ category: "budget" }) }),
      run("failed", "agy", "readonly", { failure: failure({ category: "internal" }) }),
      run("cancelled", "agy", "readonly"),
      run("interrupted", "agy", "readonly"),
      ...Array.from({ length: 19 }, () => run("succeeded", "claude", "readonly")),
      run("failed", "claude", "readonly", { failure: failure({ category: "auth" }) }),
      ...Array.from({ length: 5 }, () => run("succeeded", "codex", "workspace_write")),
      run("succeeded", "claude", "full"),
    ];
    const health = aggregateRouteHealth(runs, scan);
    expect(health).toMatchObject({
      windowDays: 7,
      from,
      generatedAt: now.toISOString(),
      scannedRuns: runs.length,
      complete: true,
      incompleteReason: null,
    });
    expect(health.routes.map((r) => `${r.harnessId}/${r.access}`)).toEqual([
      "agy/readonly",
      "claude/full",
      "claude/readonly",
      "codex/workspace_write",
    ]);
    expect(health.routes[0]).toEqual({
      harnessId: "agy",
      access: "readonly",
      runs: 11,
      succeeded: 3,
      failed: 6,
      cancelled: 2,
      other: 0,
      topFailures: [
        {
          category: "harness_error",
          code: null,
          message: "agy headless tool permission refused: read_file",
          count: 3,
        },
        // Ties are broken by category, code, message — never by arrival order.
        { category: "auth", code: "subscription_window_exhausted", message: "failed", count: 1 },
        { category: "budget", code: null, message: "failed", count: 1 },
      ],
    });
    expect(health.routes[2]).toMatchObject({ runs: 20, succeeded: 19, failed: 1 });
    expect(health.routes[2]?.topFailures).toHaveLength(1);
    expect(health.routes[3]).toMatchObject({ runs: 5, succeeded: 5, failed: 0, topFailures: [] });
  });

  it("reports unknown access, folds the retired profile into full, and never guesses", () => {
    const health = aggregateRouteHealth(
      [
        run("succeeded", "codex", undefined),
        run("succeeded", "codex", "external_sandbox_full"),
        run("succeeded", "codex", "full"),
      ],
      scan,
    );
    expect(health.routes.map((r) => [r.access, r.runs])).toEqual([
      ["full", 2],
      ["unknown", 1],
    ]);
  });

  it("names the harness from the route, else the failure, else the primary harness, else unknown", () => {
    const health = aggregateRouteHealth(
      [
        {
          lifecycle: "failed",
          facts: summary({
            state: "failed",
            route: { harnessId: null },
            failure: failure({ harnessId: "cursor" }),
            primaryHarness: "codex",
          }),
        },
        {
          lifecycle: "succeeded",
          facts: summary({ state: "succeeded", primaryHarness: "codex" }),
        },
        { lifecycle: "succeeded", facts: summary({ state: "succeeded", primaryHarness: "" }) },
        { lifecycle: "succeeded", facts: summary({ state: "succeeded" }) },
      ],
      scan,
    );
    expect(health.routes.map((r) => [r.harnessId, r.runs])).toEqual([
      ["codex", 1],
      ["cursor", 1],
      ["unknown", 2],
    ]);
  });

  it("groups a failure without a typed record as unknown and keeps the sum invariant", () => {
    const health = aggregateRouteHealth(
      [
        // readFailure already turns a bare job error into an unknown-category record;
        // a summary with neither still reports one empty unknown group.
        run("failed", "agy", "readonly", { error: "spawn ENOENT" }),
        run("failed", "agy", "readonly"),
        run("failed", "agy", "readonly", {
          failure: failure({ category: "unknown", safeMessage: "spawn ENOENT" }),
        }),
        {
          lifecycle: "expired",
          facts: summary({ state: "failed", effectiveAccess: "readonly" }),
        },
      ],
      scan,
    );
    expect(health.routes).toEqual([
      {
        harnessId: "agy",
        access: "readonly",
        runs: 3,
        succeeded: 0,
        failed: 3,
        cancelled: 0,
        other: 0,
        topFailures: [
          { category: "unknown", code: null, message: "spawn ENOENT", count: 2 },
          { category: "unknown", code: null, message: "", count: 1 },
        ],
      },
      // A lifecycle outside the four known terminals lands in `other`, never dropped.
      {
        harnessId: "unknown",
        access: "readonly",
        runs: 1,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
        other: 1,
        topFailures: [],
      },
    ]);
  });

  it("keeps the first line of a message, redacts it and cuts it at 160 characters", () => {
    expect(failureMessageLine("  one line  \r\nsecond")).toBe("one line");
    expect(failureMessageLine(`Authorization: Bearer ${"d".repeat(40)} refused`)).toContain(
      "[redacted]",
    );
    expect(failureMessageLine("m".repeat(160))).toBe("m".repeat(160));
    const cut = failureMessageLine("m".repeat(161));
    expect(cut).toBe(`${"m".repeat(159)}…`);
    expect(cut).toHaveLength(160);
    // A cut never leaves half of an astral character behind.
    const astral = failureMessageLine(`${"m".repeat(158)}\u{1F600}${"m".repeat(10)}`);
    expect(astral).toBe(`${"m".repeat(158)}…`);
  });
});

function record(
  id: string,
  state: string,
  createdAt: string | undefined,
  finishedAt?: string,
): DaemonRunRecord {
  return {
    id,
    runId: id,
    state,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
  };
}

/** The daemon's page selector: newest first, keyset cursor, limit + 1 rows. */
function pageSource(
  records: DaemonRunRecord[],
  active?: () => boolean,
  cache?: RouteHealthFactsCache,
) {
  // The lifecycle counted is the record's, so the fake facts can stay fixed.
  const fixed = summary({ state: "succeeded", route: { harnessId: "claude" } });
  const list = vi.fn(
    async (query: RunListQuery) =>
      selectRunListPage(records, { ...query, limit: query.limit + 1 }).page,
  );
  const facts = vi.fn(async (_rec: DaemonRunRecord) => fixed);
  return { list, facts, ...(active ? { active } : {}), ...(cache ? { cache } : {}) };
}

function series(count: number, start = Date.parse("2026-10-28T11:00:00.000Z")): DaemonRunRecord[] {
  return Array.from({ length: count }, (_, i) => {
    const createdAt = new Date(start - i * 60_000).toISOString();
    return record(`r${String(i).padStart(5, "0")}`, "succeeded", createdAt, createdAt);
  });
}

describe("route health scan", () => {
  it("counts terminal runs created inside the window and stops at the first older creation", async () => {
    const source = pageSource([
      // Finished after generatedAt: it belongs to a later answer.
      record("late", "succeeded", "2026-10-28T11:30:00.000Z", "2026-10-28T12:00:00.001Z"),
      record("newest", "succeeded", "2026-10-28T11:00:00.000Z", "2026-10-28T11:05:00.000Z"),
      record("live", "running", "2026-10-27T10:00:00.000Z"),
      record("queued", "queued", "2026-10-27T09:00:00.000Z"),
      // Created inside the window: counted whatever its (skewed) finish time.
      record("skewed", "failed", "2026-10-26T10:00:00.000Z", "2026-10-20T10:00:00.000Z"),
      record("timeless", "failed", undefined),
      record("edge", "failed", from, "2026-10-21T12:30:00.000Z"),
      // Created one millisecond before the window: outside the creation cohort
      // even though it finished inside, and the walk ends here, complete.
      record("straggler", "succeeded", "2026-10-21T11:59:59.999Z", "2026-10-21T13:00:00.000Z"),
      record("old", "failed", "2026-10-01T00:00:00.000Z", "2026-10-01T00:10:00.000Z"),
    ]);
    const health = await scanRouteHealth(source, now);
    expect(health).toMatchObject({
      from,
      generatedAt: now.toISOString(),
      scannedRuns: 3,
      complete: true,
      incompleteReason: null,
    });
    expect(source.facts.mock.calls.map(([rec]) => rec.id)).toEqual(["newest", "skewed", "edge"]);
    expect(source.list).toHaveBeenCalledTimes(1);
    expect(health?.routes).toEqual([
      expect.objectContaining({ harnessId: "claude", access: "unknown", runs: 3, failed: 2 }),
    ]);
  });

  it("reads a terminal run's facts once while its record is unchanged", async () => {
    const cache: RouteHealthFactsCache = new Map();
    const records = [
      record("a", "failed", "2026-10-28T10:00:00.000Z", "2026-10-28T10:05:00.000Z"),
      record("b", "succeeded", "2026-10-28T09:00:00.000Z", "2026-10-28T09:05:00.000Z"),
    ];
    const first = pageSource(records, undefined, cache);
    await scanRouteHealth(first, now);
    expect(first.facts).toHaveBeenCalledTimes(2);
    const second = pageSource(records, undefined, cache);
    const again = await scanRouteHealth(second, now);
    expect(second.facts).not.toHaveBeenCalled();
    expect(again).toMatchObject({ scannedRuns: 2 });
    // A changed record (here a corrected finish time) is read again; so is
    // every run when the caller keeps no cache.
    records[0] = record("a", "failed", "2026-10-28T10:00:00.000Z", "2026-10-28T10:06:00.000Z");
    const third = pageSource(records, undefined, cache);
    await scanRouteHealth(third, now);
    expect(third.facts.mock.calls.map(([rec]) => rec.id)).toEqual(["a"]);
    const uncached = pageSource(records);
    await scanRouteHealth(uncached, now);
    expect(uncached.facts).toHaveBeenCalledTimes(2);
  });

  it("reads only the new run when the cache holds a full scan, and drops runs past the bound", async () => {
    const cache: RouteHealthFactsCache = new Map();
    const records = series(ROUTE_HEALTH_SCAN_BOUND);
    const first = pageSource(records, undefined, cache);
    await scanRouteHealth(first, now);
    expect(first.facts).toHaveBeenCalledTimes(ROUTE_HEALTH_SCAN_BOUND);
    // One new terminal run pushes the oldest past the scan bound: only the new
    // run is read, and the cache becomes exactly this answer's runs.
    const fresh = record(
      "fresh",
      "succeeded",
      "2026-10-28T11:30:00.000Z",
      "2026-10-28T11:31:00.000Z",
    );
    const second = pageSource([fresh, ...records], undefined, cache);
    const health = await scanRouteHealth(second, now);
    expect(second.facts.mock.calls.map(([rec]) => rec.id)).toEqual(["fresh"]);
    expect(health).toMatchObject({ scannedRuns: ROUTE_HEALTH_SCAN_BOUND, complete: false });
    expect(cache.size).toBe(ROUTE_HEALTH_SCAN_BOUND);
    expect(cache.has("fresh")).toBe(true);
    expect(cache.has(records[ROUTE_HEALTH_SCAN_BOUND - 1]!.id)).toBe(false);
  });

  it("pages back with the tail cursor until the retained records end, which is complete", async () => {
    const records = series(ROUTE_HEALTH_PAGE_LIMIT * 2 + 50);
    const source = pageSource(records);
    const health = await scanRouteHealth(source, now);
    expect(source.list).toHaveBeenCalledTimes(3);
    const first = records[ROUTE_HEALTH_PAGE_LIMIT - 1]!;
    expect(source.list.mock.calls[1]?.[0]).toEqual({
      limit: ROUTE_HEALTH_PAGE_LIMIT,
      state: null,
      cursor: { createdAt: first.createdAt, id: first.id },
    });
    expect(health).toMatchObject({ scannedRuns: 450, complete: true, incompleteReason: null });
  });

  it("stops at the scan bound inside the window and says so", async () => {
    const source = pageSource(series(ROUTE_HEALTH_SCAN_BOUND + 50));
    const health = await scanRouteHealth(source, now);
    expect(source.list).toHaveBeenCalledTimes(ROUTE_HEALTH_SCAN_BOUND / ROUTE_HEALTH_PAGE_LIMIT);
    expect(source.facts).toHaveBeenCalledTimes(ROUTE_HEALTH_SCAN_BOUND);
    expect(health).toMatchObject({
      scannedRuns: ROUTE_HEALTH_SCAN_BOUND,
      complete: false,
      incompleteReason: "scan_bound",
    });
  });

  it("is complete when exactly the bound was retained and nothing older exists", async () => {
    const health = await scanRouteHealth(pageSource(series(ROUTE_HEALTH_SCAN_BOUND)), now);
    expect(health).toMatchObject({
      scannedRuns: ROUTE_HEALTH_SCAN_BOUND,
      complete: true,
      incompleteReason: null,
    });
  });

  it("answers nothing once the caller stopped waiting", async () => {
    let calls = 0;
    const source = pageSource(series(5), () => ++calls < 2);
    expect(await scanRouteHealth(source, now)).toBeNull();
    expect(source.facts).not.toHaveBeenCalled();
  });
});
