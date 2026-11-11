import { describe, expect, it } from "vitest";
import { InteractionRequest, type InteractionAnswerSet } from "@claudexor/schema";
import { createCodexSteer, type JsonObject } from "./app-server-protocol.js";
import {
  codexAsyncAnswer,
  codexAsyncAnswerMessageId,
  codexAsyncAnswerReceipt,
  codexAsyncQuestion,
  codexAsyncQuestionId,
  isCodexAsyncAgentMessage,
} from "./async-questions.js";

const QUESTION = "Who should receive the launch update?";

/** The item the rust-v0.162.1 handler emits for the scenario's function call
 * `audience-question` (id = call_id, prose text = title plus "- option" lines),
 * in the app-server v2 field layout of the recorded 0.156.1/0.162.1 fixtures. */
function nativeItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "agentMessage",
    id: "audience-question",
    text: `${QUESTION}\n- Internal team\n- Customers`,
    phase: "final_answer",
    memoryCitation: null,
    delivery: "async",
    questions: [{ title: QUESTION, options: ["Internal team", "Customers"] }],
    ...overrides,
  };
}

function askedRequest(item: unknown = nativeItem()): InteractionRequest {
  const result = codexAsyncQuestion(item, "interaction-1");
  if (result.kind !== "question") throw new Error(`expected a question, got ${result.kind}`);
  return result.request;
}

function answers(rows: InteractionAnswerSet["answers"]): InteractionAnswerSet {
  return { interaction_id: "interaction-1", answers: rows };
}

/** The desktop recognizer's acceptance rule (async_question_reply.rs): the whole
 * trimmed text is one envelope around a JSON array or object of replies. */
function desktopReplies(text: string): Array<Record<string, unknown>> | null {
  const trimmed = text.trim();
  const open = "<send_user_message_question_reply>";
  const close = "</send_user_message_question_reply>";
  if (!trimmed.startsWith(open) || !trimmed.endsWith(close)) return null;
  const parsed: unknown = JSON.parse(trimmed.slice(open.length, -close.length));
  return Array.isArray(parsed) ? parsed : [parsed as Record<string, unknown>];
}

describe("Codex async question carrier", () => {
  it("becomes an async interaction with the native question identity and every option", () => {
    const request = askedRequest();
    expect(InteractionRequest.parse(request)).toEqual(request);
    expect(request).toEqual({
      interaction_id: "interaction-1",
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
    // The id is the desktop's JSON.stringify([tool, item id, index]).
    expect(JSON.parse(codexAsyncQuestionId("audience-question", 0))).toEqual([
      "request_user_input_async",
      "audience-question",
      0,
    ]);
  });

  it("keeps several questions, a free-text-only question and long text byte-exact", () => {
    const long = `Context line one\nline two ${"ü".repeat(600)}`;
    const request = askedRequest(
      nativeItem({ questions: [{ title: long }, { title: "Pick", options: ["A, B", "C"] }] }),
    );
    expect(request.questions.map((question) => question.id)).toEqual([
      codexAsyncQuestionId("audience-question", 0),
      codexAsyncQuestionId("audience-question", 1),
    ]);
    expect(request.questions[0]!.question).toBe(long);
    expect(request.questions[0]!.options).toEqual([]);
    expect(request.questions[1]!.options.map((option) => option.label)).toEqual(["A, B", "C"]);
  });

  it("recognizes the normalized agent_message spelling as the same carrier", () => {
    expect(askedRequest(nativeItem({ type: "agent_message" })).delivery).toBe("async");
  });

  it("leaves ordinary agent messages and other items alone", () => {
    for (const item of [
      nativeItem({ delivery: null, questions: null }),
      nativeItem({ delivery: null }),
      { type: "userMessage", id: "u", delivery: "async", questions: [{ title: "x" }] },
      null,
      "text",
      [],
    ]) {
      expect(codexAsyncQuestion(item, "i")).toEqual({ kind: "none" });
    }
    expect(isCodexAsyncAgentMessage(nativeItem({ delivery: null, questions: null }))).toBe(false);
  });

  it("marks every async-delivered agent message as not the turn's answer", () => {
    expect(isCodexAsyncAgentMessage(nativeItem())).toBe(true);
    // A future async note without questions is still not the final answer.
    expect(isCodexAsyncAgentMessage(nativeItem({ questions: null }))).toBe(true);
    expect(codexAsyncQuestion(nativeItem({ questions: null }), "i")).toEqual({ kind: "none" });
  });

  it("reports a carrier it cannot read instead of inventing or dropping a question", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [nativeItem({ id: "" }), "the async question item has no id"],
      [nativeItem({ questions: [] }), "the async question item carries no question list"],
      [nativeItem({ questions: {} }), "the async question item carries no question list"],
      [nativeItem({ questions: [{ title: "  " }] }), "question 0 has no title"],
      [
        nativeItem({ questions: [{ title: "ok" }, { title: "Pick", options: [""] }] }),
        "question 1 has options that are not non-empty strings",
      ],
      [
        nativeItem({ questions: [{ title: "Pick", options: [{ label: "A" }] }] }),
        "question 0 has options that are not non-empty strings",
      ],
    ];
    for (const [item, reason] of cases) {
      const result = codexAsyncQuestion(item, "i");
      expect(result).toMatchObject({ kind: "unrecognized", reason });
    }
  });
});

