import {
  InteractionChannelError,
  type InteractionChannel,
  type spawnProcess,
} from "@claudexor/core";
import type { HarnessEvent, InteractionAnswerSet, InteractionRequest } from "@claudexor/schema";
import { HarnessRunSpec } from "@claudexor/schema";
import { describe, expect, it } from "vitest";
import { runCodexAppServer } from "./app-server-run.js";

type Frame = Record<string, unknown>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("app-server test peer timed out")), 1_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function approvalPeer(
  method: string,
  approvalId: number | string,
  itemDetails: Frame,
  requestDetails: Frame = {},
  peerOptions: { approvalRpcError?: boolean } = {},
) {
  const writes: Frame[] = [];
  const frames: string[] = [];
  const wroteApproval = deferred<Frame>();
  let wake: (() => void) | undefined;
  let stopped = false;
  let turnCount = 0;
  let close!: () => void;
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  const push = (frame: Frame) => {
    frames.push(JSON.stringify(frame));
    wake?.();
    wake = undefined;
  };
  const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
    const safety = setTimeout(() => {
      stopped = true;
      close();
      wake?.();
    }, 1_500);
    options.onSpawn?.({
      write(line) {
        const frame = JSON.parse(line) as Frame;
        writes.push(frame);
        if (frame["method"] === "initialize") push({ id: frame["id"], result: {} });
        if (frame["method"] === "thread/start")
          push({ id: frame["id"], result: { thread: { id: "thread-approval" } } });
        if (frame["method"] === "turn/start") {
          turnCount += 1;
          if (method === "item/autoApprovalReview/completed") {
            const turnId = `turn-approval-${turnCount}`;
            push({
              method: "turn/started",
              params: { threadId: "thread-approval", turn: { id: turnId } },
            });
            push({ id: frame["id"], result: { turn: { id: turnId } } });
            if (turnCount === 1 && itemDetails["type"] === "mcpToolCall")
              push({
                method: "item/started",
                params: {
                  threadId: "thread-approval",
                  turnId,
                  item: { id: "item-approval", ...itemDetails },
                },
              });
            if (turnCount === 1)
              push({
                method,
                params: {
                  threadId: "thread-approval",
                  turnId,
                  reviewId: "review-1",
                  targetItemId: "item-approval",
                  action: {
                    type: "command",
                    source: "shell",
                    command: "node --test",
                    cwd: process.cwd(),
                  },
                  review: { status: "denied", rationale: "Needs permission" },
                  startedAtMs: 100,
                  completedAtMs: 200,
                  decisionSource: "agent",
                  ...requestDetails,
                },
              });
            push({
              method: "item/completed",
              params: {
                threadId: "thread-approval",
                turnId,
                item: {
                  id: "msg-final",
                  type: "agentMessage",
                  text: turnCount === 1 ? "Blocked by policy" : "Verified after retry",
                },
              },
            });
            push({
              method: "turn/completed",
              params: {
                threadId: "thread-approval",
                turn: { id: turnId, status: "completed", items: [] },
              },
            });
            return;
          }
          push({
            method: "turn/started",
            params: { threadId: "thread-approval", turn: { id: "turn-approval" } },
          });
          push({
            method: "item/started",
            params: {
              threadId: "thread-approval",
              turnId: "turn-approval",
              item: {
                id: "item-approval",
                type:
                  method === "item/fileChange/requestApproval" ? "fileChange" : "commandExecution",
                ...itemDetails,
              },
            },
          });
          // The server request intentionally precedes the turn/start reply. A numeric
          // server id may collide with this outstanding client RPC id.
          push({
            id: approvalId,
            method,
            params: {
              threadId: "thread-approval",
              turnId: "turn-approval",
              itemId: "item-approval",
              ...requestDetails,
            },
          });
          push({ id: frame["id"], result: { turn: { id: "turn-approval" } } });
        }
        if (frame["method"] === "thread/approveGuardianDeniedAction") {
          wroteApproval.resolve(frame);
          push(
            peerOptions.approvalRpcError
              ? {
                  id: frame["id"],
                  error: { code: -32601, message: "Native authorization unavailable" },
                }
              : { id: frame["id"], result: {} },
          );
        }
        if (frame["id"] === approvalId && frame["method"] === undefined) {
          wroteApproval.resolve(frame);
          push({
            method: "item/completed",
            params: {
              threadId: "thread-approval",
              turnId: "turn-approval",
              item: { id: "msg-final", type: "agentMessage", text: "Done" },
            },
          });
          push({
            method: "turn/completed",
            params: {
              threadId: "thread-approval",
              turn: { id: "turn-approval", status: "completed", items: [] },
            },
          });
        }
        if (frame["method"] === "thread/read")
          push({ id: frame["id"], result: { thread: { status: { type: "idle" } } } });
        if (frame["method"] === "thread/goal/get")
          push({ id: frame["id"], result: { goal: { status: "complete" } } });
        if (frame["method"] === "thread/backgroundTerminals/list")
          push({ id: frame["id"], result: { data: [] } });
        if (frame["method"] === "turn/interrupt") push({ id: frame["id"], result: {} });
      },
      end() {
        stopped = true;
        close();
        wake?.();
      },
      closed,
    });
    try {
      while (!stopped || frames.length) {
        if (frames.length) yield { type: "stdout", line: frames.shift()! };
        else await new Promise<void>((resolve) => (wake = resolve));
      }
      yield { type: "exit", code: 0, signal: null, durationMs: 0 };
    } finally {
      clearTimeout(safety);
    }
  };
  const disconnect = () => {
    stopped = true;
    close();
    wake?.();
  };
  return { spawn, writes, wroteApproval: wroteApproval.promise, push, disconnect };
}

