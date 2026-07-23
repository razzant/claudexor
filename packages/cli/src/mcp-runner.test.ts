import { afterEach, describe, expect, it, vi } from "vitest";
import { makeInteractionBridge } from "./mcp-runner.js";

const addr = { baseUrl: "http://127.0.0.1:1", token: "t" } as never;

describe("makeInteractionBridge (MCP daemon-run interaction plumbing)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards each pending interaction ONCE and posts mapped answers to the typed endpoint", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const pending = [
      {
        interactionId: "int-1",
        questions: [
          {
            id: "q1",
            question: "Pick",
            header: null,
            options: [{ label: "A", description: null }],
            multi_select: false,
          },
        ],
        timeoutAt: null,
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        if (init?.method === "POST") {
          posts.push({ url, body: JSON.parse(init.body ?? "{}") });
          return { ok: true, json: async () => ({}) } as never;
        }
        return { ok: true, json: async () => ({ pendingInteractions: pending }) } as never;
      }),
    );
    const seenRequests: unknown[] = [];
    const bridge = makeInteractionBridge(addr, async (ctx) => {
      seenRequests.push(ctx);
      return { answers: [{ question_id: "q1", selected_labels: ["A"], free_text: null }] };
    });

    await bridge({ runId: "run-1" });
    // Second tick inside the throttle window: no new fetch, no re-ask.
    await bridge({ runId: "run-1" });
    expect(seenRequests).toHaveLength(1);
    expect((seenRequests[0] as any).request.interaction_id).toBe("int-1");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toContain("/runs/run-1/interactions/int-1/answer");
    // Engine snake_case answers map to the control API's camelCase contract.
    expect(posts[0]!.body).toEqual({ answers: [{ questionId: "q1", selectedLabels: ["A"] }] });
  });

  it("declined interactions (null) post nothing and are not re-asked", async () => {
    let detailCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string }) => {
        if (init?.method === "POST") throw new Error("must not post on decline");
        detailCalls += 1;
        return {
          ok: true,
          json: async () => ({
            pendingInteractions: [{ interactionId: "int-2", questions: [], timeoutAt: null }],
          }),
        } as never;
      }),
    );
    let asks = 0;
    const bridge = makeInteractionBridge(addr, async () => {
      asks += 1;
      return null;
    });
    await bridge({ runId: "run-2" });
    await new Promise((r) => setTimeout(r, 1_100));
    await bridge({ runId: "run-2" });
    expect(detailCalls).toBe(2); // re-polled after the throttle window...
    expect(asks).toBe(1); // ...but the same interaction is never re-asked
  });

  it("retries a cached answer after a non-2xx response without asking the user twice", async () => {
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string }) => {
        if (init?.method === "POST") {
          posts += 1;
          return { ok: posts > 1, json: async () => ({}) } as never;
        }
        return {
          ok: true,
          json: async () => ({
            pendingInteractions: [{ interactionId: "int-retry", questions: [], timeoutAt: null }],
          }),
        } as never;
      }),
    );
    let asks = 0;
    const bridge = makeInteractionBridge(addr, async () => {
      asks += 1;
      return { answers: [{ question_id: "q", selected_labels: ["A"], free_text: null }] };
    });
    await bridge({ runId: "run-retry" });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await bridge({ runId: "run-retry" });
    expect(asks).toBe(1);
    expect(posts).toBe(2);
  });
});

describe("makeCancelBridge (host cancel -> typed daemon cancel)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the cancel control exactly once after the signal aborts", async () => {
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        if (init?.method === "POST") posts.push(`${url} ${init.body}`);
        return { ok: true, json: async () => ({}) } as never;
      }),
    );
    const { makeCancelBridge } = await import("./mcp-runner.js");
    const controller = new AbortController();
    const bridge = makeCancelBridge(addr, controller.signal);
    bridge({ runId: "run-9" }); // not aborted yet: no post
    expect(posts).toHaveLength(0);
    controller.abort();
    bridge({ runId: "run-9" });
    bridge({ runId: "run-9" }); // idempotent
    await new Promise((r) => setTimeout(r, 20));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("/runs/run-9/control");
    expect(posts[0]).toContain('"kind":"cancel"');
  });

  it("does not mark a failed cancel delivery as acknowledged and retries", async () => {
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        posts += 1;
        return { ok: posts > 1, json: async () => ({}) } as never;
      }),
    );
    const { makeCancelBridge } = await import("./mcp-runner.js");
    const controller = new AbortController();
    controller.abort();
    const bridge = makeCancelBridge(addr, controller.signal);
    await bridge({ runId: "run-retry" });
    await bridge({ runId: "run-retry" });
    expect(posts).toBe(2);
  });
});