describe("Codex async answer envelope", () => {
  it("renders the answered_question.rs reply for the pinned scenario answer", () => {
    const request = askedRequest();
    const reply = codexAsyncAnswer(
      request,
      answers([
        {
          question_id: request.questions[0]!.id,
          selected_labels: ["Customers"],
          free_text: null,
        },
      ]),
    );
    expect(reply).toEqual({
      kind: "steer",
      text:
        "<send_user_message_question_reply>\n" +
        '[{"answer":"Customers","question":"Who should receive the launch update?","questionItemId":"[\\"request_user_input_async\\",\\"audience-question\\",0]"}]' +
        "\n</send_user_message_question_reply>",
      questionIds: [request.questions[0]!.id],
    });
    expect(desktopReplies((reply as { text: string }).text)).toEqual([
      {
        answer: "Customers",
        question: QUESTION,
        questionItemId: '["request_user_input_async","audience-question",0]',
      },
    ]);
  });

  it("batches answered questions in question order and omits unanswered ones", () => {
    const request = askedRequest(
      nativeItem({
        questions: [
          { title: "First?" },
          { title: "Second?", options: ["Yes"] },
          { title: "Third?" },
        ],
      }),
    );
    const [first, second, third] = request.questions.map((question) => question.id);
    const reply = codexAsyncAnswer(
      request,
      answers([
        { question_id: third!, selected_labels: [], free_text: "later" },
        { question_id: first!, selected_labels: ["Yes", "No"], free_text: null },
      ]),
    );
    expect(reply.kind).toBe("steer");
    expect(desktopReplies((reply as { text: string }).text)).toEqual([
      { answer: "Yes, No", question: "First?", questionItemId: first },
      { answer: "later", question: "Third?", questionItemId: third },
    ]);
    expect((reply as { questionIds: string[] }).questionIds).toEqual([first, third]);
    expect(second).toBeDefined();
  });

  it("lets free text win over a selected label, as every adapter does", () => {
    const request = askedRequest();
    const reply = codexAsyncAnswer(
      request,
      answers([
        {
          question_id: request.questions[0]!.id,
          selected_labels: ["Customers"],
          free_text: "Customers and partners",
        },
      ]),
    );
    expect(desktopReplies((reply as { text: string }).text)?.[0]?.["answer"]).toBe(
      "Customers and partners",
    );
  });

  it("sends nothing for a decline, a missing set or a set that answers nothing", () => {
    const request = askedRequest();
    expect(codexAsyncAnswer(request, null)).toEqual({ kind: "none" });
    expect(codexAsyncAnswer(request, answers([]))).toEqual({ kind: "none" });
  });

  it("refuses a set the request cannot accept instead of guessing", () => {
    const request = askedRequest();
    expect(
      codexAsyncAnswer(
        request,
        answers([{ question_id: "unknown", selected_labels: ["A"], free_text: null }]),
      ),
    ).toEqual({
      kind: "refused",
      reason: "question 'unknown' is not part of this interaction",
    });
    expect(
      codexAsyncAnswer(request, {
        interaction_id: "other",
        answers: [
          { question_id: request.questions[0]!.id, selected_labels: ["A"], free_text: null },
        ],
      }).kind,
    ).toBe("refused");
  });

  it("frames a long or multi-line question like answered_question.rs; the interaction keeps it whole", () => {
    const title = `Line one\r\nline two ${"€".repeat(200)}`;
    const request = askedRequest(nativeItem({ questions: [{ title }] }));
    const reply = codexAsyncAnswer(
      request,
      answers([{ question_id: request.questions[0]!.id, selected_labels: [], free_text: "ok" }]),
    );
    const framed = desktopReplies((reply as { text: string }).text)![0]!["question"] as string;
    expect(Buffer.byteLength(framed)).toBeLessThanOrEqual(512);
    expect(framed.startsWith("Line one  line two €")).toBe(true);
    expect(framed).not.toMatch(/[\r\n]/);
    // Truncation lands on a character boundary: no replacement character appears.
    expect(framed).not.toContain("�");
    expect(title.startsWith(framed.replace("one  line", "one\r\nline"))).toBe(true);
    expect(request.questions[0]!.question).toBe(title);
  });

  it("falls back to the plain reply when a question identity exceeds the native bound", () => {
    const request = askedRequest(nativeItem({ id: "x".repeat(600) }));
    const reply = codexAsyncAnswer(
      request,
      answers([
        { question_id: request.questions[0]!.id, selected_labels: ["Customers"], free_text: null },
      ]),
    );
    expect(reply).toEqual({
      kind: "steer",
      text: `> ${QUESTION}\n\nCustomers`,
      questionIds: [request.questions[0]!.id],
    });
  });

  it("refuses a reply larger than the Codex input limit instead of sending a truncated one", () => {
    const request = askedRequest();
    const reply = codexAsyncAnswer(
      request,
      answers([
        {
          question_id: request.questions[0]!.id,
          selected_labels: [],
          free_text: "a".repeat(1_048_576),
        },
      ]),
    );
    expect(reply.kind).toBe("refused");
    expect((reply as { reason: string }).reason).toMatch(/at most 1048576$/);
  });

  it("replaces a lone surrogate so the envelope stays valid JSON for serde_json", () => {
    const request = askedRequest();
    const reply = codexAsyncAnswer(
      request,
      answers([
        { question_id: request.questions[0]!.id, selected_labels: [], free_text: "a\uD800b" },
      ]),
    );
    expect(desktopReplies((reply as { text: string }).text)?.[0]?.["answer"]).toBe("a�b");
  });
});

