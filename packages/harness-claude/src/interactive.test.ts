import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { ChildStdin } from "@claudexor/core";
import type { HarnessEvent, InteractionRequest } from "@claudexor/schema";
import {
  DECLINE_MESSAGE,
  allowResponseFrame,
  denyResponseFrame,
  handleControlRequestFrame,
  initialSessionFrames,
  initialUserMessageFrame,
  interactionRequestFromNative,
  isControlRequestFrame,
  isResultFrame,
  userMessageFrame,
} from "./interactive.js";

function fakeIo(): { io: ChildStdin; written: string[]; ended: boolean; close(): void } {
  const state = { written: [] as string[], ended: false };
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  return {
    io: {
      write: (data: string) => state.written.push(data),
      end: () => {
        state.ended = true;
      },
      closed,
    },
    written: state.written,
    get ended() {
      return state.ended;
    },
    close: resolveClosed,
  };
}

const NATIVE_ASK = {
  type: "control_request",
  request_id: "req-1",
  request: {
    subtype: "can_use_tool",
    tool_name: "AskUserQuestion",
    input: {
      questions: [
        {
          question: "How should I format the output?",
          header: "Format",
          options: [
            { label: "Summary", description: "Brief overview" },
            { label: "Detailed", description: "Full explanation" },
          ],
          multiSelect: false,
        },
      ],
    },
  },
};

/** Native AskUserQuestion input longer than every former display bound
 * (question 2000, header 100, label 500, description 1000 characters). */
function longNativeAsk() {
  const question = `Which rollout keeps the 🚀 release safe? ${"Подробности ".repeat(260)}END`;
  return {
    questions: [
      {
        question,
        header: `Rollout ${"h".repeat(150)}`,
        options: [
          { label: `Canary ${"a".repeat(700)}`, description: `First ${"d".repeat(1300)}` },
          { label: `Blue-green ${"b".repeat(700)}`, description: `Second ${"e".repeat(1300)}` },
        ],
        multiSelect: false,
      },
      { question: `Anything else? ${"x".repeat(2100)}`, options: [], multiSelect: false },
    ],
  };
}

const MULTILINE_FREE_TEXT = "\n  indented first line\nsecond line with trailing spaces  \n\n";

