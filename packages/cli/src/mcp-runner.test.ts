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
  it("requires the existing parent daemon for belt runs and never auto-starts one", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const connectSpy = vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue(null);
    const ensureSpy = vi.spyOn(daemonRun, "ensureDaemon");
    try {
      await expect(
        mcpSurfaceRunner({ requireExistingDaemon: true })({ mode: "agent", prompt: "go" }),
      ).rejects.toThrow("cannot reach its parent daemon");
      expect(connectSpy).toHaveBeenCalledOnce();
      expect(ensureSpy).not.toHaveBeenCalled();
    } finally {
      connectSpy.mockRestore();
      ensureSpy.mockRestore();
    }
  });

  it("never auto-starts a daemon for a belt-context catalog query", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const connectSpy = vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue(null);
    const ensureSpy = vi.spyOn(daemonRun, "ensureDaemon");
    try {
      await expect(
        mcpSurfaceRunner({ requireExistingDaemon: true })({ mode: "__status" }),
      ).rejects.toThrow(/cannot reach its parent daemon/);
      expect(connectSpy).toHaveBeenCalledOnce();
      expect(ensureSpy).not.toHaveBeenCalled();
    } finally {
      connectSpy.mockRestore();
      ensureSpy.mockRestore();
    }
  });

  it("does not tell a stranded belt read tool to start a second daemon", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const connectSpy = vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue(null);
    try {
      const result = (await mcpSurfaceRunner({ requireExistingDaemon: true })({
        mode: "__run_status",
        runId: "run-child",
      })) as { summary: string };
      expect(result.summary).toContain("cannot reach its parent daemon");
      expect(result.summary).not.toContain("daemon start");
    } finally {
      connectSpy.mockRestore();
    }
  });

  it("preserves the daemon's typed error field for a missing-run belt roundtrip", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const connectSpy = vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: "no such run smoke-missing-run" }),
      })) as never,
    );
    try {
      await expect(
        mcpSurfaceRunner({ requireExistingDaemon: true })({
          mode: "__run_status",
          runId: "smoke-missing-run",
        }),
      ).rejects.toThrow("no such run smoke-missing-run");
    } finally {
      connectSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("degrades a raised post-terminal detail problem into detailProblem instead of eating the result", async () => {
    // The run FINISHED: a typed 500 (e.g. run_facts_invalid) on the follow-up
    // GET /runs/:id must ride the result as detailProblem with the runId
    // preserved — never erase the terminal outcome by rethrowing.
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const ensureSpy = vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
    });
    const enqueueSpy = vi.spyOn(daemonRun, "enqueueAndAwait").mockResolvedValue({
      runId: "run-done",
      runDir: "",
      status: "succeeded",
      jobId: "job-done",
    });
    const detailSpy = vi.spyOn(daemonRun, "fetchRunDetail").mockRejectedValue(
      Object.assign(new Error("canonical RunFacts receipt is invalid"), {
        code: "run_facts_invalid",
        retryable: false,
      }),
    );
    try {
      const result = (await mcpSurfaceRunner()({ mode: "agent", prompt: "go" })) as Record<
        string,
        unknown
      >;
      expect(result).toMatchObject({
        runId: "run-done",
        status: "succeeded",
        detailProblem: {
          code: "run_facts_invalid",
          message: "canonical RunFacts receipt is invalid",
          retryable: false,
        },
      });
      expect(result["applyEligibility"]).toBeNull();
      expect(result["spendUsd"]).toBeNull();
    } finally {
      ensureSpy.mockRestore();
      enqueueSpy.mockRestore();
      detailSpy.mockRestore();
    }
  });

  it("marks an unexpected post-terminal throw with the child terminal evidence for the belt", async () => {
    // Field contract with the delegation belt (childTerminalEvidence): a throw
    // AFTER the terminal is durable discloses the child really ran, so the
    // belt keeps its slot consumed and reconciles spend fail-closed.
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const ensureSpy = vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
    });
    const enqueueSpy = vi.spyOn(daemonRun, "enqueueAndAwait").mockResolvedValue({
      runId: "run-done",
      runDir: "",
      status: "succeeded",
      jobId: "job-done",
    });
    const summarySpy = vi.spyOn(daemonRun, "daemonOutcomeSummary").mockImplementation(() => {
      throw new Error("post-terminal projection bug");
    });
    try {
      await expect(mcpSurfaceRunner()({ mode: "agent", prompt: "go" })).rejects.toMatchObject({
        message: "post-terminal projection bug",
        delegationChildTerminal: { runId: "run-done", status: "succeeded" },
      });
    } finally {
      ensureSpy.mockRestore();
      enqueueSpy.mockRestore();
      summarySpy.mockRestore();
    }
  });

  it("honors the externalContextPolicy alias when web is absent (schema advertises both)", async () => {
    // The alias is validated equal to web when both are present; alone it IS
    // the web policy — silently dropping it would run the daemon default.
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    void mcpSurfaceRunner; // body mapping is exercised through the daemon route below
    const daemonRun = await import("./daemon-run.js");
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as never),
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

  it("maps the best-of tool's race marker to the documented default n=2", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const ensureSpy = vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
    });
    const enqueueSpy = vi.spyOn(daemonRun, "enqueueAndAwait").mockResolvedValue({
      runId: "run-best-of",
      runDir: "",
      status: "running",
      jobId: "job-best-of",
    });
    try {
      await mcpSurfaceRunner()({
        mode: "agent",
        prompt: "compare",
        race: true,
        deferred: true,
      });
      expect(enqueueSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ n: 2 }),
        expect.objectContaining({ waitForTerminal: false }),
      );
    } finally {
      ensureSpy.mockRestore();
      enqueueSpy.mockRestore();
    }
  });

  it("ignores raw Delegate lineage and enables internal enqueue only from the bound belt constructor", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const connection = {
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
    };
    const ensureSpy = vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue(connection);
    const connectSpy = vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue(connection);
    const calls: Array<{ body: Record<string, unknown>; options: Record<string, unknown> }> = [];
    const enqueueSpy = vi
      .spyOn(daemonRun, "enqueueAndAwait")
      .mockImplementation(async (_client, _addr, body, options) => {
        calls.push({ body, options: options as Record<string, unknown> });
        return { runId: "run-child", runDir: "", status: "running", jobId: "job-child" };
      });
    try {
      await mcpSurfaceRunner()({
        mode: "agent",
        prompt: "raw",
        deferred: true,
        repoPath: "/forged/raw-project",
        parentRunId: "forged",
        delegatedFromRunId: "forged",
      });
      await mcpSurfaceRunner({
        requireExistingDaemon: true,
        delegationParentRunId: "run-parent",
        delegationRepoRoot: "/bound/original-project",
      })({
        mode: "agent",
        prompt: "bound",
        deferred: true,
        repoPath: "/forged/parent-envelope",
        delegatedFromRunId: "forged",
      });
      expect(calls[0]!.body).not.toHaveProperty("parentRunId");
      expect(calls[0]!.body).not.toHaveProperty("delegatedFromRunId");
      expect(calls[0]!.options).not.toHaveProperty("internalDaemonEnqueue");
      expect(calls[0]!.body).toMatchObject({
        scope: { kind: "project", root: "/forged/raw-project" },
      });
      expect(calls[1]!.body).toMatchObject({
        parentRunId: "run-parent",
        delegatedFromRunId: "run-parent",
        scope: { kind: "project", root: "/bound/original-project" },
      });
      expect(calls[1]!.options).toMatchObject({ internalDaemonEnqueue: true });
    } finally {
      ensureSpy.mockRestore();
      connectSpy.mockRestore();
      enqueueSpy.mockRestore();
    }
  });

  it("refuses a belt status/result read for a run outside its bound parent", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const connectSpy = vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          summary: { runId: "run-other", delegatedFromRunId: "another-parent" },
        }),
      })) as never,
    );
    try {
      const runner = mcpSurfaceRunner({
        requireExistingDaemon: true,
        delegationParentRunId: "run-parent",
      });
      for (const mode of ["__run_status", "__run_result"]) {
        await expect(runner({ mode, runId: "run-other" })).rejects.toMatchObject({
          code: "delegation_child_scope_violation",
          status: 403,
        });
      }
    } finally {
      connectSpy.mockRestore();
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

  it("projects an immediate child result lineage and terminal fields from one detail snapshot", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const ensureSpy = vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
    });
    const enqueueSpy = vi.spyOn(daemonRun, "enqueueAndAwait").mockResolvedValue({
      runId: "run-child",
      runDir: "",
      status: "succeeded",
      jobId: "job-child",
    });
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        summary: {
          parentRunId: "run-parent",
          delegatedFromRunId: "run-parent",
          spendUsd: 0.25,
          delegation: {
            requested: false,
            effective: false,
            used: false,
            reason: "not_requested",
            remediation: null,
          },
        },
        applyEligibility: { eligible: false, state: "no_op" },
        outcomeBanner: "Completed",
        council: null,
      }),
    }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const result = (await mcpSurfaceRunner()({ mode: "agent", prompt: "go" })) as Record<
        string,
        unknown
      >;
      expect(result).toMatchObject({
        runId: "run-child",
        parentRunId: "run-parent",
        delegatedFromRunId: "run-parent",
        spendUsd: 0.25,
        outcomeBanner: "Completed",
        delegation: { reason: "not_requested" },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      ensureSpy.mockRestore();
      enqueueSpy.mockRestore();
      vi.unstubAllGlobals();
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
      // Honest TOTAL across both pages (summed page lengths), not the single-page
      // undercount of 2 nor a 50k-row accumulation.
      expect(result["summary"]).toBe("3 daemon-tracked run(s)");
      expect(result["total"]).toBe(3);
      // The returned rows are only the FIRST page (deeper pages are counted then
      // discarded so the walk never materializes the whole retained set).
      expect((result["runs"] as unknown[]).length).toBe(2);
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
