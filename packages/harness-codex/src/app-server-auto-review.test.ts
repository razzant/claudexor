import { describe, expect, it } from "vitest";
import {
  HarnessRunSpec,
  type InteractionAnswerSet,
  type InteractionRequest,
} from "@claudexor/schema";
import { stableStringify } from "@claudexor/util";
import { CodexAutoReview } from "./app-server-auto-review.js";

const denial = (overrides: Record<string, unknown> = {}) => ({
  method: "item/autoApprovalReview/completed",
  params: {
    threadId: "root",
    turnId: "turn",
    reviewId: "review",
    targetItemId: "item",
    startedAtMs: 100,
    completedAtMs: 200,
    decisionSource: "agent",
    action: { type: "command", source: "unifiedExec", command: "node --test", cwd: process.cwd() },
    review: { status: "denied", rationale: "Requires explicit authorization" },
    ...overrides,
  },
});

const mcpAction = {
  type: "mcpToolCall",
  server: "wiki",
  toolName: "read",
  connectorId: null,
  connectorName: null,
  toolTitle: null,
};

const mcpCall = (method: string, id: string, args: unknown, turnId = "turn") => ({
  method,
  params: {
    threadId: "root",
    turnId,
    item: { id, type: "mcpToolCall", server: "wiki", tool: "read", arguments: args },
  },
});

function setup(access = "workspace_write", channel = true) {
  const asks: InteractionRequest[] = [];
  let answer!: (value: InteractionAnswerSet | null) => void;
  let signal: AbortSignal | undefined;
  let turn = "turn";
  const spec = HarnessRunSpec.parse({
    session_id: "test",
    intent: "implement",
    prompt: "work",
    cwd: process.cwd(),
    access,
  });
  if (channel)
    spec.extra["interactionChannel"] = {
      request(request: InteractionRequest, abort: AbortSignal) {
        asks.push(request);
        signal = abort;
        return new Promise<InteractionAnswerSet | null>((resolve) => {
          answer = resolve;
        });
      },
    };
  const review = new CodexAutoReview({
    spec,
    threadId: () => "root",
    turnId: () => turn,
    live: () => true,
  });
  return {
    review,
    asks,
    signal: () => signal,
    /** The root's next active turn (a goal continuation or an authorized retry). */
    turn: (id: string) => {
      turn = id;
    },
    answer: (labels: string[], freeText: string | null = null) =>
      answer({
        interaction_id: asks.at(-1)!.interaction_id,
        answers: [{ question_id: "approval", selected_labels: labels, free_text: freeText }],
      }),
  };
}

