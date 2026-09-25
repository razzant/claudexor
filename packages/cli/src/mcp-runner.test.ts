import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeOutcomeFacts, SCHEMA_VERSION, validateRunFactsInvariants } from "@claudexor/schema";
import { makeInteractionBridge } from "./mcp-runner.js";

const addr = { baseUrl: "http://127.0.0.1:1", token: "t" } as never;
const PUBLIC_RECOVERY_MODES = ["__run_inspect", "__run_status", "__run_result"] as const;
const BELT_RECOVERY_MODES = ["__run_status", "__run_result"] as const;

function validPlanRunFacts(runId: string) {
  return validateRunFactsInvariants({
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    task_id: `task-${runId}`,
    mode: "plan",
    outcome: makeOutcomeFacts("succeeded"),
    deliverable: {
      present: true,
      kind: "plan",
      path: "final/plan.md",
      producer_attempt_id: "p01",
    },
    participants: {
      planners: 1,
      attempts: [
        {
          attempt_id: "p01",
          harness_id: "codex",
          role: "planner",
          deliverable_present: true,
          status: "success",
        },
      ],
    },
    gates: {
      configured: false,
      required: 0,
      total: 0,
      executed: false,
      state: "not_configured",
      receipt_attempt_id: null,
    },
    review: { state: "not_run", blocker_ids: [], blockers: 0 },
    apply: { eligibility: null, operator_decision_present: false },
    required_actions: [],
    generated_at: "2026-08-14T00:00:00.000Z",
  });
}

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
    expect(Object.hasOwn(seenRequests[0] as object, "timeoutAt")).toBe(true);
    expect((seenRequests[0] as any).timeoutAt).toBeNull();
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
    expect(posts[0]).toContain('"reason_code":"host_cancelled"');
  });

  it.each(["user_cancelled", "owner_task_gone"])(
    "preserves the caller's typed %s cancellation cause",
    async (reason) => {
      const fetch = vi.fn(async () => ({ ok: true }));
      vi.stubGlobal("fetch", fetch);
      const { makeCancelBridge } = await import("./mcp-runner.js");
      const controller = new AbortController();
      controller.abort(reason);
      await makeCancelBridge(addr, controller.signal)({ runId: "run-cause" });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/runs/run-cause/control"),
        expect.objectContaining({
          body: JSON.stringify({
            control: {
              kind: "cancel",
              reason: "calling surface cancelled the run",
              reason_code: reason,
            },
          }),
        }),
      );
    },
  );

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

  it("passes the daemon-owned Git capability through the MCP catalog", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const connectSpy = vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toContain("/agent-capabilities");
        return {
          ok: true,
          json: async () => ({
            ok: true,
            git: {
              status: "developer_tools_stub",
              version: null,
              detail: "xcode-select: no developer tools",
              remediation: "Install Apple Command Line Tools.",
            },
          }),
        } as never;
      }),
    );
    try {
      const result = (await mcpSurfaceRunner()({ mode: "__capabilities" })) as Record<string, any>;
      expect(result.git).toMatchObject({ status: "developer_tools_stub" });
    } finally {
      connectSpy.mockRestore();
      vi.unstubAllGlobals();
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

  it.each(["__run_cancel", "__run_answer", "__apply_check"])(
    "fails %s when no daemon can perform the action",
    async (mode) => {
      const { mcpSurfaceRunner } = await import("./mcp-runner.js");
      const daemonRun = await import("./daemon-run.js");
      const connectSpy = vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue(null);
      try {
        await expect(
          mcpSurfaceRunner()({
            mode,
            runId: "run-offline",
            ...(mode === "__run_answer" ? { interactionId: "int-1", answers: { q1: "A" } } : {}),
          }),
        ).rejects.toMatchObject({ code: "daemon_unavailable", retryable: true });
      } finally {
        connectSpy.mockRestore();
      }
    },
  );

  it("preserves the daemon's typed error field for a missing-run belt roundtrip", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const connectSpy = vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
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

  it.each(["run_facts_invalid", "invalid_service_response"])(
    "preserves a post-terminal %s problem without trusting local artifacts",
    async (problemCode) => {
      // The run FINISHED: a typed 500 (e.g. run_facts_invalid) on the follow-up
      // GET /runs/:id must ride the result as detailProblem with the runId
      // preserved — never erase the terminal outcome by rethrowing.
      const { mcpSurfaceRunner } = await import("./mcp-runner.js");
      const daemonRun = await import("./daemon-run.js");
      const ensureSpy = vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
        client: {} as never,
        addr: { baseUrl: "http://x", token: "t" } as never,
        engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
      });
      const runDir = mkdtempSync(join(tmpdir(), "claudexor-mcp-detail-problem-"));
      mkdirSync(join(runDir, "final"));
      writeFileSync(join(runDir, "final", "patch.diff"), "local fallback must not be trusted\n");
      const enqueueSpy = vi.spyOn(daemonRun, "enqueueAndAwait").mockResolvedValue({
        runId: "run-done",
        runDir,
        status: "succeeded",
        jobId: "job-done",
      });
      const detailSpy = vi.spyOn(daemonRun, "fetchRunDetail").mockRejectedValue(
        Object.assign(new Error("canonical run detail is invalid"), {
          code: problemCode,
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
          summary: "run succeeded",
          detailProblem: {
            code: problemCode,
            message: "canonical run detail is invalid",
            retryable: false,
          },
        });
        expect(result["applyEligibility"]).toBeNull();
        expect(result["spendUsd"]).toBeNull();
      } finally {
        ensureSpy.mockRestore();
        enqueueSpy.mockRestore();
        detailSpy.mockRestore();
        rmSync(runDir, { recursive: true, force: true });
      }
    },
  );

  it("keeps immediate missing and transport-unavailable detail as null without a problem", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const ensureSpy = vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    const enqueueSpy = vi.spyOn(daemonRun, "enqueueAndAwait").mockResolvedValue({
      runId: "run-soft-absence",
      runDir: "",
      status: "succeeded",
      jobId: "job-soft-absence",
    });
    try {
      for (const unavailable of [false, true]) {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => {
            if (unavailable) throw new Error("socket lost");
            return { ok: false, status: 404, json: async () => ({}) } as never;
          }),
        );
        const result = (await mcpSurfaceRunner()({ mode: "agent", prompt: "go" })) as Record<
          string,
          unknown
        >;
        expect(result).toMatchObject({
          runId: "run-soft-absence",
          runFacts: null,
          outcomeFacts: null,
          applyEligibility: null,
        });
        expect(result).not.toHaveProperty("detailProblem");
      }
    } finally {
      ensureSpy.mockRestore();
      enqueueSpy.mockRestore();
      vi.unstubAllGlobals();
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
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
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
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    const enqueueSpy = vi
      .spyOn(daemonRun, "enqueueAndAwait")
      .mockImplementation(async (_c, _a, body) => {
        bodies.push(body);
        return { runId: "r", runDir: "", status: "no_op", jobId: "j" };
      });
    try {
      const runner = mcpSurfaceRunner();
      await runner({
        mode: "agent",
        prompt: "go",
        externalContextPolicy: "cached",
        credentialProfileId: "work-secondary",
      });
      await runner({ mode: "plan", prompt: "plan it" });
      expect(bodies[0]?.["web"]).toBe("cached");
      expect(bodies[0]?.["credentialProfileId"]).toBe("work-secondary");
      expect(bodies[1]?.["mode"]).toBe("plan");
      expect(ensureSpy).toHaveBeenCalledTimes(2);
    } finally {
      ensureSpy.mockRestore();
      enqueueSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("creates a persistent thread and enqueues a turn through the control API", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const ensureSpy = vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: string }) => {
        requests.push({
          url,
          body: JSON.parse(init?.body ?? "{}") as Record<string, unknown>,
        });
        return {
          ok: true,
          status: 200,
          json: async () =>
            url.endsWith("/threads")
              ? {
                  id: "th-1",
                  title: "Audit",
                  createdAt: "2026-09-24T00:00:00Z",
                  updatedAt: "2026-09-24T00:00:00Z",
                }
              : {
                  jobId: "job-1",
                  threadId: "th-1",
                  turnId: "turn-1",
                  runId: "run-1",
                  runDir: "/tmp/run-1",
                },
        } as never;
      }),
    );
    try {
      const runner = mcpSurfaceRunner();
      const created = (await runner({
        mode: "__thread_create",
        repoPath: "/tmp/project",
        title: "Audit",
        credentialProfileId: "work-secondary",
        access: "workspace_write",
      })) as Record<string, unknown>;
      const turn = (await runner({
        mode: "__thread_turn",
        threadId: "th-1",
        prompt: "continue",
        primaryHarness: "codex",
        model: "gpt-6-sol",
        effort: "high",
        credentialProfileId: "work-secondary",
      })) as Record<string, unknown>;

      expect(requests).toEqual([
        {
          url: "http://x/v2/threads",
          body: {
            title: "Audit",
            scope: { kind: "project", root: "/tmp/project" },
            credentialProfileId: "work-secondary",
            access: "workspace_write",
          },
        },
        {
          url: "http://x/v2/threads/th-1/turns",
          body: {
            prompt: "continue",
            primaryHarness: "codex",
            model: "gpt-6-sol",
            effort: "high",
            credentialProfileId: "work-secondary",
          },
        },
      ]);
      expect(created).toMatchObject({ threadId: "th-1" });
      expect(turn).toMatchObject({ threadId: "th-1", turnId: "turn-1", runId: "run-1" });
    } finally {
      ensureSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("preserves typed thread control problems", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const ensureSpy = vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({ error: "thread is busy", code: "thread_busy", retryable: true }),
      })) as never,
    );
    try {
      await expect(
        mcpSurfaceRunner()({ mode: "__thread_turn", threadId: "th-1", prompt: "continue" }),
      ).rejects.toMatchObject({ code: "thread_busy" });
    } finally {
      ensureSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("rejects malformed successful thread responses", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const ensureSpy = vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) as never,
    );
    try {
      await expect(
        mcpSurfaceRunner()({ mode: "__thread_create", repoPath: "/tmp/project" }),
      ).rejects.toMatchObject({ code: "invalid_response" });
      await expect(
        mcpSurfaceRunner()({ mode: "__thread_turn", threadId: "th-1", prompt: "continue" }),
      ).rejects.toMatchObject({ code: "invalid_response" });
    } finally {
      ensureSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("maps the best-of tool's race marker to the documented default n=2", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const ensureSpy = vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
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
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" as const },
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
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          summary: {
            jobId: "job-other",
            runId: "run-other",
            state: "running",
            delegatedFromRunId: "another-parent",
          },
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

  it.each([true, false, undefined])(
    "preserves review=%s when requesting a durable MCP run handle",
    async (review) => {
      const { mcpSurfaceRunner } = await import("./mcp-runner.js");
      const daemonRun = await import("./daemon-run.js");
      const ensureSpy = vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
        client: {} as never,
        addr: { baseUrl: "http://x", token: "t" } as never,
        engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
      });
      const enqueueSpy = vi.spyOn(daemonRun, "enqueueAndAwait").mockResolvedValue({
        runId: "run-durable",
        runDir: "/tmp/run-durable",
        status: "running",
        jobId: "job-durable",
      });
      const detailSpy = vi.spyOn(daemonRun, "fetchRunDetail");
      try {
        const result = await mcpSurfaceRunner()({
          mode: "agent",
          prompt: "go",
          deferred: true,
          review,
        });
        expect(enqueueSpy).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          expect.anything(),
          expect.objectContaining({ waitForTerminal: false }),
        );
        expect(enqueueSpy.mock.calls[0]?.[2]).toMatchObject(review === undefined ? {} : { review });
        if (review === undefined)
          expect(enqueueSpy.mock.calls[0]?.[2]).not.toHaveProperty("review");
        expect(result).toMatchObject({ runId: "run-durable", status: "running" });
        expect(result).toMatchObject({ runFacts: null });
        expect(detailSpy).not.toHaveBeenCalled();
        expect(ensureSpy).toHaveBeenCalledOnce();
      } finally {
        ensureSpy.mockRestore();
        enqueueSpy.mockRestore();
        detailSpy.mockRestore();
      }
    },
  );

  it("projects detail when a deferred MCP start already observes a failed terminal", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const failure = {
      phase: "execute",
      category: "auth",
      code: null,
      harnessId: "claude",
      attemptId: "a01",
      safeMessage: "Authentication expired",
      rawDetailRef: null,
      resetsAt: null,
      logRefs: [],
      eventRefs: [],
      runDir: "/tmp/run-fast-failed",
      nextActions: ["Log in again"],
    };
    const ensureSpy = vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    const enqueueSpy = vi.spyOn(daemonRun, "enqueueAndAwait").mockResolvedValue({
      runId: "run-fast-failed",
      runDir: "/tmp/run-fast-failed",
      status: "failed",
      jobId: "job-fast-failed",
    });
    const detailSpy = vi.spyOn(daemonRun, "fetchRunDetail").mockResolvedValue({ failure });
    try {
      const result = (await mcpSurfaceRunner()({
        mode: "agent",
        prompt: "go",
        deferred: true,
      })) as Record<string, unknown>;
      expect(enqueueSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ waitForTerminal: false }),
      );
      expect(result).toMatchObject({
        runId: "run-fast-failed",
        status: "failed",
        failure,
      });
      expect(detailSpy).toHaveBeenCalledOnce();
      expect(detailSpy).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: "http://x", token: "t" }),
        "run-fast-failed",
      );
    } finally {
      ensureSpy.mockRestore();
      enqueueSpy.mockRestore();
      detailSpy.mockRestore();
    }
  });

  it("projects an immediate child result lineage and terminal fields from one detail snapshot", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const ensureSpy = vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    const enqueueSpy = vi.spyOn(daemonRun, "enqueueAndAwait").mockResolvedValue({
      runId: "run-child",
      runDir: "",
      status: "succeeded",
      jobId: "job-child",
    });
    const outcomeFacts = makeOutcomeFacts("succeeded");
    const runFacts = validPlanRunFacts("run-child");
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        summary: {
          jobId: "job-child",
          runId: "run-child",
          taskId: "task-run-child",
          state: "succeeded",
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
          outcomeFacts,
        },
        runFacts,
        applyEligibility: {
          eligible: false,
          state: "no_op",
          reason: null,
          requiredAction: null,
        },
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
        outcomeFacts,
        runFacts,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      ensureSpy.mockRestore();
      enqueueSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("clears the entire immediate detail snapshot when RunFacts invariants are invalid", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const ensureSpy = vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    const enqueueSpy = vi.spyOn(daemonRun, "enqueueAndAwait").mockResolvedValue({
      runId: "run-invalid",
      runDir: "/tmp/run-invalid",
      status: "succeeded",
      jobId: "job-invalid",
    });
    const valid = validPlanRunFacts("run-invalid");
    const fetchSpy = vi.spyOn(daemonRun, "fetchRunDetail").mockResolvedValue({
      summary: {
        runId: "run-invalid",
        taskId: "task-run-invalid",
        state: "succeeded",
        spendUsd: 0.75,
        outcomeFacts: makeOutcomeFacts("succeeded"),
        parentRunId: "run-parent",
        delegatedFromRunId: "run-parent",
        delegation: {
          requested: true,
          effective: true,
          used: true,
          reason: null,
          remediation: null,
        },
      },
      runFacts: {
        ...valid,
        participants: { ...valid.participants, planners: 2 },
      },
      primaryOutput: { kind: "plan", path: "final/plan.md", text: "must be discarded" },
      applyEligibility: {
        eligible: false,
        state: "no_op",
        reason: null,
        requiredAction: null,
      },
      outcomeBanner: "must be discarded",
      planReadiness: { state: "ready", questionCount: 0 },
      council: {
        requested: 2,
        drafted: 2,
        degraded: false,
        mergedBy: "codex",
        members: [
          { harnessId: "codex", role: "primary", status: "merged", error: null },
          { harnessId: "cursor", role: "member", status: "drafted", error: null },
        ],
      },
      budget: {
        paidBudget: { kind: "finite", maxUsd: 2 },
        spendUsd: 0.75,
        valuationUsd: 1.25,
        valuationKnowledge: "estimated",
        remainingUsd: 1.25,
        estimated: false,
        source: "events",
        evidence: "complete",
      },
      failure: {
        phase: "execute",
        category: "auth",
        code: null,
        harnessId: "codex",
        attemptId: "p01",
        safeMessage: "must be discarded",
        rawDetailRef: null,
        resetsAt: null,
        logRefs: [],
        eventRefs: [],
        runDir: "/tmp/run-invalid",
        nextActions: ["must be discarded"],
      },
    });
    try {
      const result = (await mcpSurfaceRunner()({ mode: "plan", prompt: "go" })) as Record<
        string,
        unknown
      >;
      expect(result).toMatchObject({
        runId: "run-invalid",
        status: "succeeded",
        summary: "run succeeded",
        runFacts: null,
        outcomeFacts: null,
        applyEligibility: null,
        spendUsd: null,
        outcomeBanner: null,
        planReadiness: null,
        council: null,
        failure: null,
        parentRunId: null,
        delegatedFromRunId: null,
        delegation: null,
        detailProblem: { code: "run_facts_invalid", retryable: false },
      });
      expect(result).not.toHaveProperty("budget");
      expect(result).not.toHaveProperty("primaryOutput");
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      ensureSpy.mockRestore();
      enqueueSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it("clears the immediate detail snapshot when a shape-valid receipt carries the wrong run identity", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const ensureSpy = vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    const enqueueSpy = vi.spyOn(daemonRun, "enqueueAndAwait").mockResolvedValue({
      runId: "run-right",
      runDir: "/tmp/run-right",
      status: "succeeded",
      jobId: "job-right",
    });
    // HTTP 200 malformed-success without a summary identity, carrying a
    // receipt that validates in isolation but belongs to a different run: the
    // immediate call site itself must bind the enqueued identity (the
    // summary-derived fallback is absent here by construction).
    const fetchSpy = vi.spyOn(daemonRun, "fetchRunDetail").mockResolvedValue({
      runFacts: validPlanRunFacts("run-wrong"),
      outcomeBanner: "must be discarded",
    });
    try {
      const result = (await mcpSurfaceRunner()({ mode: "plan", prompt: "go" })) as Record<
        string,
        unknown
      >;
      expect(result).toMatchObject({
        runId: "run-right",
        status: "succeeded",
        runFacts: null,
        outcomeFacts: null,
        outcomeBanner: null,
        detailProblem: { code: "run_facts_invalid", retryable: false },
      });
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      ensureSpy.mockRestore();
      enqueueSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it("__runs_list walks the keyset cursor so the count is not undercounted by one page (QA-052)", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const connectSpy = vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
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
    const runFacts = validPlanRunFacts("run-result");
    const connectSpy = vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("http://x/v2/runs/run-result");
        return {
          ok: true,
          json: async () => ({
            summary: {
              jobId: "job-result",
              runId: "run-result",
              taskId: "task-run-result",
              state: "succeeded",
              runDir: "/tmp/run-result",
              result: { kind: "plan", changed_files: [] },
            },
            runFacts,
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
        runFacts,
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

  it.each(
    PUBLIC_RECOVERY_MODES.flatMap((mode) =>
      (["run_facts_invalid", "invalid_service_response"] as const).map(
        (problemCode) => [mode, problemCode] as const,
      ),
    ),
  )("degrades public %s typed %s to a minimal handle", async (mode, problemCode) => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const connectSpy = vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    const retryable = problemCode === "invalid_service_response";
    const fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({
        code: problemCode,
        message: `typed ${problemCode}`,
        retryable,
      }),
    }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const result = (await mcpSurfaceRunner()({
        mode,
        runId: "run-degraded",
      })) as Record<string, unknown>;
      expect(result).toEqual({
        summary: "run run-degraded: detail unavailable",
        runId: "run-degraded",
        runDir: null,
        status: null,
        runFacts: null,
        decisionStatus: null,
        pendingInteractions: null,
        outcomeFacts: null,
        failure: null,
        outcomeBanner: null,
        applyEligibility: null,
        planReadiness: null,
        council: null,
        budget: null,
        parentRunId: null,
        delegatedFromRunId: null,
        delegation: null,
        detailProblem: {
          code: problemCode,
          message: `typed ${problemCode}`,
          retryable,
        },
      });
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      connectSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("also degrades malformed success and wrong receipt identity without partial authority", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const connectSpy = vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    const responses = [
      {
        ok: true,
        status: 200,
        json: async () => ({ summary: { runId: "run-degraded", state: "succeeded" } }),
      },
      {
        ok: true,
        status: 200,
        json: async () => ({
          summary: {
            jobId: "job-degraded",
            runId: "run-degraded",
            taskId: "task-run-degraded",
            state: "succeeded",
          },
          runFacts: validPlanRunFacts("run-other"),
        }),
      },
    ];
    const fetchSpy = vi.fn(async () => responses.shift() as never);
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const runner = mcpSurfaceRunner();
      for (const expectedCode of ["invalid_service_response", "run_facts_invalid"]) {
        const result = (await runner({
          mode: "__run_result",
          runId: "run-degraded",
        })) as Record<string, unknown>;
        expect(result).toMatchObject({
          runId: "run-degraded",
          runDir: null,
          status: null,
          runFacts: null,
          outcomeFacts: null,
          failure: null,
          applyEligibility: null,
          council: null,
          budget: null,
          parentRunId: null,
          delegatedFromRunId: null,
          detailProblem: { code: expectedCode },
        });
      }
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      connectSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it.each(
    PUBLIC_RECOVERY_MODES.flatMap((mode) =>
      (["404", "auth", "untyped integrity-looking 500", "transport"] as const).map(
        (failureKind) => [mode, failureKind] as const,
      ),
    ),
  )("keeps public %s %s as a tool error", async (mode, failureKind) => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const connectSpy = vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (failureKind === "transport") throw new Error("socket lost");
        if (failureKind === "404") {
          return { ok: false, status: 404, json: async () => ({ error: "missing" }) } as never;
        }
        if (failureKind === "auth") {
          return {
            ok: false,
            status: 401,
            json: async () => ({ code: "unauthorized", message: "denied", retryable: false }),
          } as never;
        }
        return {
          ok: false,
          status: 500,
          json: async () => ({ code: "run_facts_invalid", message: "missing typed fields" }),
        } as never;
      }),
    );
    try {
      const run = mcpSurfaceRunner()({ mode, runId: "run-error" });
      if (failureKind === "transport") await expect(run).rejects.toThrow("socket lost");
      else if (failureKind === "404") await expect(run).rejects.toThrow("missing");
      else if (failureKind === "auth") {
        await expect(run).rejects.toMatchObject({ code: "unauthorized" });
      } else {
        await expect(run).rejects.toMatchObject({ code: "run_facts_invalid" });
      }
    } finally {
      connectSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it.each(BELT_RECOVERY_MODES)(
    "keeps delegation-belt %s fail-closed when detail integrity hides lineage",
    async (mode) => {
      const { mcpSurfaceRunner } = await import("./mcp-runner.js");
      const daemonRun = await import("./daemon-run.js");
      const connectSpy = vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue({
        client: {} as never,
        addr: { baseUrl: "http://x", token: "t" } as never,
        engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
      });
      const fetchSpy = vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({
          code: "run_facts_invalid",
          message: "canonical receipt is invalid",
          retryable: false,
        }),
      }));
      vi.stubGlobal("fetch", fetchSpy);
      try {
        await expect(
          mcpSurfaceRunner({
            requireExistingDaemon: true,
            delegationParentRunId: "run-parent",
          })({ mode, runId: "run-child" }),
        ).rejects.toMatchObject({ code: "run_facts_invalid" });
        expect(fetchSpy).toHaveBeenCalledOnce();
      } finally {
        connectSpy.mockRestore();
        vi.unstubAllGlobals();
      }
    },
  );

  it("preserves typed RunFailure in recovery projections", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const connectSpy = vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    const failure = {
      phase: "execute",
      category: "auth",
      code: null,
      harnessId: "claude",
      attemptId: "a01",
      safeMessage: "Authentication expired",
      rawDetailRef: null,
      resetsAt: null,
      vendorFailure: null,
      logRefs: [],
      eventRefs: [],
      runDir: "/tmp/run-failed",
      nextActions: ["Log in again"],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            json: async () => ({
              summary: {
                jobId: "job-failed",
                runId: "run-failed",
                state: "failed",
                runDir: "/tmp/run-failed",
              },
              finalSummary: "Run failed.",
              primaryOutput: {
                kind: "diagnostic",
                path: "final/failure.yaml",
                text: "Authentication expired",
              },
              failure,
            }),
          }) as never,
      ),
    );
    try {
      const runner = mcpSurfaceRunner();
      for (const mode of ["__run_inspect", "__run_status", "__run_result"]) {
        const result = (await runner({ mode, runId: "run-failed" })) as Record<string, unknown>;
        expect(result["status"]).toBe("failed");
        expect(result["failure"]).toEqual(failure);
      }
    } finally {
      connectSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
