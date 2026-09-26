import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
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

const FAKE_EXITING_BIDI_CLI = `
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.once('line', () => {
  console.log(JSON.stringify({ type: 'control_request', request_id: 'r-exit' }));
  setTimeout(() => process.exit(17), 10);
});
`;

describe("runCliHarness one-shot input", () => {
  it("delivers a multi-megabyte Unicode prompt byte-exactly through stdin", async () => {
    const input = `snowman=☃\n${"x".repeat(1_760_000)}\nend`;
    const expected = {
      bytes: Buffer.byteLength(input),
      sha256: createHash("sha256").update(input).digest("hex"),
      argvHasInput: false,
    };
    let observed: unknown;
    const child = [
      "const chunks = []",
      "process.stdin.on('data', (chunk) => chunks.push(chunk))",
      "process.stdin.on('end', () => {",
      "  const input = Buffer.concat(chunks)",
      "  const sha256 = require('node:crypto').createHash('sha256').update(input).digest('hex')",
      "  const argvHasInput = process.argv.includes(input.toString('utf8'))",
      "  console.log(JSON.stringify({ bytes: input.length, sha256, argvHasInput }))",
      "})",
    ].join(";");

    const events: HarnessEvent[] = [];
    for await (const event of runCliHarness({
      bin: process.execPath,
      args: ["-e", child],
      input,
      spec: spec(),
      parseEvent: (obj) => {
        observed = obj;
        return [];
      },
    })) {
      events.push(event);
    }

    expect(observed).toEqual(expected);
    expect(events.at(-1)?.type).toBe("completed");
    expect(events.at(-1)?.payload?.["exit_code"]).toBe(0);
  }, 15_000);

  it("refuses competing one-shot and bidirectional stdin owners before spawn", async () => {
    const collect = async (): Promise<void> => {
      for await (const _event of runCliHarness({
        bin: process.execPath,
        args: ["-e", "process.exit(0)"],
        input: "one shot",
        spec: spec(),
        parseEvent: () => [],
        session: {
          initialStdin: "session frame",
          matches: () => false,
          handle: async function* () {},
        },
      })) {
        // drain
      }
    };

    await expect(collect()).rejects.toThrow(/mutually exclusive stdin owners/);
  });
});

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

  it("consumes a queued child exit while an inline session handler awaits process closure", async () => {
    const collect = async (): Promise<HarnessEvent[]> => {
      const events: HarnessEvent[] = [];
      for await (const event of runCliHarness({
        bin: process.execPath,
        args: ["-e", FAKE_EXITING_BIDI_CLI],
        spec: spec(),
        parseEvent: () => null,
        session: {
          initialStdin: '{"type":"user"}\n',
          matches: (obj) => (obj as Record<string, unknown>)["type"] === "control_request",
          handle: async function* (_obj, io) {
            yield {
              type: "interaction_requested",
              session_id: "ses-loop",
              ts: new Date().toISOString(),
            } as HarnessEvent;
            await io.closed;
          },
        },
      })) {
        events.push(event);
      }
      return events;
    };

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("runCliHarness remained blocked after child exit")),
        2_000,
      );
    });
    const events = await Promise.race([collect(), timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });

    expect(events.some((event) => event.type === "interaction_requested")).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(events.at(-1)?.type).toBe("completed");
    expect(events.at(-1)?.payload?.["exit_code"]).toBe(17);
  }, 5_000);
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

