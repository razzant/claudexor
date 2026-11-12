import type { spawnProcess } from "@claudexor/core";
import { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { describe, expect, it } from "vitest";
import { runCodexAppServer } from "./app-server-run.js";
import { CodexSubagentThreads } from "./app-server-threads.js";
import { codexNativeWarningEvents } from "./app-server-warnings.js";

type Frame = { method: string; params?: Record<string, unknown> };

// Vendor texts at rust-v0.162.1 (fixtures/manifest.yaml has their provenance).
const BWRAP = "Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces.";
const LOG_WRITE =
  "Codex couldn't save diagnostic logs to its local database. Run `codex doctor` for diagnostics.";
const MODEL_METADATA =
  "Model metadata for `fixture-model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.";

const configWarning = (params: Record<string, unknown>): Frame => ({
  method: "configWarning",
  params,
});
const warning = (params: Record<string, unknown>): Frame => ({ method: "warning", params });

/** Scripted app-server: answers the adapter's own requests and emits each frame group where Codex does. */
function scriptedCodex(frames: {
  afterInitialize: Frame[];
  afterThreadStart: Frame[];
  inTurn: Frame[];
  /** Answers this request with a JSON-RPC error and sends nothing after it. */
  refuse?: "thread/start" | "turn/start";
  /** Resumes this thread id; the peer answers `thread/resume` with `thread-1` instead. */
  resume?: string;
  /** Sent while the settled root thread is read, ahead of the reply. */
  onThreadRead?: Frame[];
  /** Sent when the adapter closes stdin to stop the process. */
  onStop?: Frame[];
}): typeof spawnProcess {
  return async function* (_bin, _args, options = {}) {
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let stopped = false;
    const push = (...messages: unknown[]): void => {
      for (const message of messages) replies.push(JSON.stringify(message));
      wake?.();
      wake = undefined;
    };
    options.onSpawn?.({
      write(data) {
        const { id, method } = JSON.parse(data) as { id?: number; method: string };
        const refused = { id, error: { code: -32603, message: `${method} refused` } };
        if (method === "initialize") push({ id, result: {} }, ...frames.afterInitialize);
        else if (method === "thread/start" || method === "thread/resume")
          push(
            ...(frames.refuse === method
              ? [refused]
              : [{ id, result: { thread: { id: "thread-1" } } }, ...frames.afterThreadStart]),
          );
        else if (method === "turn/start")
          push(
            ...(frames.refuse === method
              ? [refused]
              : [
                  { id, result: { turn: { id: "turn-1" } } },
                  {
                    method: "turn/started",
                    params: { threadId: "thread-1", turn: { id: "turn-1" } },
                  },
                  ...frames.inTurn,
                  {
                    method: "item/completed",
                    params: {
                      threadId: "thread-1",
                      turnId: "turn-1",
                      item: { id: "msg-1", type: "agentMessage", text: "Text-only answer." },
                    },
                  },
                  {
                    method: "turn/completed",
                    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
                  },
                ]),
          );
        else if (method === "thread/read")
          push(...(frames.onThreadRead ?? []), {
            id,
            result: { thread: { status: { type: "idle" } } },
          });
        else if (method === "thread/goal/get") push({ id, result: { goal: null } });
        else if (method === "thread/backgroundTerminals/list") push({ id, result: { data: [] } });
      },
      end() {
        for (const message of frames.onStop ?? []) replies.push(JSON.stringify(message));
        stopped = true;
        wake?.();
      },
      closed: Promise.resolve(),
    });
    while (!stopped || replies.length) {
      if (replies.length) yield { type: "stdout", line: replies.shift()! };
      else await new Promise<void>((resolve) => (wake = resolve));
    }
    yield { type: "exit", code: 0, signal: null, durationMs: 0 };
  };
}

type Script = Parameters<typeof scriptedCodex>[0];

async function collect(script: Script): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of runCodexAppServer({
    bin: "codex",
    args: [],
    env: {},
    pollIntervalMs: 0,
    spawn: scriptedCodex(script),
    spec: HarnessRunSpec.parse({
      session_id: "session-warnings",
      intent: "explain",
      prompt: "Answer without tools",
      cwd: process.cwd(),
      access: "readonly",
      ...(script.resume ? { resume_session_id: script.resume } : {}),
    }),
  }))
    events.push(event);
  return events;
}

