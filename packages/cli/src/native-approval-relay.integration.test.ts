import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { InteractionChannel, spawnProcess } from "@claudexor/core";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { runCodexAppServer } from "../../harness-codex/src/app-server-run.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";
import { mcpWire, startInteractionDaemon } from "./test-support/interaction-daemon.js";

type Frame = Record<string, unknown>;

const cleanups: Array<() => void | Promise<void>> = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0).reverse();
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});

/** A Codex app-server root thread whose turns the test scripts frame by frame. */
function codexPeer(cwd: string) {
  const writes: Frame[] = [];
  const frames: string[] = [];
  const turnStarts: Array<(id: string) => void> = [];
  let turns = 0;
  let wake: (() => void) | undefined;
  let stopped = false;
  let close!: () => void;
  const closed = new Promise<void>((done) => (close = done));
  const push = (frame: Frame) => {
    frames.push(JSON.stringify(frame));
    wake?.();
    wake = undefined;
  };
  const written = (match: (frame: Frame) => boolean) =>
    vi.waitFor(
      () => {
        const frame = writes.find(match);
        expect(frame).toBeDefined();
        return frame!;
      },
      { timeout: 5_000, interval: 10 },
    );
  const finishTurn = (turnId: string, text: string) => {
    push({
      method: "item/completed",
      params: {
        threadId: "root",
        turnId,
        item: { id: `msg-${turnId}`, type: "agentMessage", text },
      },
    });
    push({
      method: "turn/completed",
      params: { threadId: "root", turn: { id: turnId, status: "completed", items: [] } },
    });
  };
  const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
    options.onSpawn?.({
      write(line) {
        const frame = JSON.parse(line) as Frame;
        writes.push(frame);
        const method = frame["method"];
        if (method === "initialize") push({ id: frame["id"], result: {} });
        if (method === "thread/start")
          push({ id: frame["id"], result: { thread: { id: "root" } } });
        if (method === "turn/start") {
          turns += 1;
          const turnId = `turn-${turns}`;
          push({ method: "turn/started", params: { threadId: "root", turn: { id: turnId } } });
          push({ id: frame["id"], result: { turn: { id: turnId } } });
          turnStarts.shift()?.(turnId);
        }
        if (method === "thread/approveGuardianDeniedAction") push({ id: frame["id"], result: {} });
        if (method === "turn/steer")
          push({
            id: frame["id"],
            result: { turnId: (frame["params"] as Frame)["expectedTurnId"] },
          });
        if (method === "thread/read")
          push({ id: frame["id"], result: { thread: { status: { type: "idle" } } } });
        if (method === "thread/goal/get")
          push({ id: frame["id"], result: { goal: { status: "complete" } } });
        if (method === "thread/backgroundTerminals/list")
          push({ id: frame["id"], result: { data: [] } });
        if (method === "turn/interrupt") push({ id: frame["id"], result: {} });
      },
      end() {
        stopped = true;
        close();
        wake?.();
      },
      closed,
    });
    while (!stopped || frames.length) {
      if (frames.length) yield { type: "stdout", line: frames.shift()! };
      else await new Promise<void>((done) => (wake = done));
    }
    yield { type: "exit", code: 0, signal: null, durationMs: 0 };
  };
  return {
    cwd,
    spawn,
    writes,
    push,
    written,
    finishTurn,
    /** Resolves with the id of the next root turn the adapter starts. */
    nextTurn: () => new Promise<string>((done) => turnStarts.push(done)),
    /** The item rust-v0.162.1 `request_user_input_async` emits (id = call_id). */
    asyncQuestion(turnId: string, itemId: string, questions: Array<Record<string, unknown>>) {
      const text = questions
        .map((q) =>
          [q["title"], ...((q["options"] as string[] | undefined) ?? []).map((o) => `- ${o}`)].join(
            "\n",
          ),
        )
        .join("\n\n");
      const params = {
        threadId: "root",
        turnId,
        item: {
          id: itemId,
          type: "agentMessage",
          text,
          phase: "final_answer",
          delivery: "async",
          questions,
        },
      };
      push({ method: "item/started", params });
      push({ method: "item/completed", params });
    },
    say(turnId: string, id: string, text: string) {
      push({
        method: "item/completed",
        params: { threadId: "root", turnId, item: { id, type: "agentMessage", text } },
      });
    },
    fileApproval(turnId: string, requestId: string) {
      push({
        method: "item/started",
        params: {
          threadId: "root",
          turnId,
          item: {
            id: `item-${requestId}`,
            type: "fileChange",
            changes: [{ path: "smoke.txt", kind: { type: "add" }, diff: "+exact bytes\n" }],
          },
        },
      });
      push({
        id: requestId,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "root",
          turnId,
          itemId: `item-${requestId}`,
          reason: "write outside the base sandbox",
        },
      });
    },
    autoReviewDenial(turnId: string, reviewId: string) {
      push({
        method: "item/autoApprovalReview/completed",
        params: {
          threadId: "root",
          turnId,
          reviewId,
          targetItemId: "item-command",
          action: { type: "command", source: "shell", command: "node --test", cwd },
          review: { status: "denied", rationale: "Needs explicit authorization" },
          startedAtMs: 100,
          completedAtMs: 200,
          decisionSource: "agent",
        },
      });
    },
  };
}