// GH #120: the redacted stderr tail must ride the terminal completed payload on
// EVERY exit path — zero exit and abort included — whenever the ring is
// non-empty after trim. It is a raw diagnostics channel (events.jsonl / SSE /
// --json-stream), never a verdict axis and never severity-classified (INV-049).
// Children write stderr via fs.writeSync(2, ...) so the bytes are in the pipe
// synchronously — console.error to a pipe is async on POSIX and process.exit
// (or a kill) could truncate it, making the ring assertion flaky.
describe("runCliHarness stderr tail on every exit path", () => {
  const collect = async (opts: {
    args: string[];
    redact?: (text: string) => string;
    parseStderrFailure?: (stderr: string, sessionId: string) => HarnessEvent | null;
  }): Promise<HarnessEvent[]> => {
    const events: HarnessEvent[] = [];
    for await (const ev of runCliHarness({
      bin: process.execPath,
      args: opts.args,
      spec: spec(),
      parseEvent: () => null,
      ...(opts.redact ? { redact: opts.redact } : {}),
      ...(opts.parseStderrFailure ? { parseStderrFailure: opts.parseStderrFailure } : {}),
    })) {
      events.push(ev);
    }
    return events;
  };

  it("attaches a redacted stderr_tail on a ZERO exit (custom redact proves the seam)", async () => {
    const events = await collect({
      args: ["-e", "require('node:fs').writeSync(2, 'diag: token tok-cafebabe seen\\n')"],
      redact: (text) => text.replaceAll("tok-cafebabe", "[scrubbed]"),
    });
    const completed = events.at(-1);
    expect(completed?.type).toBe("completed");
    expect(completed?.payload?.["exit_code"]).toBe(0);
    const tail = completed?.payload?.["stderr_tail"];
    expect(typeof tail).toBe("string");
    expect(tail).toContain("[scrubbed]");
    expect(tail).not.toContain("tok-cafebabe");
  }, 15_000);

  it("omits the key entirely for a provably-silent child (trim semantics)", async () => {
    // An empty -e script writes nothing to stderr; the tail is empty after
    // trim, so the key must be ABSENT — not present-and-empty.
    const events = await collect({ args: ["-e", ""] });
    const completed = events.at(-1);
    expect(completed?.type).toBe("completed");
    expect(completed?.payload?.["exit_code"]).toBe(0);
    expect(completed?.payload && "stderr_tail" in completed.payload).toBe(false);
  }, 15_000);

  it("preserves the tail on the ABORT path", async () => {
    // The child writes its stderr line SYNCHRONOUSLY before announcing
    // readiness on stdout, so the bytes are already buffered parent-side when
    // the abort kills it — the ring drains them while the stream winds down.
    const ac = new AbortController();
    const runSpec = spec();
    runSpec.extra["abortSignal"] = ac.signal;
    const events: HarnessEvent[] = [];
    for await (const ev of runCliHarness({
      bin: process.execPath,
      args: [
        "-e",
        "require('node:fs').writeSync(2, 'pre-abort stderr noise\\n');" +
          "console.log(JSON.stringify({ type: 'ready' }));" +
          "setTimeout(() => {}, 5000)",
      ],
      spec: runSpec,
      parseEvent: (obj) => {
        if ((obj as Record<string, unknown>)["type"] === "ready") {
          ac.abort();
          return [];
        }
        return null;
      },
    })) {
      events.push(ev);
    }
    const completed = events.at(-1);
    expect(completed?.type).toBe("completed");
    expect(completed?.payload?.["aborted"]).toBe(true);
    expect(completed?.payload?.["stderr_tail"]).toContain("pre-abort stderr noise");
  }, 15_000);

  it("keeps the NONZERO path unchanged: prose fold + parseStderrFailure argument, plus the typed tail", async () => {
    let failureTailArg: string | null = null;
    const events = await collect({
      args: ["-e", "require('node:fs').writeSync(2, 'fatal: broke badly\\n'); process.exit(3)"],
      parseStderrFailure: (stderr) => {
        failureTailArg = stderr;
        return null; // fall through to the generic synthesized error
      },
    });
    // The failure-path argument still receives the tail (harness-codex depends on it) ...
    expect(failureTailArg).toContain("fatal: broke badly");
    // ... the synthesized error still folds the tail into prose ...
    const err = events.find((e) => e.type === "error");
    expect(err?.error).toMatch(/exited with code 3: [\s\S]*fatal: broke badly/);
    // ... and the terminal payload now ALSO carries the typed copy (deliberate duplication).
    const completed = events.at(-1);
    expect(completed?.type).toBe("completed");
    expect(completed?.payload?.["exit_code"]).toBe(3);
    expect(completed?.payload?.["stderr_tail"]).toContain("fatal: broke badly");
  }, 15_000);
});

