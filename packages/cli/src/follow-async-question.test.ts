/**
 * `claudexor follow` with a Codex async question (#628), through the real
 * producer chain: the Codex async-question translation -> the orchestrator's
 * interaction channel -> the daemon InteractionRegistry. Only the store, the
 * HTTP/SSE transport and the TTY reader are replaced.
 *
 * An async question is attention while the agent keeps working: it never
 * suspends the watchdog, a blocking question is asked before its open prompt,
 * its answer becomes the native reply envelope, and the run's terminal ends
 * follow even while an async question is still unanswered.
 */
import { afterEach, expect, it, vi } from "vitest";
import type { InteractionRequest } from "@claudexor/schema";
import { codexAsyncAnswer, codexAsyncQuestion } from "../../harness-codex/src/async-questions.js";
import { interactionChannelFor } from "../../orchestrator/src/interaction.js";
import { InteractionRegistry, pendingInteraction } from "../../daemon/src/interactions.js";
import type { InteractionStorePort } from "../../daemon/src/store-contracts.js";
import { followRun } from "./live.js";

vi.mock("./control-api-address.js", () => ({
  controlApiAddress: () => ({ baseUrl: "http://fixture", token: "fixture" }),
}));
const tty = vi.hoisted(() => ({ prompts: [] as Array<{ text: string; signal: AbortSignal }> }));
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question(prompt: string, options: { signal: AbortSignal }) {
      tty.prompts.push({ text: prompt, signal: options.signal });
      return new Promise<string>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    },
    close() {},
  }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function memoryStore(): InteractionStorePort {
  const rows = new Map<string, ReturnType<typeof pendingInteraction>>();
  const resolved = new Set<string>();
  return {
    request(ctx) {
      const row = pendingInteraction(ctx);
      rows.set(row.interactionId, row);
      return row;
    },
    resolve(_run, id) {
      if (resolved.has(id)) return "already_resolved";
      if (!rows.has(id)) return "not_found";
      rows.delete(id);
      resolved.add(id);
      return "resolved";
    },
    resolveRun() {
      const ids = [...rows.keys()];
      rows.clear();
      return ids;
    },
    status(_run, id) {
      return rows.has(id) ? "pending" : resolved.has(id) ? "resolved" : "missing";
    },
    pendingForRun() {
      return [...rows.values()];
    },
  };
}

/** The item Codex rust-v0.162.1 emits for one request_user_input_async call. */
function asyncItem(callId: string, title: string) {
  return {
    type: "agentMessage",
    id: callId,
    text: title,
    phase: "final_answer",
    memoryCitation: null,
    delivery: "async",
    questions: [{ title, options: ["Internal team", "Customers"] }],
  };
}

function asyncRequest(callId: string, title: string): InteractionRequest {
  const translated = codexAsyncQuestion(asyncItem(callId, title), `async-${callId}`);
  if (translated.kind !== "question") throw new Error("expected an async question");
  return translated.request;
}