async function fixture() {
  let peer!: ReturnType<typeof codexPeer>;
  const harnessEvents: HarnessEvent[] = [];
  const channels: InteractionChannel[] = [];
  const daemon = await startInteractionDaemon({
    cleanups,
    removals,
    harnessId: "codex",
    prompt: "native relay fixture",
    execute: async ({ runId, signal, channel }, workspace) => {
      const spec = HarnessRunSpec.parse({
        session_id: runId,
        intent: "implement",
        prompt: "Make the change and verify it",
        cwd: workspace,
        access: "workspace_write",
      });
      spec.extra["interactionChannel"] = channel;
      spec.extra["abortSignal"] = signal;
      channels.push(channel);
      for await (const event of runCodexAppServer({
        bin: "codex",
        args: [],
        spec,
        env: {},
        spawn: peer.spawn,
        pollIntervalMs: 5,
      }))
        harnessEvents.push(event);
      return harnessEvents;
    },
  });
  peer = codexPeer(daemon.workspace);
  return { ...daemon, peer, harnessEvents, channels };
}

const answerBody = (questionId: string, label: string) => ({
  answers: [{ questionId, selectedLabels: [label] }],
});

const decisionsFor = (writes: Frame[], requestId: string) =>
  writes.filter((frame) => frame["id"] === requestId && frame["method"] === undefined);