// A harness that VOICED its own error on stdout and then exited non-zero did not
// crash. `harness_reported_error` is the typed fact that says so, and it is set
// ONLY for error events translated from the harness's own stdout frames (adapter
// parse or adapter session handler) — never for an error this loop or its
// process layer produced.
describe("runCliHarness harness_reported_error terminal fact", () => {
  const errorEvent = (text: string): HarnessEvent => ({
    type: "error",
    session_id: "ses-loop",
    ts: new Date().toISOString(),
    error: text,
  });
  const parseErrorFrame = (obj: unknown): HarnessEvent[] | null => {
    const o = obj as Record<string, unknown>;
    if (o["type"] === "error") return [errorEvent(String(o["message"]))];
    if (o["type"] === "ok") return [];
    return null;
  };
  const run = async (
    opts: Partial<Parameters<typeof runCliHarness>[0]> & { args: string[] },
    runSpec: HarnessRunSpec = spec(),
  ): Promise<HarnessEvent[]> => {
    const events: HarnessEvent[] = [];
    for await (const ev of runCliHarness({
      bin: process.execPath,
      spec: runSpec,
      parseEvent: parseErrorFrame,
      ...opts,
    })) {
      events.push(ev);
    }
    return events;
  };
  const reported = (events: HarnessEvent[]): boolean => {
    const payload = events.at(-1)?.payload;
    return payload !== undefined && "harness_reported_error" in payload;
  };

  it("fires when the adapter parse turned a stdout frame into an error and the CLI exited non-zero", async () => {
    const events = await run({
      args: [
        "-e",
        "console.log(JSON.stringify({ type: 'error', message: 'model is at capacity' })); process.exitCode = 1",
      ],
    });
    const completed = events.at(-1);
    expect(completed?.type).toBe("completed");
    expect(completed?.payload?.["harness_reported_error"]).toBe(true);
    expect(completed?.payload?.["exit_code"]).toBe(1);
    // The harness's own words are the only error: nothing was synthesized on top.
    expect(events.filter((e) => e.type === "error").map((e) => e.error)).toEqual([
      "model is at capacity",
    ]);
  }, 15_000);

  it("fires when the adapter SESSION handler yielded the error", async () => {
    const events = await run({
      args: [
        "-e",
        "console.log(JSON.stringify({ type: 'control_request' })); process.stdin.on('end', () => process.exit(1)); process.stdin.resume()",
      ],
      session: {
        matches: (obj) => (obj as Record<string, unknown>)["type"] === "control_request",
        handle: async function* (_obj, io) {
          yield errorEvent("session refused");
          io.end();
        },
      },
    });
    expect(events.at(-1)?.payload?.["harness_reported_error"]).toBe(true);
    expect(events.at(-1)?.payload?.["exit_code"]).toBe(1);
  }, 15_000);

  it("stays quiet on a SILENT non-zero exit: the loop's synthesized error is not the harness speaking", async () => {
    const events = await run({ args: ["-e", "process.exit(3)"] });
    expect(events.find((e) => e.type === "error")?.error).toMatch(/exited with code 3/);
    expect(events.at(-1)?.payload?.["exit_code"]).toBe(3);
    expect(reported(events)).toBe(false);
  }, 15_000);

  it("stays quiet on a STDERR-ONLY failure even when the adapter translates the stderr tail", async () => {
    const events = await run({
      args: ["-e", "require('node:fs').writeSync(2, 'fatal: not logged in\\n'); process.exit(2)"],
      parseStderrFailure: (stderr) => errorEvent(`translated: ${stderr}`),
    });
    expect(events.find((e) => e.type === "error")?.error).toContain("translated: fatal");
    expect(events.at(-1)?.payload?.["exit_code"]).toBe(2);
    expect(reported(events)).toBe(false);
  }, 15_000);

  it("stays quiet on a SPAWN failure", async () => {
    const events = await run({ bin: "/nonexistent/claudexor-no-such-binary", args: [] });
    expect(events.find((e) => e.type === "error")?.error).toMatch(/failed to start/);
    expect(events.at(-1)?.payload?.["spawn_failed"]).toBe(true);
    expect(reported(events)).toBe(false);
  }, 15_000);

  it("stays quiet on an UNCONFIRMED termination", async () => {
    const ac = new AbortController();
    const runSpec = spec();
    runSpec.extra["abortSignal"] = ac.signal;
    const events = await run(
      {
        args: [
          "-e",
          "console.log(JSON.stringify({ type: 'ok' })); process.on('SIGINT', () => process.exit(0)); setTimeout(() => {}, 5000)",
        ],
        parseEvent: (obj) => {
          if ((obj as Record<string, unknown>)["type"] === "ok") ac.abort();
          return [];
        },
        reap: async () => ({ state: "unconfirmed", survivors: [424242], unresolved: [] }),
      },
      runSpec,
    );
    expect(events.find((e) => e.type === "error")?.error).toMatch(/could not confirm/i);
    expect(events.at(-1)?.payload?.["termination_unconfirmed"]).toBeTruthy();
    expect(reported(events)).toBe(false);
  }, 15_000);

  it("stays quiet on a clean exit", async () => {
    const events = await run({ args: ["-e", "console.log(JSON.stringify({ type: 'ok' }))"] });
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)?.payload?.["exit_code"]).toBe(0);
    expect(reported(events)).toBe(false);
  }, 15_000);
});