const isNative = (event: HarnessEvent): boolean =>
  event.payload?.["code"] === "codex_native_warning";
const texts = (events: HarnessEvent[]) => events.filter(isNative).map((event) => event.text);
/** Everything but the warnings and the clocks: what a warning must never change. */
const withoutWarnings = (events: HarnessEvent[]) =>
  events.filter((event) => !isNative(event)).map(({ ts: _ts, ...rest }) => rest);

describe("Codex native warning notifications", () => {
  it("keeps startup, pre-turn and in-turn warnings as status evidence beside a text-only answer", async () => {
    const invalidConfig = {
      summary: "Invalid configuration; using defaults.",
      details: "fixture parse error",
      path: "/fixture/codex-home/config.toml",
      range: { start: { line: 3, column: 1 }, end: { line: 3, column: 12 } },
    };
    const events: HarnessEvent[] = [];
    for await (const event of runCodexAppServer({
      bin: "codex",
      args: [],
      env: {},
      pollIntervalMs: 0,
      spawn: scriptedCodex({
        // Sent right after `initialize`: queued before thread/start names the root.
        afterInitialize: [
          configWarning({ summary: BWRAP, details: null }),
          configWarning(invalidConfig),
          configWarning({ summary: 42 }),
          { method: "remoteControl/status/changed", params: { status: "disabled" } },
        ],
        afterThreadStart: [
          warning({ threadId: "thread-1", message: MODEL_METADATA }),
          warning({ threadId: "thread-1" }),
          { method: "warning" },
        ],
        inTurn: [
          warning({ threadId: null, message: LOG_WRITE }),
          warning({ threadId: null, message: LOG_WRITE }),
          warning({ threadId: "child-1", message: MODEL_METADATA }),
        ],
      }),
      spec: HarnessRunSpec.parse({
        session_id: "session-warnings",
        intent: "explain",
        prompt: "Answer without tools",
        cwd: process.cwd(),
        access: "readonly",
      }),
    }))
      events.push(event);

    expect(events[0]?.type).toBe("started");
    const warnings = events.filter((event) => event.payload?.["code"] === "codex_native_warning");
    // One event per native frame, in arrival order, the repeated frame included.
    expect(warnings.map((event) => [event.text, event.payload?.["native_params"]])).toEqual([
      [BWRAP, { summary: BWRAP, details: null }],
      ["Invalid configuration; using defaults.: fixture parse error", invalidConfig],
      [MODEL_METADATA, { threadId: "thread-1", message: MODEL_METADATA }],
      [LOG_WRITE, { threadId: null, message: LOG_WRITE }],
      [LOG_WRITE, { threadId: null, message: LOG_WRITE }],
      [MODEL_METADATA, { threadId: "child-1", message: MODEL_METADATA }],
    ]);
    expect(warnings.map((event) => event.payload?.["native_method"])).toEqual([
      "configWarning",
      "configWarning",
      "warning",
      "warning",
      "warning",
      "warning",
    ]);
    for (const event of warnings) {
      expect(event.type).toBe("status");
      expect(event.status).toBeUndefined();
      expect(HarnessEvent.safeParse(event).success).toBe(true);
    }
    // Only a sub-agent's frame carries the sub-agent attribution.
    expect(warnings.map((event) => event.payload?.["subagent"] ?? false)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(warnings[5]?.payload?.["native_thread_id"]).toBe("child-1");
    // Evidence only: no error, the final answer stays the root's text, and only
    // the malformed frames and the remote-control status remain unrecognized.
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(events.filter((event) => event.final).map((event) => event.text)).toEqual([
      "Text-only answer.",
    ]);
    const finalIndex = events.findIndex((event) => event.final);
    expect(events.indexOf(warnings.at(-1)!)).toBeLessThan(finalIndex);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      payload: { native_session_id: "thread-1", dropped_unrecognized_events: 4 },
    });
    expect(events.at(-1)?.payload).not.toHaveProperty("harness_reported_error");
  });

  it.each([
    ["configWarning", { summary: "S", details: "D" }, "S: D"],
    ["configWarning", { summary: "S", details: "" }, "S"],
    ["configWarning", { summary: "S", details: 7 }, "S"],
    ["configWarning", { summary: "S" }, "S"],
    ["configWarning", { details: "D" }, null],
    ["configWarning", { summary: ["S"] }, null],
    ["warning", { message: "M" }, "M"],
    ["warning", { threadId: "t", message: "M" }, "M"],
    ["warning", { threadId: "t", summary: "S" }, null],
  ] as const)(
    "maps %s %j to text %j, keeping a secret-free params object as it came",
    (method, params, text) => {
      const events = codexNativeWarningEvents(method, { ...params }, "session-map");
      if (text === null) {
        expect(events).toBeNull();
        return;
      }
      expect(events).toEqual([
        {
          type: "status",
          session_id: "session-map",
          ts: expect.any(String),
          text,
          payload: { code: "codex_native_warning", native_method: method, native_params: params },
        },
      ]);
    },
  );
});

