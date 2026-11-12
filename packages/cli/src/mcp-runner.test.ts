import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ControlPendingInteraction,
  ControlProblem,
  makeOutcomeFacts,
  SCHEMA_VERSION,
  validateRunFactsInvariants,
} from "@claudexor/schema";
import { requestInteractionAnswers } from "../../acp-server/src/interaction-answers.js";
import { DaemonControlApiServer } from "../../control-api/src/daemon-server.js";
import type { DaemonRunRecord } from "../../control-api/src/run-record.js";
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

  /** Each POST answers with the next scripted outcome; the detail keeps listing the question. */
  function scriptedPosts(outcomes: Array<"throw" | { status: number; body: unknown }>) {
    const posted: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
        if (init?.method === "POST") {
          posted.push(JSON.parse(init.body ?? "{}"));
          const outcome = outcomes.shift() ?? { status: 200, body: {} };
          if (outcome === "throw") throw new TypeError("fetch failed");
          return {
            ok: outcome.status < 300,
            status: outcome.status,
            json: async () => outcome.body,
          } as never;
        }
        return {
          ok: true,
          json: async () => ({
            pendingInteractions: [{ interactionId: "int-r", questions: [], timeoutAt: null }],
          }),
        } as never;
      }),
    );
    return posted;
  }

  async function ticks(bridge: (info: { runId: string }) => Promise<void>, count: number) {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (let tick = 0; tick < count; tick++) {
        await bridge({ runId: "run-r" });
        // The prompt and its post run beside the tick.
        await new Promise((resolve) => setTimeout(resolve, 0));
        vi.setSystemTime(Date.now() + 1_100);
      }
    } finally {
      vi.useRealTimers();
    }
  }

  it("stops re-posting an answer the daemon definitely refused, without asking again", async () => {
    // The answer route's problem for a refused answer: nothing committed, the
    // question still pending, and the same body would be refused again.
    const posted = scriptedPosts([
      {
        status: 409,
        body: {
          code: "conflict",
          message: "question 'q' has neither a selected label nor free text",
          retryable: false,
          context: { accepted: false, status: "rejected" },
        },
      },
    ]);
    let asks = 0;
    const bridge = makeInteractionBridge(addr, async () => {
      asks += 1;
      return { answers: [{ question_id: "q", selected_labels: [""], free_text: null }] };
    });
    await ticks(bridge, 4);
    expect(asks).toBe(1);
    expect(posted).toHaveLength(1);
  });

  it("keeps re-posting the same answer after a transport failure or a refusal that is not definite", async () => {
    const posted = scriptedPosts([
      "throw",
      {
        status: 503,
        body: {
          code: "daemon_stopping",
          message: "daemon is stopping",
          retryable: true,
          context: {},
        },
      },
      { status: 200, body: { accepted: true, status: "delivered" } },
    ]);
    let asks = 0;
    const bridge = makeInteractionBridge(addr, async () => {
      asks += 1;
      return { answers: [{ question_id: "q", selected_labels: ["A"], free_text: null }] };
    });
    await ticks(bridge, 5);
    expect(asks).toBe(1);
    // Three attempts with the same body, then delivered: nothing more is posted.
    expect(posted).toEqual(
      Array(3).fill({ answers: [{ questionId: "q", selectedLabels: ["A"] }] }),
    );
  });
});

