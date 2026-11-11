import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEventReadQuery } from "./mcp-run-event-read.js";
import { mcpSurfaceRunner } from "./mcp-runner.js";

vi.mock("./daemon-run.js", () => ({ connectDaemonIfRunning: vi.fn(), ensureDaemon: vi.fn() }));
vi.mock("./live.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./live.js")>()),
  controlApiFetch: vi.fn(),
}));
import { connectDaemonIfRunning, ensureDaemon } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";

const part = {
  runId: "run-1",
  seq: 1,
  type: "run.created",
  totalBytes: 10,
  sha256: "0".repeat(64),
  offset: 0,
  nextOffset: 4,
  text: '{"se',
};

describe("MCP event part reads", () => {
  beforeEach(() => {
    vi.mocked(connectDaemonIfRunning).mockResolvedValue({
      addr: { baseUrl: "http://local", token: "t" },
    } as never);
  });
  afterEach(() => vi.resetAllMocks());

  it("reads one addressed part through the daemon route without starting a daemon", async () => {
    vi.mocked(controlApiFetch).mockResolvedValue(Response.json(part));
    expect(
      await mcpSurfaceRunner()({ mode: "__run_event_read", runId: "job/1", seq: 1, maxBytes: 4 }),
    ).toEqual(part);
    expect(controlApiFetch).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      "/runs/job%2F1/events/1?offset=0&limit=4",
      { method: "GET" },
    );
    expect(ensureDaemon).not.toHaveBeenCalled();
  });

  it.each([
    { seq: 2 },
    { offset: 4 },
    { nextOffset: 0 },
    { nextOffset: 11 },
    { text: '{"s' },
    { nextOffset: 6, text: '{"seq:' },
  ])("refuses a part that does not match its address or facts: %j", async (override) => {
    vi.mocked(controlApiFetch).mockResolvedValue(Response.json({ ...part, ...override }));
    await expect(runEventReadQuery({ runId: "run-1", seq: 1, maxBytes: 4 })).rejects.toMatchObject({
      code: "invalid_service_response",
    });
  });

  it("keeps daemon refusals typed", async () => {
    vi.mocked(controlApiFetch).mockResolvedValue(
      Response.json(
        { code: "run_event_invalid", message: "not valid", retryable: false },
        { status: 422 },
      ),
    );
    await expect(runEventReadQuery({ runId: "run-1", seq: 3 })).rejects.toMatchObject({
      code: "run_event_invalid",
    });
  });

  it.each([
    { runId: "r" },
    { runId: "r", seq: 0 },
    { runId: "r", seq: 1, maxBytes: 3 },
    { runId: "r", seq: 1, path: "x" },
  ])("rejects malformed input %j before connection", async (input) => {
    await expect(runEventReadQuery(input)).rejects.toBeDefined();
    expect(connectDaemonIfRunning).not.toHaveBeenCalled();
  });

  it("keeps the Delegate belt and a missing daemon closed", async () => {
    await expect(runEventReadQuery({ runId: "r", seq: 1 }, true)).rejects.toMatchObject({
      code: "delegation_forbidden",
    });
    vi.mocked(connectDaemonIfRunning).mockResolvedValue(null);
    await expect(runEventReadQuery({ runId: "r", seq: 1 })).rejects.toMatchObject({
      code: "daemon_unavailable",
    });
    expect(controlApiFetch).not.toHaveBeenCalled();
  });
});
