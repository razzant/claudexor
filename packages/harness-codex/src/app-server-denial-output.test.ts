import type { InteractionChannel, spawnProcess } from "@claudexor/core";
import { AnswerAssembly, acceptedTryOutput } from "@claudexor/core";
import {
  HarnessRunSpec,
  type HarnessEvent,
  type InteractionAnswerSet,
  type InteractionRequest,
} from "@claudexor/schema";
import { describe, expect, it, vi } from "vitest";
import { runCodexAppServer } from "./app-server-run.js";

type Frame = Record<string, unknown>;
type Turn = {
  text: string;
  denial?: Frame | null;
  status?: "completed" | "failed";
  /** The thread reports systemError after this turn completed. */
  systemErrorAfter?: boolean;
};

const COMMAND = { type: "command", source: "shell", command: "node --test", cwd: process.cwd() };
const ENVELOPE = JSON.stringify({
  work_report: { state: "completed", required_inputs: [] },
  output: { rows: [1, 2, 3] },
});

/** A scripted app-server root thread: each turn/start plays the next turn. */
function peer(turns: Turn[], options: { authorizationFails?: boolean } = {}) {
  const writes: Frame[] = [];
  let lifecycleError = false;
  const frames: string[] = [];
  let wake: (() => void) | undefined;
  let stopped = false;
  let started = 0;
  let close!: () => void;
  const closed = new Promise<void>((resolve) => (close = resolve));
  const push = (frame: Frame) => {
    frames.push(JSON.stringify(frame));
    wake?.();
    wake = undefined;
  };
  const playTurn = (rpcId: unknown) => {
    const turn = turns[started] ?? { text: "unexpected extra turn" };
    started += 1;
    const turnId = `turn-${started}`;
    push({ method: "turn/started", params: { threadId: "root", turn: { id: turnId } } });
    push({ id: rpcId, result: { turn: { id: turnId } } });
    if (turn.denial)
      push({
        method: "item/autoApprovalReview/completed",
        params: {
          threadId: "root",
          turnId,
          reviewId: `review-${started}`,
          targetItemId: "item-command",
          action: COMMAND,
          review: { status: "denied", rationale: "Needs permission" },
          startedAtMs: 100,
          completedAtMs: 200,
          decisionSource: "agent",
          ...turn.denial,
        },
      });
    push({
      method: "item/completed",
      params: {
        threadId: "root",
        turnId,
        item: { id: `msg-${started}`, type: "agentMessage", text: turn.text },
      },
    });
    push({
      method: "turn/completed",
      params: {
        threadId: "root",
        turn: {
          id: turnId,
          status: turn.status ?? "completed",
          items: [],
          ...(turn.status === "failed" ? { error: { message: "retry turn failed" } } : {}),
        },
      },
    });
    if (turn.systemErrorAfter)
      push({
        method: "thread/status/changed",
        params: { threadId: "root", status: { type: "systemError" } },
      });
  };
  const spawn: typeof spawnProcess = async function* (_bin, _args, opts = {}) {
    const safety = setTimeout(() => {
      stopped = true;
      close();
      wake?.();
    }, 3_000);
    opts.onSpawn?.({
      write(line) {
        const frame = JSON.parse(line) as Frame;
        writes.push(frame);
        const method = frame["method"];
        if (method === "initialize") push({ id: frame["id"], result: {} });
        if (method === "thread/start")
          push({ id: frame["id"], result: { thread: { id: "root" } } });
        if (method === "turn/start") playTurn(frame["id"]);
        if (method === "thread/approveGuardianDeniedAction")
          push(
            options.authorizationFails
              ? { id: frame["id"], error: { code: -32603, message: "authorization unavailable" } }
              : { id: frame["id"], result: {} },
          );
        if (method === "thread/read")
          push({
            id: frame["id"],
            result: { thread: { status: { type: lifecycleError ? "systemError" : "idle" } } },
          });
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
  return {
    spawn,
    writes,
    turnStarts: () => started,
    failRoot: () =>
      push({
        method: "thread/status/changed",
        params: { threadId: "root", status: { type: "systemError" } },
      }),
    failLifecycle: () => {
      lifecycleError = true;
    },
  };
}

function start(
  scripted: ReturnType<typeof peer>,
  options: {
    channel?: boolean;
    outputSchema?: boolean;
    abort?: AbortController;
    reply?: (request: InteractionRequest) => InteractionAnswerSet | null | "wait";
  } = {},
) {
  const asked: InteractionRequest[] = [];
  const signals: AbortSignal[] = [];
  const asking: Array<() => void> = [];
  const channel: InteractionChannel = {
    request(request, signal) {
      asked.push(request);
      if (signal) signals.push(signal);
      asking.splice(0).forEach((notify) => notify());
      const answer = options.reply?.(request) ?? null;
      return answer === "wait" ? new Promise(() => {}) : Promise.resolve(answer);
    },
  };
  const spec = HarnessRunSpec.parse({
    session_id: "denial-output",
    intent: "implement",
    prompt: "Make a safe change",
    cwd: process.cwd(),
    access: "workspace_write",
    ...(options.outputSchema ? { output_schema: { type: "object" } } : {}),
  });
  if (options.channel !== false) spec.extra["interactionChannel"] = channel;
  if (options.abort) spec.extra["abortSignal"] = options.abort.signal;
  const events: HarnessEvent[] = [];
  const done = (async () => {
    for await (const event of runCodexAppServer({
      bin: "codex",
      args: [],
      spec,
      env: {},
      spawn: scripted.spawn,
      pollIntervalMs: 5,
    }))
      events.push(event);
    return events;
  })();
  const firstAsk = new Promise<void>((resolve) =>
    asked.length ? resolve() : asking.push(resolve),
  );
  return { done, asked, events, firstAsk, signals };
}

const choose = (request: InteractionRequest, label: string): InteractionAnswerSet => ({
  interaction_id: request.interaction_id,
  answers: [{ question_id: "approval", selected_labels: [label], free_text: null }],
});

/** What the orchestrator would keep as this attempt's answer bytes. */
function keptOutput(events: HarnessEvent[]): string {
  const answer = new AnswerAssembly();
  for (const event of events) answer.observe(event);
  return acceptedTryOutput(
    answer,
    events.some((event) => event.type === "error"),
  );
}

const finals = (events: HarnessEvent[]) =>
  events.filter((event) => event.type === "message" && event.final === true);
const notOffered = (events: HarnessEvent[]) =>
  events.filter((event) => event.payload?.["code"] === "codex_auto_review_not_offered");

describe("completed Codex output survives native-denial handback", () => {
  it.each([
    ["ordinary text", false, "Blocked by policy; reported the denial"],
    ["structured envelope", true, ENVELOPE],
  ])(
    "keeps the %s and the success when the controller declines",
    async (_label, outputSchema, text) => {
      const scripted = peer([{ text, denial: {} }]);
      const run = start(scripted, {
        outputSchema,
        reply: (request) => choose(request, "Decline"),
      });
      const events = await run.done;
      expect(run.asked).toHaveLength(1);
      expect(scripted.turnStarts()).toBe(1);
      expect(events.some((event) => event.type === "error")).toBe(false);
      expect(keptOutput(events)).toBe(text);
      expect(events.at(-1)).toMatchObject({ type: "completed" });
      expect(events.at(-1)?.payload?.["harness_reported_error"]).not.toBe(true);
    },
  );

  it.each([
    ["ordinary text", false, "Could not apply the patch outside the workspace"],
    ["structured envelope", true, ENVELOPE],
  ])(
    "keeps the %s when a denial cannot be offered, disclosing that the native denial stands",
    async (_label, outputSchema, text) => {
      const scripted = peer([
        { text, denial: { action: { type: "applyPatch", cwd: process.cwd(), files: ["x"] } } },
      ]);
      const run = start(scripted, { outputSchema });
      const events = await run.done;
      expect(run.asked).toEqual([]);
      expect(notOffered(events)).toHaveLength(1);
      expect(events.some((event) => event.type === "error")).toBe(false);
      expect(keptOutput(events)).toBe(text);
      expect(
        scripted.writes.some((frame) => frame["method"] === "thread/approveGuardianDeniedAction"),
      ).toBe(false);
    },
  );

  it("keeps an unattended run's answer when no controller channel exists", async () => {
    const scripted = peer([{ text: "Finished without the denied command", denial: {} }]);
    const run = start(scripted, { channel: false });
    const events = await run.done;
    expect(notOffered(events)).toHaveLength(1);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(keptOutput(events)).toBe("Finished without the denied command");
  });

  it.each([
    ["ordinary text", false, "Blocked by policy"],
    ["structured envelope", true, ENVELOPE],
  ])(
    "fails honestly but keeps the %s when the native authorization RPC fails",
    async (_label, outputSchema, text) => {
      const scripted = peer([{ text, denial: {} }], { authorizationFails: true });
      const run = start(scripted, {
        outputSchema,
        reply: (request) => choose(request, "Authorize one retry"),
      });
      const events = await run.done;
      expect(scripted.turnStarts()).toBe(1);
      expect(events.some((event) => event.type === "error")).toBe(true);
      expect(finals(events)).toHaveLength(1);
      expect(keptOutput(events)).toBe(text);
      expect(events.at(-1)?.payload?.["native_authorization_requests"]).toEqual([
        { review_id: "review-1", state: "submitted" },
      ]);
    },
  );

  it("keeps the retry turn's report and does not ask again when native review denies the authorized action again", async () => {
    const scripted = peer([
      { text: "Blocked by policy", denial: {} },
      { text: "Native review refused the retry again; tests not run", denial: {} },
    ]);
    const run = start(scripted, { reply: (request) => choose(request, "Authorize one retry") });
    const events = await run.done;
    expect(run.asked).toHaveLength(1);
    expect(scripted.turnStarts()).toBe(2);
    expect(
      scripted.writes.filter((frame) => frame["method"] === "thread/approveGuardianDeniedAction"),
    ).toHaveLength(1);
    expect(notOffered(events)).toEqual([
      expect.objectContaining({ text: expect.stringMatching(/already authorized retry again/) }),
    ]);
    expect(finals(events).map((event) => event.text)).toEqual([
      "Blocked by policy",
      "Native review refused the retry again; tests not run",
    ]);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(keptOutput(events)).toBe("Native review refused the retry again; tests not run");
  });

  it("keeps the completed answer when the authorized retry turn itself fails", async () => {
    const scripted = peer([
      { text: "Blocked by policy", denial: {} },
      { text: "partial retry narration", status: "failed" },
    ]);
    const run = start(scripted, { reply: (request) => choose(request, "Authorize one retry") });
    const events = await run.done;
    expect(scripted.turnStarts()).toBe(2);
    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(finals(events).map((event) => event.text)).toEqual(["Blocked by policy"]);
    expect(keptOutput(events)).toBe("Blocked by policy");
  });

  it.each([
    ["a healthy thread still offers", false],
    ["a systemError thread never offers", true],
  ])("%s the denial for one authorized retry", async (_label, systemErrorAfter) => {
    const scripted = peer([
      { text: "Blocked by policy", denial: {}, systemErrorAfter },
      { text: "Retried and verified" },
    ]);
    const run = start(scripted, { reply: (request) => choose(request, "Authorize one retry") });
    const events = await run.done;
    const authorizations = scripted.writes.filter(
      (frame) => frame["method"] === "thread/approveGuardianDeniedAction",
    );
    if (!systemErrorAfter) {
      expect(run.asked).toHaveLength(1);
      expect(authorizations).toHaveLength(1);
      expect(scripted.turnStarts()).toBe(2);
      expect(events.some((event) => event.type === "error")).toBe(false);
      return;
    }
    // No question, no native authorization RPC and no extra paid turn; the
    // failed thread stays a failure instead of becoming a handed-back success.
    expect(run.asked).toEqual([]);
    expect(authorizations).toEqual([]);
    expect(scripted.turnStarts()).toBe(1);
    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "completed" });
    expect(events.at(-1)?.payload?.["harness_reported_error"]).toBe(true);
  });

  it("withdraws pending authorization when the root fails during controller deliberation", async () => {
    const scripted = peer([{ text: "Completed report before failure", denial: {} }]);
    const run = start(scripted, { reply: () => "wait" });
    await run.firstAsk;
    scripted.failRoot();
    await vi.waitFor(() => expect(run.signals[0]?.aborted).toBe(true));
    const events = await run.done;
    expect(scripted.turnStarts()).toBe(1);
    expect(
      scripted.writes.some((frame) => frame["method"] === "thread/approveGuardianDeniedAction"),
    ).toBe(false);
    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(finals(events).map((event) => event.text)).toEqual(["Completed report before failure"]);
  });

  it("refuses authorization when refreshed lifecycle reveals a failed root", async () => {
    const scripted = peer([{ text: "Report before lifecycle failure", denial: {} }]);
    const run = start(scripted, {
      reply: (request) => {
        scripted.failLifecycle();
        return choose(request, "Authorize one retry");
      },
    });
    const events = await run.done;
    expect(scripted.turnStarts()).toBe(1);
    expect(
      scripted.writes.some((frame) => frame["method"] === "thread/approveGuardianDeniedAction"),
    ).toBe(false);
    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(keptOutput(events)).toBe("Report before lifecycle failure");
  });

  it("keeps the completed answer when Stop arrives while authorization is pending", async () => {
    const scripted = peer([{ text: "Done except the denied check", denial: {} }]);
    const abort = new AbortController();
    const run = start(scripted, { abort, reply: () => "wait" });
    await run.firstAsk;
    abort.abort();
    const events = await run.done;
    expect(scripted.turnStarts()).toBe(1);
    expect(
      scripted.writes.some((frame) => frame["method"] === "thread/approveGuardianDeniedAction"),
    ).toBe(false);
    expect(finals(events).map((event) => event.text)).toEqual(["Done except the denied check"]);
    expect(events.at(-1)?.aborted).toBe(true);
  });
});