describe("mcp daemon body mapping", () => {
  it("honors the externalContextPolicy alias when web is absent (schema advertises both)", async () => {
    // The alias is validated equal to web when both are present; alone it IS
    // the web policy — silently dropping it would run the daemon default.
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    void mcpSurfaceRunner; // body mapping is exercised through the daemon route below
    const daemonRun = await import("./daemon-run.js");
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false }) as never),
    );
    const ensureSpy = vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
    });
    const enqueueSpy = vi
      .spyOn(daemonRun, "enqueueAndAwait")
      .mockImplementation(async (_c, _a, body) => {
        bodies.push(body);
        return { runId: "r", runDir: "", status: "no_op", jobId: "j" };
      });
    try {
      const runner = mcpSurfaceRunner();
      await runner({ mode: "agent", prompt: "go", externalContextPolicy: "cached" });
      await runner({ mode: "plan", prompt: "plan it" });
      expect(bodies[0]?.["web"]).toBe("cached");
      expect(bodies[1]?.["mode"]).toBe("plan");
      expect(ensureSpy).toHaveBeenCalledTimes(2);
    } finally {
      ensureSpy.mockRestore();
      enqueueSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("requests a durable handle instead of waiting for terminal when MCP marks a run deferred", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const ensureSpy = vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
    });
    const enqueueSpy = vi.spyOn(daemonRun, "enqueueAndAwait").mockResolvedValue({
      runId: "run-durable",
      runDir: "/tmp/run-durable",
      status: "running",
      jobId: "job-durable",
    });
    try {
      const result = await mcpSurfaceRunner()({ mode: "agent", prompt: "go", deferred: true });
      expect(enqueueSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ waitForTerminal: false }),
      );
      expect(result).toMatchObject({ runId: "run-durable", status: "running" });
      expect(ensureSpy).toHaveBeenCalledOnce();
    } finally {
      ensureSpy.mockRestore();
      enqueueSpy.mockRestore();
    }
  });

  it("__runs_list walks the keyset cursor so the count is not undercounted by one page (QA-052)", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const connectSpy = vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
    });
    // Page 1 caps at 2 with hasMore; page 2 (cursor present) returns the tail.
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        const hasCursor = url.includes("cursor=");
        const body = hasCursor
          ? { runs: [{ runId: "r3", state: "succeeded" }], hasMore: false, nextCursor: null }
          : {
              runs: [
                { runId: "r1", state: "running" },
                { runId: "r2", state: "queued" },
              ],
              hasMore: true,
              nextCursor: "cursor-1",
            };
        return { ok: true, json: async () => body } as never;
      }),
    );
    try {
      const result = (await mcpSurfaceRunner()({ mode: "__runs_list" })) as Record<string, unknown>;
      // Honest TOTAL across both pages, not the single-page undercount of 2.
      expect(result["summary"]).toBe("3 daemon-tracked run(s)");
      expect((result["runs"] as unknown[]).length).toBe(3);
      expect(result["truncated"]).toBe(false);
      // It walked: the second request carried the page-1 nextCursor.
      expect(urls.some((u) => u.includes("cursor=cursor-1"))).toBe(true);
    } finally {
      connectSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("returns the terminal primary output and artifact handles from __run_result", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const connectSpy = vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("http://x/v2/runs/run-result");
        return {
          ok: true,
          json: async () => ({
            summary: {
              runId: "run-result",
              state: "succeeded",
              runDir: "/tmp/run-result",
              result: { kind: "plan", changed_files: [] },
            },
            finalSummary: "generic summary must not replace the plan",
            primaryOutput: {
              kind: "plan",
              path: "final/plan.md",
              text: "# Actual plan\n\nShip it.",
            },
            artifacts: [
              { path: "final/plan.md", kind: "file" },
              { path: "final/telemetry.yaml", kind: "file" },
            ],
            applyEligibility: {
              eligible: false,
              state: "no_op",
              reason: "plan has no patch",
              requiredAction: null,
            },
          }),
        } as never;
      }),
    );
    try {
      const runner = mcpSurfaceRunner();
      const result = (await runner({
        mode: "__run_result",
        runId: "run-result",
      })) as Record<string, any>;
      // v3: the read tools project the typed McpRunHandleResult shape — the
      // human `summary` still shows the primary output text, but the structured
      // fields are the D8 axes, not the raw primaryOutput/artifacts/result blob.
      expect(result).toMatchObject({
        summary: "# Actual plan\n\nShip it.",
        runId: "run-result",
        runDir: "/tmp/run-result",
        status: "succeeded",
        applyEligibility: { eligible: false, state: "no_op" },
      });
      expect(result).not.toHaveProperty("primaryOutput");
      expect(result).not.toHaveProperty("artifacts");
      expect(result).not.toHaveProperty("result");
      const inspect = (await runner({
        mode: "__run_inspect",
        runId: "run-result",
      })) as Record<string, unknown>;
      expect(inspect).not.toHaveProperty("primaryOutput");
      expect(inspect).not.toHaveProperty("artifacts");
    } finally {
      connectSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
