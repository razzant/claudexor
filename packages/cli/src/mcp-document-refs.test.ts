import { describe, expect, it, vi } from "vitest";
import { mcpSurfaceRunner } from "./mcp-runner.js";
import { threadQuery } from "./mcp-thread-query.js";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  enqueue: vi.fn(),
  fetch: vi.fn(),
  project: vi.fn(),
}));
vi.mock("./daemon-run.js", () => ({
  connectDaemonIfRunning: mocks.connect,
  ensureDaemon: mocks.connect,
  enqueueAndAwait: mocks.enqueue,
}));
vi.mock("./live.js", () => ({ controlApiFetch: mocks.fetch }));
vi.mock("./mcp-launch-handle.js", () => ({
  projectLaunchHandle: mocks.project,
  keyedLaunchNeedsProject: vi.fn(),
}));

describe("CLI bridge resource refs", () => {
  const refs = [{ resourceId: "resource" }];
  it.each(["ask", "plan", "agent"])(
    "forwards refs on %s while preserving omission",
    async (mode) => {
      mocks.connect.mockResolvedValue({ client: {}, addr: {} });
      mocks.enqueue.mockResolvedValue({});
      mocks.project.mockResolvedValue({});
      const runner = mcpSurfaceRunner();
      await runner({ mode, prompt: "read document", repoPath: "/project", attachments: refs });
      expect(mocks.enqueue.mock.lastCall?.[2]).toMatchObject({ mode, attachments: refs });
      await runner({ mode, prompt: "read document", repoPath: "/project" });
      expect(mocks.enqueue.mock.lastCall?.[2]).not.toHaveProperty("attachments");
    },
  );
  it("forwards refs on thread turns with the caller's key and preserves omission", async () => {
    mocks.connect.mockResolvedValue({ addr: {} });
    mocks.fetch.mockImplementation(async () =>
      Response.json({ threadId: "thread", turnId: "turn", jobId: "job", state: "queued" }),
    );
    await threadQuery(
      {
        mode: "__thread_turn",
        threadId: "thread",
        prompt: "read",
        attachments: refs,
        idempotencyKey: "turn-key",
      },
      true,
    );
    expect(mocks.fetch.mock.lastCall?.[2]).toMatchObject({
      headers: { "Idempotency-Key": "turn-key" },
    });
    expect(JSON.parse(mocks.fetch.mock.lastCall?.[2].body)).toMatchObject({ attachments: refs });
    await threadQuery({ mode: "__thread_turn", threadId: "thread", prompt: "read" }, true);
    expect(JSON.parse(mocks.fetch.mock.lastCall?.[2].body)).not.toHaveProperty("attachments");
  });
  it.each([
    [{ path: "/host/file" }],
    [{ base64: "abc" }],
    [{ resourceId: "resource", path: "/host/file" }],
    [{ resource_id: "internal" }],
  ])("rejects invalid refs before forwarding", async (attachment) => {
    mocks.connect.mockResolvedValue({ client: {}, addr: {} });
    mocks.enqueue.mockClear();
    mocks.fetch.mockClear();
    await expect(
      mcpSurfaceRunner()({ mode: "ask", prompt: "read", attachments: [attachment] }),
    ).rejects.toThrow();
    await expect(
      threadQuery(
        { mode: "__thread_turn", threadId: "thread", prompt: "read", attachments: [attachment] },
        true,
      ),
    ).rejects.toThrow();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
