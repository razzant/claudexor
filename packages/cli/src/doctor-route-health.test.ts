import { describe, expect, it, vi } from "vitest";
import { readRouteHealth, routeHealthLines } from "./doctor-route-health.js";

const agy = {
  harnessId: "agy",
  access: "readonly" as const,
  runs: 123,
  succeeded: 57,
  failed: 64,
  cancelled: 2,
  other: 0,
  topFailures: [
    {
      category: "harness_error" as const,
      code: null,
      message: "agy headless tool permission refused: read_file",
      count: 38,
    },
  ],
};
const claude = {
  harnessId: "claude",
  access: "readonly" as const,
  runs: 410,
  succeeded: 406,
  failed: 4,
  cancelled: 0,
  other: 0,
  topFailures: [
    {
      category: "auth" as const,
      code: "subscription_window_exhausted" as const,
      message: "",
      count: 4,
    },
  ],
};
const codex = {
  harnessId: "codex",
  access: "full" as const,
  runs: 20,
  succeeded: 19,
  failed: 0,
  cancelled: 1,
  other: 0,
  topFailures: [],
};
const health = {
  windowDays: 7 as const,
  from: "2026-10-21T12:00:00.000Z",
  generatedAt: "2026-10-28T12:00:00.000Z",
  scannedRuns: 553,
  complete: true,
  incompleteReason: null,
  routes: [agy, claude, codex],
};

describe("doctor route-health lines", () => {
  it("prints one summary line, then only the routes that failed, most frequent cause first", () => {
    expect(routeHealthLines(health)).toEqual([
      "route health, last 7 days: 553 run(s) over 3 route(s), 2 with failures",
      "    agy readonly: 64/123 failed (52%), 2 cancelled; most: harness_error — agy headless tool permission refused: read_file ×38",
      "    claude readonly: 4/410 failed (1%); most: auth (subscription_window_exhausted) ×4",
    ]);
  });

  it("says when the scan stopped at its bound instead of pretending the week is covered", () => {
    const [summary] = routeHealthLines({
      ...health,
      complete: false,
      incompleteReason: "scan_bound",
      routes: [codex],
    });
    expect(summary).toBe(
      "route health, newest 553 runs of the last 7 days (scan bound reached; older runs of the window are not counted): 553 run(s) over 1 route(s), 0 with failures",
    );
    expect(routeHealthLines(health)[0]).not.toContain("scan bound");
  });

  it("names an engine without the read instead of inventing an empty week", () => {
    expect(routeHealthLines(null)).toEqual([
      "? route health: unavailable from this engine version",
    ]);
  });

  it("keeps the counts and rounds a share only where rounding cannot erase or invent failures (#569)", () => {
    const line = (failed: number, runs: number) =>
      routeHealthLines({
        ...health,
        routes: [{ ...codex, runs, succeeded: runs - failed, failed, cancelled: 0 }],
      })[1];
    expect(line(1, 201)).toBe("    codex full: 1/201 failed (<1%)");
    expect(line(1, 200)).toBe("    codex full: 1/200 failed (1%)");
    expect(line(199, 200)).toBe("    codex full: 199/200 failed (>99%)");
    expect(line(201, 201)).toBe("    codex full: 201/201 failed (100%)");
  });
});

describe("doctor route-health read", () => {
  it("returns the parsed answer, null on 404, and rethrows every other failure", async () => {
    expect(await readRouteHealth(async () => health)).toEqual(health);
    const older = vi.fn(async () => {
      throw Object.assign(new Error("control API /daemon/route-health failed (404)"), {
        status: 404,
      });
    });
    expect(await readRouteHealth(older)).toBeNull();
    const broken = async () => {
      throw Object.assign(new Error("control API /daemon/route-health failed (503)"), {
        status: 503,
      });
    };
    await expect(readRouteHealth(broken)).rejects.toThrow("503");
    await expect(readRouteHealth(async () => ({ windowDays: 14 }))).rejects.toThrow();
  });
});