describe("Codex native warning diagnostic masking", () => {
  // Built, not written, so no token-shaped literal sits in the source.
  const TOKEN = `ghp_${"a".repeat(36)}`;
  const PEM_BEGIN = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  const PEM_END = "-----END PRIVATE KEY-----";
  const only = (method: "configWarning" | "warning", params: Record<string, unknown>) => {
    const [event] = codexNativeWarningEvents(method, params, "session-mask")!;
    return event!;
  };

  it("masks a secret Codex quotes in a config warning's text and params, keeping the rest", () => {
    const params = {
      summary: `Invalid value near token ${TOKEN}`,
      details: `parse error at ${TOKEN}`,
      path: "/fixture/codex-home/config.toml",
      range: { start: { line: 3, column: 1 }, end: { line: 3, column: 12 } },
    };
    const event = only("configWarning", params);
    expect(event.text).toBe("Invalid value near token [redacted]: parse error at [redacted]");
    expect(event.payload).toEqual({
      code: "codex_native_warning",
      native_method: "configWarning",
      native_params: {
        ...params,
        summary: "Invalid value near token [redacted]",
        details: "parse error at [redacted]",
      },
    });
    expect(event.type).toBe("status");
    expect(JSON.stringify(event)).not.toContain(TOKEN);
    expect(HarnessEvent.safeParse(event).success).toBe(true);
  });

  it("masks a runtime warning's message and keeps its thread id", () => {
    const event = only("warning", { threadId: "thread-1", message: `leaked ${TOKEN} here` });
    expect(event.text).toBe("leaked [redacted] here");
    expect(event.payload).toEqual({
      code: "codex_native_warning",
      native_method: "warning",
      native_params: { threadId: "thread-1", message: "leaked [redacted] here" },
    });
  });

  it("leaves a secret-free warning's params as the same object", () => {
    const params = { threadId: null, message: LOG_WRITE, extra: { n: 1, list: ["a", 2, null] } };
    const event = only("warning", params);
    expect(event.text).toBe(LOG_WRITE);
    expect(event.payload?.["native_params"]).toBe(params);
  });

  it("keeps the masked text when masking the params' JSON no longer parses", () => {
    // A key block opens in one string and closes in a later one: masking the JSON text
    // cuts across the structure, so the masked text itself is kept, secret-free.
    const params = { message: "m", a: [`${PEM_BEGIN}\nSECRETBODY`], b: `${PEM_END} tail` };
    const event = only("warning", params);
    const kept = event.payload?.["native_params"];
    expect(typeof kept).toBe("string");
    expect(kept).not.toContain("SECRETBODY");
    expect(event.text).toBe("m");
    expect(event.payload).toMatchObject({ native_method: "warning" });
  });

  it("does not throw on params that cannot be serialized", () => {
    const params: Record<string, unknown> = { message: "m" };
    params["self"] = params;
    const event = only("warning", params);
    expect(event.text).toBe("m");
    expect(event.payload?.["native_params"]).toBe("[unserializable diagnostic]");
  });
});