describe("native Codex approvals through the existing interaction surfaces", () => {
  it("withdraws an MCP request when the native server resolves it", async () => {
    const f = await fixture();
    const mcp = mcpWire(cleanups);
    await mcp.start();
    const turn = f.peer.nextTurn();
    const run = await f.started();
    const turnId = await turn;
    f.peer.push({
      id: "mcp-stale",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "root",
        turnId,
        serverName: "wiki",
        mode: "form",
        message: "Allow lookup?",
        requestedSchema: { type: "object", properties: {} },
      },
    });
    const [interaction] = await f.pending(run.runId, 1);
    f.peer.push({
      method: "serverRequest/resolved",
      params: { threadId: "root", requestId: "mcp-stale" },
    });
    await f.pending(run.runId, 0);
    const late = await mcp.tool("claudexor_answer_interaction", {
      runId: run.runId,
      interactionId: interaction!.interactionId,
      answers: [{ questionId: interaction!.questions[0].id, selectedLabels: ["Accept request"] }],
    });
    expect(late.result.isError).toBe(true);
    f.peer.finishTurn(turnId, "The server withdrew its request");
    expect((await f.terminal(run.id)).state).toBe("succeeded");
    expect(decisionsFor(f.peer.writes, "mcp-stale")).toEqual([]);
  }, 20_000);
  it("delivers an MCP server request through the daemon MCP and answers its original RPC", async () => {
    const f = await fixture();
    const mcp = mcpWire(cleanups);
    await mcp.start();
    const turn = f.peer.nextTurn();
    const run = await f.started();
    const turnId = await turn;
    f.peer.push({
      id: "mcp-request",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "root",
        turnId,
        serverName: "wiki",
        mode: "form",
        message: "Allow lookup?",
        requestedSchema: { type: "object", properties: {} },
        _meta: { tool_params: { slug: "support" } },
      },
    });
    await f.pending(run.runId, 1);
    const listed = await mcp.tool("claudexor_run_interactions", { runId: run.runId });
    const interaction = listed.result.structuredContent.interactions[0];
    const question = interaction.questions[0];
    expect(question.question).toContain('"slug": "support"');
    expect(question.question).toContain("not verified as a native tool-call approval");
    const result = await mcp.tool("claudexor_answer_interaction", {
      runId: run.runId,
      interactionId: interaction.interactionId,
      answers: [{ questionId: question.id, selectedLabels: ["Accept request"] }],
    });
    expect(result.result.isError).not.toBe(true);
    await f.peer.written((frame) => frame["id"] === "mcp-request" && frame["method"] === undefined);
    expect(decisionsFor(f.peer.writes, "mcp-request")).toEqual([
      { id: "mcp-request", result: { action: "accept", content: {}, _meta: null } },
    ]);
    f.peer.finishTurn(turnId, "Lookup complete");
    expect((await f.terminal(run.id)).state).toBe("succeeded");
  }, 20_000);

  it("hands a correlated MCP denial to the controller and retries under the original policy", async () => {
    const f = await fixture();
    const mcp = mcpWire(cleanups);
    await mcp.start();
    const first = f.peer.nextTurn();
    const run = await f.started();
    const turnId = await first;
    f.peer.push({
      method: "item/started",
      params: {
        threadId: "root",
        turnId,
        item: {
          id: "mcp-item",
          type: "mcpToolCall",
          server: "wiki",
          tool: "read",
          arguments: { slug: "support" },
        },
      },
    });
    f.peer.push({
      method: "item/autoApprovalReview/completed",
      params: {
        threadId: "root",
        turnId,
        reviewId: "mcp-review",
        targetItemId: "mcp-item",
        action: {
          type: "mcpToolCall",
          server: "wiki",
          toolName: "read",
          connectorId: null,
          connectorName: null,
          toolTitle: null,
        },
        review: { status: "denied", rationale: "Needs explicit authorization" },
        startedAtMs: 100,
        completedAtMs: 200,
        decisionSource: "agent",
      },
    });
    f.peer.finishTurn(turnId, "Lookup denied");
    await f.pending(run.runId, 1);
    const listed = await mcp.tool("claudexor_run_interactions", { runId: run.runId });
    const interaction = listed.result.structuredContent.interactions[0];
    const question = interaction.questions[0];
    expect(question.question).toContain('"slug": "support"');
    expect(question.question).toContain("not bound to these arguments");
    const second = f.peer.nextTurn();
    const answered = await mcp.tool("claudexor_answer_interaction", {
      runId: run.runId,
      interactionId: interaction.interactionId,
      answers: [{ questionId: question.id, selectedLabels: ["Authorize one retry"] }],
    });
    expect(answered.result.isError).not.toBe(true);
    const secondTurn = await second;
    const authorization = await f.peer.written(
      (frame) => frame["method"] === "thread/approveGuardianDeniedAction",
    );
    expect(authorization["params"]).toMatchObject({
      event: {
        id: "mcp-review",
        action: { type: "mcp_tool_call", server: "wiki", tool_name: "read" },
      },
    });
    const retry = f.peer.writes.filter((frame) => frame["method"] === "turn/start")[1];
    expect(retry?.["params"]).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    });
    expect(JSON.stringify(retry)).toContain("support");
    f.peer.finishTurn(secondTurn, "Lookup completed");
    expect((await f.terminal(run.id)).state).toBe("succeeded");
  }, 20_000);
  it("answers one exact pending action over HTTP once, and refuses a duplicate answer", async () => {
    const f = await fixture();
    const turn = f.peer.nextTurn();
    const run = await f.started();
    const turnId = await turn;
    f.peer.fileApproval(turnId, "srv-file");
    const [interaction] = await f.pending(run.runId, 1);
    const question = interaction!.questions[0];
    expect(question.question).toContain("smoke.txt");
    expect(question.question).toContain("+exact bytes");
    expect(question.question).toContain("No session-wide permission");
    expect(question.options.map((option: { label: string }) => option.label)).toEqual([
      "Approve once",
      "Decline",
    ]);
    const path = `/runs/${run.runId}/interactions/${interaction!.interactionId}/answer`;
    expect(await f.http("POST", path, answerBody(question.id, "Approve once"))).toMatchObject({
      status: 200,
      body: { accepted: true, status: "delivered" },
    });
    await f.peer.written((frame) => frame["id"] === "srv-file" && frame["method"] === undefined);
    expect(decisionsFor(f.peer.writes, "srv-file")).toEqual([
      { id: "srv-file", result: { decision: "accept" } },
    ]);
    expect(await f.http("POST", path, answerBody(question.id, "Approve once"))).toMatchObject({
      status: 409,
      body: { context: { accepted: false, status: "already_resolved" } },
    });
    f.peer.finishTurn(turnId, "Wrote smoke.txt");
    expect((await f.terminal(run.id)).state).toBe("succeeded");
    expect(decisionsFor(f.peer.writes, "srv-file")).toHaveLength(1);
    expect(JSON.stringify(f.peer.writes)).not.toMatch(/acceptForSession|acceptWithExecpolicy/);
    const events = readFileSync(join(run.runDir, "events.jsonl"), "utf8");
    expect(events).toContain("interaction.answered");
  }, 20_000);

  it("revokes a native request the app-server resolved itself and refuses the late answer", async () => {
    const f = await fixture();
    const turn = f.peer.nextTurn();
    const run = await f.started();
    const turnId = await turn;
    f.peer.fileApproval(turnId, "srv-revoked");
    const [interaction] = await f.pending(run.runId, 1);
    f.peer.push({
      method: "serverRequest/resolved",
      params: { threadId: "root", requestId: "srv-revoked" },
    });
    await f.pending(run.runId, 0);
    const late = await f.http(
      "POST",
      `/runs/${run.runId}/interactions/${interaction!.interactionId}/answer`,
      answerBody(interaction!.questions[0].id, "Approve once"),
    );
    expect(late).toMatchObject({
      status: 409,
      body: { context: { accepted: false, status: "already_resolved" } },
    });
    f.peer.finishTurn(turnId, "Continued without the write");
    expect((await f.terminal(run.id)).state).toBe("succeeded");
    expect(decisionsFor(f.peer.writes, "srv-revoked")).toEqual([]);
    // The durable per-run stream announces the withdrawal answer surfaces close on.
    const events = readFileSync(join(run.runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
    expect(
      events.filter(
        (event) =>
          event.type.startsWith("interaction.") &&
          event.payload["interaction_id"] === interaction!.interactionId,
      ),
    ).toEqual([
      expect.objectContaining({ type: "interaction.requested" }),
      expect.objectContaining({ type: "interaction.withdrawn" }),
    ]);
  }, 20_000);

  it("lets an MCP controller authorize one denied-action retry, keeping both turns' answers", async () => {
    const f = await fixture();
    const mcp = mcpWire(cleanups);
    await mcp.start();
    const first = f.peer.nextTurn();
    const run = await f.started();
    const firstTurn = await first;
    f.peer.autoReviewDenial(firstTurn, "review-1");
    f.peer.finishTurn(firstTurn, "Blocked: node --test needs permission");
    await f.pending(run.runId, 1);
    const listed = await mcp.tool("claudexor_run_interactions", { runId: run.runId });
    const interaction = listed.result.structuredContent.interactions[0];
    const question = interaction.questions[0];
    expect(question.question).toContain('"command": "node --test"');
    expect(question.question).toContain("Blocked: node --test needs permission");
    expect(question.options.map((option: { label: string }) => option.label)).toEqual([
      "Authorize one retry",
      "Decline",
    ]);
    const second = f.peer.nextTurn();
    const answered = await mcp.tool("claudexor_answer_interaction", {
      runId: run.runId,
      interactionId: interaction.interactionId,
      answers: [{ questionId: question.id, selectedLabels: ["Authorize one retry"] }],
    });
    expect(answered.result.isError).not.toBe(true);
    const secondTurn = await second;
    const authorization = await f.peer.written(
      (frame) => frame["method"] === "thread/approveGuardianDeniedAction",
    );
    expect(authorization["params"]).toMatchObject({
      threadId: "root",
      event: {
        id: "review-1",
        status: "denied",
        action: { type: "command", command: "node --test", cwd: f.peer.cwd },
      },
    });
    const retryStart = f.peer.writes.filter((frame) => frame["method"] === "turn/start")[1];
    expect(retryStart?.["params"]).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    });
    f.peer.finishTurn(secondTurn, "Verified after the authorized retry");
    expect((await f.terminal(run.id)).state).toBe("succeeded");
    expect(f.harnessEvents.filter((event) => event.final).map((event) => event.text)).toEqual([
      "Blocked: node --test needs permission",
      "Verified after the authorized retry",
    ]);
    const late = await mcp.tool("claudexor_answer_interaction", {
      runId: run.runId,
      interactionId: interaction.interactionId,
      answers: [{ questionId: question.id, selectedLabels: ["Authorize one retry"] }],
    });
    expect(late.result.isError).toBe(true);
    expect(
      f.peer.writes.filter((frame) => frame["method"] === "thread/approveGuardianDeniedAction"),
    ).toHaveLength(1);
  }, 20_000);

  it("releases a pending denial handback on Stop without authorizing it", async () => {
    const f = await fixture();
    const first = f.peer.nextTurn();
    const run = await f.started();
    const turnId = await first;
    f.peer.autoReviewDenial(turnId, "review-stop");
    f.peer.finishTurn(turnId, "Done except the denied check");
    const [interaction] = await f.pending(run.runId, 1);
    const stop = await f.http("POST", `/runs/${run.runId}/control`, {
      control: { kind: "cancel", reason: "fixture stop", reason_code: "user_cancelled" },
    });
    expect(stop.status).toBe(200);
    expect((await f.terminal(run.id)).state).toBe("cancelled");
    const late = await f.http(
      "POST",
      `/runs/${run.runId}/interactions/${interaction!.interactionId}/answer`,
      answerBody(interaction!.questions[0].id, "Authorize one retry"),
    );
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(late.body.context?.accepted ?? false).toBe(false);
    expect(
      f.peer.writes.some((frame) => frame["method"] === "thread/approveGuardianDeniedAction"),
    ).toBe(false);
    expect(f.peer.writes.filter((frame) => frame["method"] === "turn/start")).toHaveLength(1);
    expect(f.harnessEvents.filter((event) => event.final).map((event) => event.text)).toEqual([
      "Done except the denied check",
    ]);
    const events = readFileSync(join(run.runDir, "events.jsonl"), "utf8");
    expect(events).not.toContain('"type":"interaction.withdrawn"');
    expect(events).not.toContain('"reason":"request_withdrawn"');
  }, 20_000);

  it("lets a hard time limit stop the run while a native approval waits, without approving it", async () => {
    const f = await fixture();
    const turn = f.peer.nextTurn();
    const run = await f.started({ maxSeconds: 1 });
    const turnId = await turn;
    f.peer.fileApproval(turnId, "srv-deadline");
    const [interaction] = await f.pending(run.runId, 1);
    // Calendar time keeps running while the question waits for an answer.
    expect((await f.terminal(run.id)).state).toBe("cancelled");
    expect(f.abortReasons).toEqual(["wall_clock_exceeded"]);
    expect(decisionsFor(f.peer.writes, "srv-deadline")).toEqual([]);
    const late = await f.http(
      "POST",
      `/runs/${run.runId}/interactions/${interaction!.interactionId}/answer`,
      answerBody(interaction!.questions[0].id, "Approve once"),
    );
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(decisionsFor(f.peer.writes, "srv-deadline")).toEqual([]);
    const events = readFileSync(join(run.runDir, "events.jsonl"), "utf8");
    expect(events).toMatch(/"control":\{"kind":"time_limit","action":"reached"\}/);
    expect(events).not.toContain('"type":"interaction.withdrawn"');
    expect(events).not.toContain('"reason":"request_withdrawn"');
  }, 20_000);
});

