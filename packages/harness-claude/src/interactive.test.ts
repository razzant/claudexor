import { describe, expect, it } from "vitest";
import type { ChildStdin } from "@claudexor/core";
import type { HarnessEvent } from "@claudexor/schema";
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
} from "./interactive.js";

function fakeIo(): { io: ChildStdin; written: string[]; ended: boolean } {
  const state = { written: [] as string[], ended: false };
  return {
    io: {
      write: (data: string) => state.written.push(data),
      end: () => {
        state.ended = true;
      },
    },
    written: state.written,
    get ended() {
      return state.ended;
    },
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

  it("opens interactive sessions with the initialize handshake before the prompt", () => {
    const lines = initialSessionFrames("hello").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
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
      }),
    ) as Record<string, any>;
    expect(frame["type"]).toBe("control_response");
    expect(frame["response"]["subtype"]).toBe("success");
    expect(frame["response"]["request_id"]).toBe("req-1");
    const inner = frame["response"]["response"];
    expect(inner["behavior"]).toBe("allow");
    expect(inner["updatedInput"]["answers"]).toEqual({ "How should I format the output?": "Summary" });
  });

  it("joins multi-select labels and passes free text verbatim", () => {
    const req = interactionRequestFromNative("req-1", NATIVE_ASK.request.input);
    const multi = JSON.parse(
      allowResponseFrame("req-1", NATIVE_ASK.request.input, req, {
        interaction_id: "req-1",
        answers: [{ question_id: "q1", selected_labels: ["Summary", "Detailed"], free_text: null }],
      }),
    ) as Record<string, any>;
    expect(multi["response"]["response"]["updatedInput"]["answers"]).toEqual({
      "How should I format the output?": "Summary, Detailed",
    });
    const free = JSON.parse(
      allowResponseFrame("req-1", NATIVE_ASK.request.input, req, {
        interaction_id: "req-1",
        answers: [{ question_id: "q1", selected_labels: [], free_text: "Use markdown tables" }],
      }),
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
    for await (const ev of handleControlRequestFrame(NATIVE_ASK, io, "ses-1", channel)) events.push(ev);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("interaction_requested");
    expect(events[0]?.interaction?.interaction_id).toBe("req-1");
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('"behavior":"allow"');
    expect(written[0]).toContain("Detailed");
  });

  it("declines benignly when the channel resolves null (timeout)", async () => {
    const { io, written } = fakeIo();
    const events: HarnessEvent[] = [];
    const channel = { request: async () => null };
    for await (const ev of handleControlRequestFrame(NATIVE_ASK, io, "ses-1", channel)) events.push(ev);
    expect(events).toHaveLength(1);
    expect(written[0]).toContain('"behavior":"deny"');
    expect(written[0]).toContain(DECLINE_MESSAGE.slice(0, 20));
  });

  it("denies non-interactive permission requests without liberalizing policy", async () => {
    const { io, written } = fakeIo();
    const frame = {
      type: "control_request",
      request_id: "req-2",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "rm -rf /" } },
    };
    const events: HarnessEvent[] = [];
    for await (const ev of handleControlRequestFrame(frame, io, "ses-1", { request: async () => null })) events.push(ev);
    expect(events).toHaveLength(0);
    expect(written[0]).toContain('"behavior":"deny"');
    expect(written[0]).toContain("Not permitted by Claudexor policy");
  });

  it("answers unknown control subtypes with an error response", async () => {
    const { io, written } = fakeIo();
    const frame = { type: "control_request", request_id: "req-3", request: { subtype: "hook_callback" } };
    const events: HarnessEvent[] = [];
    for await (const ev of handleControlRequestFrame(frame, io, "ses-1", undefined)) events.push(ev);
    expect(events).toHaveLength(0);
    expect(JSON.parse(written[0] ?? "{}")["response"]["subtype"]).toBe("error");
  });

  it("deny frame shape matches the control protocol", () => {
    const frame = JSON.parse(denyResponseFrame("req-9", "nope")) as Record<string, any>;
    expect(frame["response"]["response"]).toEqual({ behavior: "deny", message: "nope", interrupt: false });
  });
});