describe("native automatic review handback", () => {
  it("keeps accepting new MCP calls after the recent-item cache fills", () => {
    const t = setup();
    for (let id = 0; id < 300; id++)
      t.review.observe({
        method: "item/started",
        params: {
          threadId: "root",
          turnId: "turn",
          item: {
            id: String(id),
            type: "mcpToolCall",
            server: "wiki",
            tool: "read",
            arguments: { id },
          },
        },
      });
    t.review.observe(
      denial({
        targetItemId: "299",
        action: {
          type: "mcpToolCall",
          server: "wiki",
          toolName: "read",
          connectorId: null,
          connectorName: null,
          toolTitle: null,
        },
      }),
    );
    expect(t.review.interactions("turn", "Blocked")[0]?.type).toBe("interaction_requested");
    expect(t.asks[0]!.questions[0]!.question).toContain('"id": 299');
  });

  it("preserves a denial's correlated call while later MCP calls evict recent items", () => {
    const t = setup();
    t.review.observe({
      method: "item/started",
      params: {
        threadId: "root",
        turnId: "turn",
        item: {
          id: "item",
          type: "mcpToolCall",
          server: "wiki",
          tool: "read",
          arguments: { slug: "support" },
        },
      },
    });
    t.review.observe(
      denial({
        action: {
          type: "mcpToolCall",
          server: "wiki",
          toolName: "read",
          connectorId: null,
          connectorName: null,
          toolTitle: null,
        },
      }),
    );
    for (let id = 0; id < 300; id++)
      t.review.observe({
        method: "item/started",
        params: {
          threadId: "root",
          turnId: "turn",
          item: {
            id: String(id),
            type: "mcpToolCall",
            server: "wiki",
            tool: "read",
            arguments: { id },
          },
        },
      });
    expect(t.review.interactions("turn", "Blocked")[0]?.type).toBe("interaction_requested");
    expect(t.asks[0]!.questions[0]!.question).toContain('"slug": "support"');
  });

  it("invalidates a duplicate reviewed item even after recent-item eviction", () => {
    const t = setup();
    const item = (args: object) => ({
      method: "item/started",
      params: {
        threadId: "root",
        turnId: "turn",
        item: { id: "item", type: "mcpToolCall", server: "wiki", tool: "read", arguments: args },
      },
    });
    t.review.observe(item({ slug: "first" }));
    t.review.observe(
      denial({
        action: {
          type: "mcpToolCall",
          server: "wiki",
          toolName: "read",
          connectorId: null,
          connectorName: null,
          toolTitle: null,
        },
      }),
    );
    for (let id = 0; id < 300; id++)
      t.review.observe({
        method: "item/started",
        params: {
          threadId: "root",
          turnId: "turn",
          item: {
            id: String(id),
            type: "mcpToolCall",
            server: "wiki",
            tool: "read",
            arguments: { id },
          },
        },
      });
    t.review.observe(item({ slug: "second" }));
    expect(t.review.interactions("turn", "Blocked")[0]?.payload).toMatchObject({
      code: "codex_auto_review_not_offered",
    });
    expect(t.asks).toEqual([]);
  });

  it("does not accept a reused evicted item ID before its first review", () => {
    const t = setup();
    const item = (id: string, args: object) => ({
      method: "item/started",
      params: {
        threadId: "root",
        turnId: "turn",
        item: { id, type: "mcpToolCall", server: "wiki", tool: "read", arguments: args },
      },
    });
    t.review.observe(item("item", { slug: "first" }));
    for (let id = 0; id < 300; id++) t.review.observe(item(String(id), { id }));
    t.review.observe(item("item", { slug: "second" }));
    t.review.observe(
      denial({
        action: {
          type: "mcpToolCall",
          server: "wiki",
          toolName: "read",
          connectorId: null,
          connectorName: null,
          toolTitle: null,
        },
      }),
    );
    expect(t.review.interactions("turn", "Blocked")[0]?.payload).toMatchObject({
      code: "codex_auto_review_not_offered",
    });
    expect(t.asks).toEqual([]);
  });

  it.each(["invalid", [], {}, { connectorId: "other" }])(
    "refuses invalid or mismatched connector context %j",
    (appContext) => {
      const t = setup();
      t.review.observe({
        method: "item/started",
        params: {
          threadId: "root",
          turnId: "turn",
          item: {
            id: "item",
            type: "mcpToolCall",
            server: "wiki",
            tool: "read",
            arguments: { slug: "support" },
            appContext,
          },
        },
      });
      t.review.observe(
        denial({
          action: {
            type: "mcpToolCall",
            server: "wiki",
            toolName: "read",
            connectorId: null,
            connectorName: null,
            toolTitle: null,
          },
        }),
      );
      expect(t.review.interactions("turn", "Blocked")[0]?.payload).toMatchObject({
        code: "codex_auto_review_not_offered",
      });
      expect(t.asks).toEqual([]);
    },
  );
  it("offers a clearly contextual retry for a matching denied MCP tool call", async () => {
    const t = setup();
    t.review.observe({
      method: "item/started",
      params: {
        threadId: "root",
        turnId: "turn",
        item: {
          id: "item",
          type: "mcpToolCall",
          server: "wiki",
          tool: "read",
          arguments: { slug: "support" },
        },
      },
    });
    t.review.observe(
      denial({
        action: {
          type: "mcpToolCall",
          server: "wiki",
          toolName: "read",
          connectorId: null,
          connectorName: null,
          toolTitle: null,
        },
      }),
    );
    expect(t.review.interactions("turn", "The lookup was refused.")).toHaveLength(1);
    const { question, options } = t.asks[0]!.questions[0]!;
    expect(question).toContain('"slug": "support"');
    expect(question).toMatch(/not.*bound.*arguments/i);
    // Codex records a contextual thread note, not a one-call permission.
    expect(question).toContain("not bound to these arguments or limited to one call");
    expect(question).toMatch(/contextual note in this thread/);
    expect(question).toMatch(/one more model turn/);
    expect(question).toMatch(/later native reviews in this thread may consider the note/);
    expect(options.map((option) => option.label)).toEqual(["Authorize one retry", "Decline"]);
    expect(options[0]!.description).toMatch(/not bound to these arguments or to one call/);
    const pending = t.review.takeRetries();
    t.answer(["Authorize one retry"]);
    expect(await pending).toMatchObject([
      { action: { type: "mcp_tool_call", server: "wiki", tool_name: "read" } },
    ]);
  });

  it("does not repeatedly authorize the same denied MCP tool", async () => {
    const t = setup();
    const action = {
      type: "mcpToolCall",
      server: "wiki",
      toolName: "read",
      connectorId: null,
      connectorName: null,
      toolTitle: null,
    };
    t.review.observe({
      method: "item/started",
      params: {
        threadId: "root",
        turnId: "turn",
        item: {
          id: "item",
          type: "mcpToolCall",
          server: "wiki",
          tool: "read",
          arguments: { slug: "support" },
        },
      },
    });
    t.review.observe(denial({ action }));
    t.review.interactions("turn", "Blocked");
    const result = t.review.takeRetries();
    t.answer(["Authorize one retry"]);
    await result;
    t.review.observe(denial({ action, reviewId: "retry-denied" }));
    expect(t.review.interactions("turn", "Still blocked")[0]?.payload).toMatchObject({
      code: "codex_auto_review_not_offered",
    });
    expect(t.asks).toHaveLength(1);
  });

  it("after an authorized MCP retry, re-offers only other arguments, never the same call under a new ID", async () => {
    const t = setup();
    t.review.observe(mcpCall("item/started", "first", { slug: "a", rev: 1 }));
    t.review.observe(denial({ targetItemId: "first", action: mcpAction }));
    t.review.interactions("turn", "Blocked");
    const authorized = t.review.takeRetries();
    t.answer(["Authorize one retry"]);
    expect(await authorized).toHaveLength(1);
    // The retry turn: the same call (new item ID, reordered keys) and another call are denied.
    t.turn("retry");
    t.review.observe(mcpCall("item/started", "same", { rev: 1, slug: "a" }, "retry"));
    t.review.observe(
      denial({ turnId: "retry", reviewId: "same", targetItemId: "same", action: mcpAction }),
    );
    t.review.observe(mcpCall("item/started", "other", { slug: "b", rev: 1 }, "retry"));
    t.review.observe(
      denial({ turnId: "retry", reviewId: "other", targetItemId: "other", action: mcpAction }),
    );
    expect(t.review.interactions("retry", "Still blocked")).toEqual([
      expect.objectContaining({
        text: expect.stringMatching(/already authorized retry again/),
        payload: { code: "codex_auto_review_not_offered", review_id: "same" },
      }),
      expect.objectContaining({ type: "interaction_requested" }),
    ]);
    expect(t.asks).toHaveLength(2);
    expect(t.asks[1]!.questions[0]!.question).toContain('"slug": "b"');
    const second = t.review.takeRetries();
    t.answer(["Authorize one retry"]);
    expect(await second).toMatchObject([{ id: "other", turn_id: "retry" }]);
  });

  it("compares authorized MCP arguments exactly: nested key order is ignored, arrays, nulls and own __proto__ keys are not", async () => {
    const t = setup();
    // Native frames are JSON.parse output, where "__proto__" is an ordinary own key.
    const authorized =
      '{"data":[1,null],"meta":{"__proto__":{"slug":"a","rev":[2,{"y":1,"x":0}]}}}';
    t.review.observe(mcpCall("item/started", "first", JSON.parse(authorized)));
    t.review.observe(denial({ targetItemId: "first", action: mcpAction }));
    t.review.interactions("turn", "Blocked");
    const answered = t.review.takeRetries();
    t.answer(["Authorize one retry"]);
    expect(await answered).toHaveLength(1);
    const retried = {
      same: '{"meta":{"__proto__":{"rev":[2,{"x":0,"y":1}],"slug":"a"}},"data":[1,null]}',
      arrayOrder: '{"data":[null,1],"meta":{"__proto__":{"slug":"a","rev":[2,{"y":1,"x":0}]}}}',
      nestedArray: '{"data":[[1],null],"meta":{"__proto__":{"slug":"a","rev":[2,{"y":1,"x":0}]}}}',
      nullValue: '{"data":[1,{}],"meta":{"__proto__":{"slug":"a","rev":[2,{"y":1,"x":0}]}}}',
      protoValue: '{"data":[1,null],"meta":{"__proto__":{"slug":"b","rev":[2,{"y":1,"x":0}]}}}',
      protoAbsent: '{"data":[1,null],"meta":{}}',
    };
    // Negative control: the shared stable hash drops own __proto__ keys (its
    // stored digests depend on that), so it would refuse these two as repeats.
    for (const key of ["protoValue", "protoAbsent"] as const)
      expect(stableStringify(JSON.parse(retried[key]))).toBe(
        stableStringify(JSON.parse(authorized)),
      );
    t.turn("retry");
    for (const [id, args] of Object.entries(retried)) {
      t.review.observe(mcpCall("item/started", id, JSON.parse(args), "retry"));
      t.review.observe(
        denial({ turnId: "retry", reviewId: id, targetItemId: id, action: mcpAction }),
      );
    }
    expect(t.review.interactions("retry", "Still blocked")).toEqual([
      expect.objectContaining({
        text: expect.stringMatching(/already authorized retry again/),
        payload: { code: "codex_auto_review_not_offered", review_id: "same" },
      }),
      ...Array.from({ length: 5 }, () =>
        expect.objectContaining({ type: "interaction_requested" }),
      ),
    ]);
    expect(t.asks).toHaveLength(6);
    expect(t.asks[4]!.questions[0]!.question).toContain('"slug": "b"');
  });

  it("correlates a new turn's MCP denial after earlier completed turns started over 4,096 calls", () => {
    const t = setup();
    for (const turn of ["t0", "t1", "t2"]) {
      t.turn(turn);
      for (let id = 0; id < 1_400; id++) {
        t.review.observe(mcpCall("item/started", String(id), { id }, turn));
        t.review.observe(mcpCall("item/completed", String(id), { id }, turn));
      }
    }
    t.turn("t3");
    t.review.observe(mcpCall("item/started", "call", { slug: "support" }, "t3"));
    t.review.observe(denial({ turnId: "t3", targetItemId: "call", action: mcpAction }));
    expect(t.review.interactions("t3", "Blocked")).toEqual([
      expect.objectContaining({ type: "interaction_requested" }),
    ]);
    expect(t.asks[0]!.questions[0]!.question).toContain('"slug": "support"');
  });

  it("correlates a late review in its own turn, keeps it across the next turn, and never matches an earlier turn's call", () => {
    const t = setup();
    t.review.observe(mcpCall("item/started", "call", { slug: "support" }));
    t.review.observe(mcpCall("item/completed", "call", { slug: "support" }));
    t.review.observe(denial({ targetItemId: "call", action: mcpAction }));
    t.turn("next");
    t.review.observe(mcpCall("item/started", "fresh", { slug: "other" }, "next"));
    t.review.observe(
      denial({ turnId: "next", reviewId: "stale", targetItemId: "call", action: mcpAction }),
    );
    expect(t.review.interactions("next", "Blocked")).toEqual([
      expect.objectContaining({ type: "interaction_requested" }),
      expect.objectContaining({
        text: expect.stringMatching(/lacks an exact, complete call correlation/),
        payload: { code: "codex_auto_review_not_offered", review_id: "stale" },
      }),
    ]);
    expect(t.asks[0]!.questions[0]!.question).toContain('"slug": "support"');
  });

  it("names the retained per-turn bound when it leaves a denied MCP call uncorrelated", () => {
    const t = setup();
    for (let id = 0; id < 4_096; id++)
      t.review.observe(mcpCall("item/started", String(id), { id }));
    t.review.observe(mcpCall("item/started", "unrecorded", { slug: "support" }));
    t.review.observe(denial({ targetItemId: "unrecorded", action: mcpAction }));
    t.review.observe(denial({ reviewId: "evicted", targetItemId: "0", action: mcpAction }));
    const bound = expect.stringMatching(/beyond its turn's retained call evidence/);
    expect(t.review.interactions("turn", "Blocked")).toEqual([
      expect.objectContaining({
        text: bound,
        payload: { code: "codex_auto_review_not_offered", review_id: "review" },
      }),
      expect.objectContaining({
        text: bound,
        payload: { code: "codex_auto_review_not_offered", review_id: "evicted" },
      }),
    ]);
    expect(t.asks).toEqual([]);
  });

  it.each([
    { targetItemId: null },
    { targetItemId: "other" },
    {
      action: {
        type: "mcpToolCall",
        server: "wiki",
        toolName: "write",
        connectorId: null,
        connectorName: null,
        toolTitle: null,
      },
    },
    // Same tool name on another server: only the server comparison refuses it.
    { action: { ...mcpAction, server: "other" } },
  ])("does not offer an MCP retry without an exact item correlation: %j", async (overrides) => {
    const t = setup();
    t.review.observe({
      method: "item/started",
      params: {
        threadId: "root",
        turnId: "turn",
        item: {
          id: "item",
          type: "mcpToolCall",
          server: "wiki",
          tool: "read",
          arguments: { slug: "support" },
        },
      },
    });
    t.review.observe(
      denial({
        action: {
          type: "mcpToolCall",
          server: "wiki",
          toolName: "read",
          connectorId: null,
          connectorName: null,
          toolTitle: null,
        },
        ...overrides,
      }),
    );
    expect(t.review.interactions("turn", "Blocked")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ code: "codex_auto_review_not_offered" }),
      }),
    ]);
    expect(t.asks).toEqual([]);
  });

  it.each(["foreign-thread", "foreign-turn", "duplicate", "oversized"])(
    "refuses untrustworthy MCP call evidence: %s",
    (kind) => {
      const t = setup();
      const frame = {
        method: "item/started",
        params: {
          threadId: kind === "foreign-thread" ? "other" : "root",
          turnId: kind === "foreign-turn" ? "other" : "turn",
          item: {
            id: "item",
            type: "mcpToolCall",
            server: "wiki",
            tool: "read",
            arguments: { slug: kind === "oversized" ? "x".repeat(33_000) : "support" },
          },
        },
      };
      t.review.observe(frame);
      if (kind === "duplicate") t.review.observe(frame);
      t.review.observe(
        denial({
          action: {
            type: "mcpToolCall",
            server: "wiki",
            toolName: "read",
            connectorId: null,
            connectorName: null,
            toolTitle: null,
          },
        }),
      );
      expect(t.review.interactions("turn", "Blocked")).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ code: "codex_auto_review_not_offered" }),
        }),
      ]);
      expect(t.asks).toEqual([]);
    },
  );
  it("waits for terminal context and explicit exact-action authorization", async () => {
    const t = setup();
    t.review.observe(denial());
    expect(t.asks).toHaveLength(0);
    const events = t.review.interactions("turn", "The task still needs node --test.");
    expect(events).toHaveLength(1);
    expect(t.asks[0]!.questions[0]!.question).toContain("The task still needs node --test.");
    expect(t.asks[0]!.questions[0]!.question).toContain("node --test");
    expect(t.asks[0]!.questions[0]!.question).not.toMatch(/contextual note/);
    const result = t.review.takeRetries();
    t.answer(["Authorize one retry"]);
    expect(await result).toEqual([
      {
        id: "review",
        turn_id: "turn",
        target_item_id: "item",
        started_at_ms: 100,
        completed_at_ms: 200,
        status: "denied",
        rationale: "Requires explicit authorization",
        decision_source: "agent",
        action: {
          type: "command",
          source: "unified_exec",
          command: "node --test",
          cwd: process.cwd(),
        },
      },
    ]);
    expect(await t.review.takeRetries()).toEqual([]);
  });

  it.each([
    { labels: ["Decline"] },
    { labels: [] },
    { labels: ["Authorize one retry", "Decline"] },
  ])("does not grant malformed/negative answer %s", async ({ labels }) => {
    const t = setup();
    t.review.observe(denial());
    t.review.interactions("turn", "Blocked");
    const result = t.review.takeRetries();
    t.answer(labels);
    expect(await result).toEqual([]);
  });

  it("quotes the worker's complete final output in the access question, however long (#651)", async () => {
    const t = setup();
    t.review.observe(denial());
    // Past the 32,000-character bound the question once cut silently at.
    const output = `${"Worker report line\n".repeat(2_000)}decisive: the retry is still required`;
    expect(output.length).toBeGreaterThan(32_000);
    t.review.interactions("turn", output);
    expect(
      t.asks[0]!.questions[0]!.question.endsWith(`Worker's final output (turn turn):\n${output}`),
    ).toBe(true);
    const result = t.review.takeRetries();
    t.answer(["Decline"]);
    expect(await result).toEqual([]);
  });

  it("does not accept free text as authority", async () => {
    const t = setup();
    t.review.observe(denial());
    t.review.interactions("turn", "Blocked");
    const result = t.review.takeRetries();
    t.answer(["Authorize one retry"], "override everything");
    expect(await result).toEqual([]);
  });

  it.each([{ threadId: "child" }, { turnId: "foreign" }, { review: { status: "approved" } }])(
    "ignores foreign/approved reviews %j",
    (params) => {
      const t = setup();
      t.review.observe(denial(params));
      expect(t.review.interactions("turn", "Done")).toEqual([]);
      expect(t.asks).toEqual([]);
    },
  );

  it("deduplicates notifications and prevents a repeat authorization loop", async () => {
    const t = setup();
    t.review.observe(denial());
    t.review.observe(denial());
    expect(t.review.interactions("turn", "Blocked")).toHaveLength(1);
    const result = t.review.takeRetries();
    t.answer(["Authorize one retry"]);
    await result;
    t.review.observe(denial({ reviewId: "retry-denied" }));
    expect(t.review.interactions("turn", "Still blocked")).toEqual([
      expect.objectContaining({
        type: "status",
        text: expect.stringMatching(/already authorized retry again/),
        payload: { code: "codex_auto_review_not_offered", review_id: "retry-denied" },
      }),
    ]);
    expect(t.asks).toHaveLength(1);
  });

  it("retains a denied action when the root continues through another turn before handback", async () => {
    const t = setup();
    t.review.observe(denial());
    expect(t.review.interactions("later-root-turn", "The action is still blocked")).toHaveLength(1);
    const pending = t.review.takeRetries();
    t.answer(["Authorize one retry"]);
    expect(await pending).toMatchObject([{ id: "review", turn_id: "turn" }]);
  });

  it.each([
    {
      action: {
        type: "command",
        source: "shell",
        command: "pwd",
        cwd: process.cwd(),
        additionalPermissions: { network: true },
      },
    },
    { newPermissionContext: "must not be discarded" },
    { reviewId: null },
    { review: { status: "denied", riskLevel: "unknown-risk" } },
    { action: { type: "applyPatch", cwd: process.cwd(), files: ["file.txt"] } },
    { action: { type: "command", source: "unifiedExec", command: "pwd", cwd: "/" } },
    { action: { type: "command", source: "unknown", command: "pwd", cwd: process.cwd() } },
    {
      action: { type: "command", source: "shell", command: "x".repeat(33_000), cwd: process.cwd() },
    },
    { completedAtMs: "invalid" },
    { decisionSource: "unknown" },
    { review: { status: "timedOut" } },
    { review: { status: "aborted" } },
  ])("keeps the native denial without offering an incomplete action %j", async (params) => {
    const t = setup();
    t.review.observe(denial(params));
    const events = t.review.interactions("turn", "Blocked");
    expect(events).toEqual([
      expect.objectContaining({
        type: "status",
        payload: expect.objectContaining({ code: "codex_auto_review_not_offered" }),
      }),
    ]);
    expect(t.asks).toEqual([]);
    expect(await t.review.takeRetries()).toEqual([]);
  });

  it("offers a credential-named command in the workspace like any other (INV-146)", async () => {
    const t = setup();
    t.review.observe(
      denial({
        action: { type: "command", source: "unifiedExec", command: "cat .env", cwd: process.cwd() },
      }),
    );
    expect(t.review.interactions("turn", "Blocked")).toHaveLength(1);
    expect(t.asks[0]!.questions[0]!.question).toContain("cat .env");
  });

  it.each(["readonly", "full", "inherit_native"])(
    "does not enable automatic-review escalation under %s",
    async (access) => {
      const t = setup(access);
      t.review.observe(denial());
      expect(t.review.interactions("turn", "Blocked")).toEqual([
        expect.objectContaining({
          payload: { code: "codex_auto_review_not_offered", review_id: "review" },
        }),
      ]);
      expect(t.asks).toEqual([]);
      expect(await t.review.takeRetries()).toEqual([]);
    },
  );

  it("discloses a missing controller channel instead of auto-authorizing", async () => {
    const t = setup("workspace_write", false);
    t.review.observe(denial());
    expect(t.review.interactions("turn", "Blocked")).toEqual([
      expect.objectContaining({ text: expect.stringMatching(/controller interaction/) }),
    ]);
    expect(await t.review.takeRetries()).toEqual([]);
  });

  it("preserves complete execve actions and review context without accepting answer-supplied actions", async () => {
    const t = setup();
    t.review.observe(
      denial({
        action: {
          type: "execve",
          source: "unifiedExec",
          program: "node",
          argv: ["node", "--test"],
          cwd: process.cwd(),
        },
        review: { status: "denied", riskLevel: "medium", userAuthorization: "low" },
      }),
    );
    t.review.interactions("turn", "Blocked");
    const pending = t.review.takeRetries();
    t.answer(["Authorize one retry"]);
    expect(await pending).toMatchObject([
      {
        risk_level: "medium",
        user_authorization: "low",
        action: {
          type: "execve",
          source: "unified_exec",
          program: "node",
          argv: ["node", "--test"],
        },
      },
    ]);
  });

  it("records partial authorization without starting a retry if a later native RPC fails", async () => {
    const sent: string[] = [];
    // The transport fixture represents an already-settled native root turn.
    const settled = new CodexAutoReview({
      spec: HarnessRunSpec.parse({
        session_id: "test",
        intent: "implement",
        prompt: "work",
        cwd: process.cwd(),
        access: "workspace_write",
      }),
      threadId: () => "root",
      turnId: () => null,
      live: () => true,
    });
    await expect(
      settled.retry(
        [
          { id: "one", action: {} },
          { id: "two", action: {} },
        ],
        async (method) => {
          sent.push(method);
          if (sent.length === 2) throw new Error("RPC failure");
          return {};
        },
        async () => ({
          threadStatus: "idle",
          threadSettled: true,
          goalActive: false,
          ownedBackground: [],
        }),
      ),
    ).rejects.toThrow("RPC failure");
    expect(sent).toEqual([
      "thread/approveGuardianDeniedAction",
      "thread/approveGuardianDeniedAction",
    ]);
    expect(settled.authorizationSubmissions).toEqual([
      { review_id: "one", state: "acknowledged" },
      { review_id: "two", state: "submitted" },
    ]);
  });

  it("reuses the exact sandbox policy on an authorized continuation", async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const settled = new CodexAutoReview({
      spec: HarnessRunSpec.parse({
        session_id: "test",
        intent: "implement",
        prompt: "work",
        cwd: process.cwd(),
        access: "workspace_write",
      }),
      threadId: () => "root",
      turnId: () => null,
      live: () => true,
    });
    const sandboxPolicy = {
      type: "workspaceWrite",
      writableRoots: ["/workspace/allowed"],
      networkAccess: false,
    };
    await settled.retry(
      [{ id: "review", action: { type: "mcp_tool_call", server: "wiki", tool_name: "read" } }],
      async (method, params) => {
        requests.push({ method, params });
        return {};
      },
      async () => ({
        threadStatus: "idle",
        threadSettled: true,
        goalActive: false,
        ownedBackground: [],
      }),
      sandboxPolicy,
    );
    expect(requests[1]).toMatchObject({
      method: "turn/start",
      params: { sandboxPolicy, approvalPolicy: "on-request", approvalsReviewer: "auto_review" },
    });
  });

  it("does not start a retry after cancellation even if an authorization RPC was acknowledged", async () => {
    const sent: string[] = [];
    const settled = new CodexAutoReview({
      spec: HarnessRunSpec.parse({
        session_id: "test",
        intent: "implement",
        prompt: "work",
        cwd: process.cwd(),
        access: "workspace_write",
      }),
      threadId: () => "root",
      turnId: () => null,
      live: () => true,
    });
    const retried = await settled.retry(
      [{ id: "one", action: {} }],
      async (method) => {
        sent.push(method);
        settled.close();
        return {};
      },
      async () => ({
        threadStatus: "idle",
        threadSettled: true,
        goalActive: false,
        ownedBackground: [],
      }),
    );
    expect(retried).toBe(false);
    expect(sent).toEqual(["thread/approveGuardianDeniedAction"]);
    expect(settled.authorizationSubmissions).toEqual([{ review_id: "one", state: "acknowledged" }]);
  });

  it("revokes outstanding authority on cancellation even if the channel ignores abort", async () => {
    const t = setup();
    t.review.observe(denial());
    t.review.interactions("turn", "Blocked");
    const result = t.review.takeRetries();
    t.review.close();
    expect(t.signal()?.aborted).toBe(true);
    expect(await result).toEqual([]);
    t.answer(["Authorize one retry"]);
    expect(await t.review.takeRetries()).toEqual([]);
  });
});