describe("makeInteractionBridge with async questions (#628)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const question = (interactionId: string, delivery?: "blocking" | "async") => ({
    interactionId,
    questions: [
      {
        id: "q1",
        question: "Who is it for?",
        header: null,
        options: [{ label: "Customers", description: null }],
        multi_select: false,
      },
    ],
    timeoutAt: null,
    ...(delivery ? { delivery } : {}),
  });

  function detailServer(initial: unknown[]) {
    let pending = initial;
    const posts: Array<{ url: string; body: unknown }> = [];
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
    return {
      posts,
      set: (next: unknown[]) => {
        pending = next;
      },
    };
  }

  // Monotonic across calls, so every tick passes the bridge's one-second poll
  // throttle instead of landing inside the window of the previous one.
  let clock = 0;
  async function nextTick(bridge: (info: { runId: string }) => Promise<void>) {
    clock = Math.max(clock, Date.now()) + 1_100;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(clock);
      await bridge({ runId: "run-a" });
    } finally {
      vi.useRealTimers();
    }
  }

  it("never holds the poll tick on an async prompt and closes it once the question is gone", async () => {
    const server = detailServer([question("async-1", "async")]);
    const seen: any[] = [];
    let release!: (value: unknown) => void;
    const bridge = makeInteractionBridge(addr, (ctx) => {
      seen.push(ctx);
      return new Promise((resolve) => {
        release = resolve;
        ctx.signal.addEventListener("abort", () => resolve(null), { once: true });
      });
    });
    // The tick returns while the async prompt is still open.
    await bridge({ runId: "run-a" });
    expect(seen).toHaveLength(1);
    expect(seen[0].request).toMatchObject({ interaction_id: "async-1", delivery: "async" });
    expect(seen[0].signal.aborted).toBe(false);
    // Answered elsewhere: the next tick closes the obsolete prompt and posts nothing.
    server.set([]);
    await nextTick(bridge);
    expect(seen[0].signal.aborted).toBe(true);
    release({ answers: [{ question_id: "q1", selected_labels: ["Customers"], free_text: null }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(server.posts).toEqual([]);
    // The closed question is never asked again.
    server.set([question("async-1", "async")]);
    await nextTick(bridge);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toHaveLength(1);
  });

  it("posts an async answer the user gives while the question is still pending", async () => {
    const server = detailServer([question("async-1", "async")]);
    let answer!: (value: unknown) => void;
    const bridge = makeInteractionBridge(addr, () => new Promise((resolve) => (answer = resolve)));
    await bridge({ runId: "run-a" });
    answer({ answers: [{ question_id: "q1", selected_labels: [], free_text: "Customers" }] });
    await vi.waitFor(() => expect(server.posts).toHaveLength(1));
    expect(server.posts[0]).toEqual({
      url: expect.stringContaining("/runs/run-a/interactions/async-1/answer"),
      body: { answers: [{ questionId: "q1", selectedLabels: [], freeText: "Customers" }] },
    });
  });

  it("asks a blocking question first and is never held back by an open async prompt", async () => {
    detailServer([question("async-1", "async"), question("blocking-1")]);
    const order: string[] = [];
    const bridge = makeInteractionBridge(addr, async (ctx) => {
      order.push(`${ctx.request.interaction_id}:${ctx.request.delivery}`);
      if (ctx.request.delivery === "async") return new Promise(() => undefined);
      return null;
    });
    await bridge({ runId: "run-a" });
    // The async question waits while the blocking prompt is open.
    expect(order).toEqual(["blocking-1:blocking"]);
    await settle();
    await nextTick(bridge);
    expect(order).toEqual(["blocking-1:blocking", "async-1:async"]);
  });

  it("does not hold a tick on a blocking prompt, and closes one whose question is gone", async () => {
    const server = detailServer([question("blocking-1"), question("blocking-2")]);
    const asked: any[] = [];
    // A hook that ignores its signal and never settles, as a stale editor may.
    const bridge = makeInteractionBridge(addr, (ctx) => {
      asked.push(ctx);
      return new Promise(() => undefined);
    });
    await bridge({ runId: "run-a" });
    expect(asked.map((ctx) => ctx.request)).toEqual([
      expect.objectContaining({ interaction_id: "blocking-1", delivery: "blocking" }),
    ]);
    // Still pending: the same prompt stays open and nothing else is asked.
    await nextTick(bridge);
    expect(asked).toHaveLength(1);
    expect(asked[0].signal.aborted).toBe(false);
    // Answered elsewhere: the prompt closes and no longer holds the next question.
    server.set([question("blocking-2")]);
    await nextTick(bridge);
    expect(asked[0].signal.reason).toEqual({ kind: "interaction_resolved" });
    expect(asked.map((ctx) => ctx.request.interaction_id)).toEqual(["blocking-1", "blocking-2"]);
    expect(asked[1].signal.aborted).toBe(false);
    expect(server.posts).toEqual([]);
  });

  it("posts nothing for a blocking prompt answered after it closed, and reports no failure for one", async () => {
    const server = detailServer([question("blocking-1"), question("blocking-2")]);
    const settlers: Array<{
      answer: (value: unknown) => void;
      fail: (error: Error) => void;
    }> = [];
    const bridge = makeInteractionBridge(
      addr,
      () => new Promise((answer, fail) => settlers.push({ answer, fail })),
    );
    await bridge({ runId: "run-a" });
    expect(settlers).toHaveLength(1);
    server.set([question("blocking-2")]);
    await nextTick(bridge);
    expect(settlers).toHaveLength(2);
    settlers[0]!.answer({
      answers: [{ question_id: "q1", selected_labels: ["Customers"], free_text: null }],
    });
    server.set([]);
    await nextTick(bridge);
    settlers[1]!.fail(new Error("closed prompt's own failure"));
    await settle();
    await expect(nextTick(bridge)).resolves.toBeUndefined();
    expect(server.posts).toEqual([]);
    // Neither closed prompt is asked again if its id were listed once more.
    server.set([question("blocking-1"), question("blocking-2")]);
    await nextTick(bridge);
    expect(settlers).toHaveLength(2);
  });

  it("closes every prompt the moment the caller cancels and asks nothing after", async () => {
    const server = detailServer([question("async-1", "async"), question("blocking-1")]);
    const signals: AbortSignal[] = [];
    const caller = new AbortController();
    const bridge = makeInteractionBridge(
      addr,
      (ctx) => {
        signals.push(ctx.signal);
        return new Promise(() => undefined);
      },
      caller.signal,
    );
    await bridge({ runId: "run-a" });
    expect(signals).toHaveLength(1);
    caller.abort("user_cancelled");
    expect(signals[0]!.reason).toEqual({ kind: "bridge_closed" });
    await nextTick(bridge);
    expect(signals).toHaveLength(1);
    expect(server.posts).toEqual([]);
  });

  it("opens nothing for a caller that cancelled before the bridge existed", async () => {
    detailServer([question("blocking-1")]);
    const onInteraction = vi.fn(async () => null);
    const bridge = makeInteractionBridge(addr, onInteraction, AbortSignal.abort("user_cancelled"));
    await bridge({ runId: "run-a" });
    expect(onInteraction).not.toHaveBeenCalled();
  });

  it("closes every prompt left open when the runner stops observing the run", async () => {
    detailServer([question("async-1", "async")]);
    let signal!: AbortSignal;
    const bridge = makeInteractionBridge(addr, (ctx) => {
      signal = ctx.signal;
      return new Promise(() => undefined);
    });
    await bridge({ runId: "run-a" });
    expect(signal.aborted).toBe(false);
    bridge.close();
    expect(signal.aborted).toBe(true);
    // A closed bridge asks nothing more.
    await nextTick(bridge);
  });

  /** The ACP client of the real ACP answer surface, failing every permission
   * request as a client error or a lost connection does. Its session updates
   * are kept as the question's call: opened, then how it was closed. */
  function failingAcpClient() {
    const permissionRequests: unknown[] = [];
    const calls: Array<[string, string, unknown]> = [];
    const client = {
      notify: async (_method: string, params: { update: Record<string, unknown> }) => {
        const { sessionUpdate, toolCallId, status } = params.update;
        if (typeof toolCallId === "string") calls.push([String(sessionUpdate), toolCallId, status]);
      },
      request: async (_method: string, params: unknown) => {
        permissionRequests.push(params);
        throw new Error("Internal error");
      },
    };
    return { permissionRequests, calls, client: client as never };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("asks an async question whose prompt failed only once, posts nothing for it and keeps polling", async () => {
    const server = detailServer([question("async-1", "async")]);
    const acp = failingAcpClient();
    const bridge = makeInteractionBridge(addr, (ctx) =>
      requestInteractionAnswers(acp.client, "session-a", ctx, async () => undefined),
    );
    await bridge({ runId: "run-a" });
    await vi.waitFor(() => expect(acp.permissionRequests).toHaveLength(1));
    await settle();
    // Every later poll still lists the question. The failed prompt may have
    // shown it, so none asks it again; nothing answers or declines it, and the
    // run stays observed while the agent keeps working.
    for (let tick = 0; tick < 3; tick++) {
      await expect(nextTick(bridge)).resolves.toBeUndefined();
      await settle();
    }
    expect(acp.permissionRequests).toHaveLength(1);
    expect(server.posts).toEqual([]);
    // Its call was closed as failed once, never left pending.
    expect(acp.calls).toEqual([
      ["tool_call", "async-1:q1", "pending"],
      ["tool_call_update", "async-1:q1", "failed"],
    ]);
  });

  it("ends a multi-select prompt resolved elsewhere during its first option: nothing more asked or posted", async () => {
    const server = detailServer([
      {
        interactionId: "async-ms",
        delivery: "async",
        timeoutAt: null,
        questions: [
          {
            id: "q1",
            question: "Which platforms?",
            header: null,
            multi_select: true,
            options: [
              { label: "macOS", description: null },
              { label: "linux", description: null },
            ],
          },
        ],
      },
    ]);
    const asked: string[] = [];
    const calls: Array<[string, unknown]> = [];
    const said: string[] = [];
    // An editor that leaves the prompt open and reports only the cancellation.
    const client = {
      notify: async (_method: string, params: { update: Record<string, unknown> }) => {
        calls.push([String(params.update.toolCallId), params.update.status]);
      },
      request: (
        _method: string,
        params: { toolCall: { toolCallId: string } },
        options: { cancellationSignal: AbortSignal },
      ) => {
        asked.push(params.toolCall.toolCallId);
        return new Promise((resolve) => {
          const cancelled = () => resolve({ outcome: { outcome: "cancelled" } });
          if (options.cancellationSignal.aborted) cancelled();
          else options.cancellationSignal.addEventListener("abort", cancelled, { once: true });
        });
      },
    };
    const bridge = makeInteractionBridge(addr, (ctx) =>
      requestInteractionAnswers(client as never, "session-m", ctx, async (text) => {
        said.push(text);
      }),
    );
    await bridge({ runId: "run-a" });
    await vi.waitFor(() => expect(asked).toEqual(["async-ms:q1:opt-1"]));
    // Another surface answered it: the next poll no longer lists the question.
    server.set([]);
    await nextTick(bridge);
    await settle();
    expect(asked).toEqual(["async-ms:q1:opt-1"]);
    expect(calls).toEqual([
      ["async-ms:q1:opt-1", "pending"],
      ["async-ms:q1:opt-1", "failed"],
    ]);
    expect(said).toEqual([]);
    expect(server.posts).toEqual([]);
  });

  it("still fails the next poll tick when a blocking question's prompt fails", async () => {
    const server = detailServer([question("blocking-1")]);
    const acp = failingAcpClient();
    const bridge = makeInteractionBridge(addr, (ctx) =>
      requestInteractionAnswers(acp.client, "session-b", ctx, async () => undefined),
    );
    await bridge({ runId: "run-a" });
    await vi.waitFor(() => expect(acp.permissionRequests).toHaveLength(1));
    await settle();
    // The agent is held on this prompt, so its failure is the runner's to report,
    // and inside the poll throttle too: it reports on the very next tick.
    await expect(bridge({ runId: "run-a" })).rejects.toThrow("Internal error");
    expect(acp.permissionRequests).toHaveLength(1);
    expect(server.posts).toEqual([]);
    expect(acp.calls).toEqual([
      ["tool_call", "blocking-1:q1", "pending"],
      ["tool_call_update", "blocking-1:q1", "failed"],
    ]);
  });

  it("re-posts an async answer whose reply was lost with the same body, without asking again", async () => {
    const posted: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
        if (init?.method === "POST") {
          posted.push(JSON.parse(init.body ?? "{}"));
          if (posted.length === 1) throw new TypeError("fetch failed");
          return {
            ok: true,
            status: 200,
            json: async () => ({ accepted: true, status: "delivered" }),
          } as never;
        }
        return {
          ok: true,
          json: async () => ({ pendingInteractions: [question("async-1", "async")] }),
        } as never;
      }),
    );
    let asks = 0;
    const bridge = makeInteractionBridge(addr, async () => {
      asks += 1;
      return { answers: [{ question_id: "q1", selected_labels: ["Customers"], free_text: null }] };
    });
    await bridge({ runId: "run-a" });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    await settle();
    await nextTick(bridge);
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    await settle();
    // Delivered: a later poll neither asks nor posts again.
    await nextTick(bridge);
    await settle();
    expect(asks).toBe(1);
    expect(posted).toEqual(
      Array(2).fill({ answers: [{ questionId: "q1", selectedLabels: ["Customers"] }] }),
    );
  });
});