function startApprovalRun(
  peer: ReturnType<typeof approvalPeer>,
  signal?: AbortSignal,
  access: "readonly" | "workspace_write" | "full" = "full",
  channelFailure?: unknown,
) {
  const asked = deferred<InteractionRequest>();
  const reply = deferred<InteractionAnswerSet | null>();
  const channel: InteractionChannel = {
    request(request) {
      asked.resolve(request);
      return channelFailure === undefined ? reply.promise : Promise.reject(channelFailure);
    },
  };
  const events: HarnessEvent[] = [];
  const spec = HarnessRunSpec.parse({
    session_id: "session-approval",
    intent: "implement",
    prompt: "Make a safe change",
    cwd: process.cwd(),
    access,
  });
  spec.extra["interactionChannel"] = channel;
  if (signal) spec.extra["abortSignal"] = signal;
  const done = (async () => {
    for await (const event of runCodexAppServer({
      bin: "codex",
      args: [],
      spec,
      env: {},
      spawn: peer.spawn,
    }))
      events.push(event);
    return events;
  })();
  return { asked: asked.promise, reply: reply.resolve, done, events };
}

async function observedRequest(run: ReturnType<typeof startApprovalRun>) {
  const request = await bounded(Promise.race([run.asked, run.done.then(() => null)]));
  expect(request).not.toBeNull();
  return request!;
}

function answer(
  request: InteractionRequest,
  selectedLabels: string[],
  freeText: string | null = null,
) {
  return {
    interaction_id: request.interaction_id,
    answers: [
      {
        question_id: request.questions[0]!.id,
        selected_labels: selectedLabels,
        free_text: freeText,
      },
    ],
  };
}

