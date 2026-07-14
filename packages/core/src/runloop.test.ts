import { describe, expect, it } from "vitest";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { runCliHarness } from "./runloop.js";
import type { ChildStdin } from "./proc.js";

const spec = (): HarnessRunSpec =>
  HarnessRunSpec.parse({
    session_id: "ses-loop",
    intent: "implement",
    prompt: "hello",
    cwd: process.cwd(),
  });

/**
 * Simulated bidirectional CLI: echoes the initial stdin frame, raises one
 * control_request, waits for the control_response on stdin, then emits the
 * terminal result frame and waits for stdin EOF before exiting (exactly the
 * cooperative shutdown contract of Claude's stream-json sessions).
 */
const FAKE_BIDI_CLI = `
const rl = require('node:readline').createInterface({ input: process.stdin });
let phase = 'init';
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (phase === 'init' && msg.type === 'user') {
    console.log(JSON.stringify({ type: 'echo', text: msg.message.content[0].text }));
    console.log(JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: {} } }));
    phase = 'awaiting_response';
    return;
  }
  if (phase === 'awaiting_response' && msg.type === 'control_response') {
    console.log(JSON.stringify({ type: 'answered', behavior: msg.response.response.behavior }));
    console.log(JSON.stringify({ type: 'result', subtype: 'success' }));
    phase = 'done';
  }
});
rl.on('close', () => process.exit(0));
`;

describe("runCliHarness session mode", () => {
  it("writes the initial frame, routes control frames to the handler, and closes stdin on the result frame", async () => {
    const written: string[] = [];
    const events: HarnessEvent[] = [];
    for await (const ev of runCliHarness({
      bin: process.execPath,
      args: ["-e", FAKE_BIDI_CLI],
      spec: spec(),
      parseEvent: (obj) => {
        const o = obj as Record<string, unknown>;
        if (o["type"] === "echo")
          return [
            {
              type: "message",
              session_id: "ses-loop",
              ts: new Date().toISOString(),
              text: String(o["text"]),
            },
          ];
        if (o["type"] === "answered")
          return [
            {
              type: "message",
              session_id: "ses-loop",
              ts: new Date().toISOString(),
              text: `answered:${String(o["behavior"])}`,
            },
          ];
        if (o["type"] === "result") return [];
        return null;
      },
      session: {
        initialStdin:
          JSON.stringify({
            type: "user",
            message: { role: "user", content: [{ type: "text", text: "hello" }] },
          }) + "\n",
        matches: (obj) => (obj as Record<string, unknown>)["type"] === "control_request",
        handle: async function* (obj, io: ChildStdin) {
          const o = obj as Record<string, any>;
          written.push(String(o["request_id"]));
          yield {
            type: "interaction_requested",
            session_id: "ses-loop",
            ts: new Date().toISOString(),
          } as HarnessEvent;
          io.write(
            JSON.stringify({
              type: "control_response",
              response: {
                subtype: "success",
                request_id: o["request_id"],
                response: { behavior: "allow" },
              },
            }) + "\n",
          );
        },
        closeStdinOn: (obj) => (obj as Record<string, unknown>)["type"] === "result",
      },
    })) {
      events.push(ev);
    }
    const texts = events.filter((e) => e.type === "message").map((e) => e.text);
    expect(texts).toContain("hello"); // echo of the initial stdin frame
    expect(texts).toContain("answered:allow"); // control_response delivered
    expect(written).toEqual(["r1"]);
    expect(events.some((e) => e.type === "interaction_requested")).toBe(true);
    const completed = events.at(-1);
    expect(completed?.type).toBe("completed");
    expect(completed?.payload?.["exit_code"]).toBe(0);
  }, 15_000);
});