describe("an async answer steered into the active turn", () => {
  function steerHarness(reply: "accepted" | "refused") {
    const sent: Array<{ method: string; params: JsonObject }> = [];
    const steer = createCodexSteer({
      sessionId: "session-1",
      threadId: () => "thread-1",
      activeTurnId: () => "turn-1",
      live: () => true,
      send: async (method, params) => {
        sent.push({ method, params });
        return reply === "accepted"
          ? { kind: "result", result: { turnId: "turn-1" } }
          : { kind: "rpc_error", code: -32600, message: "refused" };
      },
      responseDeadlineMs: 5_000,
    });
    return { steer, sent };
  }

  it("travels as one turn/steer whose input is the envelope, correlated by its echo", async () => {
    const request = askedRequest();
    const reply = codexAsyncAnswer(
      request,
      answers([
        { question_id: request.questions[0]!.id, selected_labels: ["Customers"], free_text: null },
      ]),
    );
    if (reply.kind !== "steer") throw new Error("expected a steer");
    const messageId = codexAsyncAnswerMessageId(request.interaction_id);
    const { steer, sent } = steerHarness("accepted");
    const result = await steer.send({ messageId, text: reply.text });
    expect(result).toEqual({ outcome: "accepted", nativeTurnId: "turn-1" });
    expect(sent).toEqual([
      {
        method: "turn/steer",
        params: {
          threadId: "thread-1",
          expectedTurnId: "turn-1",
          clientUserMessageId: "interaction-answer:interaction-1",
          input: [{ type: "text", text: reply.text, text_elements: [] }],
        },
      },
    ]);
    // Acceptance is not consumption: the userMessage echo carrying the client id is.
    const echo = {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "userMessage",
          id: "user-2",
          clientId: messageId,
          content: [{ type: "text", text: reply.text, text_elements: [] }],
        },
      },
    };
    steer.observeEcho(echo);
    expect(steer.deliveredEvents(echo)).toMatchObject([
      { type: "status", payload: { code: "live_input_delivered", message_id: messageId } },
    ]);
  });

  it("records each native outcome as a distinct receipt, never as compliance", async () => {
    const { steer } = steerHarness("refused");
    const result = await steer.send({ messageId: "interaction-answer:i", text: "x" });
    const refused = codexAsyncAnswerReceipt({
      sessionId: "session-1",
      interactionId: "i",
      messageId: "interaction-answer:i",
      result,
    });
    expect(refused).toMatchObject({
      type: "status",
      session_id: "session-1",
      payload: {
        code: "interaction_answer_steer",
        interaction_id: "i",
        message_id: "interaction-answer:i",
        outcome: "rejected",
        reason: "rpc_refused",
      },
    });
    expect(refused.text).toBe(
      "answer to async question i as the agent's next message: rejected (rpc_refused)",
    );
    const accepted = codexAsyncAnswerReceipt({
      sessionId: "session-1",
      interactionId: "i",
      messageId: "interaction-answer:i",
      result: { outcome: "accepted", nativeTurnId: "turn-1" },
    });
    expect(accepted.payload).toEqual({
      code: "interaction_answer_steer",
      interaction_id: "i",
      message_id: "interaction-answer:i",
      outcome: "accepted",
      native_turn_id: "turn-1",
    });
    const notSent = codexAsyncAnswerReceipt({
      sessionId: "session-1",
      interactionId: "i",
      messageId: "interaction-answer:i",
      result: { outcome: "not_sent", reason: "the reply exceeds the input limit" },
    });
    expect(notSent.text).toBe(
      "answer to async question i as the agent's next message: not sent: the reply exceeds the input limit",
    );
    expect(notSent.payload).toMatchObject({ outcome: "not_sent" });
  });
});
