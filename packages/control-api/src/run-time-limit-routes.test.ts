import { describe, expect, it, vi } from "vitest";
import { handleRunTimeLimitRoute } from "./run-time-limit-routes.js";

const snapshot = {
  revision: 2,
  mode: "soft",
  state: "armed",
  deadlineAt: "2026-10-15T12:00:00.000Z",
  reachedAt: null,
} as const;

function fixture(state = "running") {
  const calls: unknown[] = [];
  const responses: Array<{ status: number; body: unknown }> = [];
  const ctx = {
    daemon: {
      runTimeLimit: vi.fn(async (id: string, request: unknown) => {
        calls.push([id, request]);
        return snapshot;
      }),
    },
    findRun: vi.fn(async () => ({ id: "job-1", runId: "run-1", state })),
    readBody: vi.fn(async () => ({ action: "extend", seconds: 60, expectedRevision: 2 })),
    json: (_res: unknown, status: number, body: unknown) => responses.push({ status, body }),
    requestError: (_res: unknown, error: unknown) => {
      throw error;
    },
  };
  return { ctx, calls, responses };
}

describe("run time limit route", () => {
  it("reads one addressed run without a request body", async () => {
    const { ctx, calls, responses } = fixture();
    expect(
      await handleRunTimeLimitRoute(ctx, "GET", "/runs/run-1/time-limit", {} as never, {} as never),
    ).toBe(true);
    expect(calls).toEqual([["job-1", { action: "read" }]]);
    expect(responses).toEqual([{ status: 200, body: snapshot }]);
    expect(ctx.readBody).not.toHaveBeenCalled();
  });

  it("passes a revision-guarded mutation to the daemon", async () => {
    const { ctx, calls } = fixture();
    await handleRunTimeLimitRoute(ctx, "PATCH", "/runs/run-1/time-limit", {} as never, {} as never);
    expect(calls).toEqual([["job-1", { action: "extend", seconds: 60, expectedRevision: 2 }]]);
  });

  it("refuses mutation of a terminal run", async () => {
    const { ctx, calls, responses } = fixture("succeeded");
    await handleRunTimeLimitRoute(ctx, "PATCH", "/runs/run-1/time-limit", {} as never, {} as never);
    expect(calls).toEqual([]);
    expect(responses[0]?.status).toBe(409);
  });

  it("returns 404 for an unknown run and 501 for a daemon without timer support", async () => {
    const missing = fixture();
    missing.ctx.findRun.mockResolvedValue(null as never);
    await handleRunTimeLimitRoute(
      missing.ctx,
      "GET",
      "/runs/absent/time-limit",
      {} as never,
      {} as never,
    );
    expect(missing.responses[0]?.status).toBe(404);

    const unsupported = fixture();
    (unsupported.ctx.daemon as { runTimeLimit?: unknown }).runTimeLimit = undefined;
    await handleRunTimeLimitRoute(
      unsupported.ctx,
      "GET",
      "/runs/run-1/time-limit",
      {} as never,
      {} as never,
    );
    expect(unsupported.responses[0]?.status).toBe(501);
  });

  it("rejects read action on PATCH", async () => {
    const { ctx, calls } = fixture();
    ctx.readBody.mockResolvedValue({ action: "read" } as never);
    await expect(
      handleRunTimeLimitRoute(ctx, "PATCH", "/runs/run-1/time-limit", {} as never, {} as never),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
  });
});
