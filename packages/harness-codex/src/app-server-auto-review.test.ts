import { describe, expect, it } from "vitest";
import {
  HarnessRunSpec,
  type InteractionAnswerSet,
  type InteractionRequest,
} from "@claudexor/schema";
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

function setup(access = "workspace_write", channel = true) {
  const asks: InteractionRequest[] = [];
  let answer!: (value: InteractionAnswerSet | null) => void;
  let signal: AbortSignal | undefined;
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
    turnId: () => "turn",
    live: () => true,
  });
  return {
    review,
    asks,
    signal: () => signal,
    answer: (labels: string[], freeText: string | null = null) =>
      answer({
        interaction_id: asks[0]!.interaction_id,
        answers: [{ question_id: "approval", selected_labels: labels, free_text: freeText }],
      }),
  };
}

describe("native automatic review handback", () => {
  it("waits for terminal context and explicit exact-action authorization", async () => {
    const t = setup();
    t.review.observe(denial());
    expect(t.asks).toHaveLength(0);
    const events = t.review.interactions("turn", "The task still needs node --test.");
    expect(events).toHaveLength(1);
    expect(t.asks[0]!.questions[0]!.question).toContain("The task still needs node --test.");
    expect(t.asks[0]!.questions[0]!.question).toContain("node --test");
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