describe("claude interactive control protocol", () => {
  it("recognizes control_request and result frames", () => {
    expect(isControlRequestFrame(NATIVE_ASK)).toBe(true);
    expect(isControlRequestFrame({ type: "assistant" })).toBe(false);
    expect(isResultFrame({ type: "result", subtype: "success" })).toBe(true);
  });

  it("sends the prompt as a stream-json user message", () => {
    const frame = JSON.parse(initialUserMessageFrame("hello")) as Record<string, any>;
    expect(frame["type"]).toBe("user");
    expect(frame["message"]["content"][0]["text"]).toBe("hello");
  });

  it("gives every user frame the recorded identity shape: a uuid (fresh per prompt, the caller's for a live message) and a null parent", () => {
    // The prompt's own uuid keeps its --replay-user-messages echo identifiable
    // (and ignored) beside the live messages' echoes: two prompts never share one.
    const a = JSON.parse(initialUserMessageFrame("hello")) as Record<string, any>;
    const b = JSON.parse(initialUserMessageFrame("hello")) as Record<string, any>;
    expect(typeof a["uuid"]).toBe("string");
    expect(a["uuid"]).not.toBe(b["uuid"]);
    expect(a["parent_tool_use_id"]).toBeNull();
    // A live message rides the exact frame recorded on 2.1.283 with the
    // message id as its uuid — the key every receipt is correlated by.
    expect(JSON.parse(userMessageFrame("Also say MANGO.", "live-msg-1"))).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Also say MANGO." }] },
      parent_tool_use_id: null,
      uuid: "live-msg-1",
    });
    expect(JSON.parse(initialUserMessageFrame("hello", [], "pinned"))["uuid"]).toBe("pinned");
  });

  it("puts an admitted generic-file sentinel in the stream-json vendor payload", () => {
    const frame = JSON.parse(
      initialUserMessageFrame("read it", [{ type: "text", text: "generic sentinel" }]),
    ) as Record<string, any>;
    expect(frame["message"]["content"]).toEqual([
      { type: "text", text: "read it" },
      { type: "text", text: "generic sentinel" },
    ]);
  });

  it("opens interactive sessions with the initialize handshake before the prompt", () => {
    const lines = initialSessionFrames("hello")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, any>);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.["type"]).toBe("control_request");
    expect(lines[0]?.["request"]["subtype"]).toBe("initialize");
    expect(lines[1]?.["type"]).toBe("user");
    expect(lines[1]?.["message"]["content"][0]["text"]).toBe("hello");
  });

  it("maps native questions into the typed InteractionRequest", () => {
    const req = interactionRequestFromNative("req-1", NATIVE_ASK.request.input);
    expect(req.interaction_id).toBe("req-1");
    expect(req.source_tool).toBe("AskUserQuestion");
    expect(req.questions).toHaveLength(1);
    expect(req.questions[0]?.id).toBe("q1");
    expect(req.questions[0]?.question).toBe("How should I format the output?");
    expect(req.questions[0]?.options.map((o) => o.label)).toEqual(["Summary", "Detailed"]);
    expect(req.questions[0]?.multi_select).toBe(false);
  });

  it("builds the documented answers map (question text -> selected label)", () => {
    const req = interactionRequestFromNative("req-1", NATIVE_ASK.request.input);
    const frame = JSON.parse(
      allowResponseFrame("req-1", NATIVE_ASK.request.input, req, {
        interaction_id: "req-1",
        answers: [{ question_id: "q1", selected_labels: ["Summary"], free_text: null }],
      })!,
    ) as Record<string, any>;
    expect(frame["type"]).toBe("control_response");
    expect(frame["response"]["subtype"]).toBe("success");
    expect(frame["response"]["request_id"]).toBe("req-1");
    const inner = frame["response"]["response"];
    expect(inner["behavior"]).toBe("allow");
    expect(inner["updatedInput"]["answers"]).toEqual({
      "How should I format the output?": "Summary",
    });
  });

  it("joins multi-select labels and passes free text verbatim", () => {
    const req = interactionRequestFromNative("req-1", NATIVE_ASK.request.input);
    const multi = JSON.parse(
      allowResponseFrame("req-1", NATIVE_ASK.request.input, req, {
        interaction_id: "req-1",
        answers: [{ question_id: "q1", selected_labels: ["Summary", "Detailed"], free_text: null }],
      })!,
    ) as Record<string, any>;
    expect(multi["response"]["response"]["updatedInput"]["answers"]).toEqual({
      "How should I format the output?": "Summary, Detailed",
    });
    const free = JSON.parse(
      allowResponseFrame("req-1", NATIVE_ASK.request.input, req, {
        interaction_id: "req-1",
        answers: [{ question_id: "q1", selected_labels: [], free_text: "Use markdown tables" }],
      })!,
    ) as Record<string, any>;
    expect(free["response"]["response"]["updatedInput"]["answers"]).toEqual({
      "How should I format the output?": "Use markdown tables",
    });
  });

  it("routes AskUserQuestion through the channel and writes the allow frame", async () => {
    const { io, written } = fakeIo();
    const events: HarnessEvent[] = [];
    const channel = {
      request: async () => ({
        interaction_id: "req-1",
        answers: [{ question_id: "q1", selected_labels: ["Detailed"], free_text: null }],
      }),
    };
    for await (const ev of handleControlRequestFrame(NATIVE_ASK, io, "ses-1", channel))
      events.push(ev);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("interaction_requested");
    expect(events[0]?.interaction?.interaction_id).toBe("req-1");
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('"behavior":"allow"');
    expect(written[0]).toContain("Detailed");
  });

  it("declines benignly when the channel resolves an unclassified null", async () => {
    const { io, written } = fakeIo();
    const events: HarnessEvent[] = [];
    const channel = { request: async () => null };
    for await (const ev of handleControlRequestFrame(NATIVE_ASK, io, "ses-1", channel))
      events.push(ev);
    expect(events).toHaveLength(1);
    expect(written[0]).toContain('"behavior":"deny"');
    expect(written[0]).toContain(DECLINE_MESSAGE.slice(0, 20));
  });

  it("releases a pending native question when the child process closes", async () => {
    const { io, written, close } = fakeIo();
    const events: HarnessEvent[] = [];
    const consuming = (async () => {
      for await (const ev of handleControlRequestFrame(NATIVE_ASK, io, "ses-1", {
        request: () => new Promise(() => undefined),
      })) {
        events.push(ev);
      }
    })();

    await vi.waitFor(() => expect(events).toHaveLength(1));
    close();
    await consuming;

    expect(events[0]?.type).toBe("interaction_requested");
    expect(written).toEqual([]);
  });

  it("denies non-interactive permission requests without liberalizing policy", async () => {
    const { io, written } = fakeIo();
    const frame = {
      type: "control_request",
      request_id: "req-2",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "rm -rf /" } },
    };
    const events: HarnessEvent[] = [];
    for await (const ev of handleControlRequestFrame(frame, io, "ses-1", {
      request: async () => null,
    }))
      events.push(ev);
    expect(events).toHaveLength(0);
    expect(written[0]).toContain('"behavior":"deny"');
    expect(written[0]).toContain("Not permitted by Claudexor policy");
  });

  it("answers unknown control subtypes with an error response", async () => {
    const { io, written } = fakeIo();
    const frame = {
      type: "control_request",
      request_id: "req-3",
      request: { subtype: "hook_callback" },
    };
    const events: HarnessEvent[] = [];
    for await (const ev of handleControlRequestFrame(frame, io, "ses-1", undefined))
      events.push(ev);
    expect(events).toHaveLength(0);
    expect(JSON.parse(written[0] ?? "{}")["response"]["subtype"]).toBe("error");
  });

  it("surfaces every native question, header, label and description exactly, however long", () => {
    const native = longNativeAsk();
    const req = interactionRequestFromNative("req-long", native);
    expect(req.questions).toEqual([
      {
        id: "q1",
        question: native.questions[0]!.question,
        header: native.questions[0]!.header,
        options: native.questions[0]!.options,
        multi_select: false,
      },
      {
        id: "q2",
        question: native.questions[1]!.question,
        header: null,
        options: [],
        multi_select: false,
      },
    ]);
  });

  it("answers a long question with its exact label and multi-line free text verbatim", () => {
    const native = longNativeAsk();
    const req = interactionRequestFromNative("req-long", native);
    const frame = JSON.parse(
      allowResponseFrame("req-long", native, req, {
        interaction_id: "req-long",
        answers: [
          {
            question_id: "q1",
            selected_labels: [req.questions[0]!.options[1]!.label],
            free_text: null,
          },
          { question_id: "q2", selected_labels: [], free_text: MULTILINE_FREE_TEXT },
        ],
      })!,
    ) as Record<string, any>;
    const inner = frame["response"]["response"];
    expect(inner["updatedInput"]["questions"]).toEqual(native.questions);
    expect(inner["updatedInput"]["answers"]).toEqual({
      [native.questions[0]!.question]: native.questions[0]!.options[1]!.label,
      [native.questions[1]!.question]: MULTILINE_FREE_TEXT,
    });
    // Old-mapping replay: neither the bounded display prefix of the question
    // nor of the label may stand in for the native text.
    const keys = Object.keys(inner["updatedInput"]["answers"]);
    expect(keys).not.toContain(native.questions[0]!.question.slice(0, 2000));
    expect(Object.values(inner["updatedInput"]["answers"])).not.toContain(
      native.questions[0]!.options[1]!.label.slice(0, 500),
    );
  });

  it("never sends an allow frame that answers nothing: such a set is the benign decline", async () => {
    const req = interactionRequestFromNative("req-1", NATIVE_ASK.request.input);
    for (const answers of [
      // An empty set is the caller's explicit decline.
      [],
      [{ question_id: "q9", selected_labels: ["Summary"], free_text: null }],
      [{ question_id: "q1", selected_labels: [], free_text: null }],
      [{ question_id: "q1", selected_labels: ["  "], free_text: " \n\t" }],
    ]) {
      expect(
        allowResponseFrame("req-1", NATIVE_ASK.request.input, req, {
          interaction_id: "req-1",
          answers,
        }),
      ).toBeNull();
      const { io, written } = fakeIo();
      const events: HarnessEvent[] = [];
      for await (const ev of handleControlRequestFrame(NATIVE_ASK, io, "ses-1", {
        request: async () => ({ interaction_id: "req-1", answers }),
      }))
        events.push(ev);
      expect(events.map((ev) => ev.type)).toEqual(["interaction_requested"]);
      expect(written).toHaveLength(1);
      expect(JSON.parse(written[0]!)["response"]["response"]).toEqual({
        behavior: "deny",
        message: DECLINE_MESSAGE,
        interrupt: false,
      });
    }
  });

  it("passes a label that is not one of the options through as the answer text", () => {
    const req = interactionRequestFromNative("req-1", NATIVE_ASK.request.input);
    const frame = JSON.parse(
      allowResponseFrame("req-1", NATIVE_ASK.request.input, req, {
        interaction_id: "req-1",
        answers: [{ question_id: "q1", selected_labels: ["Plain text"], free_text: null }],
      })!,
    ) as Record<string, any>;
    expect(frame["response"]["response"]["updatedInput"]["answers"]).toEqual({
      "How should I format the output?": "Plain text",
    });
  });

  it("writes the recorded native selected-label answer frame (control-handshake.jsonl)", async () => {
    const records = readFileSync(
      join(
        fileURLToPath(new URL("../fixtures", import.meta.url)),
        "protocol/control-handshake.jsonl",
      ),
      "utf8",
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { direction: string; frame: Record<string, any> });
    const request = records.find(
      (r) => r.direction === "cli->client" && r.frame["type"] === "control_request",
    )!.frame;
    const recordedAnswer = records.find(
      (r) => r.direction === "client->cli" && r.frame["type"] === "control_response",
    )!.frame;
    const { io, written } = fakeIo();
    let asked: InteractionRequest | undefined;
    const events: HarnessEvent[] = [];
    for await (const ev of handleControlRequestFrame(request, io, "ses-1", {
      request: async (interaction) => {
        asked = interaction;
        return {
          interaction_id: interaction.interaction_id,
          answers: [{ question_id: "q1", selected_labels: ["Blue"], free_text: null }],
        };
      },
    }))
      events.push(ev);
    expect(events.map((ev) => ev.type)).toEqual(["interaction_requested"]);
    expect(asked?.questions[0]?.options.map((o) => o.label)).toEqual(["Red", "Blue"]);
    expect(written.map((line) => JSON.parse(line))).toEqual([recordedAnswer]);
  });

  it("deny frame shape matches the control protocol", () => {
    const frame = JSON.parse(denyResponseFrame("req-9", "nope")) as Record<string, any>;
    expect(frame["response"]["response"]).toEqual({
      behavior: "deny",
      message: "nope",
      interrupt: false,
    });
  });
});