describe("Codex app-server approval relay", () => {
  it("fails closed on an elicitation that reuses a pending command RPC id", async () => {
    const peer = approvalPeer("item/commandExecution/requestApproval", 7, {
      command: "pwd",
      cwd: process.cwd(),
    });
    const run = startApprovalRun(peer);
    const request = await observedRequest(run);
    peer.push({
      id: 7,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-approval",
        turnId: "turn-approval",
        serverName: "wiki",
        mode: "form",
        message: "Allow?",
        requestedSchema: { type: "object", properties: {} },
      },
    });
    const events = await bounded(run.done);
    run.reply(answer(request, ["Approve once"]));
    expect(
      peer.writes.filter((frame) => frame["id"] === 7 && frame["method"] === undefined),
    ).toEqual([]);
    expect(events.some((event) => event.type === "error")).toBe(true);
  });
  it.each([
    ["Accept request", "accept"],
    ["Decline", "decline"],
  ])("answers a simple untrusted MCP server request with %s", async (choice, action) => {
    const peer = approvalPeer(
      "mcpServer/elicitation/request",
      "mcp-request",
      {},
      {
        serverName: "wiki",
        mode: "form",
        message: "Allow lookup?",
        requestedSchema: { type: "object", properties: {} },
        _meta: { tool_params: { slug: "support" } },
      },
    );
    const run = startApprovalRun(peer, undefined, "workspace_write");
    const request = await observedRequest(run);
    expect(request.source_tool).toBe("mcpServer/elicitation/request");
    expect(request.questions[0]!.question).toContain('"slug": "support"');
    expect(request.questions[0]!.question).toContain("not verified as a native tool-call approval");
    run.reply(answer(request, [choice]));
    expect(await bounded(peer.wroteApproval)).toEqual({
      id: "mcp-request",
      result: { action, content: action === "accept" ? {} : null, _meta: null },
    });
    await bounded(run.done);
  });

  it.each(["readonly", "full"] as const)(
    "declines an MCP server request under %s without asking",
    async (access) => {
      const peer = approvalPeer(
        "mcpServer/elicitation/request",
        "mcp-request",
        {},
        {
          serverName: "wiki",
          mode: "form",
          message: "Allow?",
          requestedSchema: { type: "object", properties: {} },
        },
      );
      const run = startApprovalRun(peer, undefined, access);
      expect(await bounded(peer.wroteApproval)).toEqual({
        id: "mcp-request",
        result: { action: "decline", content: null, _meta: null },
      });
      await bounded(run.done);
    },
  );

  it("declines unsupported MCP form schemas rather than accepting incomplete input", async () => {
    const peer = approvalPeer(
      "mcpServer/elicitation/request",
      "mcp-request",
      {},
      {
        serverName: "wiki",
        mode: "form",
        message: "Type a value",
        requestedSchema: { type: "object", properties: { value: { type: "string" } } },
      },
    );
    const run = startApprovalRun(peer, undefined, "workspace_write");
    expect(await bounded(peer.wroteApproval)).toEqual({
      id: "mcp-request",
      result: { action: "decline", content: null, _meta: null },
    });
    await bounded(run.done);
  });

  it.each([
    { threadId: "foreign" },
    { turnId: null },
    { serverName: "" },
    { mode: "url", url: "https://example.test/verify" },
    { message: "x".repeat(33_000) },
  ])("declines unsupported or uncorrelated MCP requests %j", async (overrides) => {
    const peer = approvalPeer(
      "mcpServer/elicitation/request",
      "mcp-request",
      {},
      {
        serverName: "wiki",
        mode: "form",
        message: "Allow?",
        requestedSchema: { type: "object", properties: {} },
        ...overrides,
      },
    );
    const run = startApprovalRun(peer, undefined, "workspace_write");
    expect(await bounded(peer.wroteApproval)).toEqual({
      id: "mcp-request",
      result: { action: "decline", content: null, _meta: null },
    });
    const events = await bounded(run.done);
    expect(
      events.some(
        (event) =>
          event.type === "status" &&
          event.payload?.["code"] === "codex_mcp_elicitation_not_offered",
      ),
    ).toBe(true);
  });
  it("presents a denied MCP call and carries the original arguments into the next turn", async () => {
    const peer = approvalPeer(
      "item/autoApprovalReview/completed",
      "unused",
      { type: "mcpToolCall", server: "wiki", tool: "read", arguments: { slug: "support" } },
      {
        action: {
          type: "mcpToolCall",
          server: "wiki",
          toolName: "read",
          connectorId: null,
          connectorName: null,
          toolTitle: null,
        },
      },
    );
    const run = startApprovalRun(peer, undefined, "workspace_write");
    const request = await observedRequest(run);
    expect(request.questions[0]!.question).toContain('"slug": "support"');
    expect(request.questions[0]!.question).toMatch(/not bound to these arguments/);
    run.reply(answer(request, ["Authorize one retry"]));
    const events = await bounded(run.done);
    const authorization = peer.writes.find(
      (frame) => frame["method"] === "thread/approveGuardianDeniedAction",
    );
    expect(authorization?.["params"]).toMatchObject({
      event: { action: { type: "mcp_tool_call", server: "wiki", tool_name: "read" } },
    });
    const turns = peer.writes.filter((frame) => frame["method"] === "turn/start");
    expect(turns).toHaveLength(2);
    expect(JSON.stringify(turns[1])).toContain("support");
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      payload: { native_turn_id: "turn-approval-2" },
    });
  });
  it("returns to the controller after a native denial, then re-reviews one explicitly authorized retry", async () => {
    const peer = approvalPeer("item/autoApprovalReview/completed", "unused", {});
    const run = startApprovalRun(peer, undefined, "workspace_write");
    const request = await observedRequest(run);
    expect(request.questions[0]!.question).toContain("Blocked by policy");
    expect(peer.writes.filter((frame) => frame["method"] === "turn/start")).toHaveLength(1);
    expect(
      peer.writes.some((frame) => frame["method"] === "thread/approveGuardianDeniedAction"),
    ).toBe(false);
    run.reply(answer(request, ["Authorize one retry"]));
    const events = await bounded(run.done);
    expect(peer.writes.filter((frame) => frame["method"] === "turn/start")).toHaveLength(2);
    const native = peer.writes.find(
      (frame) => frame["method"] === "thread/approveGuardianDeniedAction",
    );
    expect(native?.["params"]).toMatchObject({
      threadId: "thread-approval",
      event: {
        id: "review-1",
        turn_id: "turn-approval-1",
        status: "denied",
        action: { command: "node --test" },
      },
    });
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      payload: { native_turn_id: "turn-approval-2" },
    });
    expect(events.at(-1)?.payload?.["harness_reported_error"]).not.toBe(true);
    expect(events.filter((event) => event.final).at(-1)?.text).toBe("Verified after retry");
    for (const frame of peer.writes.filter((frame) => frame["method"] === "turn/start"))
      expect(frame["params"]).toMatchObject({
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
      });
  });

  it("does not retry or grant permission when the controller declines a native denial", async () => {
    const peer = approvalPeer("item/autoApprovalReview/completed", "unused", {});
    const run = startApprovalRun(peer, undefined, "workspace_write");
    const request = await observedRequest(run);
    run.reply(answer(request, ["Decline"]));
    await bounded(run.done);
    expect(peer.writes.filter((frame) => frame["method"] === "turn/start")).toHaveLength(1);
    expect(
      peer.writes.some((frame) => frame["method"] === "thread/approveGuardianDeniedAction"),
    ).toBe(false);
  });

  it.each(["cancel", "disconnect"])(
    "revokes a native denial handback on %s before any authorization RPC",
    async (mode) => {
      const peer = approvalPeer("item/autoApprovalReview/completed", "unused", {});
      const abort = new AbortController();
      const run = startApprovalRun(peer, abort.signal, "workspace_write");
      const request = await observedRequest(run);
      if (mode === "cancel") abort.abort();
      else peer.disconnect();
      const events = await bounded(run.done);
      run.reply(answer(request, ["Authorize one retry"]));
      expect(
        peer.writes.some((frame) => frame["method"] === "thread/approveGuardianDeniedAction"),
      ).toBe(false);
      expect(peer.writes.filter((frame) => frame["method"] === "turn/start")).toHaveLength(1);
      if (mode === "cancel") expect(events.at(-1)?.aborted).toBe(true);
      else expect(events.some((event) => event.type === "error")).toBe(true);
    },
  );

  it("does not start a retry when the native authorization RPC fails, and records uncertainty", async () => {
    const peer = approvalPeer(
      "item/autoApprovalReview/completed",
      "unused",
      {},
      {},
      { approvalRpcError: true },
    );
    const run = startApprovalRun(peer, undefined, "workspace_write");
    const request = await observedRequest(run);
    run.reply(answer(request, ["Authorize one retry"]));
    const events = await bounded(run.done);
    expect(peer.writes.filter((frame) => frame["method"] === "turn/start")).toHaveLength(1);
    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(events.at(-1)?.payload?.["native_authorization_requests"]).toEqual([
      { review_id: "review-1", state: "submitted" },
    ]);
  });

  it.each([
    [
      0,
      "item/fileChange/requestApproval",
      { changes: [{ path: "smoke.txt", kind: { type: "add" }, diff: "+safe\n" }] },
      {},
    ],
    [
      3,
      "item/commandExecution/requestApproval",
      { command: "pwd", cwd: process.cwd() },
      { command: "pwd", cwd: process.cwd() },
    ],
    [
      "approval-1",
      "item/fileChange/requestApproval",
      { changes: [{ path: "smoke.txt", kind: { type: "add" }, diff: "+safe\n" }] },
      {},
    ],
  ] as const)(
    "waits for explicit approval before accepting native request %s",
    async (id, method, itemDetails, requestDetails) => {
      const peer = approvalPeer(method, id, itemDetails, requestDetails);
      const run = startApprovalRun(
        peer,
        undefined,
        method === "item/fileChange/requestApproval" ? "workspace_write" : "full",
      );
      const request = await observedRequest(run);
      expect(request.source_tool).toBe(method);
      expect(request.questions).toHaveLength(1);
      expect(request.questions[0]!.options.map((option) => option.label)).toEqual([
        "Approve once",
        "Decline",
      ]);
      expect(
        peer.writes.filter((frame) => frame["id"] === id && frame["method"] === undefined),
      ).toEqual([]);
      run.reply(answer(request, ["Approve once"]));
      expect(await bounded(peer.wroteApproval)).toEqual({ id, result: { decision: "accept" } });
      expect(
        (await bounded(run.done)).some((event) => event.type === "interaction_requested"),
      ).toBe(true);
    },
  );

  it("declines a file-change approval on a readonly run without offering approval", async () => {
    const peer = approvalPeer("item/fileChange/requestApproval", "approval-readonly-file", {
      changes: [{ path: "smoke.txt", kind: { type: "add" }, diff: "+safe\n" }],
    });
    const run = startApprovalRun(peer, undefined, "readonly");
    const first = await bounded(
      Promise.race([
        peer.wroteApproval.then((frame) => ({ kind: "native" as const, frame })),
        run.asked.then((request) => ({ kind: "question" as const, request })),
      ]),
    );
    if (first.kind === "question") run.reply(null);
    const response = await bounded(peer.wroteApproval);
    await bounded(run.done);
    expect(first.kind).toBe("native");
    expect(response).toEqual({
      id: "approval-readonly-file",
      result: { decision: "decline" },
    });
    expect(run.events.some((event) => event.type === "interaction_requested")).toBe(false);
  });

  it.each([
    ["readonly", "pwd"],
    ["readonly", "printf probe > readonly-probe.txt"],
    ["workspace_write", "pwd"],
    ["workspace_write", "printf probe > ../outside-workspace-probe.txt"],
  ] as const)(
    "declines %s native command approval without offering an escape: %s",
    async (access, command) => {
      const peer = approvalPeer(
        "item/commandExecution/requestApproval",
        "approval-readonly-command",
        { command, cwd: process.cwd() },
        { command, cwd: process.cwd(), availableDecisions: ["accept", "decline"] },
      );
      const run = startApprovalRun(peer, undefined, access);
      const first = await bounded(
        Promise.race([peer.wroteApproval.then(() => "native"), run.asked.then(() => "question")]),
      );
      if (first === "question") run.reply(null);
      expect(await bounded(peer.wroteApproval)).toEqual({
        id: "approval-readonly-command",
        result: { decision: "decline" },
      });
      await bounded(run.done);
      expect(first).toBe("native");
      expect(run.events.some((event) => event.type === "interaction_requested")).toBe(false);
      expect(run.events.find((event) => event.type === "error")?.error).toContain(access);
    },
  );

  it("uses the cached command item when native request command and cwd are null", async () => {
    const peer = approvalPeer(
      "item/commandExecution/requestApproval",
      "approval-command-fallback",
      { command: "pwd", cwd: process.cwd() },
      { command: null, cwd: null },
    );
    const run = startApprovalRun(peer);
    const request = await observedRequest(run);
    expect(request.questions[0]!.question).toContain("pwd");
    expect(request.questions[0]!.question).toContain(process.cwd());
    run.reply(answer(request, ["Approve once"]));
    expect(await bounded(peer.wroteApproval)).toEqual({
      id: "approval-command-fallback",
      result: { decision: "accept" },
    });
    await bounded(run.done);
  });

  it("reviews a named execution environment but grants only the one native command", async () => {
    const peer = approvalPeer(
      "item/commandExecution/requestApproval",
      "approval-environment",
      { command: "cat smoke.txt", cwd: process.cwd() },
      {
        command: "cat smoke.txt",
        cwd: process.cwd(),
        kind: "command",
        environmentId: "environment-synthetic",
        availableDecisions: [
          "accept",
          { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["cat", "smoke.txt"] } },
          "cancel",
        ],
      },
    );
    const run = startApprovalRun(peer);
    const request = await observedRequest(run);
    expect(request.questions[0]!.question).toContain("environment-synthetic");
    expect(request.questions[0]!.question).toContain("cat smoke.txt");
    run.reply(answer(request, ["Approve once"]));
    expect(await bounded(peer.wroteApproval)).toEqual({
      id: "approval-environment",
      result: { decision: "accept" },
    });
    await bounded(run.done);
  });

  it("declines the native action and records why when the answer channel fails (#622 class)", async () => {
    const peer = approvalPeer("item/fileChange/requestApproval", "approval-unavailable", {
      changes: [{ path: "smoke.txt", kind: { type: "add" }, diff: "+safe\n" }],
    });
    const failure = new InteractionChannelError(new Error("interaction store unavailable"));
    const run = startApprovalRun(peer, undefined, "workspace_write", failure);
    const request = await observedRequest(run);
    // Fail closed: nobody approved, so the action is declined natively...
    expect(await bounded(peer.wroteApproval)).toEqual({
      id: "approval-unavailable",
      result: { decision: "decline" },
    });
    const events = await bounded(run.done);
    // ...and the run says the channel failed, not that a person declined.
    expect(
      events.filter((event) => event.payload?.["code"] === "interaction_answer_unavailable"),
    ).toEqual([
      expect.objectContaining({
        type: "status",
        text: `item/fileChange/requestApproval ${request.interaction_id} could not be answered: the answer channel failed (interaction store unavailable)`,
        payload: {
          code: "interaction_answer_unavailable",
          reason: "answer_channel_failed",
          interaction_id: request.interaction_id,
          error: "interaction store unavailable",
        },
      }),
    ]);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.at(-1)?.payload?.["harness_reported_error"]).not.toBe(true);
  });

  it("keeps a native denial without a retry and records why when the answer channel fails", async () => {
    const peer = approvalPeer("item/autoApprovalReview/completed", "unused", {});
    const failure = new InteractionChannelError("bridge lost");
    const run = startApprovalRun(peer, undefined, "workspace_write", failure);
    const request = await observedRequest(run);
    const events = await bounded(run.done);
    expect(peer.writes.filter((frame) => frame["method"] === "turn/start")).toHaveLength(1);
    expect(
      peer.writes.some((frame) => frame["method"] === "thread/approveGuardianDeniedAction"),
    ).toBe(false);
    expect(
      events.filter((event) => event.payload?.["code"] === "interaction_answer_unavailable"),
    ).toEqual([
      expect.objectContaining({
        payload: {
          code: "interaction_answer_unavailable",
          reason: "answer_channel_failed",
          interaction_id: request.interaction_id,
          error: "bridge lost",
        },
      }),
    ]);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.filter((event) => event.final).at(-1)?.text).toBe("Blocked by policy");
  });

  it("maps Decline to native cancel when cancel is offered without decline", async () => {
    const peer = approvalPeer(
      "item/commandExecution/requestApproval",
      "approval-cancel-only",
      { command: "cat smoke.txt", cwd: process.cwd() },
      {
        command: "cat smoke.txt",
        cwd: process.cwd(),
        availableDecisions: ["accept", "cancel"],
      },
    );
    const run = startApprovalRun(peer);
    const request = await observedRequest(run);
    run.reply(answer(request, ["Decline"]));
    expect(await bounded(peer.wroteApproval)).toEqual({
      id: "approval-cancel-only",
      result: { decision: "cancel" },
    });
    await bounded(run.done);
  });

  it("omits unrelated native metadata from the surfaced approval question", async () => {
    const peer = approvalPeer(
      "item/commandExecution/requestApproval",
      "approval-projection",
      { command: "pwd", cwd: process.cwd() },
      { command: "pwd", cwd: process.cwd(), unrelatedDiagnostic: "CUSTOMER_CANARY_NOT_FOR_REVIEW" },
    );
    const run = startApprovalRun(peer);
    const request = await observedRequest(run);
    run.reply(answer(request, ["Decline"]));
    expect(await bounded(peer.wroteApproval)).toEqual({
      id: "approval-projection",
      result: { decision: "decline" },
    });
    await bounded(run.done);
    expect(request.questions[0]!.question).toContain("pwd");
    expect(request.questions[0]!.question).not.toContain("CUSTOMER_CANARY_NOT_FOR_REVIEW");
  });

  it.each([
    ["free text", (request: InteractionRequest) => answer(request, ["Approve once"], "yes")],
    [
      "wrong question",
      (request: InteractionRequest) => ({
        ...answer(request, ["Approve once"]),
        answers: [{ question_id: "other", selected_labels: ["Approve once"], free_text: null }],
      }),
    ],
    [
      "wrong interaction",
      (request: InteractionRequest) => ({
        ...answer(request, ["Approve once"]),
        interaction_id: "other",
      }),
    ],
    ["unknown label", (request: InteractionRequest) => answer(request, ["Always approve"])],
    [
      "multiple labels",
      (request: InteractionRequest) => answer(request, ["Approve once", "Decline"]),
    ],
    ["decline", (request: InteractionRequest) => answer(request, ["Decline"])],
  ] as const)("never grants native approval for %s", async (_case, makeAnswer) => {
    const peer = approvalPeer("item/fileChange/requestApproval", "approval-invalid", {
      changes: [{ path: "smoke.txt", kind: { type: "add" }, diff: "+safe\n" }],
    });
    const run = startApprovalRun(peer);
    const request = await observedRequest(run);
    run.reply(makeAnswer(request));
    expect(await bounded(peer.wroteApproval)).toEqual({
      id: "approval-invalid",
      result: { decision: "decline" },
    });
    await bounded(run.done);
  });

  it.each([
    ["missing file changes", "item/fileChange/requestApproval", {}, {}],
    [
      "missing command cwd",
      "item/commandExecution/requestApproval",
      { command: "pwd" },
      { command: "pwd" },
    ],
    [
      "absolute file outside workspace",
      "item/fileChange/requestApproval",
      { changes: [{ path: "/outside/smoke.txt", kind: { type: "add" }, diff: "+safe\n" }] },
      {},
    ],
    [
      "traversal file outside workspace",
      "item/fileChange/requestApproval",
      { changes: [{ path: "../outside/smoke.txt", kind: { type: "add" }, diff: "+safe\n" }] },
      {},
    ],
    [
      "move target outside workspace",
      "item/fileChange/requestApproval",
      {
        changes: [
          {
            path: "smoke.txt",
            kind: { type: "update", move_path: "../outside/smoke.txt" },
            diff: "+safe\n",
          },
        ],
      },
      {},
    ],
    [
      "command cwd outside workspace",
      "item/commandExecution/requestApproval",
      { command: "pwd", cwd: "/outside" },
      { command: "pwd", cwd: "/outside" },
    ],
    [
      "additional network permission",
      "item/commandExecution/requestApproval",
      { command: "pwd", cwd: process.cwd() },
      { command: "pwd", cwd: process.cwd(), additionalPermissions: { network: { enabled: true } } },
    ],
    [
      "proposed network policy amendment",
      "item/commandExecution/requestApproval",
      { command: "pwd", cwd: process.cwd() },
      {
        command: "pwd",
        cwd: process.cwd(),
        proposedNetworkPolicyAmendments: [{ host: "example.test", action: "allow" }],
      },
    ],
    [
      "oversized change metadata",
      "item/fileChange/requestApproval",
      {
        changes: [{ path: "smoke.txt", kind: { type: "add" }, diff: "+" + "x".repeat(1_100_000) }],
      },
      {},
    ],
    [
      "unavailable accept decision",
      "item/fileChange/requestApproval",
      { changes: [{ path: "smoke.txt", kind: { type: "add" }, diff: "+safe\n" }] },
      { availableDecisions: ["decline"] },
    ],
    [
      "non-null grant root",
      "item/fileChange/requestApproval",
      { changes: [{ path: "smoke.txt", kind: { type: "add" }, diff: "+safe\n" }] },
      { grantRoot: "/workspace" },
    ],
    [
      "foreign thread",
      "item/fileChange/requestApproval",
      { changes: [{ path: "smoke.txt", kind: { type: "add" }, diff: "+safe\n" }] },
      {
        threadId: "thread-foreign",
      },
    ],
    [
      "foreign turn",
      "item/fileChange/requestApproval",
      { changes: [{ path: "smoke.txt", kind: { type: "add" }, diff: "+safe\n" }] },
      {
        turnId: "turn-foreign",
      },
    ],
  ] as const)(
    "declines %s without presenting an approvable question",
    async (_case, method, itemDetails, requestDetails) => {
      const peer = approvalPeer(method, "approval-unowned", itemDetails, requestDetails);
      const run = startApprovalRun(peer);
      const first = await bounded(
        Promise.race([
          peer.wroteApproval.then((frame) => ({ kind: "native" as const, frame })),
          run.asked.then((request) => ({ kind: "question" as const, request })),
        ]),
      );
      if (first.kind === "question") run.reply(null);
      const response = await bounded(peer.wroteApproval);
      await bounded(run.done);
      expect(first.kind).toBe("native");
      expect(response).toEqual({
        id: "approval-unowned",
        result: { decision: "decline" },
      });
      expect(run.events.some((event) => event.type === "interaction_requested")).toBe(false);
    },
  );

  /** Run one native approval request to its refusal; the declined reply and the run's error text. */
  async function refusal(
    method: string,
    itemDetails: Frame,
    requestDetails: Frame,
    access: "readonly" | "workspace_write" | "full",
  ) {
    const peer = approvalPeer(method, "approval-refused", itemDetails, requestDetails);
    const run = startApprovalRun(peer, undefined, access);
    const first = await bounded(
      Promise.race([peer.wroteApproval.then(() => "native"), run.asked.then(() => "question")]),
    );
    if (first === "question") run.reply(null);
    const reply = await bounded(peer.wroteApproval);
    await bounded(run.done);
    expect(first).toBe("native");
    expect(run.events.some((event) => event.type === "interaction_requested")).toBe(false);
    return { reply, error: run.events.find((event) => event.type === "error")?.error ?? "" };
  }

  const bigChange = { path: "smoke.txt", kind: { type: "add" }, diff: "+" + "x".repeat(40_000) };
  const bigCommand = `printf ${"x".repeat(40_000)}`;

  it("names the measured size when an approval exceeds the review limit (#651)", async () => {
    const file = await refusal(
      "item/fileChange/requestApproval",
      { changes: [bigChange] },
      {},
      "full",
    );
    expect(file.reply).toEqual({ id: "approval-refused", result: { decision: "decline" } });
    const fileChars = JSON.stringify({ changes: [bigChange] }, null, 2).length;
    expect(file.error).toContain(
      `the action's review details (${fileChars} characters) exceed the 32000-character review limit`,
    );
    expect(file.error).not.toContain("cannot grant native approval");
    const command = await refusal(
      "item/commandExecution/requestApproval",
      { command: "pwd", cwd: process.cwd() },
      { command: bigCommand, cwd: process.cwd() },
      "full",
    );
    expect(command.reply).toEqual({ id: "approval-refused", result: { decision: "decline" } });
    const commandChars = JSON.stringify(
      {
        method: "item/commandExecution/requestApproval",
        workspace: process.cwd(),
        environmentId: null,
        reason: null,
        command: bigCommand,
        cwd: process.cwd(),
      },
      null,
      2,
    ).length;
    expect(command.error).toContain(`review details (${commandChars} characters)`);
  });

  it("keeps the access refusals ahead of an oversized approval (#651)", async () => {
    const readonly = await refusal(
      "item/fileChange/requestApproval",
      { changes: [bigChange] },
      {},
      "readonly",
    );
    expect(readonly.error).toContain("readonly access forbids sandbox escalation");
    expect(readonly.error).not.toContain("review limit");
    const sandboxed = await refusal(
      "item/commandExecution/requestApproval",
      { command: "pwd", cwd: process.cwd() },
      { command: bigCommand, cwd: process.cwd() },
      "workspace_write",
    );
    expect(sandboxed.error).toContain("workspace_write access cannot grant an unsandboxed command");
    expect(sandboxed.error).not.toContain("review limit");
  });

  it.each([
    ["a credential-named path", { path: ".env", kind: { type: "add" }, diff: "+safe\n" }],
    [
      "credential-shaped content",
      { path: "smoke.txt", kind: { type: "add" }, diff: "+sk-proj-" + "x".repeat(40) },
    ],
  ] as const)("presents %s inside the workspace for approval (INV-146)", async (_case, change) => {
    const peer = approvalPeer("item/fileChange/requestApproval", "approval-exact", {
      changes: [change],
    });
    const run = startApprovalRun(peer);
    const request = await observedRequest(run);
    expect(JSON.stringify(request)).toContain(change.path);
    expect(JSON.stringify(request)).toContain(change.diff.slice(1).trimEnd().slice(0, 8));
    run.reply(answer(request, ["Approve once"]));
    expect(await bounded(peer.wroteApproval)).toEqual({
      id: "approval-exact",
      result: { decision: "accept" },
    });
    await bounded(run.done);
  });

  it("does not accept a late answer after cancellation", async () => {
    const peer = approvalPeer(
      "item/commandExecution/requestApproval",
      "approval-cancel",
      {
        command: "pwd",
        cwd: process.cwd(),
      },
      { command: "pwd", cwd: process.cwd() },
    );
    const abort = new AbortController();
    const run = startApprovalRun(peer, abort.signal);
    const request = await observedRequest(run);
    abort.abort();
    await bounded(run.done);
    run.reply(answer(request, ["Approve once"]));
    await Promise.resolve();
    expect(peer.writes).not.toContainEqual({
      id: "approval-cancel",
      result: { decision: "accept" },
    });
  });

  it("does not accept a late answer after the native turn completes", async () => {
    const peer = approvalPeer("item/fileChange/requestApproval", "approval-finished", {
      changes: [{ path: "smoke.txt", kind: { type: "add" }, diff: "+safe\n" }],
    });
    const run = startApprovalRun(peer);
    const request = await observedRequest(run);
    peer.push({
      method: "turn/completed",
      params: {
        threadId: "thread-approval",
        turn: { id: "turn-approval", status: "completed", items: [] },
      },
    });
    await bounded(run.done);
    run.reply(answer(request, ["Approve once"]));
    await Promise.resolve();
    expect(peer.writes).not.toContainEqual({
      id: "approval-finished",
      result: { decision: "accept" },
    });
  });

  it("does not accept a late answer after a new root turn replaces the pending turn", async () => {
    const peer = approvalPeer("item/fileChange/requestApproval", "approval-replaced", {
      changes: [{ path: "smoke.txt", kind: { type: "add" }, diff: "+safe\n" }],
    });
    const run = startApprovalRun(peer);
    const request = await observedRequest(run);
    peer.push({
      method: "turn/started",
      params: { threadId: "thread-approval", turn: { id: "turn-replacement" } },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    run.reply(answer(request, ["Approve once"]));
    peer.push({
      method: "turn/completed",
      params: {
        threadId: "thread-approval",
        turn: { id: "turn-replacement", status: "completed", items: [] },
      },
    });
    await bounded(run.done);
    expect(peer.writes).not.toContainEqual({
      id: "approval-replaced",
      result: { decision: "accept" },
    });
  });

  it("does not accept a late answer after native transport closes", async () => {
    const peer = approvalPeer("item/fileChange/requestApproval", "approval-disconnected", {
      changes: [{ path: "smoke.txt", kind: { type: "add" }, diff: "+safe\n" }],
    });
    const run = startApprovalRun(peer);
    const request = await observedRequest(run);
    peer.disconnect();
    await bounded(run.done);
    run.reply(answer(request, ["Approve once"]));
    await Promise.resolve();
    expect(peer.writes).not.toContainEqual({
      id: "approval-disconnected",
      result: { decision: "accept" },
    });
  });

  it("does not accept a late answer after matching serverRequest/resolved", async () => {
    const peer = approvalPeer("item/fileChange/requestApproval", "approval-resolved", {
      changes: [{ path: "smoke.txt", kind: { type: "add" }, diff: "+safe\n" }],
    });
    const run = startApprovalRun(peer);
    const request = await observedRequest(run);
    peer.push({
      method: "serverRequest/resolved",
      params: { requestId: "approval-resolved", threadId: "thread-approval" },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    run.reply(answer(request, ["Approve once"]));
    peer.push({
      method: "turn/completed",
      params: {
        threadId: "thread-approval",
        turn: { id: "turn-approval", status: "completed", items: [] },
      },
    });
    await bounded(run.done);
    expect(peer.writes).not.toContainEqual({
      id: "approval-resolved",
      result: { decision: "accept" },
    });
  });

  it("keeps an approval live when serverRequest/resolved belongs to another thread", async () => {
    const peer = approvalPeer("item/fileChange/requestApproval", "approval-live", {
      changes: [{ path: "smoke.txt", kind: { type: "add" }, diff: "+safe\n" }],
    });
    const run = startApprovalRun(peer);
    const request = await observedRequest(run);
    peer.push({
      method: "serverRequest/resolved",
      params: { requestId: "approval-live", threadId: "thread-foreign" },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    run.reply(answer(request, ["Approve once"]));
    expect(await bounded(peer.wroteApproval)).toEqual({
      id: "approval-live",
      result: { decision: "accept" },
    });
    await bounded(run.done);
  });
});