describe("makeInteractionBridge keeps an answer only while its question is pending", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  type Reply = "throw" | { status: number; body: unknown; gate?: Promise<void> };

  const alreadyResolved = {
    status: 409,
    body: {
      code: "conflict",
      message: "interaction already resolved",
      retryable: false,
      context: { accepted: false, status: "already_resolved" },
    },
  };
  const untyped = { status: 500, body: { error: "boom" } };
  const entry = (interactionId: string, delivery?: "async") => ({
    interactionId,
    questions: [],
    timeoutAt: null,
    ...(delivery ? { delivery } : {}),
  });
  const answerOf = (label: string) => ({
    answers: [{ question_id: "q", selected_labels: [label], free_text: null }],
  });
  const postOf = (label: string) => ({ answers: [{ questionId: "q", selectedLabels: [label] }] });

  /** A daemon whose run-detail reads and answer replies the test scripts. */
  function scriptedDaemon(replies: Reply[] = []) {
    const posted: unknown[] = [];
    let read: "throw" | { ok: boolean; body: unknown } = {
      ok: true,
      body: { pendingInteractions: [] },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
        if (init?.method === "POST") {
          posted.push(JSON.parse(init.body ?? "{}"));
          const reply = replies.shift() ?? {
            status: 200,
            body: { accepted: true, status: "delivered" },
          };
          if (reply === "throw") throw new TypeError("fetch failed");
          await reply.gate;
          return {
            ok: reply.status < 300,
            status: reply.status,
            json: async () => reply.body,
          } as never;
        }
        const current = read;
        if (current === "throw") throw new TypeError("fetch failed");
        return {
          ok: current.ok,
          status: current.ok ? 200 : 500,
          json: async () => current.body,
        } as never;
      }),
    );
    return {
      posted,
      list: (...entries: unknown[]) => {
        read = { ok: true, body: { pendingInteractions: entries } };
      },
      readThrows: () => {
        read = "throw";
      },
      readFails: () => {
        read = { ok: false, body: {} };
      },
      readOmitsList: () => {
        read = { ok: true, body: {} };
      },
      readLists: (value: unknown) => {
        read = { ok: true, body: { pendingInteractions: value } };
      },
    };
  }
  type Scripted = ReturnType<typeof scriptedDaemon>;
  /** Every read that returns no usable list, in the bridge's terms: unknown, not empty. */
  const unknownReads = (server: Scripted) => [
    server.readThrows,
    server.readFails,
    server.readOmitsList,
    () => server.readLists("not a list"),
    () => server.readLists([null]),
    () => server.readLists([{ questions: [] }]),
    () => server.readLists([{ interactionId: "" }]),
  ];

  /** The bridge plus its own answer cache: the first Map it creates. A test
   * proves it is the cache by seeing an answer in it before seeing one leave. */
  function trackedBridge(onInteraction: (ctx: any) => Promise<any | null>) {
    const maps: Array<Map<string, unknown>> = [];
    const NativeMap = globalThis.Map;
    globalThis.Map = class extends NativeMap<string, unknown> {
      constructor() {
        super();
        maps.push(this);
      }
    } as MapConstructor;
    try {
      return { bridge: makeInteractionBridge(addr, onInteraction), cache: maps[0]! };
    } finally {
      globalThis.Map = NativeMap;
    }
  }

  let clock = 0;
  async function tick(bridge: (info: { runId: string }) => Promise<void>) {
    clock = Math.max(clock, Date.now()) + 1_100;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(clock);
      await bridge({ runId: "run-c" });
    } finally {
      vi.useRealTimers();
    }
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  function gated(reply: { status: number; body: unknown }) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    return { reply: { ...reply, gate }, release };
  }

  it.each([
    ["blocking", undefined, alreadyResolved],
    ["async", "async", untyped],
  ] as const)(
    "drops a refused %s answer once a successful read no longer lists its question",
    async (_kind, delivery, refusal) => {
      const server = scriptedDaemon([refusal]);
      let asks = 0;
      const { bridge, cache } = trackedBridge(async () => {
        asks += 1;
        return answerOf(asks === 1 ? "old" : "new");
      });
      server.list(entry("int-c", delivery));
      await tick(bridge);
      await settle();
      expect(server.posted).toEqual([postOf("old")]);
      expect(cache.has("int-c")).toBe(true);
      // Resolved another way: nothing can deliver this answer any more.
      server.list();
      await tick(bridge);
      await settle();
      expect(cache.has("int-c")).toBe(false);
      expect(server.posted).toHaveLength(1);
      // The same id listed again is pending anew: the old answer is not replayed.
      server.list(entry("int-c", delivery));
      await tick(bridge);
      await settle();
      expect(asks).toBe(2);
      expect(server.posted).toEqual([postOf("old"), postOf("new")]);
    },
  );

  it.each([
    ["blocking", undefined],
    ["async", "async"],
  ] as const)(
    "keeps a %s answer through reads that prove nothing and retries the same body",
    async (_kind, delivery) => {
      const server = scriptedDaemon(["throw"]);
      let asks = 0;
      const { bridge, cache } = trackedBridge(async () => {
        asks += 1;
        return answerOf("kept");
      });
      server.list(entry("int-k", delivery));
      await tick(bridge);
      await settle();
      expect(server.posted).toEqual([postOf("kept")]);
      expect(cache.has("int-k")).toBe(true);
      for (const inconclusive of unknownReads(server)) {
        inconclusive();
        await tick(bridge);
        await settle();
        expect(cache.has("int-k")).toBe(true);
      }
      server.list(entry("int-k", delivery));
      await tick(bridge);
      await settle();
      expect(asks).toBe(1);
      expect(server.posted).toEqual([postOf("kept"), postOf("kept")]);
      expect(cache.has("int-k")).toBe(false);
    },
  );

  it("leaves an open async prompt open through reads that prove nothing and closes it on a real empty list", async () => {
    const server = scriptedDaemon();
    const signals: AbortSignal[] = [];
    const bridge = makeInteractionBridge(addr, (ctx) => {
      signals.push(ctx.signal);
      return new Promise((resolve) =>
        ctx.signal.addEventListener("abort", () => resolve(null), { once: true }),
      );
    });
    server.list(entry("int-o", "async"));
    await tick(bridge);
    expect(signals).toHaveLength(1);
    for (const inconclusive of unknownReads(server)) {
      inconclusive();
      await tick(bridge);
      await settle();
      expect(signals[0]!.aborted).toBe(false);
    }
    // Still listed: the same open prompt continues, nothing is asked twice.
    server.list(entry("int-o", "async"));
    await tick(bridge);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    server.list();
    await tick(bridge);
    expect(signals[0]!.reason).toEqual({ kind: "interaction_resolved" });
  });

  it.each([
    ["blocking", undefined],
    ["async", "async"],
  ] as const)("drops a retained %s answer when the bridge closes", async (_kind, delivery) => {
    const server = scriptedDaemon([untyped]);
    const { bridge, cache } = trackedBridge(async () => answerOf("left"));
    server.list(entry("int-t", delivery));
    await tick(bridge);
    await settle();
    expect(cache.has("int-t")).toBe(true);
    bridge.close();
    expect(cache.size).toBe(0);
  });

  it.each([
    ["blocking", undefined],
    ["async", "async"],
  ] as const)(
    "keeps nothing of a %s answer whose post is still out when the bridge closes",
    async (_kind, delivery) => {
      const { reply, release } = gated(untyped);
      const server = scriptedDaemon([reply]);
      const { bridge, cache } = trackedBridge(async () => answerOf("late"));
      server.list(entry("int-p", delivery));
      const ticking = tick(bridge);
      await settle();
      expect(server.posted).toEqual([postOf("late")]);
      expect(cache.has("int-p")).toBe(true);
      bridge.close();
      expect(cache.size).toBe(0);
      release();
      await ticking;
      await settle();
      expect(cache.size).toBe(0);
    },
  );

  it.each([
    ["blocking", undefined],
    ["async", "async"],
  ] as const)(
    "keeps nothing of a %s prompt that completes after the bridge closed",
    async (_kind, delivery) => {
      const server = scriptedDaemon();
      let finish!: (value: unknown) => void;
      const { bridge, cache } = trackedBridge(() => new Promise((resolve) => (finish = resolve)));
      server.list(entry("int-l", delivery));
      const ticking = tick(bridge);
      await settle();
      bridge.close();
      finish(answerOf("late"));
      await ticking;
      await settle();
      expect(server.posted).toEqual([]);
      expect(cache.size).toBe(0);
    },
  );

  it("cannot keep an answer whose question left the list while its post was still out", async () => {
    const { reply, release } = gated(alreadyResolved);
    const server = scriptedDaemon([reply]);
    const { bridge, cache } = trackedBridge(async () => answerOf("late"));
    server.list(entry("int-g", "async"));
    await tick(bridge);
    await settle();
    expect(server.posted).toEqual([postOf("late")]);
    expect(cache.has("int-g")).toBe(true);
    server.list();
    await tick(bridge);
    await settle();
    expect(cache.has("int-g")).toBe(false);
    release();
    await settle();
    expect(cache.has("int-g")).toBe(false);
  });
});