describe("Codex native warnings the run had not read when it stopped", () => {
  const startup = configWarning({ summary: BWRAP, details: null });
  const malformed = configWarning({ summary: 42 });

  it("delivers the startup warning queued behind a refused thread/start, ahead of the failure", async () => {
    const script: Script = {
      afterInitialize: [startup, malformed],
      afterThreadStart: [],
      inTurn: [],
      refuse: "thread/start",
    };
    const events = await collect(script);
    // The malformed frame is not delivered; the secret-free text and params stay as they came.
    expect(events.map((event) => event.type)).toEqual(["status", "error", "completed"]);
    expect(events[0]).toMatchObject({
      text: BWRAP,
      payload: {
        code: "codex_native_warning",
        native_method: "configWarning",
        native_params: { summary: BWRAP, details: null },
      },
    });
    expect(events[0]?.payload).not.toHaveProperty("subagent");
    expect(HarnessEvent.safeParse(events[0]).success).toBe(true);
    expect(events[1]).toMatchObject({
      error: expect.stringContaining("thread/start refused"),
      payload: { code: "codex_app_server_failure" },
    });
    expect(events[2]?.payload).toMatchObject({ code: "codex_app_server_failure" });
    expect(withoutWarnings(events)).toEqual(
      withoutWarnings(await collect({ ...script, afterInitialize: [] })),
    );
  });

  it("delivers the warnings queued behind a refused turn/start in arrival order, ahead of the failure", async () => {
    const script: Script = {
      afterInitialize: [startup],
      afterThreadStart: [
        warning({ threadId: "thread-1", message: MODEL_METADATA }),
        warning({ threadId: "child-1", message: LOG_WRITE }),
      ],
      inTurn: [],
      refuse: "turn/start",
    };
    const events = await collect(script);
    expect(events.map((event) => event.type)).toEqual([
      "status",
      "status",
      "status",
      "error",
      "completed",
    ]);
    expect(texts(events)).toEqual([BWRAP, MODEL_METADATA, LOG_WRITE]);
    // The root is bound by now: only the other thread's frame is a sub-agent's.
    expect(
      events
        .slice(0, 3)
        .map((event) => [
          event.payload?.["subagent"] ?? false,
          event.payload?.["native_thread_id"],
        ]),
    ).toEqual([
      [false, undefined],
      [false, undefined],
      [true, "child-1"],
    ]);
    expect(events.at(-1)?.payload).toMatchObject({
      code: "codex_app_server_failure",
      native_session_id: "thread-1",
    });
    expect(withoutWarnings(events)).toEqual(
      withoutWarnings(await collect({ ...script, afterInitialize: [], afterThreadStart: [] })),
    );
  });

  it("delivers warnings that arrive while the settled run is read and while its process stops", async () => {
    const script: Script = {
      afterInitialize: [],
      afterThreadStart: [],
      inTurn: [],
      onThreadRead: [warning({ threadId: "thread-1", message: MODEL_METADATA })],
      onStop: [warning({ threadId: null, message: LOG_WRITE })],
    };
    const events = await collect(script);
    const delivered = events.filter(isNative);
    expect(delivered.map((event) => [event.text, event.payload?.["native_params"]])).toEqual([
      [MODEL_METADATA, { threadId: "thread-1", message: MODEL_METADATA }],
      [LOG_WRITE, { threadId: null, message: LOG_WRITE }],
    ]);
    // Ahead of the typed final and of the single terminal event; evidence only.
    expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("completed");
    expect(events.indexOf(delivered.at(-1)!)).toBeLessThan(
      events.findIndex((event) => event.final),
    );
    expect(events.filter((event) => event.final).map((event) => event.text)).toEqual([
      "Text-only answer.",
    ]);
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(events.at(-1)?.payload).toMatchObject({ native_session_id: "thread-1" });
    expect(events.at(-1)?.payload).not.toHaveProperty("harness_reported_error");
    expect(withoutWarnings(events)).toEqual(
      withoutWarnings(await collect({ ...script, onThreadRead: [], onStop: [] })),
    );
  });

  it("delivers the queued warning ahead of a resume identity refusal, which still starts no turn", async () => {
    const script: Script = {
      afterInitialize: [startup],
      afterThreadStart: [],
      inTurn: [],
      resume: "expected-thread",
    };
    const events = await collect(script);
    expect(events.map((event) => event.type)).toEqual(["status", "error", "completed"]);
    expect(texts(events)).toEqual([BWRAP]);
    expect(events[1]).toMatchObject({
      payload: {
        code: "resume_identity_mismatch",
        expected_thread_id: "expected-thread",
        observed_thread_id: "thread-1",
      },
    });
    expect(events[2]?.payload).toMatchObject({ code: "resume_identity_mismatch" });
    expect(withoutWarnings(events)).toEqual(
      withoutWarnings(await collect({ ...script, afterInitialize: [] })),
    );
  });

  it("attributes a sub-agent's late warning to its own thread, as the run loop does", async () => {
    const events = await collect({
      afterInitialize: [],
      afterThreadStart: [],
      inTurn: [],
      onThreadRead: [warning({ threadId: "child-1", message: LOG_WRITE })],
    });
    const [delivered] = events.filter(isNative);
    expect(delivered).toMatchObject({
      type: "status",
      text: LOG_WRITE,
      payload: { native_thread_id: "child-1", subagent: true },
    });
    // Neither the answer nor the outcome is the sub-agent's.
    expect(events.filter((event) => event.final).map((event) => event.text)).toEqual([
      "Text-only answer.",
    ]);
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(events.at(-1)?.payload).toMatchObject({
      native_session_id: "thread-1",
      subagent_threads: 1,
    });
  });

  it("still fails a completed answer that a late root turn invalidates, the warning ahead of the failure", async () => {
    const lateTurn = {
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-2" } },
    };
    const script: Script = {
      afterInitialize: [],
      afterThreadStart: [],
      inTurn: [],
      onStop: [warning({ threadId: "thread-1", message: LOG_WRITE }), lateTurn],
    };
    const events = await collect(script);
    const types = events.map((event) => event.type);
    expect(texts(events)).toEqual([LOG_WRITE]);
    expect(types.slice(-2)).toEqual(["error", "completed"]);
    expect(events.at(-2)?.error).toContain("invalidated during process teardown");
    expect(events.findIndex(isNative)).toBeLessThan(types.indexOf("error"));
    expect(withoutWarnings(events)).toEqual(
      withoutWarnings(await collect({ ...script, onStop: [lateTurn] })),
    );
  });
});