it("keeps an async question as attention while work continues, asks a blocking one first, and never stalls the terminal", async () => {
  const oldTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  tty.prompts.length = 0;
  const written: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as never);
  const store = memoryStore();
  const registry = new InteractionRegistry({ forRequest: () => store, forRun: () => store });
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller;
    },
  });
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const log = {
    emit(type: string, payload: Record<string, unknown>) {
      const event = { seq: events.length + 1, type, payload };
      events.push(event);
      stream.enqueue(
        new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`),
      );
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/handshake")) return Response.json({ compatible: true, protocolMajor: 3 });
      if (url.endsWith("/events")) return new Response(body);
      if (url.endsWith("/runs/run"))
        return Response.json({
          summary: { state: "running" },
          pendingInteractions: registry.pendingForRun("run"),
        });
      throw new Error(`unexpected URL ${url}`);
    }),
  );
  const channel = interactionChannelFor(
    { onInteraction: (ctx) => registry.register(ctx, {}), interactionTimeoutMs: null },
    log as never,
    "run",
    "task",
    "a01",
    "codex",
    true,
  )!;
  const following = followRun("run", false);
  try {
    // The adapter never awaits an async request in its event pump.
    const audience = asyncRequest("audience-question", "Who should receive the launch update?");
    const asked = channel.request(audience);
    await vi.waitFor(() => expect(tty.prompts).toHaveLength(1));
    expect(channel.pendingCount!()).toBe(0);
    expect(registry.pendingForRun("run").map((row) => row.delivery)).toEqual(["async"]);

    // A blocking question goes ahead of the open async prompt.
    const blocking = channel.request({
      interaction_id: "approval-1",
      source_tool: "item/fileChange/requestApproval",
      delivery: "blocking",
      questions: [
        {
          id: "approval",
          header: "Codex approval",
          question: "Approve this single native action?",
          options: [
            { label: "Approve once", description: null },
            { label: "Decline", description: null },
          ],
          multi_select: false,
        },
      ],
    });
    expect(channel.pendingCount!()).toBe(1);
    await vi.waitFor(() => expect(tty.prompts).toHaveLength(2));
    expect(tty.prompts[0]!.signal.aborted).toBe(true);
    expect(tty.prompts[1]!.signal.aborted).toBe(false);
    expect(
      registry.answer("run", "approval-1", {
        interaction_id: "approval-1",
        answers: [{ question_id: "approval", selected_labels: ["Decline"], free_text: null }],
      }).status,
    ).toBe("delivered");
    await expect(blocking).resolves.toMatchObject({ interaction_id: "approval-1" });
    expect(channel.pendingCount!()).toBe(0);
    // The set-aside async question is asked again, still unanswered.
    await vi.waitFor(() => expect(tty.prompts).toHaveLength(3));
    expect(tty.prompts[2]!.signal.aborted).toBe(false);

    // Its answer reaches the adapter, which turns it into the native reply.
    const questionId = audience.questions[0]!.id;
    expect(
      registry.answer("run", audience.interaction_id, {
        interaction_id: audience.interaction_id,
        answers: [{ question_id: questionId, selected_labels: ["Customers"], free_text: null }],
      }).status,
    ).toBe("delivered");
    const answers = await asked;
    expect(codexAsyncAnswer(audience, answers)).toEqual({
      kind: "steer",
      text:
        "<send_user_message_question_reply>\n" +
        JSON.stringify([
          {
            answer: "Customers",
            question: "Who should receive the launch update?",
            questionItemId: '["request_user_input_async","audience-question",0]',
          },
        ]) +
        "\n</send_user_message_question_reply>",
      questionIds: [questionId],
    });
    await vi.waitFor(() => expect(tty.prompts[2]!.signal.aborted).toBe(true));

    // A second async question stays unanswered; the terminal still ends follow.
    const later = channel.request(asyncRequest("later-question", "Any other audience?"));
    await vi.waitFor(() => expect(tty.prompts).toHaveLength(4));
    registry.dropForRun("run");
    await expect(later).resolves.toBeNull();
    log.emit("run.completed", { lifecycle: "succeeded" });
    stream.enqueue(new TextEncoder().encode("event: end\ndata: {}\n\n"));
    stream.close();
    await expect(following).resolves.toBe(0);
    expect(tty.prompts[3]!.signal.aborted).toBe(true);

    const text = written.join("");
    expect(text).toContain(
      "QUESTION pending (interaction async-audience-question) — the agent keeps working",
    );
    expect(text).toContain("answer handed to the running agent (sent as its next message)");
    expect(text).toContain("the agent keeps working; this question does not pause it");
    expect(
      events
        .filter((event) => event.type === "interaction.requested")
        .map((event) => [event.payload["interaction_id"], event.payload["delivery"]]),
    ).toEqual([
      ["async-audience-question", "async"],
      ["approval-1", "blocking"],
      ["async-later-question", "async"],
    ]);
  } finally {
    write.mockRestore();
    if (oldTty) Object.defineProperty(process.stdin, "isTTY", oldTty);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  }
}, 30_000);
