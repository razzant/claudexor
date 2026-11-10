import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AnswerAssembly,
  runCliHarness,
  streamExpectationViolations,
  validateTypedStream,
  type ChildStdin,
  type CliRunLoopOptions,
  type FixtureStreamExpectations,
  type LiveMessageResult,
} from "@claudexor/core";
import {
  HarnessRunSpec,
  type HarnessEvent,
  type InteractionAnswerSet,
  type InteractionRequest,
} from "@claudexor/schema";
import { parse as parseYaml } from "yaml";
import { createClaudeAdapter } from "./index.js";
import { FOREIGN_RESULT, LIVE_INPUT_DELIVERED } from "./live-input.js";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
const manifest = parseYaml(readFileSync(join(FIXTURES, "manifest.yaml"), "utf8")) as {
  fixtures: Record<string, { expectations?: FixtureStreamExpectations }>;
};

interface WireRecord {
  direction: "client->cli" | "cli->client";
  frame: Record<string, any>;
}

/**
 * A fake Claude CLI that replays a DIRECTIONAL recording 1:1: every
 * `cli->client` frame is printed in order, and every `client->cli` frame is a
 * barrier released only once a stdin frame of the recorded type arrived (the
 * initialize handshake, the initial prompt, a question's control response, the
 * live message) — so the wire the adapter drives is exactly the recorded one.
 * Like the real CLI it names the prompt frame it was sent: every value equal to
 * the recording's prompt uuid (the JSON alias argument; null for a recording
 * whose prompt carries none) becomes the uuid the adapter actually wrote. It
 * exits 0 once the adapter closes stdin (the cooperative end), after flushing
 * stdout; when stdin closes before a barrier, that client frame can never
 * arrive: it says so on stderr and exits 3.
 */
const FAKE_REPLAY_CLI = `
const fs = require('node:fs');
const [file, aliasJson] = process.argv.slice(-2);
const alias = JSON.parse(aliasJson);
const records = fs.readFileSync(file, 'utf8').split('\\n').filter(Boolean).map(JSON.parse);
const rl = require('node:readline').createInterface({ input: process.stdin });
const inbox = []; let waiting = null; let closed = false; let prompt = null;
const wake = () => { if (waiting) { const w = waiting; waiting = null; w(); } };
rl.on('line', (line) => { inbox.push(JSON.parse(line)); wake(); });
rl.on('close', () => { closed = true; wake(); });
const bind = (v) => alias !== null && v === alias ? prompt : Array.isArray(v) ? v.map(bind)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bind(x)])) : v;
(async () => {
  for (const record of records) {
    if (record.direction === 'cli->client') { process.stdout.write(JSON.stringify(bind(record.frame)) + '\\n'); continue; }
    for (;;) {
      const idx = inbox.findIndex((m) => m.type === record.frame.type);
      if (idx >= 0) { const [m] = inbox.splice(idx, 1); if (m.type === 'user' && prompt === null) prompt = m.uuid; break; }
      if (closed) {
        process.stderr.write('stdin closed before the recorded ' + record.frame.type + ' frame\\n');
        process.stdout.write('', () => process.exit(3));
        return;
      }
      await new Promise((resolve) => { waiting = resolve; });
    }
  }
  while (!closed) await new Promise((resolve) => { waiting = resolve; });
  process.stdout.write('', () => process.exit(0));
})();
`;

