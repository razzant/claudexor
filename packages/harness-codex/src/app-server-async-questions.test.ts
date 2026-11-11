/**
 * Codex async questions through the real app-server run (#628): a scripted
 * app-server peer plays the rust-v0.162.1 `request_user_input_async` item and
 * the turn/steer contract; the answer surface is a stub InteractionChannel
 * that, like the orchestrator's, settles a withdrawn request with null. The
 * daemon registry and the orchestrator channel are exercised end to end in
 * packages/cli/src/native-approval-relay.integration.test.ts.
 */
import {
  AnswerAssembly,
  InteractionChannelError,
  acceptedTryOutput,
  type InteractionChannel,
  type spawnProcess,
} from "@claudexor/core";
import {
  HarnessRunSpec,
  type HarnessEvent,
  type InteractionAnswerSet,
  type InteractionRequest,
} from "@claudexor/schema";
import { describe, expect, it } from "vitest";
import { runCodexAppServer, type CodexAppServerRunInput } from "./app-server-run.js";

type Frame = Record<string, any>;
type Question = { title: string; options?: string[] };

const QUESTION = "Who should receive the launch update?";
const SCENARIO: Question[] = [{ title: QUESTION, options: ["Internal team", "Customers"] }];
/** answered_question.rs for the pinned scenario's answer ("Customers"): message 10 of request 3
 * in all__suite__scenarios__astra_async_question_and_answer.snap (rust-v0.162.1). */
const SCENARIO_REPLY =
  "<send_user_message_question_reply>\n" +
  '[{"answer":"Customers","question":"Who should receive the launch update?","questionItemId":"[\\"request_user_input_async\\",\\"audience-question\\",0]"}]' +
  "\n</send_user_message_question_reply>";

