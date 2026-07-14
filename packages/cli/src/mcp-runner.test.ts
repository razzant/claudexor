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
});

describe("mcp daemon body mapping", () => {
  it("honors the externalContextPolicy alias when web is absent (schema advertises both)", async () => {
    // The alias is validated equal to web when both are present; alone it IS
    // the web policy — silently dropping it would run the daemon default.
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    void mcpSurfaceRunner; // body mapping is exercised through the daemon route below
    const daemonRun = await import("./daemon-run.js");
    const bodies: Record<string, unknown>[] = [];
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
    }
  });
});