describe("Codex async questions through the existing interaction surfaces (#628)", () => {
  const QUESTION = "Who should receive the launch update?";
  const QUESTION_ID = '["request_user_input_async","audience-question",0]';
  const SCENARIO = [{ title: QUESTION, options: ["Internal team", "Customers"] }];
  // answered_question.rs for the pinned rust-v0.162.1 scenario's answer.
  const SCENARIO_REPLY =
    "<send_user_message_question_reply>\n" +
    '[{"answer":"Customers","question":"Who should receive the launch update?","questionItemId":"[\\"request_user_input_async\\",\\"audience-question\\",0]"}]' +
    "\n</send_user_message_question_reply>";
  const steers = (writes: Frame[]) => writes.filter((frame) => frame["method"] === "turn/steer");
  const journal = (runDir: string) =>
    readFileSync(join(runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, any> });

  it("answers one pending async question over HTTP as the agent's next message, never holding the run", async () => {
    const f = await fixture();
    const mcp = mcpWire(cleanups);
    await mcp.start();
    const turn = f.peer.nextTurn();
    const run = await f.started();
    const turnId = await turn;
    f.peer.asyncQuestion(turnId, "audience-question", SCENARIO);
    const [pending] = await f.pending(run.runId, 1);
    expect(pending).toMatchObject({
      delivery: "async",
      sourceTool: "request_user_input_async",
      questions: [
        {
          id: QUESTION_ID,
          question: QUESTION,
          options: [{ label: "Internal team" }, { label: "Customers" }],
          multi_select: false,
        },
      ],
    });
    const detail = await f.http("GET", `/runs/${run.runId}`);
    expect(detail.body["summary"]).toMatchObject({ waitingOnUser: true, asyncQuestionsOnly: true });
    // The watchdog stays armed: an async question is not legitimate silence.
    const channel = f.channels[0]!;
    expect(channel.pendingCount!()).toBe(0);
    expect(channel.suspensionVersion!()).toBe(0);
    // A waiting MCP controller is woken by it (the #628 caller path).
    const waited = (await mcp.tool("claudexor_run_wait", { runId: run.runId, waitMs: 0 })).result
      .structuredContent;
    expect(waited.wakeReason).toBe("interactions");
    expect(waited.pendingInteractions).toMatchObject([
      { interactionId: pending!.interactionId, delivery: "async" },
    ]);
    // The agent keeps working; its stream is read while nobody has answered.
    f.peer.say(turnId, "working", "I drafted a short launch update.");
    await vi.waitFor(
      () =>
        expect(f.harnessEvents.map((event) => event.text)).toContain(
          "I drafted a short launch update.",
        ),
      { timeout: 5_000, interval: 10 },
    );
    expect(steers(f.peer.writes)).toEqual([]);

    const path = `/runs/${run.runId}/interactions/${pending!.interactionId}/answer`;
    expect(await f.http("POST", path, answerBody(QUESTION_ID, "Customers"))).toMatchObject({
      status: 200,
      body: { accepted: true, status: "delivered" },
    });
    const steer = await f.peer.written((frame) => frame["method"] === "turn/steer");
    expect(steer["params"]).toEqual({
      threadId: "root",
      expectedTurnId: turnId,
      clientUserMessageId: `interaction-answer:${pending!.interactionId}`,
      input: [{ type: "text", text: SCENARIO_REPLY, text_elements: [] }],
    });
    expect(await f.http("POST", path, answerBody(QUESTION_ID, "Customers"))).toMatchObject({
      status: 409,
      body: { context: { accepted: false, status: "already_resolved" } },
    });
    await vi.waitFor(
      () =>
        expect(
          f.harnessEvents.find((event) => event.payload?.["code"] === "interaction_answer_steer")
            ?.payload,
        ).toMatchObject({ outcome: "accepted", native_turn_id: turnId }),
      { timeout: 5_000, interval: 10 },
    );
    f.peer.finishTurn(turnId, "Here is the launch update for customers.");
    expect((await f.terminal(run.id)).state).toBe("succeeded");
    expect(steers(f.peer.writes)).toHaveLength(1);
    expect(f.harnessEvents.filter((event) => event.final).map((event) => event.text)).toEqual([
      "Here is the launch update for customers.",
    ]);
    expect(channel.suspensionVersion!()).toBe(0);
    const lifecycle = journal(run.runDir).filter((event) => event.type.startsWith("interaction."));
    expect(lifecycle.map((event) => [event.type, event.payload["delivery"]])).toEqual([
      ["interaction.requested", "async"],
      ["interaction.answered", "async"],
    ]);
  }, 20_000);

  it("withdraws the question when its turn ends and refuses the late answer", async () => {
    const f = await fixture();
    const turn = f.peer.nextTurn();
    const run = await f.started();
    const turnId = await turn;
    f.peer.asyncQuestion(turnId, "audience-question", SCENARIO);
    const [pending] = await f.pending(run.runId, 1);
    f.peer.finishTurn(turnId, "Finished without waiting for the answer.");
    expect((await f.terminal(run.id)).state).toBe("succeeded");
    await f.pending(run.runId, 0);
    const late = await f.http(
      "POST",
      `/runs/${run.runId}/interactions/${pending!.interactionId}/answer`,
      answerBody(QUESTION_ID, "Customers"),
    );
    expect(late).toMatchObject({
      status: 409,
      body: { context: { accepted: false, status: "already_resolved" } },
    });
    expect(steers(f.peer.writes)).toEqual([]);
    expect(f.harnessEvents.filter((event) => event.final).map((event) => event.text)).toEqual([
      "Finished without waiting for the answer.",
    ]);
    expect(
      journal(run.runDir)
        .filter((event) => event.payload["interaction_id"] === pending!.interactionId)
        .map((event) => event.type),
    ).toEqual(["interaction.requested", "interaction.withdrawn"]);
  }, 20_000);

  it("keeps a blocking approval and an async question apart in one turn", async () => {
    const f = await fixture();
    const turn = f.peer.nextTurn();
    const run = await f.started();
    const turnId = await turn;
    f.peer.fileApproval(turnId, "srv-mixed");
    f.peer.asyncQuestion(turnId, "audience-question", SCENARIO);
    const pending = await f.pending(run.runId, 2);
    const blocking = pending.find((interaction) => interaction["delivery"] === "blocking")!;
    const asked = pending.find((interaction) => interaction["delivery"] === "async")!;
    expect(blocking["sourceTool"]).toBe("item/fileChange/requestApproval");
    expect((await f.http("GET", `/runs/${run.runId}`)).body["summary"]).toMatchObject({
      waitingOnUser: true,
      asyncQuestionsOnly: false,
    });
    // Only the blocking approval holds the watchdog.
    expect(f.channels[0]!.pendingCount!()).toBe(1);
    expect(
      await f.http(
        "POST",
        `/runs/${run.runId}/interactions/${asked["interactionId"]}/answer`,
        answerBody(QUESTION_ID, "Customers"),
      ),
    ).toMatchObject({ status: 200, body: { status: "delivered" } });
    await f.peer.written((frame) => frame["method"] === "turn/steer");
    expect(decisionsFor(f.peer.writes, "srv-mixed")).toEqual([]);
    expect(
      await f.http(
        "POST",
        `/runs/${run.runId}/interactions/${blocking["interactionId"]}/answer`,
        answerBody(blocking["questions"][0].id, "Approve once"),
      ),
    ).toMatchObject({ status: 200, body: { status: "delivered" } });
    await f.peer.written((frame) => frame["id"] === "srv-mixed" && frame["method"] === undefined);
    expect(decisionsFor(f.peer.writes, "srv-mixed")).toEqual([
      { id: "srv-mixed", result: { decision: "accept" } },
    ]);
    f.peer.finishTurn(turnId, "Wrote smoke.txt for customers");
    expect((await f.terminal(run.id)).state).toBe("succeeded");
    expect(steers(f.peer.writes)).toHaveLength(1);
    expect(steers(f.peer.writes)[0]!["params"]).toMatchObject({
      clientUserMessageId: `interaction-answer:${asked["interactionId"]}`,
      input: [{ type: "text", text: SCENARIO_REPLY }],
    });
  }, 20_000);

  it("lets a finite deadline expire the question: nothing is sent and the run keeps working", async () => {
    const f = await fixture();
    const turn = f.peer.nextTurn();
    const run = await f.started({ interactionTimeoutMs: 200 });
    const turnId = await turn;
    f.peer.asyncQuestion(turnId, "audience-question", SCENARIO);
    const [pending] = await f.pending(run.runId, 1);
    expect(pending!["timeoutAt"]).toEqual(expect.any(String));
    await vi.waitFor(
      () => expect(journal(run.runDir).map((event) => event.type)).toContain("interaction.timeout"),
      { timeout: 5_000, interval: 10 },
    );
    const late = await f.http(
      "POST",
      `/runs/${run.runId}/interactions/${pending!.interactionId}/answer`,
      answerBody(QUESTION_ID, "Customers"),
    );
    expect(late).toMatchObject({
      status: 409,
      body: { context: { accepted: false, status: "already_resolved" } },
    });
    f.peer.finishTurn(turnId, "Finished on my own assumptions.");
    expect((await f.terminal(run.id)).state).toBe("succeeded");
    expect(steers(f.peer.writes)).toEqual([]);
    expect(
      journal(run.runDir)
        .filter((event) => event.payload["interaction_id"] === pending!.interactionId)
        .map((event) => [event.type, event.payload["delivery"]]),
    ).toEqual([
      ["interaction.requested", "async"],
      ["interaction.timeout", "async"],
    ]);
    expect(f.harnessEvents.filter((event) => event.final).map((event) => event.text)).toEqual([
      "Finished on my own assumptions.",
    ]);
  }, 20_000);

  it("ends on Stop with the question pending: nothing is sent and the late answer is refused", async () => {
    const f = await fixture();
    const turn = f.peer.nextTurn();
    const run = await f.started();
    const turnId = await turn;
    f.peer.asyncQuestion(turnId, "audience-question", SCENARIO);
    const [pending] = await f.pending(run.runId, 1);
    const stop = await f.http("POST", `/runs/${run.runId}/control`, {
      control: { kind: "cancel", reason: "fixture stop", reason_code: "user_cancelled" },
    });
    expect(stop.status).toBe(200);
    expect((await f.terminal(run.id)).state).toBe("cancelled");
    const late = await f.http(
      "POST",
      `/runs/${run.runId}/interactions/${pending!.interactionId}/answer`,
      answerBody(QUESTION_ID, "Customers"),
    );
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(late.body.context?.accepted ?? false).toBe(false);
    expect(steers(f.peer.writes)).toEqual([]);
    const events = readFileSync(join(run.runDir, "events.jsonl"), "utf8");
    expect(events).not.toContain('"type":"interaction.withdrawn"');
    expect(events).not.toContain('"type":"interaction.answered"');
  }, 20_000);
});
