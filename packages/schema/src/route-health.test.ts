import { describe, expect, it } from "vitest";
import {
  ControlRouteHealth,
  ControlRouteHealthRoute,
  ROUTE_HEALTH_MESSAGE_MAX_CHARS,
} from "./route-health.js";

const group = {
  category: "harness_error",
  code: null,
  message: "agy headless tool permission refused: read_file",
  count: 38,
};
const route = {
  harnessId: "agy",
  access: "readonly",
  runs: 123,
  succeeded: 57,
  failed: 64,
  cancelled: 2,
  other: 0,
  topFailures: [group],
};
const health = {
  windowDays: 7,
  from: "2026-10-21T12:00:00.000Z",
  generatedAt: "2026-10-28T12:00:00.000Z",
  scannedRuns: 1234,
  complete: true,
  incompleteReason: null,
  routes: [route],
};

describe("route health contract", () => {
  it("accepts the documented answer and keeps it byte-identical", () => {
    expect(ControlRouteHealth.parse(health)).toEqual(health);
  });

  it("is strict at every level and pins the fixed window", () => {
    expect(ControlRouteHealth.safeParse({ ...health, extra: 1 }).success).toBe(false);
    expect(
      ControlRouteHealth.safeParse({ ...health, routes: [{ ...route, extra: 1 }] }).success,
    ).toBe(false);
    expect(
      ControlRouteHealth.safeParse({
        ...health,
        routes: [{ ...route, topFailures: [{ ...group, extra: 1 }] }],
      }).success,
    ).toBe(false);
    expect(ControlRouteHealth.safeParse({ ...health, windowDays: 14 }).success).toBe(false);
  });

  it("requires runs to equal the sum of its lifecycle buckets", () => {
    expect(ControlRouteHealthRoute.safeParse(route).success).toBe(true);
    expect(ControlRouteHealthRoute.safeParse({ ...route, other: 1 }).success).toBe(false);
    expect(ControlRouteHealthRoute.safeParse({ ...route, runs: 124, other: 1 }).success).toBe(true);
  });

  it("never lets the failure groups count more runs than failed", () => {
    expect(
      ControlRouteHealthRoute.safeParse({ ...route, topFailures: [{ ...group, count: 64 }] })
        .success,
    ).toBe(true);
    expect(
      ControlRouteHealthRoute.safeParse({ ...route, topFailures: [{ ...group, count: 65 }] })
        .success,
    ).toBe(false);
    expect(
      ControlRouteHealthRoute.safeParse({
        ...route,
        topFailures: [group, group, group, { ...group, count: 1 }],
      }).success,
    ).toBe(false);
  });

  it("bounds the group message at 160 characters", () => {
    const exact = { ...group, message: "m".repeat(ROUTE_HEALTH_MESSAGE_MAX_CHARS) };
    expect(ControlRouteHealthRoute.safeParse({ ...route, topFailures: [exact] }).success).toBe(
      true,
    );
    const over = { ...group, message: "m".repeat(ROUTE_HEALTH_MESSAGE_MAX_CHARS + 1) };
    expect(ControlRouteHealthRoute.safeParse({ ...route, topFailures: [over] }).success).toBe(
      false,
    );
  });

  it("names unknown access and never carries the retired profile on the wire", () => {
    expect(ControlRouteHealthRoute.safeParse({ ...route, access: "unknown" }).success).toBe(true);
    expect(
      ControlRouteHealthRoute.safeParse({ ...route, access: "external_sandbox_full" }).success,
    ).toBe(false);
  });

  it("types the incomplete reason", () => {
    expect(
      ControlRouteHealth.safeParse({ ...health, complete: false, incompleteReason: "scan_bound" })
        .success,
    ).toBe(true);
    expect(
      ControlRouteHealth.safeParse({ ...health, complete: false, incompleteReason: "tired" })
        .success,
    ).toBe(false);
  });
});