async function bounded<T>(promise: Promise<T>, ms = 3_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("async question test timed out")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A scripted Codex app-server with one root thread whose turns the test drives. */
function codexPeer(options: { steer?: "accept" | "refuse" | "silent" } = {}) {
  const writes: Frame[] = [];
  const frames: string[] = [];
  const waiters: Array<{ match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
  const state = { turns: 0, active: null as string | null, goalActive: false };
  let wake: (() => void) | undefined;
  let stopped = false;
  let close!: () => void;
  const closed = new Promise<void>((resolve) => (close = resolve));
  const push = (frame: Frame) => {
    frames.push(JSON.stringify(frame));
    wake?.();
    wake = undefined;
  };
  const startTurn = (turnId: string) => {
    state.active = turnId;
    push({ method: "turn/started", params: { threadId: "root", turn: { id: turnId } } });
  };
  const completeTurn = (turnId: string, status = "completed") => {
    if (state.active === turnId) state.active = null;
    push({
      method: "turn/completed",
      params: { threadId: "root", turn: { id: turnId, status, items: [] } },
    });
  };
  const spawn: typeof spawnProcess = async function* (_bin, _args, spawnOptions = {}) {
    const safety = setTimeout(() => {
      stopped = true;
      close();
      wake?.();
    }, 10_000);
    spawnOptions.onSpawn?.({
      write(line) {
        const frame = JSON.parse(line) as Frame;
        writes.push(frame);
        for (const waiter of waiters.splice(0)) {
          if (waiter.match(frame)) waiter.resolve(frame);
          else waiters.push(waiter);
        }
        const method = frame["method"];
        const reply = (result: Frame) => push({ id: frame["id"], result });
        if (method === "initialize") reply({});
        if (method === "thread/start") reply({ thread: { id: "root" } });
        if (method === "turn/start") {
          state.turns += 1;
          reply({ turn: { id: `turn-${state.turns}` } });
          startTurn(`turn-${state.turns}`);
        }
        if (method === "turn/steer") {
          if (options.steer === "refuse")
            push({ id: frame["id"], error: { code: -32600, message: "steer refused" } });
          else if (options.steer !== "silent") reply({ turnId: frame["params"]["expectedTurnId"] });
        }
        if (method === "thread/read")
          reply({ thread: { status: { type: state.active ? "active" : "idle" } } });
        if (method === "thread/goal/get")
          reply({ goal: state.goalActive ? { status: "active" } : null });
        if (method === "thread/backgroundTerminals/list") reply({ data: [] });
        if (method === "turn/interrupt") {
          reply({});
          if (state.active) completeTurn(state.active, "interrupted");
        }
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
    push,
    state,
    startTurn,
    completeTurn,
    /** The item request_user_input_async emits: item/started then item/completed. */
    ask(
      turnId: string,
      itemId: string,
      questions: unknown,
      extra: { threadId?: string; item?: Frame } = {},
    ) {
      const text = Array.isArray(questions)
        ? (questions as Question[])
            .map((q) => [q.title, ...(q.options ?? []).map((option) => `- ${option}`)].join("\n"))
            .join("\n\n")
        : "";
      const item = {
        type: "agentMessage",
        id: itemId,
        text,
        phase: "final_answer",
        memoryCitation: null,
        delivery: "async",
        questions,
        ...extra.item,
      };
      const params = { threadId: extra.threadId ?? "root", turnId, item };
      push({ method: "item/started", params });
      push({ method: "item/completed", params });
    },
    /** An ordinary agent message in the recorded 0.162.1 layout. */
    say(turnId: string, id: string, text: string) {
      push({
        method: "item/completed",
        params: {
          threadId: "root",
          turnId,
          item: { type: "agentMessage", id, text, phase: null, delivery: null, questions: null },
        },
      });
    },
    /** The userMessage echo of a steered message. */
    echo(turnId: string, clientId: string, text: string) {
      for (const method of ["item/started", "item/completed"])
        push({
          method,
          params: {
            threadId: "root",
            turnId,
            item: {
              type: "userMessage",
              id: `user-${clientId}`,
              clientId,
              content: [{ type: "text", text, text_elements: [] }],
            },
          },
        });
    },
    steers: () => writes.filter((frame) => frame["method"] === "turn/steer"),
    written: (match: (frame: Frame) => boolean): Promise<Frame> => {
      const found = writes.find(match);
      return found
        ? Promise.resolve(found)
        : new Promise((resolve) => waiters.push({ match, resolve }));
    },
  };
}

interface Asked {
  request: InteractionRequest;
  signal?: AbortSignal;
  answer: (value: unknown) => void;
  fail: (error: unknown) => void;
}

/** A stub answer surface. Like the orchestrator channel it settles a withdrawn
 * request with null, unless the test plays an answer that wins that race. */
function answerSurface(
  mode: { atOnce?: unknown; throws?: unknown; ignoreWithdrawal?: boolean } = {},
) {
  const asked: Asked[] = [];
  const waiters: Array<{ index: number; resolve: (entry: Asked) => void }> = [];
  const channel: InteractionChannel = {
    request(request, signal) {
      if (mode.throws !== undefined) throw mode.throws;
      if (mode.atOnce !== undefined) return Promise.reject(mode.atOnce);
      return new Promise((resolve, reject) => {
        // Tests may hand back a malformed set on purpose: the adapter must refuse it.
        const answer = (value: unknown) => resolve(value as InteractionAnswerSet | null);
        const entry: Asked = { request, signal, answer, fail: reject };
        if (!mode.ignoreWithdrawal)
          signal?.addEventListener("abort", () => resolve(null), { once: true });
        asked.push(entry);
        for (const waiter of waiters.splice(0)) {
          if (asked[waiter.index]) waiter.resolve(asked[waiter.index]!);
          else waiters.push(waiter);
        }
      });
    },
    pendingCount: () => 0,
  };
  return {
    channel,
    asked,
    nth: (index: number): Promise<Asked> =>
      asked[index]
        ? Promise.resolve(asked[index]!)
        : new Promise((resolve) => waiters.push({ index, resolve })),
  };
}

function start(
  peer: ReturnType<typeof codexPeer>,
  channel: InteractionChannel | null,
  overrides: Partial<CodexAppServerRunInput> = {},
) {
  const spec = HarnessRunSpec.parse({
    session_id: "session-async",
    intent: "implement",
    prompt: "Draft a short launch update. Ask me who it is for and keep working while I answer.",
    cwd: process.cwd(),
    access: "workspace_write",
  });
  if (channel) spec.extra["interactionChannel"] = channel;
  const events: HarnessEvent[] = [];
  const watchers: Array<{ match: (event: HarnessEvent) => boolean; resolve: () => void }> = [];
  const done = (async () => {
    for await (const event of runCodexAppServer({
      bin: "codex",
      args: [],
      spec,
      env: {},
      spawn: peer.spawn,
      pollIntervalMs: 5,
      ...overrides,
    })) {
      events.push(event);
      for (const watcher of watchers.splice(0)) {
        if (watcher.match(event)) watcher.resolve();
        else watchers.push(watcher);
      }
    }
    return events;
  })();
  return {
    events,
    done,
    seen: (match: (event: HarnessEvent) => boolean): Promise<void> =>
      bounded(
        events.some(match)
          ? Promise.resolve()
          : new Promise<void>((resolve) => watchers.push({ match, resolve })),
      ),
  };
}

const answers = (request: InteractionRequest, rows: Array<[number, string[], string | null]>) => ({
  interaction_id: request.interaction_id,
  answers: rows.map(([index, labels, freeText]) => ({
    question_id: request.questions[index]!.id,
    selected_labels: labels,
    free_text: freeText,
  })),
});
const code = (event: HarnessEvent): unknown => event.payload?.["code"];
const receipts = (events: HarnessEvent[]) =>
  events.filter((event) => code(event) === "interaction_answer_steer");
const unavailable = (events: HarnessEvent[]) =>
  events.filter((event) => code(event) === "interaction_answer_unavailable");
const requested = (events: HarnessEvent[]) =>
  events.filter((event) => event.type === "interaction_requested");
const finals = (events: HarnessEvent[]) =>
  events.filter((event) => event.final).map((event) => event.text);
const started = (event: HarnessEvent) => event.type === "started";

describe("Codex async questions in an app-server run", () => {
  it("asks the pinned scenario's question once, keeps working, and steers the answer as the native reply", async () => {
    const peer = codexPeer();
    const surface = answerSurface();
    const run = start(peer, surface.channel);
    await run.seen(started);
    peer.ask("turn-1", "audience-question", SCENARIO);
    const asked = await bounded(surface.nth(0));
    expect(asked.request).toEqual({
      interaction_id: expect.any(String),
      source_tool: "request_user_input_async",
      delivery: "async",
      questions: [
        {
          id: '["request_user_input_async","audience-question",0]',
          question: QUESTION,
          header: null,
          options: [
            { label: "Internal team", description: null },
            { label: "Customers", description: null },
          ],
          multi_select: false,
        },
      ],
    });
    expect(asked.signal?.aborted).toBe(false);
    // The event pump keeps running while nobody has answered.
    peer.say("turn-1", "working", "I drafted a short launch update.");
    await run.seen((event) => event.text === "I drafted a short launch update.");
    expect(peer.steers()).toEqual([]);

    const id = asked.request.interaction_id;
    const messageId = `interaction-answer:${id}`;
    asked.answer(answers(asked.request, [[0, ["Customers"], null]]));
    expect(await bounded(peer.written((frame) => frame["method"] === "turn/steer"))).toEqual({
      id: expect.any(Number),
      method: "turn/steer",
      params: {
        threadId: "root",
        expectedTurnId: "turn-1",
        clientUserMessageId: messageId,
        input: [{ type: "text", text: SCENARIO_REPLY, text_elements: [] }],
      },
    });
    await run.seen((event) => receipts([event]).length > 0);
    peer.echo("turn-1", messageId, SCENARIO_REPLY);
    await run.seen((event) => code(event) === "live_input_delivered");
    peer.say("turn-1", "answered", "Here is the launch update for customers.");
    peer.completeTurn("turn-1");
    const events = await bounded(run.done);

    const carrier = events.findIndex((event) => event.payload?.["delivery"] === "async");
    expect(events[carrier]).toEqual({
      type: "message",
      session_id: "session-async",
      ts: expect.any(String),
      text: `${QUESTION}\n- Internal team\n- Customers`,
      payload: { delivery: "async", item_id: "audience-question" },
    });
    expect(requested(events).map((event) => event.interaction)).toEqual([asked.request]);
    // Native acceptance and the committed echo are separate records; neither claims compliance.
    expect(receipts(events).map((event) => event.payload)).toEqual([
      {
        code: "interaction_answer_steer",
        interaction_id: id,
        message_id: messageId,
        outcome: "accepted",
        native_turn_id: "turn-1",
      },
    ]);
    const delivered = events.filter((event) => code(event) === "live_input_delivered");
    expect(delivered.map((event) => event.payload)).toEqual([
      { code: "live_input_delivered", message_id: messageId, native_turn_id: "turn-1" },
    ]);
    expect(finals(events)).toEqual(["Here is the launch update for customers."]);
    const order = [
      carrier,
      events.indexOf(requested(events)[0]!),
      events.indexOf(receipts(events)[0]!),
      events.indexOf(delivered[0]!),
      events.findIndex((event) => event.final),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(events.at(-1)).toMatchObject({ type: "completed" });
    expect(events.at(-1)?.payload?.["harness_reported_error"]).toBeUndefined();
    expect(peer.steers()).toHaveLength(1);
    expect(peer.writes.filter((frame) => frame["method"] === "turn/start")).toHaveLength(1);
  });

  it("never lets a question become the final answer, and withdraws it when its turn ends", async () => {
    const peer = codexPeer();
    const surface = answerSurface({ ignoreWithdrawal: true });
    const run = start(peer, surface.channel);
    await run.seen(started);
    peer.say("turn-1", "draft", "Drafted the update.");
    peer.ask("turn-1", "late-question", SCENARIO);
    const asked = await bounded(surface.nth(0));
    peer.completeTurn("turn-1");
    const events = await bounded(run.done);
    expect(finals(events)).toEqual(["Drafted the update."]);
    expect(asked.signal?.aborted).toBe(true);
    // An answer that arrives after the run closed sends nothing.
    asked.answer(answers(asked.request, [[0, ["Customers"], null]]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(peer.steers()).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "completed" });
  });

  it("opens one question per native item: item/started and replays of the same id open none", async () => {
    const peer = codexPeer();
    const surface = answerSurface();
    const run = start(peer, surface.channel);
    await run.seen(started);
    peer.ask("turn-1", "dup", SCENARIO);
    peer.ask("turn-1", "dup", SCENARIO);
    peer.say("turn-1", "after", "Kept working.");
    await run.seen((event) => event.text === "Kept working.");
    expect(surface.asked).toHaveLength(1);
    peer.completeTurn("turn-1");
    const events = await bounded(run.done);
    expect(requested(events)).toHaveLength(1);
    expect(unavailable(events)).toEqual([]);
    expect(surface.asked[0]!.signal?.aborted).toBe(true);
  });

  it("answers only into the asking turn: a turn change withdraws it and a stale frame is not answerable", async () => {
    const peer = codexPeer();
    peer.state.goalActive = true;
    const surface = answerSurface({ ignoreWithdrawal: true });
    const run = start(peer, surface.channel);
    await run.seen(started);
    peer.ask("turn-1", "first", SCENARIO);
    const asked = await bounded(surface.nth(0));
    peer.completeTurn("turn-1");
    await bounded(
      new Promise<void>((resolve) =>
        asked.signal!.aborted
          ? resolve()
          : asked.signal!.addEventListener("abort", () => resolve()),
      ),
    );
    // The answer wins the withdrawal race in the channel: the adapter still sends nothing.
    asked.answer(answers(asked.request, [[0, ["Customers"], null]]));
    await run.seen((event) => receipts([event]).length > 0);
    peer.startTurn("turn-2");
    peer.ask("turn-1", "stale", SCENARIO);
    await run.seen((event) => unavailable([event]).length > 0);
    peer.state.goalActive = false;
    peer.say("turn-2", "final", "Continued without an answer.");
    peer.completeTurn("turn-2");
    const events = await bounded(run.done);
    expect(peer.steers()).toEqual([]);
    expect(surface.asked).toHaveLength(1);
    expect(receipts(events).map((event) => event.payload)).toEqual([
      {
        code: "interaction_answer_steer",
        interaction_id: asked.request.interaction_id,
        message_id: `interaction-answer:${asked.request.interaction_id}`,
        outcome: "not_sent",
        reason: "the turn that asked the question is no longer active",
      },
    ]);
    expect(unavailable(events).map((event) => event.payload)).toEqual([
      { code: "interaction_answer_unavailable", reason: "no_active_turn", item_id: "stale" },
    ]);
    expect(finals(events)).toEqual(["Continued without an answer."]);
  });

  it.each([
    [{ id: "bad", questions: [{ title: "  " }] }, "question 0 has no title", "bad"],
    [{ id: "bad", questions: [] }, "the async question item carries no question list", "bad"],
    [
      { id: "bad", questions: [{ title: "Pick", options: [1] }] },
      "question 0 has options that are not non-empty strings",
      "bad",
    ],
    [{ id: "", questions: SCENARIO }, "the async question item has no id", undefined],
  ])(
    "reports an unreadable carrier %j instead of inventing a question",
    async (item, reason, itemId) => {
      const peer = codexPeer();
      const surface = answerSurface();
      const run = start(peer, surface.channel);
      await run.seen(started);
      peer.ask("turn-1", "unused", SCENARIO, { item });
      peer.say("turn-1", "final", "Done.");
      peer.completeTurn("turn-1");
      const events = await bounded(run.done);
      expect(surface.asked).toEqual([]);
      expect(requested(events)).toEqual([]);
      expect(unavailable(events).map((event) => event.payload)).toEqual([
        {
          code: "interaction_answer_unavailable",
          reason: "unreadable_question",
          ...(itemId ? { item_id: itemId } : {}),
          error: reason,
        },
      ]);
      expect(events.some((event) => event.payload?.["delivery"] === "async")).toBe(true);
      expect(finals(events)).toEqual(["Done."]);
    },
  );

  it("records that nobody can answer in a run without an answer channel, and completes normally", async () => {
    const peer = codexPeer();
    const run = start(peer, null);
    await run.seen(started);
    peer.ask("turn-1", "audience-question", SCENARIO);
    peer.say("turn-1", "final", "Done without asking anyone.");
    peer.completeTurn("turn-1");
    const events = await bounded(run.done);
    expect(unavailable(events)).toMatchObject([
      {
        type: "status",
        text: "request_user_input_async audience-question could not be answered: this run has no answer channel",
        payload: { reason: "no_answer_channel", item_id: "audience-question" },
      },
    ]);
    expect(requested(events)).toEqual([]);
    expect(peer.steers()).toEqual([]);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(finals(events)).toEqual(["Done without asking anyone."]);
  });

  it.each([
    ["rejects at once", { atOnce: new InteractionChannelError(new Error("store is full")) }, false],
    ["throws synchronously", { throws: new Error("store is full") }, false],
    ["rejects after announcing", { late: true }, true],
  ] as const)(
    "records a failing answer surface that %s as unavailable, never a decline, and keeps the run",
    async (_label, mode, announced) => {
      const peer = codexPeer();
      const surface = answerSurface("late" in mode ? {} : mode);
      const run = start(peer, surface.channel);
      await run.seen(started);
      peer.ask("turn-1", "audience-question", SCENARIO);
      if ("late" in mode) {
        const asked = await bounded(surface.nth(0));
        await run.seen((event) => event.type === "interaction_requested");
        asked.fail(new Error("store is full"));
      }
      await run.seen((event) => unavailable([event]).length > 0);
      peer.say("turn-1", "final", "Done.");
      peer.completeTurn("turn-1");
      const events = await bounded(run.done);
      expect(unavailable(events).map((event) => event.payload)).toEqual([
        {
          code: "interaction_answer_unavailable",
          reason: "answer_channel_failed",
          interaction_id: expect.any(String),
          error: "store is full",
        },
      ]);
      // A question the surface refused at once was never registered, so it is not announced.
      expect(requested(events)).toHaveLength(announced ? 1 : 0);
      expect(peer.steers()).toEqual([]);
      expect(events.some((event) => event.type === "error")).toBe(false);
      expect(finals(events)).toEqual(["Done."]);
    },
  );

  it("never gives a sub-agent's question the root's identity", async () => {
    const peer = codexPeer();
    const surface = answerSurface();
    const run = start(peer, surface.channel);
    await run.seen(started);
    peer.ask("child-turn", "child-question", SCENARIO, { threadId: "child" });
    peer.say("turn-1", "final", "Done.");
    peer.completeTurn("turn-1");
    const events = await bounded(run.done);
    expect(surface.asked).toEqual([]);
    expect(requested(events)).toEqual([]);
    expect(unavailable(events)).toEqual([]);
    const child = events.filter((event) => event.payload?.["native_thread_id"] === "child");
    expect(child).toMatchObject([
      {
        type: "status",
        text: `${QUESTION}\n- Internal team\n- Customers`,
        payload: { code: "subagent_message", delivery: "async", subagent: true },
      },
    ]);
    expect(child[0]!.final).toBeUndefined();
    expect(finals(events)).toEqual(["Done."]);
  });

  it("keeps several questions and carriers apart and sends only what was answered, in order", async () => {
    const peer = codexPeer();
    const surface = answerSurface();
    const run = start(peer, surface.channel);
    await run.seen(started);
    peer.ask("turn-1", "batch", [
      { title: "First?" },
      { title: "Second?", options: ["Yes", "No"] },
    ]);
    peer.ask("turn-1", "single", [{ title: "Third?" }]);
    const batch = await bounded(surface.nth(0));
    const single = await bounded(surface.nth(1));
    expect(batch.request.questions.map((question) => question.id)).toEqual([
      '["request_user_input_async","batch",0]',
      '["request_user_input_async","batch",1]',
    ]);
    expect(single.request.questions.map((question) => question.id)).toEqual([
      '["request_user_input_async","single",0]',
    ]);
    const steered = (interactionId: string) =>
      bounded(
        peer.written(
          (frame) =>
            frame["method"] === "turn/steer" &&
            frame["params"]["clientUserMessageId"] === `interaction-answer:${interactionId}`,
        ),
      );
    batch.answer(answers(batch.request, [[1, ["No"], null]]));
    expect((await steered(batch.request.interaction_id))["params"]["input"]).toEqual([
      {
        type: "text",
        text:
          "<send_user_message_question_reply>\n" +
          '[{"answer":"No","question":"Second?","questionItemId":"[\\"request_user_input_async\\",\\"batch\\",1]"}]' +
          "\n</send_user_message_question_reply>",
        text_elements: [],
      },
    ]);
    const freeText = "Partners too,\nand the press.";
    single.answer(answers(single.request, [[0, [], freeText]]));
    const second = (await steered(single.request.interaction_id))["params"]["input"][0]["text"];
    const json = (second as string).slice(
      "<send_user_message_question_reply>\n".length,
      -"\n</send_user_message_question_reply>".length,
    );
    expect(JSON.parse(json)).toEqual([
      {
        answer: freeText,
        question: "Third?",
        questionItemId: '["request_user_input_async","single",0]',
      },
    ]);
    await run.seen((event) => receipts(run.events).length === 2);
    peer.completeTurn("turn-1");
    const events = await bounded(run.done);
    expect(peer.steers()).toHaveLength(2);
    expect(receipts(events).map((event) => event.payload?.["outcome"])).toEqual([
      "accepted",
      "accepted",
    ]);
  });

  it("sends nothing for silence, a decline, a malformed set or an oversized reply", async () => {
    const peer = codexPeer();
    const surface = answerSurface();
    const run = start(peer, surface.channel);
    await run.seen(started);
    for (const id of ["silent", "declined", "malformed", "oversized"])
      peer.ask("turn-1", id, SCENARIO);
    const [, declined, malformed, oversized] = await Promise.all(
      [0, 1, 2, 3].map((index) => bounded(surface.nth(index))),
    );
    declined!.answer({ interaction_id: declined!.request.interaction_id, answers: [] });
    malformed!.answer({ interaction_id: 7, answers: "Customers" });
    oversized!.answer(answers(oversized!.request, [[0, [], "a".repeat(1_048_577)]]));
    await run.seen((event) => receipts(run.events).length === 2);
    peer.completeTurn("turn-1");
    const events = await bounded(run.done);
    expect(peer.steers()).toEqual([]);
    expect(
      receipts(events).map((event) => [
        event.payload?.["interaction_id"],
        event.payload?.["reason"],
      ]),
    ).toEqual([
      [malformed!.request.interaction_id, "the answer set is not a valid interaction answer set"],
      [
        oversized!.request.interaction_id,
        expect.stringMatching(/^the reply is \d+ Unicode scalars; Codex accepts at most 1048576$/),
      ],
    ]);
    expect(receipts(events).every((event) => event.payload?.["outcome"] === "not_sent")).toBe(true);
  });

  it("records a refused steer as rejected without failing the run", async () => {
    const peer = codexPeer({ steer: "refuse" });
    const surface = answerSurface();
    const run = start(peer, surface.channel);
    await run.seen(started);
    peer.ask("turn-1", "audience-question", SCENARIO);
    const asked = await bounded(surface.nth(0));
    asked.answer(answers(asked.request, [[0, ["Customers"], null]]));
    await run.seen((event) => receipts([event]).length > 0);
    peer.say("turn-1", "final", "Done.");
    peer.completeTurn("turn-1");
    const events = await bounded(run.done);
    expect(receipts(events).map((event) => event.payload)).toMatchObject([
      { outcome: "rejected", reason: "rpc_refused" },
    ]);
    expect(events.at(-1)?.payload?.["harness_reported_error"]).toBeUndefined();
    expect(finals(events)).toEqual(["Done."]);
  });

  it("never waits at the terminal: an unanswered question is withdrawn and a send in flight stays unknown", async () => {
    const peer = codexPeer({ steer: "silent" });
    const surface = answerSurface();
    const run = start(peer, surface.channel, { steerDeadlineMs: 60_000 });
    await run.seen(started);
    peer.ask("turn-1", "answered", SCENARIO);
    peer.ask("turn-1", "unanswered", SCENARIO);
    const first = await bounded(surface.nth(0));
    const second = await bounded(surface.nth(1));
    first.answer(answers(first.request, [[0, ["Customers"], null]]));
    await bounded(peer.written((frame) => frame["method"] === "turn/steer"));
    peer.say("turn-1", "final", "Done.");
    peer.completeTurn("turn-1");
    const events = await bounded(run.done, 2_000);
    expect(second.signal?.aborted).toBe(true);
    expect(receipts(events).map((event) => event.payload)).toEqual([
      {
        code: "interaction_answer_steer",
        interaction_id: first.request.interaction_id,
        message_id: `interaction-answer:${first.request.interaction_id}`,
        outcome: "delivery_unknown",
        reason: "run_terminal",
      },
    ]);
    const receipt = events.indexOf(receipts(events)[0]!);
    expect(receipt).toBeLessThan(events.findIndex((event) => event.final));
    expect(events.at(-1)).toMatchObject({ type: "completed" });
    expect(peer.steers()).toHaveLength(1);
  });
});

describe("Codex async questions and the run's answer (#628)", () => {
  /** The run consumer's own fold: the orchestrator's attempt loop observes every
   * harness event into one AnswerAssembly and keeps acceptedTryOutput as answer.md. */
  const answerOf = (events: HarnessEvent[]) => {
    const answer = new AnswerAssembly();
    for (const event of events) answer.observe(event);
    return answer;
  };
  const carrierText = `${QUESTION}\n- Internal team\n- Customers`;

  it("leaves no answer material when the turn's only agent text was a question, which stays visible", async () => {
    const peer = codexPeer();
    const surface = answerSurface();
    const run = start(peer, surface.channel);
    await run.seen(started);
    peer.ask("turn-1", "audience-question", SCENARIO);
    await bounded(surface.nth(0));
    peer.completeTurn("turn-1");
    const events = await bounded(run.done);
    const answer = answerOf(events);
    expect(answer.hasFinal()).toBe(false);
    expect(answer.text()).toBe("");
    expect(acceptedTryOutput(answer, false)).toBe("");
    // It is still the run's evidence: the visible message and its interaction.
    expect(events.filter((event) => event.type === "message").map((event) => event.text)).toEqual([
      carrierText,
    ]);
    expect(requested(events)).toHaveLength(1);
  });

  it.each(["final", "narration"] as const)(
    "keeps only the ordinary %s as answer material beside a question",
    async (kind) => {
      const peer = codexPeer();
      const surface = answerSurface();
      const run = start(peer, surface.channel);
      await run.seen(started);
      if (kind === "final") peer.say("turn-1", "draft", "Drafted the update.");
      else
        peer.push({
          method: "turn/plan/updated",
          params: {
            threadId: "root",
            turnId: "turn-1",
            plan: [{ step: "Draft the update", status: "inProgress" }],
          },
        });
      peer.ask("turn-1", "audience-question", SCENARIO);
      await bounded(surface.nth(0));
      peer.completeTurn("turn-1");
      const events = await bounded(run.done);
      const answer = answerOf(events);
      const ordinary = kind === "final" ? "Drafted the update." : "Plan:\n[ ] Draft the update";
      expect(answer.hasFinal()).toBe(kind === "final");
      expect(answer.text()).toBe(ordinary);
      expect(acceptedTryOutput(answer, false)).toBe(ordinary);
      expect(events.some((event) => event.text === carrierText)).toBe(true);
    },
  );
});
