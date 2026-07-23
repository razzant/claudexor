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

// QA-027: a cancellation whose whole-tree death proof cannot confirm death must
// surface as a typed terminal fact — an error event AND a `termination_unconfirmed`
// payload on the terminal completed — never a silent clean cancel.
describe("runCliHarness proven-death terminal", () => {
  const quickBin = [
    "console.log(JSON.stringify({ type: 'ready' }))",
    "process.on('SIGINT', () => process.exit(0))",
    "setTimeout(() => {}, 5000)",
  ].join(";");

  it("emits an error + termination_unconfirmed completed payload when death is unconfirmed", async () => {
    const ac = new AbortController();
    const runSpec = HarnessRunSpec.parse({
      session_id: "ses-unconfirmed",
      intent: "implement",
      prompt: "hi",
      cwd: process.cwd(),
    });
    runSpec.extra["abortSignal"] = ac.signal;
    const events: HarnessEvent[] = [];
    for await (const ev of runCliHarness({
      bin: process.execPath,
      args: ["-e", quickBin],
      spec: runSpec,
      parseEvent: (obj) => {
        const o = obj as Record<string, unknown>;
        if (o["type"] === "ready") {
          ac.abort();
          return [];
        }
        return null;
      },
      reap: async () => ({
        state: "unconfirmed",
        survivors: [424242],
        unresolved: [{ pgid: 999, reason: "leader identity unreadable" }],
      }),
    })) {
      events.push(ev);
    }
    // Disclosed as an error event (non-clean) ...
    const err = events.find((e) => e.type === "error");
    expect(err, "unconfirmed death error emitted").toBeTruthy();
    expect(err?.error).toMatch(/could not confirm process death/i);
    // ... and as a typed field on the terminal completed event.
    const completed = events.at(-1);
    expect(completed?.type).toBe("completed");
    const tu = completed?.payload?.["termination_unconfirmed"] as
      { survivors?: number[]; unresolved?: unknown[] } | undefined;
    expect(tu?.survivors).toEqual([424242]);
    expect(tu?.unresolved).toHaveLength(1);
  }, 15_000);
});