describe("makeInteractionBridge over the real run detail when a pending read fails (#628)", () => {
  const token = "pending-read";
  const stops: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    vi.useRealTimers();
    for (const stop of stops.splice(0)) await stop();
  });

  const question = (interactionId: string, delivery: "blocking" | "async") =>
    ControlPendingInteraction.parse({
      interactionId,
      runId: "run-http",
      requestedAt: "2026-11-10T00:00:00.000Z",
      delivery,
      questions: [
        { id: "q", question: "Who is it for?", header: null, options: [], multi_select: false },
      ],
    });
  const answerOf = (text: string) => ({
    answers: [{ question_id: "q", selected_labels: [], free_text: text }],
  });

  /** The actual control API over HTTP; only its two services are scripted. */
  async function producer() {
    const record: DaemonRunRecord = {
      id: "job-http",
      runId: "run-http",
      state: "running",
      params: { mode: "ask" },
    };
    let read: () => ControlPendingInteraction[] = () => [];
    const posted: unknown[] = [];
    let refuseNextPost = false;
    const server = new DaemonControlApiServer({
      token,
      daemon: {
        list: async () => [record],
        status: async () => record,
        enqueue: async () => ({ id: "unused", state: "queued" }),
        cancel: async () => ({}),
      },
      services: {
        pendingInteractions: () => read(),
        answerInteraction: (_runId, _interactionId, answers) => {
          posted.push(answers);
          if (refuseNextPost) {
            refuseNextPost = false;
            throw new Error("answer commit failed");
          }
          return { status: "delivered" };
        },
      },
    });
    const { host, port } = await server.start();
    stops.push(() => server.stop());
    return {
      addr: { baseUrl: `http://${host}:${port}`, token } as never,
      posted,
      lists: (...rows: ControlPendingInteraction[]) => {
        read = () => rows;
      },
      readFails: () => {
        read = () => {
          throw new Error("database is locked");
        };
      },
      refuseNextPost: () => {
        refuseNextPost = true;
      },
      detail: async () => {
        const response = await fetch(`http://${host}:${port}/v2/runs/run-http`, {
          headers: { authorization: `Bearer ${token}`, "X-Claudexor-Protocol-Major": "3" },
        });
        return {
          status: response.status,
          body: (await response.json()) as Record<string, unknown>,
        };
      },
    };
  }

  let clock = 0;
  async function tick(bridge: (info: { runId: string }) => Promise<void>) {
    clock = Math.max(clock, Date.now()) + 1_100;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(clock);
      await bridge({ runId: "run-http" });
    } finally {
      vi.useRealTimers();
    }
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("keeps an async prompt open through a failed read and posts its answer after the read heals", async () => {
    const run = await producer();
    const prompts: Array<{ signal: AbortSignal; answer: (value: unknown) => void }> = [];
    const bridge = makeInteractionBridge(
      run.addr,
      (ctx) =>
        new Promise((answer) => {
          prompts.push({ signal: ctx.signal, answer });
          ctx.signal.addEventListener("abort", () => answer(null), { once: true });
        }),
    );
    const pending = question("async-http", "async");
    run.lists(pending);
    await tick(bridge);
    expect(prompts).toHaveLength(1);

    run.readFails();
    const failed = await run.detail();
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(ControlProblem.safeParse(failed.body).success).toBe(true);
    expect(failed.body).not.toHaveProperty("pendingInteractions");
    await tick(bridge);
    await settle();
    expect(prompts[0]!.signal.aborted).toBe(false);

    run.lists(pending);
    await tick(bridge);
    await settle();
    // The same open prompt continues: it is neither closed nor asked twice.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.signal.aborted).toBe(false);
    prompts[0]!.answer(answerOf("Customers"));
    await vi.waitFor(() => expect(run.posted).toHaveLength(1));
    expect(run.posted[0]).toMatchObject({ interaction_id: "async-http" });
    bridge.close();
  });

  it.each(["blocking", "async"] as const)(
    "keeps a %s answer through a failed read and retries the same body after it heals",
    async (delivery) => {
      const run = await producer();
      run.refuseNextPost();
      let asks = 0;
      const bridge = makeInteractionBridge(run.addr, async () => {
        asks += 1;
        return answerOf(`answer-${asks}`);
      });
      const pending = question(`${delivery}-http`, delivery);
      run.lists(pending);
      await tick(bridge);
      await vi.waitFor(() => expect(run.posted).toHaveLength(1));
      await settle();

      run.readFails();
      await tick(bridge);
      await settle();

      run.lists(pending);
      await tick(bridge);
      await vi.waitFor(() => expect(run.posted).toHaveLength(2));
      await settle();
      expect(asks).toBe(1);
      expect(run.posted[1]).toEqual(run.posted[0]);
      bridge.close();
    },
  );

  it("still closes the prompt when the read succeeds with a genuinely empty list", async () => {
    const run = await producer();
    const signals: AbortSignal[] = [];
    const bridge = makeInteractionBridge(run.addr, (ctx) => {
      signals.push(ctx.signal);
      return new Promise((resolve) =>
        ctx.signal.addEventListener("abort", () => resolve(null), { once: true }),
      );
    });
    run.lists(question("async-gone", "async"));
    await tick(bridge);
    run.lists();
    const empty = await run.detail();
    expect(empty.status).toBe(200);
    expect(empty.body["pendingInteractions"]).toEqual([]);
    await tick(bridge);
    expect(signals[0]!.reason).toEqual({ kind: "interaction_resolved" });
    bridge.close();
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
        mcpSurfaceRunner({ requireExistingDaemon: true, delegationParentRunId: "parent-test" })({
          mode: "agent",
          prompt: "go",
        }),
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
        mcpSurfaceRunner({ requireExistingDaemon: true, delegationParentRunId: "parent-test" })({
          mode: "__status",
        }),
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
      const result = (await mcpSurfaceRunner({
        requireExistingDaemon: true,
        delegationParentRunId: "parent-test",
      })({
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

  it.each([
    [
      "names a Git result's typed refusal",
      {
        ok: false,
        code: 1,
        stderr: "2 Git object(s) of this result are missing; nothing was written",
        refusal: { code: "result_objects_missing", message: "m", paths: [], pathCount: 0 },
      },
      "apply check refused: result_objects_missing: 2 Git object(s) of this result are missing; nothing was written",
    ],
    [
      "counts a typed refusal's paths",
      {
        ok: false,
        code: 1,
        stderr: "both changed x",
        refusal: { code: "delivery_conflict", message: "m", paths: ["x"], pathCount: 3 },
      },
      "apply check refused: delivery_conflict (3 path(s)): both changed x",
    ],
    [
      "keeps an untyped failure a patch conflict",
      { ok: false, code: 1, stderr: "error: patch failed: x:1" },
      "apply check failed: the patch does NOT apply cleanly: error: patch failed: x:1",
    ],
  ])("__apply_check %s", async (_case, body, summary) => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const connectSpy = vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => body })) as never,
    );
    try {
      expect(await mcpSurfaceRunner()({ mode: "__apply_check", runId: "run-x" })).toMatchObject({
        summary,
        runId: "run-x",
        eligible: false,
        check: body,
      });
    } finally {
      connectSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

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
        mcpSurfaceRunner({ requireExistingDaemon: true, delegationParentRunId: "parent-test" })({
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

  it.each([undefined, "in_place", "isolated"] as const)(
    "creates a persistent thread and discloses workspace %s",
    async (workspace) => {
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
                    repoRoot: "/tmp/canonical-project",
                    workspaceMode: workspace ?? "in_place",
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
          ...(workspace ? { workspace } : {}),
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
              ...(workspace ? { workspace } : {}),
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
        expect(created).toMatchObject({
          threadId: "th-1",
          repoRoot: "/tmp/canonical-project",
          workspaceMode: workspace ?? "in_place",
        });
        expect(created.summary).toContain("/tmp/canonical-project");
        expect(created.summary).not.toContain("/tmp/project");
        expect(created.summary).toContain("No model was started.");
        if (workspace === "isolated") {
          expect(created.summary).toContain("isolated persistent worktree");
          expect(created.summary).toContain("first write turn");
          expect(created.summary).toContain("thread Apply");
          expect(created.summary).not.toContain("edit the project directory directly");
        } else {
          expect(created.summary).toContain("workspace: in_place");
          expect(created.summary).toContain("Write turns edit the project directory directly");
        }
        expect(turn).toMatchObject({ threadId: "th-1", turnId: "turn-1", runId: "run-1" });
      } finally {
        ensureSpy.mockRestore();
        vi.unstubAllGlobals();
      }
    },
  );

  it("reuses the caller's turn key after a lost response, and distinguishes a new turn", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const ensureSpy = vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    const seen: Array<{ key: string | null; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const key = new Headers(init?.headers).get("Idempotency-Key");
        const body = JSON.parse(String(init?.body));
        seen.push({ key, body });
        if (seen.length === 1) throw new Error("connection lost after daemon acceptance");
        if (seen.length === 3)
          return {
            ok: false,
            status: 409,
            json: async () => ({ code: "idempotency_conflict", error: "same key, different body" }),
          } as never;
        return {
          ok: true,
          status: 202,
          json: async () => ({ jobId: "j", turnId: "t", threadId: "th", state: "queued" }),
        } as never;
      }),
    );
    try {
      const runner = mcpSurfaceRunner();
      const first = {
        mode: "__thread_turn",
        threadId: "th",
        prompt: "first",
        idempotencyKey: "logical-paid-turn",
      };
      await expect(runner(first)).rejects.toThrow("connection lost");
      expect(await runner(first)).toMatchObject({ turnId: "t", threadId: "th" });
      await expect(runner({ ...first, prompt: "other" })).rejects.toMatchObject({
        code: "idempotency_conflict",
      });
      expect(
        await runner({ ...first, prompt: "next", idempotencyKey: "next-intentional-turn" }),
      ).toMatchObject({ turnId: "t" });
      expect(seen.map((v) => v.key)).toEqual([
        "logical-paid-turn",
        "logical-paid-turn",
        "logical-paid-turn",
        "next-intentional-turn",
      ]);
      expect(seen[0]?.body).toEqual(seen[1]?.body);
      expect(seen[2]?.body).not.toEqual(seen[0]?.body);
    } finally {
      ensureSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("forwards a turn's own auxiliary writable roots and nothing when omitted", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const ensureSpy = vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return {
          ok: true,
          status: 202,
          json: async () => ({ jobId: "j", turnId: "t", threadId: "th", state: "queued" }),
        } as never;
      }),
    );
    try {
      const runner = mcpSurfaceRunner();
      const execution = { auxiliaryWritableRoots: ["/srv/cache"] };
      await runner({ mode: "__thread_turn", threadId: "th", prompt: "grant", execution });
      await runner({ mode: "__thread_turn", threadId: "th", prompt: "omit" });
      expect(bodies[0]).toMatchObject({ prompt: "grant", execution });
      expect(bodies[1]).not.toHaveProperty("execution");
    } finally {
      ensureSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("reads the daemon thread detail without creating a run or starting an absent daemon", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const daemonRun = await import("./daemon-run.js");
    const ensureSpy = vi.spyOn(daemonRun, "ensureDaemon");
    const connectSpy = vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://x", token: "t" } as never,
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        paths.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            thread: {
              id: "th-1",
              title: "Audit",
              repoRoot: "/tmp/project",
              createdAt: "2026-09-24T00:00:00Z",
              updatedAt: "2026-09-24T00:00:00Z",
            },
            sessions: [],
            turns: [],
          }),
        } as never;
      }),
    );
    try {
      const runner = mcpSurfaceRunner();
      const detail = await runner({ mode: "__thread_read", threadId: "th-1" });
      expect(detail).toMatchObject({
        summary: "thread th-1: 0 turn(s)",
        thread: { id: "th-1" },
        turns: [],
      });
      expect(paths).toEqual(["http://x/v2/threads/th-1"]);
      expect(ensureSpy).not.toHaveBeenCalled();
      connectSpy.mockResolvedValueOnce(null);
      const absent = runner({ mode: "__thread_read", threadId: "th-1" });
      await expect(absent).rejects.toMatchObject({ code: "daemon_unavailable", retryable: true });
      await expect(absent).rejects.toThrow(/daemon is not running; thread read does not start/);
      expect(ensureSpy).not.toHaveBeenCalled();
      connectSpy.mockResolvedValueOnce(null);
      await expect(
        mcpSurfaceRunner({ requireExistingDaemon: true, delegationParentRunId: "parent-test" })({
          mode: "__thread_read",
          threadId: "th-1",
        }),
      ).rejects.toThrow(/delegation belt/);
    } finally {
      ensureSpy.mockRestore();
      connectSpy.mockRestore();
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
        secretLike: null,
        objectResult: null,
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
        expect(result["failure"]).toEqual({ ...failure, poolAttempts: [] });
      }
    } finally {
      connectSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
