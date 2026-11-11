import { afterEach, describe, expect, it, vi } from "vitest";
import { runTimeLimitQuery } from "./mcp-run-time-limit.js";

vi.mock("./daemon-run.js", () => ({ connectDaemonIfRunning: vi.fn() }));
vi.mock("./live.js", () => ({ controlApiFetch: vi.fn() }));
import { connectDaemonIfRunning } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";

const snapshot = {
  revision: 2,
  mode: "soft",
  state: "armed",
  deadlineAt: "2026-10-15T12:00:00.000Z",
  reachedAt: null,
};

describe("run time limit MCP query", () => {
  afterEach(() => vi.resetAllMocks());

  it("reads from an existing daemon without starting one", async () => {
    vi.mocked(connectDaemonIfRunning).mockResolvedValue({
      addr: { baseUrl: "http://local", token: "token" },
    } as never);
    vi.mocked(controlApiFetch).mockResolvedValue({ ok: true, json: async () => snapshot } as never);
    const result = await runTimeLimitQuery({ runId: "run/1", request: { action: "read" } });
    expect(controlApiFetch).toHaveBeenCalledWith(
      expect.anything(),
      "/runs/run%2F1/time-limit",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result).toMatchObject({ runId: "run/1", revision: 2 });
  });

  it("preserves revision conflict without retrying", async () => {
    vi.mocked(connectDaemonIfRunning).mockResolvedValue({
      addr: { baseUrl: "http://local", token: "token" },
    } as never);
    vi.mocked(controlApiFetch).mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ code: "revision_conflict", error: "stale revision" }),
    } as never);
    await expect(
      runTimeLimitQuery({
        runId: "r",
        request: { action: "extend", seconds: 30, expectedRevision: 1 },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(controlApiFetch).toHaveBeenCalledTimes(1);
  });

  it("blocks belt access before connecting", async () => {
    await expect(
      runTimeLimitQuery({ runId: "r", request: { action: "read" } }, true),
    ).rejects.toMatchObject({ code: "delegation_forbidden" });
    expect(connectDaemonIfRunning).not.toHaveBeenCalled();
  });
});