/**
 * Live-input seam (Claude's native queue fold): the adapter's live-input owner
 * receives the stdin handle once after spawn and `null` exactly once when stdin
 * closes; `closeStdinOn` returning false HOLDS the session open past a native
 * terminal frame so the CLI can run a queued message as its next turn.
 */
const FAKE_MULTI_TURN_CLI = `
const rl = require('node:readline').createInterface({ input: process.stdin });
let users = 0;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'user') return;
  users += 1;
  console.log(JSON.stringify({ type: 'result', subtype: 'success', n: users }));
});
rl.on('close', () => process.exit(0));
`;

describe("runCliHarness session onIo + hold", () => {
  const userFrame = JSON.stringify({ type: "user", message: { content: [] } }) + "\n";

  it("hands the live handle to onIo after the initial frame and null exactly once when the result closes stdin", async () => {
    const calls: string[] = [];
    const events: HarnessEvent[] = [];
    for await (const ev of runCliHarness({
      bin: process.execPath,
      args: ["-e", FAKE_MULTI_TURN_CLI],
      spec: spec(),
      parseEvent: (obj) => ((obj as Record<string, unknown>)["type"] === "result" ? [] : null),
      session: {
        initialStdin: userFrame,
        matches: () => false,
        handle: async function* () {},
        closeStdinOn: (obj) => (obj as Record<string, unknown>)["type"] === "result",
        onIo: (io, sessionId) => calls.push(`${io ? "io" : "null"}:${sessionId}`),
      },
    })) {
      events.push(ev);
    }
    expect(calls).toEqual(["io:ses-loop", "null:ses-loop"]);
    expect(events.at(-1)).toMatchObject({ type: "completed", payload: { exit_code: 0 } });
  }, 15_000);

  it("keeps stdin open while closeStdinOn is false, so a second frame written through the handle runs as the next turn", async () => {
    const calls: string[] = [];
    let io: ChildStdin | null = null;
    const results: number[] = [];
    for await (const ev of runCliHarness({
      bin: process.execPath,
      args: ["-e", FAKE_MULTI_TURN_CLI],
      spec: spec(),
      parseEvent: (obj) => {
        const o = obj as Record<string, unknown>;
        if (o["type"] !== "result") return null;
        results.push(Number(o["n"]));
        return [
          {
            type: "message",
            session_id: "ses-loop",
            ts: new Date().toISOString(),
            text: `r${o["n"]}`,
          },
        ];
      },
      session: {
        initialStdin: userFrame,
        matches: () => false,
        handle: async function* () {},
        // The FIRST result does not close the session (a "queued" message is
        // still pending); the second one does.
        closeStdinOn: (obj) => (obj as Record<string, unknown>)["n"] === 2,
        onIo: (handle) => {
          calls.push(handle ? "io" : "null");
          io = handle;
        },
      },
    })) {
      if (ev.type === "message" && ev.text === "r1") {
        // stdin is still open after result#1: the live handle accepts the next frame.
        expect(io).not.toBeNull();
        io!.write(userFrame);
      }
    }
    expect(results).toEqual([1, 2]);
    expect(calls).toEqual(["io", "null"]);
    expect(io).toBeNull();
  }, 15_000);

  it("still reports null once in the finally when the child exits without a closing frame", async () => {
    const calls: string[] = [];
    for await (const _ev of runCliHarness({
      bin: process.execPath,
      args: ["-e", "process.stdin.resume(); setTimeout(() => process.exit(0), 50)"],
      spec: spec(),
      parseEvent: () => null,
      session: {
        matches: () => false,
        handle: async function* () {},
        closeStdinOn: () => false,
        onIo: (io) => calls.push(io ? "io" : "null"),
      },
    })) {
      // drain
    }
    expect(calls).toEqual(["io", "null"]);
  }, 15_000);
});