describe("CodexSubagentThreads.takeWarnings", () => {
  it("takes the readable warnings once, in arrival order, and leaves every other frame queued", () => {
    const turn = { method: "turn/started", params: { threadId: "thread-1", turn: { id: "t" } } };
    const status = { method: "remoteControl/status/changed", params: { status: "disabled" } };
    const unreadable = configWarning({ summary: 42 });
    const queue: Frame[] = [
      turn,
      configWarning({ summary: BWRAP, details: null }),
      unreadable,
      warning({ threadId: "child-1", message: LOG_WRITE }),
      status,
      warning({ threadId: null, message: MODEL_METADATA }),
    ];
    const subagents = new CodexSubagentThreads();
    const taken = subagents.takeWarnings(queue, "thread-1", "session-take");
    expect(taken.map((event) => [event.text, event.payload?.["subagent"] ?? false])).toEqual([
      [BWRAP, false],
      [LOG_WRITE, true],
      [MODEL_METADATA, false],
    ]);
    expect(queue).toEqual([turn, unreadable, status]);
    expect(subagents.takeWarnings(queue, "thread-1", "session-take")).toEqual([]);
    expect(queue).toEqual([turn, unreadable, status]);
  });

  it("treats every frame as the run's until the root is bound", () => {
    const queue: Frame[] = [warning({ threadId: "child-1", message: LOG_WRITE })];
    const subagents = new CodexSubagentThreads();
    const [event] = subagents.takeWarnings(queue, null, "session-take");
    expect(event?.payload).toEqual({
      code: "codex_native_warning",
      native_method: "warning",
      native_params: { threadId: "child-1", message: LOG_WRITE },
    });
    expect(subagents.count).toBe(0);
    expect(queue).toEqual([]);
  });
});
