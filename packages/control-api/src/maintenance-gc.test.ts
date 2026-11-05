import { expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ControlGcLastResponse, ControlGcReceipt, GcLastPass } from "@claudexor/schema";
import {
  handleMaintenanceRoute,
  MAINTENANCE_OPERATION_DRAFTS,
  type MaintenanceRouteContext,
} from "./maintenance-routes.js";

function fixture() {
  const receipt = ControlGcReceipt.parse({
    dry_run: false,
    started_at: "2026-10-27T00:00:00Z",
    finished_at: "2026-10-27T00:00:01Z",
    policy: { runs_max_age_days: 30, reviews_max_age_days: 14, keep_last_runs_per_project: 0 },
    examined_runs: 0,
    kept: {},
    freed_bytes: 0,
  });
  const runRetention = vi.fn(async () => receipt);
  const lastRetention = vi.fn(async (): Promise<ControlGcLastResponse> => ({ last: null }));
  const ctx: MaintenanceRouteContext = {
    services: { runRetention, lastRetention },
    readBody: vi.fn(async () => ({})),
    json: vi.fn(),
    requestError: vi.fn(),
  };
  return {
    ctx,
    runRetention,
    lastRetention,
    req: { url: "/v2/maintenance/gc" } as IncomingMessage,
    res: {} as ServerResponse,
  };
}
it("GET reads the saved record only, including absence, and the catalog declares it read-only", async () => {
  const f = fixture();
  expect(await handleMaintenanceRoute(f.ctx, "GET", "/maintenance/gc", f.req, f.res)).toBe(true);
  expect(f.lastRetention).toHaveBeenCalledTimes(1);
  expect(f.runRetention).not.toHaveBeenCalled();
  expect(f.ctx.readBody).not.toHaveBeenCalled();
  expect(f.ctx.json).toHaveBeenCalledWith(f.res, 200, ControlGcLastResponse.parse({ last: null }));
  expect(MAINTENANCE_OPERATION_DRAFTS).toContainEqual(
    expect.objectContaining({
      method: "GET",
      path: "/v2/maintenance/gc",
      mutability: "read_only",
      responseSchema: "ControlGcLastResponse",
    }),
  );
});
it.each([false, true])("POST exposes new fields only with retention_report=%s", async (optIn) => {
  const f = fixture();
  f.ctx.readBody = async () => ({ retention_report: optIn });
  await handleMaintenanceRoute(f.ctx, "POST", "/maintenance/gc", f.req, f.res);
  expect(f.runRetention).toHaveBeenCalledTimes(1);
  expect(f.lastRetention).not.toHaveBeenCalled();
  const body = vi.mocked(f.ctx.json).mock.calls[0]![2];
  expect(Object.hasOwn(body as object, "held")).toBe(optIn);
  expect(Object.hasOwn(body as object, "truncated")).toBe(optIn);
  expect(Object.hasOwn(body as object, "deleted_lanes")).toBe(optIn);
  if (!optIn)
    expect(ControlGcReceipt.omit({ deleted_lanes: true }).safeParse(body).success).toBe(true);
});

it.each([false, true])("GET exposes history only with retention_report=%s", async (optIn) => {
  const f = fixture();
  const last = GcLastPass.parse({
    outcome: "completed",
    started_at: "2026-10-27T00:00:00Z",
    finished_at: "2026-10-27T00:00:01Z",
    last_completed_at: "2026-10-27T00:00:01Z",
    failed_or_held_streak: 0,
    freed_bytes: 0,
    kept: {},
    held: {},
    holds: [],
    errors: { count: 0, first: null },
  });
  f.lastRetention.mockResolvedValue({ last });
  f.req.url += `?retention_report=${optIn}`;
  await handleMaintenanceRoute(f.ctx, "GET", "/maintenance/gc", f.req, f.res);
  const body = vi.mocked(f.ctx.json).mock.calls[0]![2] as ControlGcLastResponse;
  expect(Object.hasOwn(body.last!, "last_completed_at")).toBe(optIn);
  expect(Object.hasOwn(body.last!, "failed_or_held_streak")).toBe(optIn);
  if (optIn) expect(body.last).toEqual(last);
  else {
    // Main's strict schema has exactly this pre-history last-pass shape.
    const mainResponse = ControlGcLastResponse.extend({
      last: GcLastPass.omit({ last_completed_at: true, failed_or_held_streak: true }).nullable(),
    });
    expect(mainResponse.safeParse(body).success).toBe(true);
  }
  expect(f.runRetention).not.toHaveBeenCalled();
});