function readRecording(name: string): WireRecord[] {
  return readFileSync(join(FIXTURES, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WireRecord);
}

const clientUsers = (records: WireRecord[]) =>
  records.filter((r) => r.direction === "client->cli" && r.frame["type"] === "user");

const textOf = (frame: Record<string, any>): string => {
  const content = frame["message"]["content"];
  return (typeof content === "string" ? content : content[0]["text"]) as string;
};

interface ReplayOptions {
  /** Send the recording's live message (its second client user frame) on the first event of this type. */
  liveOn?: HarnessEvent["type"];
  /** The run's interaction channel; the default answers nothing (the benign decline). */
  answer?: (interaction: InteractionRequest) => Promise<InteractionAnswerSet | null>;
  /** Replay the recording's frames in another order. */
  reorder?: (records: WireRecord[]) => WireRecord[];
  /** Change named frames' fields before the replay: frame uuid to the new fields. */
  rewrite?: Record<string, Record<string, unknown>>;
}

interface Replay {
  events: HarnessEvent[];
  receipt: LiveMessageResult | undefined;
  liveMessageId: string | undefined;
  args: string[];
  expectations: FixtureStreamExpectations;
  /** The frames the adapter closed stdin on (asked only while stdin is open). */
  closedOn: Array<Record<string, any>>;
  /** What reached the run's interaction channel. */
  questions: InteractionRequest[];
  /** The control responses the adapter wrote to the CLI. */
  responses: Array<Record<string, any>>;
}

/** Record every frame the adapter writes; never change one. */
function recordingStdin(io: ChildStdin, written: Array<Record<string, any>>): ChildStdin {
  const record = (data: string) => written.push(JSON.parse(data) as Record<string, any>);
  return {
    write: (data) => {
      record(data);
      io.write(data);
    },
    ...(io.send
      ? {
          send: (data: string) => {
            record(data);
            return io.send!(data);
          },
        }
      : {}),
    end: () => io.end(),
    closed: io.closed,
  };
}

/** One run through the REAL adapter and run loop; only the binary is the replay. */
async function replay(name: string, options: ReplayOptions = {}): Promise<Replay> {
  const original = readRecording(name).map((record) => ({
    ...record,
    frame: { ...record.frame, ...options.rewrite?.[record.frame["uuid"] as string] },
  }));
  const records = options.reorder ? options.reorder(original) : original;
  const users = clientUsers(original);
  const prompt = textOf(users[0]!.frame);
  const alias = typeof users[0]!.frame["uuid"] === "string" ? users[0]!.frame["uuid"] : null;
  const live = options.liveOn
    ? { messageId: users[1]!.frame["uuid"] as string, text: textOf(users[1]!.frame) }
    : undefined;
  const expectations = manifest.fixtures[name]?.expectations;
  expect(expectations, `manifest expectations missing for ${name}`).toBeTruthy();
  const dir = mkdtempSync(join(tmpdir(), "claudexor-claude-replay-"));
  const file = join(dir, "recording.jsonl");
  writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const closedOn: Array<Record<string, any>> = [];
  const questions: InteractionRequest[] = [];
  const responses: Array<Record<string, any>> = [];
  let args: string[] = [];
  // The REAL adapter path (runClaude -> runCliHarness with the adapter's own
  // argv, session hooks and live-input owner); only the binary is the replay.
  const adapter = createClaudeAdapter({
    detectVersion: async () => "2.1.283",
    probeReadonlyProfile: async () => ({ supported: true, missingFlags: [], detail: "ok" }),
    probeAuthStatus: async () => ({
      loggedIn: true,
      authed: true,
      authMethod: "claude.ai",
      probeError: null,
    }),
    anthropicApiKey: () => null,
    claudeOAuthToken: () => null,
    probeEffortLevels: async () => ({ levels: [], live: true }),
    runCliHarness: (loop: CliRunLoopOptions) => {
      args = loop.args;
      const session = loop.session!;
      return runCliHarness({
        ...loop,
        bin: process.execPath,
        args: ["-e", FAKE_REPLAY_CLI, file, JSON.stringify(alias)],
        session: {
          ...session,
          handle: (obj, io) => session.handle(obj, recordingStdin(io, responses)),
          closeStdinOn: (obj) => {
            const close = session.closeStdinOn!(obj);
            if (close) closedOn.push(obj as Record<string, any>);
            return close;
          },
        },
      });
    },
  });
  const spec = HarnessRunSpec.parse({
    session_id: `ses-${name.replace(/[^a-z0-9]+/gi, "-")}`,
    intent: "implement",
    prompt,
    cwd: process.cwd(),
    access: "full",
    model_hint: "sonnet",
    auth_preference: "subscription",
    extra: {
      interactionChannel: {
        request: async (interaction: InteractionRequest) => {
          questions.push(interaction);
          return options.answer ? options.answer(interaction) : null;
        },
      },
    },
  });
  const events: HarnessEvent[] = [];
  let receipt: Promise<LiveMessageResult> | undefined;
  try {
    for await (const event of adapter.run(spec)) {
      events.push(event);
      if (live && !receipt && event.type === options.liveOn)
        receipt = adapter.message!(spec.session_id, live);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (live) expect(receipt, "the trigger event never arrived").toBeTruthy();
  return {
    events,
    receipt: receipt ? await receipt : undefined,
    liveMessageId: live?.messageId,
    args,
    expectations: expectations!,
    closedOn,
    questions,
    responses,
  };
}

/** Choose the first option of every question: an answered question. */
async function firstOption(interaction: InteractionRequest): Promise<InteractionAnswerSet> {
  return {
    interaction_id: interaction.interaction_id,
    answers: interaction.questions.map((q) => ({
      question_id: q.id,
      selected_labels: q.options.slice(0, 1).map((o) => o.label),
      free_text: null,
    })),
  };
}

/** The run loop's terminal event, always the last one. */
const terminal = (events: HarnessEvent[]): HarnessEvent | undefined => {
  const last = events.at(-1);
  return last?.type === "completed" ? last : undefined;
};

function expectCleanEnd(events: HarnessEvent[]): void {
  expect(terminal(events)?.payload?.["exit_code"], "replay exit code").toBe(0);
  expect(terminal(events)?.payload).not.toHaveProperty("dropped_unrecognized_events");
  expect(events.some((e) => e.type === "error")).toBe(false);
}

function expectRecordedQuotaWindows(events: HarnessEvent[]): void {
  const measured = events.filter((event) => event.quota !== undefined);
  expect(measured).toHaveLength(2);
  expect(measured.map((event) => event.quota?.constraints[0]?.id).sort()).toEqual([
    "five_hour",
    "seven_day",
  ]);
  for (const event of measured) {
    expect(event).toMatchObject({
      type: "status",
      credential_route: "vendor_native",
      credential_source: "native_session",
      quota: {
        source: "claude_rate_limit_event",
        constraints: [
          expect.objectContaining({
            used_ratio: 0.5,
            resets_at: new Date(1700000000 * 1000).toISOString(),
          }),
        ],
      },
    });
    expect(event.quota?.constraints).toHaveLength(1);
    expect(event.usage).toBeUndefined();
    expect(event.rate_limit).toBeUndefined();
  }
}

describe("claude live-input recordings (2.1.283), replayed through the real adapter", () => {
  it("fold: a message written while a tool runs is queued (accepted) and consumed inside the same turn (one delivered receipt, one result that names the prompt and closes stdin)", async () => {
    const name = "stream-json/recorded-live-fold-2.1.283.jsonl";
    const { events, receipt, liveMessageId, args, expectations, closedOn } = await replay(name, {
      liveOn: "tool_call",
    });
    expect(args).toContain("--replay-user-messages");
    expect(receipt).toEqual({ outcome: "accepted" });
    // The ONE result names the prompt and the message: stdin closes there.
    expect(closedOn.map((frame) => frame["uuid"])).toEqual(["uuid-fixture-22"]);
    expect(closedOn[0]?.["user_message_uuids"]).toHaveLength(2);
    // Exactly ONE consumption receipt, for OUR uuid: the initial prompt's own
    // replay echo (not a live message) and the later started/completed frames
    // and the result's uuid list re-announce nothing.
    expectRecordedQuotaWindows(events);
    expect(events.filter((e) => e.type === "status" && !e.quota)).toEqual([
      expect.objectContaining({
        effort_resolution: {
          requested: null,
          submitted: null,
          parameter: "--effort",
          resolution: "omitted",
          source: "live_probe",
          observed: null,
          observedSource: null,
        },
      }),
      expect.objectContaining({
        payload: { code: LIVE_INPUT_DELIVERED, message_id: liveMessageId },
        credential_route: "vendor_native",
      }),
    ]);
    expect(events.find((e) => e.effort_resolution)?.text).toBeUndefined();
    expect(events.find((e) => e.effort_resolution)?.payload).toBeUndefined();
    expect(streamExpectationViolations(events, expectations)).toEqual([]);
    const stats = validateTypedStream(events);
    expect(stats.started).toBe(1);
    expect(stats.toolCalls).toBe(2);
    expect(stats.toolResults).toBe(2);
    expect(stats.statuslessToolResults).toBe(0);
    // One result → the full cumulative cost, once.
    expect(events.filter((e) => e.type === "usage").map((e) => e.usage?.cost_usd)).toEqual([
      0.20760599999999998,
    ]);
    const answer = new AnswerAssembly();
    for (const e of events) answer.observe(e);
    expect(answer.text()).toContain("MANGO");
    // Every recorded frame is recognized (replay echo, command_lifecycle,
    // task frames, rate-limit heartbeat): nothing dropped, exit 0, no error.
    expect(events.at(-1)).toMatchObject({ type: "completed", payload: { exit_code: 0 } });
    expect(events.at(-1)?.payload).not.toHaveProperty("harness_reported_error");
    expectCleanEnd(events);
  }, 20_000);

  it("final text: a message that arrives after the last tool result runs as the next native turn of the same run (stdin held past the prompt's own result, one started, cost delta, last final wins)", async () => {
    const name = "stream-json/recorded-live-final-text-2.1.283.jsonl";
    const { events, receipt, liveMessageId, expectations, closedOn } = await replay(name, {
      liveOn: "tool_result",
    });
    expect(receipt).toEqual({ outcome: "accepted" });
    // Result#1 names the prompt; the queued message still holds stdin for the
    // next native turn, and result#2 (naming only the message) closes it.
    expect(closedOn.map((frame) => frame["uuid"])).toEqual(["uuid-fixture-20"]);
    const preparation = events.find((e) => e.type === "status")!;
    expect(preparation.effort_resolution).toEqual({
      requested: null,
      submitted: null,
      parameter: "--effort",
      resolution: "omitted",
      source: "live_probe",
      observed: null,
      observedSource: null,
    });
    expect(preparation.text).toBeUndefined();
    expect(preparation.payload).toBeUndefined();
    expectRecordedQuotaWindows(events);
    const statuses = events.filter((e) => e.type === "status" && !e.quota).map((e) => e.payload);
    expect(statuses).toEqual([
      undefined,
      { code: LIVE_INPUT_DELIVERED, message_id: liveMessageId },
      { code: "native_turn_started", turn: 2 },
    ]);
    expect(streamExpectationViolations(events, expectations)).toEqual([]);
    expect(validateTypedStream(events).started).toBe(1);
    // total_cost_usd is cumulative (0.0963518 → 0.114749): the second usage is
    // the DELTA, so the orchestrator's sum equals the CLI's final total.
    const costs = events.filter((e) => e.type === "usage").map((e) => e.usage?.cost_usd ?? 0);
    expect(costs[0]).toBe(0.0963518);
    expect(costs[1]).toBeCloseTo(0.0183972, 10);
    expect(costs.reduce((a, b) => a + b, 0)).toBeCloseTo(0.114749, 10);
    // Two results → two finals; the run's answer is the LAST one.
    const finals = events.filter((e) => e.type === "message" && e.final === true);
    expect(finals).toHaveLength(2);
    const answer = new AnswerAssembly();
    for (const e of events) answer.observe(e);
    expect(answer.text()).toBe("MANGO");
    // The hold worked end to end: the fake CLI only exits once stdin closes,
    // and the run loop closed it at result#2, not result#1 (the replay would
    // otherwise exit 3 at the barrier or be cut short before the second turn).
    expectCleanEnd(events);
  }, 20_000);
});

describe("claude live input: the current prompt's own result ends the session (#536)", () => {
  const name = "stream-json/scripted-resumed-foreign-result.jsonl";

  /** The scripted session with its earlier turn's result BEFORE Claude Code reports the prompt. */
  const earlierResultFirst = (records: WireRecord[]): WireRecord[] => {
    const queued = records.findIndex(
      (r) => r.frame["type"] === "command_lifecycle" && r.frame["state"] === "queued",
    );
    const foreign = records.findIndex((r) => r.frame["uuid"] === "result-foreign");
    expect(queued).toBeGreaterThan(-1);
    expect(foreign).toBeGreaterThan(queued);
    const reordered = records.filter((_, index) => index !== queued);
    reordered.splice(foreign, 0, records[queued]!);
    return reordered;
  };

  it.each([
    ["after Claude Code reported the prompt", undefined],
    ["before Claude Code reported the prompt", earlierResultFirst],
  ] as const)(
    "a resumed session's earlier result %s does not close stdin while the prompt runs: the live message and the question reach the turn, and stdin closes on the prompt's own result",
    async (_order, reorder) => {
      const run = await replay(name, { liveOn: "tool_call", answer: firstOption, reorder });
      // The symptoms of #536, checked together so a regression shows all of them.
      expect
        .soft(
          run.closedOn.map((frame) => frame["uuid"]),
          "stdin must close on the prompt's own result only",
        )
        .toEqual(["result-own"]);
      expect.soft(run.receipt, "the live message sent during the prompt's work").toEqual({
        outcome: "accepted",
      });
      expect
        .soft(
          run.questions.map((q) => q.questions[0]?.question),
          "the question asked during the prompt's work reaches the channel",
        )
        .toEqual(["Which rollout should I use?"]);
      expect
        .soft(
          run.responses.map((frame) => frame["response"]?.["response"]?.["behavior"]),
          "its answer reaches the CLI",
        )
        .toEqual(["allow"]);
      expectCleanEnd(run.events);
      // The message is consumed once, by the running turn.
      expect(
        run.events
          .filter((e) => e.type === "status" && e.payload?.["code"] === LIVE_INPUT_DELIVERED)
          .map((e) => e.payload?.["message_id"]),
      ).toEqual([run.liveMessageId]);
      // The earlier result and the prompt's turn fold into one run.
      expect(run.events.filter((e) => e.type === "started")).toHaveLength(1);
      expect(
        run.events
          .filter((e) => e.payload?.["code"] === "native_turn_started")
          .map((e) => e.payload),
      ).toEqual([{ code: "native_turn_started", turn: 2 }]);
      expect(run.events.filter((e) => e.type === "usage").map((e) => e.usage?.cost_usd)).toEqual([
        0, 0.0421,
      ]);
      const answer = new AnswerAssembly();
      for (const e of run.events) answer.observe(e);
      expect(answer.text()).toBe("Check passed (CHECK_OK); rolling out Canary first. MANGO.");
      expect(streamExpectationViolations(run.events, run.expectations)).toEqual([]);
    },
    20_000,
  );

  /** The status diagnostics the run kept of the earlier turn's result. */
  const foreignDiagnostics = (events: HarnessEvent[]) =>
    events.filter((e) => e.type === "status" && e.payload?.["code"] === FOREIGN_RESULT);

  const executionFailure = { subtype: "error_during_execution", is_error: true, result: "" };

  it.each([
    ["an execution failure", executionFailure, ["result subtype: error_during_execution"]],
    [
      "an execution failure with partial output",
      { ...executionFailure, result: "partial work of the earlier turn" },
      ["partial work of the earlier turn", "result subtype: error_during_execution"],
    ],
    [
      "the turn limit",
      { subtype: "error_max_turns", is_error: true, result: "", num_turns: 9 },
      ["max-turns limit reached after 9 turns before a final answer; the partial work is kept"],
    ],
    [
      "an API failure",
      { is_error: true, api_error_status: 529, result: "API Error: 529 overloaded" },
      ["API Error: 529 overloaded", "API Error: 529 overloaded"],
    ],
    [
      "a context limit",
      { is_error: true, terminal_reason: "prompt_too_long", result: "Prompt is too long" },
      ["Prompt is too long", "prompt_too_long"],
    ],
    [
      "an entitlement refusal",
      {
        is_error: true,
        result: "Your organization has disabled Claude subscription access for Claude Code",
      },
      [
        "Your organization has disabled Claude subscription access for Claude Code",
        "entitlement: Your organization has disabled Claude subscription access for Claude Code",
      ],
    ],
    ["its own answer", { result: "The earlier turn's answer." }, ["The earlier turn's answer."]],
  ] as const)(
    "%s in a resumed session's earlier result is kept as a diagnostic and the run ends on its prompt's own clean result",
    async (_case, earlier, diagnostics) => {
      const run = await replay(name, {
        liveOn: "tool_call",
        answer: firstOption,
        rewrite: { "result-foreign": { ...earlier } },
      });
      expect(foreignDiagnostics(run.events).map((e) => e.text)).toEqual([...diagnostics]);
      expect(run.closedOn.map((frame) => frame["uuid"])).toEqual(["result-own"]);
      // No error event, exit 0, nothing dropped: the run loop's and the
      // orchestrator's error test both read this stream as clean.
      expectCleanEnd(run.events);
      expect(terminal(run.events)?.payload).not.toHaveProperty("harness_reported_error");
      expect(terminal(run.events)?.payload).not.toHaveProperty("vendor_failure");
      for (const event of run.events) {
        expect(event.turn_limit).toBeUndefined();
        expect(event.request_refusal).toBeUndefined();
        expect(event.context).toBeUndefined();
        expect(event.status?.error_category).toBeUndefined();
        expect(event.payload?.["non_success_result"]).toBeUndefined();
        expect(event.payload?.["entitlement_denied"]).toBeUndefined();
      }
      // The run's one final answer is its prompt's.
      expect(streamExpectationViolations(run.events, run.expectations)).toEqual([]);
      const answer = new AnswerAssembly();
      for (const e of run.events) answer.observe(e);
      expect(answer.text()).toBe("Check passed (CHECK_OK); rolling out Canary first. MANGO.");
      expect(run.receipt).toEqual({ outcome: "accepted" });
    },
    20_000,
  );

  it("the prompt's own failure after an earlier failed result is still this run's error", async () => {
    const run = await replay(name, {
      liveOn: "tool_call",
      answer: firstOption,
      rewrite: { "result-foreign": executionFailure, "result-own": executionFailure },
    });
    expect(foreignDiagnostics(run.events).map((e) => e.text)).toEqual([
      "result subtype: error_during_execution",
    ]);
    expect(run.events.filter((e) => e.type === "error").map((e) => e.error)).toEqual([
      "result subtype: error_during_execution",
    ]);
    expect(terminal(run.events)?.payload?.["harness_reported_error"]).toBe(true);
    expect(run.closedOn.map((frame) => frame["uuid"])).toEqual(["result-own"]);
  }, 20_000);

  it("a failed result naming only this session's live message is still this run's error", async () => {
    const run = await replay(name, {
      liveOn: "tool_call",
      answer: firstOption,
      rewrite: {
        "result-own": { ...executionFailure, user_message_uuids: ["live-msg-536"] },
      },
    });
    expect(run.events.filter((e) => e.type === "error").map((e) => e.error)).toEqual([
      "result subtype: error_during_execution",
    ]);
    expect(terminal(run.events)?.payload?.["harness_reported_error"]).toBe(true);
    expect(foreignDiagnostics(run.events)).toEqual([]);
  }, 20_000);

  it("a failed result of a stream that never names a command is still this run's error (recorded 2.1.281 handshake)", async () => {
    const run = await replay("protocol/control-handshake.jsonl", {
      rewrite: { "fixture-id-15": executionFailure },
    });
    expect(run.closedOn.map((frame) => frame["uuid"])).toEqual(["fixture-id-15"]);
    expect(run.events.filter((e) => e.type === "error").map((e) => e.error)).toEqual([
      "result subtype: error_during_execution",
    ]);
    expect(terminal(run.events)?.payload?.["harness_reported_error"]).toBe(true);
    expect(foreignDiagnostics(run.events)).toEqual([]);
  }, 20_000);

  it("a stream that never names a command keeps the old rule and closes on its first result (recorded 2.1.281 handshake: no lifecycle, no user_message_uuids)", async () => {
    const run = await replay("protocol/control-handshake.jsonl");
    expect(run.closedOn.map((frame) => frame["uuid"])).toEqual(["fixture-id-15"]);
    expect(run.closedOn[0]).not.toHaveProperty("user_message_uuids");
    expect(run.questions).toHaveLength(1);
    expectCleanEnd(run.events);
  }, 20_000);
});

describe("claude questions read after the session's input closed (#622)", () => {
  it("records the input state when Claudexor read the question, not when the CLI asked it: the own result closed stdin while the question was already on its way", async () => {
    // The replay prints every frame after the prompt without waiting, so the
    // CLI asked before it could see EOF; the run loop closed stdin on the
    // prompt's own result and only then read the question.
    const run = await replay("stream-json/scripted-question-after-own-result.jsonl");
    expect(run.closedOn.map((frame) => frame["uuid"])).toEqual(["result-own"]);
    expect(run.questions).toEqual([]);
    expect(run.responses).toEqual([]);
    const status = run.events.filter(
      (e) => e.type === "status" && e.payload?.["code"] === "interaction_answer_unavailable",
    );
    expect(status).toEqual([
      expect.objectContaining({
        text: "AskUserQuestion req-late could not be answered: this session's input was already closed when Claudexor read the request",
        payload: expect.objectContaining({
          reason: "input_closed",
          interaction_id: "req-late",
          tool_use_id: "toolu_late-2",
        }),
      }),
    ]);
    expect(
      run.events.find((e) => e.type === "thinking" && e.payload?.["tool"] === "AskUserQuestion"),
    ).toMatchObject({
      text: "AskUserQuestion returned an error instead of answers; this session's input was already closed when Claudexor read the question: Tool permission request failed: AbortError: Stream closed",
      payload: { tool_use_id: "toolu_late-2", session_input: "closed" },
    });
    for (const event of run.events) expect(event.text ?? "").not.toMatch(/when it was asked/);
    expect(streamExpectationViolations(run.events, run.expectations)).toEqual([]);
    expectCleanEnd(run.events);
  }, 20_000);
});
