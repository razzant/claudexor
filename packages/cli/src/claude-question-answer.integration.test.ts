/**
 * #560: a Claude `AskUserQuestion` answered through the production answer
 * path. HTTP control API (and the MCP tools and `claudexor follow`) -> daemon
 * InteractionRegistry over the SQL engine store -> the orchestrator's
 * interaction channel -> the real Claude adapter run and core run loop -> a
 * synthetic Claude CLI child process that speaks the recorded stream-json
 * control protocol. The vendor binary and the run around the adapter are
 * synthetic: the fixture runner stands in for the orchestrator's attempt loop,
 * journaling each adapter event as that loop does (the production
 * `harnessEventPayload` projection into the run's one EventLog, which the
 * interaction channel writes too), and the fixture reduces the lifecycle itself;
 * no attempt telemetry or outcome facts are produced. The assertions read what
 * the child process actually received on its stdin. No live Claude CLI runs
 * here; the installed vendor protocol may differ from the recording.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCliHarness, type CliRunLoopOptions } from "@claudexor/core";
import { EngineStore } from "@claudexor/daemon";
import { HarnessRunSpec, type Attachment, type HarnessEvent } from "@claudexor/schema";
import { createClaudeAdapter } from "../../harness-claude/src/index.js";
import { DECLINE_MESSAGE } from "../../harness-claude/src/interactive.js";
import { unavailableDenyMessage } from "../../harness-claude/src/question-outcome.js";
import {
  createAttemptTelemetry,
  observeAttemptTelemetry,
  unrecoveredToolErrors,
} from "../../orchestrator/src/attemptTelemetry.js";
import { interactionChannelFor } from "../../orchestrator/src/interaction.js";
import { harnessEventPayload } from "../../orchestrator/src/runSupport.js";
import { followRun } from "./live.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";
import { mcpWire, startInteractionDaemon } from "./test-support/interaction-daemon.js";

type Json = Record<string, any>;

const address = vi.hoisted(() => ({ baseUrl: "", token: "fixture" }));
vi.mock("./control-api-address.js", () => ({ controlApiAddress: () => address }));
// `claudexor follow` reads the controlling terminal through readline/promises.
const tty = vi.hoisted(() => ({ replies: [] as string[], prompts: [] as string[] }));
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    async question(prompt: string) {
      tty.prompts.push(prompt);
      return tty.replies.shift() ?? "";
    },
    close() {},
  }),
}));

const cleanups: Array<() => void | Promise<void>> = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0).reverse();
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});

/**
 * Synthetic Claude CLI. It records every stdin line it receives, answers the
 * initialize handshake, raises ONE AskUserQuestion permission request with the
 * scenario's native questions (frame shapes from
 * harness-claude/fixtures/protocol/control-handshake.jsonl), and after the
 * control_response reports the tool result and a final answer. The result text
 * follows the recorded native format, looking each answer up by the exact
 * question text; when nothing matches it reports the no-answer text quoted in
 * #560. That lookup is an emulation of the recording, not the vendor's code.
 * It exits once the adapter closes stdin.
 */
const FAKE_CLAUDE = `
const fs = require('node:fs');
const [scenarioPath, capturePath] = process.argv.slice(-2);
const { questions, scenario } = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
const session = 'native-session-1';
const usage = { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const out = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
const assistant = (id, content) => out({ type: 'assistant', message: { id, type: 'message', role: 'assistant', content, model: 'claude-fable-5-1', stop_reason: null, stop_sequence: null, usage }, parent_tool_use_id: null, session_id: session, uuid: id });
const toolResult = (id, content, isError) => out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }, parent_tool_use_id: null, session_id: session, uuid: 'result-of-' + id });
const result = (text, uuids) => out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: session, num_turns: 2, duration_ms: 5, duration_api_ms: 4, total_cost_usd: 0, usage, stop_reason: 'end_turn', terminal_reason: 'completed', uuid: 'result-' + text, ...(uuids ? { user_message_uuids: uuids } : {}) });
const ask = () => {
  assistant('assistant-ask', [{ type: 'tool_use', id: 'toolu-ask', name: 'AskUserQuestion', input: { questions } }]);
  out({ type: 'control_request', request_id: 'ask-1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion', input: { questions }, tool_use_id: 'toolu-ask', requires_user_interaction: true } });
};
let asked = false;
let closed = false;
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  fs.appendFileSync(capturePath, line + '\\n');
  const frame = JSON.parse(line);
  if (frame.type === 'control_request' && frame.request && frame.request.subtype === 'initialize') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
    return;
  }
  if (frame.type === 'user' && !asked) {
    asked = true;
    out({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: session, tools: ['AskUserQuestion', 'Bash'], mcp_servers: [], model: 'claude-fable-5-1', permissionMode: 'default', claude_code_version: '2.1.281', uuid: 'init-1' });
    if (scenario !== 'late_question') return ask();
    // The current prompt's own final result (its echo and consumed uuid), then
    // a real work-tool failure: Claudexor closes stdin on this result.
    out({ type: 'user', isReplay: true, message: frame.message, parent_tool_use_id: null, session_id: session, uuid: frame.uuid });
    assistant('assistant-bash', [{ type: 'tool_use', id: 'toolu-bash', name: 'Bash', input: { command: 'make check' } }]);
    toolResult('toolu-bash', 'make: *** [check] Error 2', true);
    assistant('assistant-partial', [{ type: 'text', text: 'PARTIAL' }]);
    result('PARTIAL', [frame.uuid]);
    return;
  }
  if (frame.type === 'control_response' && frame.response && frame.response.request_id === 'ask-1') {
    const decision = frame.response.response || {};
    const allowed = decision.behavior === 'allow';
    const answers = (allowed && decision.updatedInput && decision.updatedInput.answers) || {};
    const pairs = questions.filter((q) => Object.prototype.hasOwnProperty.call(answers, q.question)).map((q) => '"' + q.question + '"="' + answers[q.question] + '"');
    const text = !allowed ? String(decision.message) : pairs.length ? 'Your questions have been answered: ' + pairs.join(', ') + '. You can now continue with these answers in mind.' : 'The user did not answer the questions.';
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-ask', content: text, ...(allowed ? {} : { is_error: true }) }] }, parent_tool_use_id: null, session_id: session, uuid: 'user-1', ...(allowed ? { tool_use_result: decision.updatedInput } : {}) });
    assistant('assistant-2', [{ type: 'text', text: 'DONE' }]);
    result('DONE');
  }
});
rl.on('close', () => {
  if (closed) return;
  closed = true;
  if (scenario === 'late_question') {
    // The CLI keeps working after Claudexor ended its input: the question's
    // permission request can no longer be answered over the closed stream.
    ask();
    toolResult('toolu-ask', 'Tool permission request failed: AbortError: Stream closed', true);
    assistant('assistant-late', [{ type: 'text', text: 'DONE with assumptions' }]);
    result('DONE with assumptions');
  }
  process.stdout.write('', () => process.exit(0));
});
`;

/** Native questions longer than every former display bound (question 2000,
 * header 100, option label 500, description 1000 characters). */
function longQuestions(): Json[] {
  return [
    {
      question: `Which rollout keeps the 🚀 release safe? ${"Подробности контекста ".repeat(120)}END`,
      header: `Rollout ${"h".repeat(150)}`,
      options: [
        { label: `Canary ${"a".repeat(700)}`, description: `First ${"d".repeat(1300)}` },
        { label: `Blue-green ${"b".repeat(700)}`, description: `Second ${"e".repeat(1300)}` },
      ],
      multiSelect: false,
    },
    {
      question: `Anything else to keep in mind? ${"x".repeat(2100)}`,
      options: [],
      multiSelect: false,
    },
  ];
}

const MULTILINE_FREE_TEXT = "\n  keep the indented first line\nand the trailing spaces  \n\n";

/** A digest-bound text resource: it keeps a Claude run on the interactive
 * stream-json path even when the run offers no answer channel. */
function textAttachment(runDir: string): Attachment {
  const path = join(runDir, "notes.txt");
  const bytes = Buffer.from("Neutral notes for the fixture run.\n");
  writeFileSync(path, bytes);
  return {
    resource_id: "res-notes",
    kind: "file",
    mime: "text/plain",
    name: "notes.txt",
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    size_bytes: bytes.length,
    path,
  };
}

/** A run journal whose append fails: the orchestrator's interaction channel
 * then rejects its request after invoking the answer surface. */
function failingJournal(): Parameters<typeof interactionChannelFor>[1] {
  return {
    emit: () => {
      throw new Error("journal append failed");
    },
  } as unknown as Parameters<typeof interactionChannelFor>[1];
}

async function fixture() {
  const harnessEvents = new Map<string, HarnessEvent[]>();
  const daemon = await startInteractionDaemon({
    cleanups,
    removals,
    harnessId: "claude",
    prompt: "Ask me first",
    waitMs: 10_000,
    execute: async ({ params, runId, runDir, signal, channel, log }, workspace) => {
      const scenario = String(params["scenario"] ?? "ask");
      const questionsPath = join(runDir, "native-questions.json");
      writeFileSync(questionsPath, JSON.stringify({ questions: params["questions"], scenario }));
      const spec = HarnessRunSpec.parse({
        session_id: runId,
        intent: "implement",
        prompt: String(params["prompt"]),
        cwd: workspace,
        access: "full",
        auth_preference: "subscription",
        attachments: scenario === "no_channel" ? [textAttachment(runDir)] : [],
      });
      // #622 scenarios: an attachment keeps the session interactive without an
      // answer channel; the orchestrator's own channel whose journal append
      // fails rejects the request.
      if (scenario === "channel_fails")
        spec.extra["interactionChannel"] = interactionChannelFor(
          { onInteraction: () => new Promise(() => undefined) },
          failingJournal(),
          runId,
          `task-${runId}`,
          "a01",
          "claude",
          true,
        );
      else if (scenario !== "no_channel") spec.extra["interactionChannel"] = channel;
      spec.extra["abortSignal"] = signal;
      // The REAL adapter run (runClaude -> runCliHarness with the adapter's own
      // session hooks); only the probes and the binary are replaced.
      const adapter = createClaudeAdapter({
        detectVersion: async () => "2.1.281",
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
        runCliHarness: (options: CliRunLoopOptions) =>
          runCliHarness({
            ...options,
            bin: process.execPath,
            args: ["-e", FAKE_CLAUDE, questionsPath, join(runDir, "native-stdin.jsonl")],
          }),
      });
      const events: HarnessEvent[] = [];
      harnessEvents.set(runId, events);
      for await (const event of adapter.run(spec)) {
        events.push(event);
        // The attempt loop's own journal write (orchestrator.ts).
        log.emit("harness.event", harnessEventPayload("claude", "a01", event));
      }
      return events;
    },
  });
  address.baseUrl = daemon.baseUrl;
  const started = (questions: Json[], extra: Record<string, unknown> = {}) =>
    daemon.started({ questions, ...extra });
  return { ...daemon, started, harnessEvents };
}

function jsonl(path: string): Json[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Json);
}

/** Every answer frame the synthetic Claude child read from its stdin. */
const nativeAnswers = (runDir: string) =>
  jsonl(join(runDir, "native-stdin.jsonl")).filter((frame) => frame["type"] === "control_response");

const interactionEvents = (runDir: string) =>
  jsonl(join(runDir, "events.jsonl")).filter((event) =>
    String(event["type"]).startsWith("interaction."),
  );

/** The journaled harness events: the collection a delegating parent reads. */
const journaledHarness = (runDir: string) =>
  jsonl(join(runDir, "events.jsonl"))
    .filter((row) => row["type"] === "harness.event")
    .map((row) => row["payload"] as Json);

/** The adapter's own "no answer can reach this question" observations (#622). */
const unavailableRecords = (events: readonly { payload?: Json }[]) =>
  events.filter((event) => event.payload?.["code"] === "interaction_answer_unavailable");

/** The benign record of the question tool's native error result. */
const questionRecord = (events: HarnessEvent[]) =>
  events.find(
    (event) => event.type === "thinking" && event.payload?.["tool"] === "AskUserQuestion",
  );

/** What the old mapping wrote for every question error result. */
const DECLINE_CLAIM = /declin|no user answer/i;

describe("Claude AskUserQuestion answers reach the native process exactly (#560)", () => {
  it("refuses rows that answer nothing without consuming the question, then delivers the exact long answer", async () => {
    const f = await fixture();
    const native = longQuestions();
    const run = await f.started(native);
    const [interaction] = await f.pending(run.runId, 1);
    // Every answering surface reads the native text itself, not a display copy.
    expect(interaction!.questions).toEqual([
      {
        id: "q1",
        question: native[0]!.question,
        header: native[0]!.header,
        options: native[0]!.options,
        multi_select: false,
      },
      { id: "q2", question: native[1]!.question, header: null, options: [], multi_select: false },
    ]);
    const requested = interactionEvents(run.runDir);
    expect(requested).toEqual([
      expect.objectContaining({
        type: "interaction.requested",
        payload: expect.objectContaining({ questions: interaction!.questions }),
      }),
    ]);
    const path = `/runs/${run.runId}/interactions/${interaction!.interactionId}/answer`;
    const longLabel = native[0]!.options[1].label as string;
    for (const answers of [
      [{ questionId: "q9", selectedLabels: [longLabel] }],
      [
        { questionId: "q1", selectedLabels: [longLabel] },
        { questionId: "q1", selectedLabels: [native[0]!.options[0].label] },
      ],
      [{ questionId: "q2", selectedLabels: [], freeText: null }],
      [{ questionId: "q2", selectedLabels: [], freeText: " \n\t " }],
      [
        { questionId: "q1", selectedLabels: [longLabel] },
        { questionId: "q2", selectedLabels: [] },
      ],
    ]) {
      expect(await f.http("POST", path, { answers }), JSON.stringify(answers)).toMatchObject({
        status: 409,
        body: { context: { accepted: false, status: "rejected" } },
      });
      await f.pending(run.runId, 1);
    }
    expect(nativeAnswers(run.runDir)).toEqual([]);
    expect(interactionEvents(run.runDir)).toHaveLength(1);

    expect(
      await f.http("POST", path, {
        answers: [
          { questionId: "q1", selectedLabels: [longLabel] },
          { questionId: "q2", selectedLabels: [], freeText: MULTILINE_FREE_TEXT },
        ],
      }),
    ).toMatchObject({ status: 200, body: { accepted: true, status: "delivered" } });
    expect((await f.terminal(run.id)).state).toBe("succeeded");

    const frames = nativeAnswers(run.runDir);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "ask-1",
        response: {
          behavior: "allow",
          updatedInput: {
            questions: native,
            answers: {
              [native[0]!.question]: longLabel,
              [native[1]!.question]: MULTILINE_FREE_TEXT,
            },
          },
        },
      },
    });
    // Old-mapping replay: the bounded display prefixes never stand in.
    const sent = frames[0]!["response"]["response"]["updatedInput"]["answers"] as Record<
      string,
      string
    >;
    expect(Object.keys(sent)).not.toContain(native[0]!.question.slice(0, 2000));
    expect(Object.values(sent)).not.toContain(longLabel.slice(0, 500));
    expect(interactionEvents(run.runDir).map((event) => event["type"])).toEqual([
      "interaction.requested",
      "interaction.answered",
    ]);
    expect(interactionEvents(run.runDir)[1]!["payload"]).toMatchObject({ answer_count: 2 });
    expect(f.harnessEvents.get(run.runId)?.find((event) => event.final)?.text).toBe("DONE");
    expect(
      await f.http("POST", path, { answers: [{ questionId: "q1", selectedLabels: [longLabel] }] }),
    ).toMatchObject({ status: 409, body: { context: { status: "already_resolved" } } });
  }, 30_000);

  it("answers a multi-option question with free text, the shape #560 reported, and the native result names it", async () => {
    const f = await fixture();
    const native = [
      {
        question: "Which rollout should I use?",
        header: "Rollout",
        options: [
          { label: "Canary", description: "Gradual traffic shift" },
          { label: "Blue-green", description: "Switch all traffic at once" },
        ],
        multiSelect: false,
      },
    ];
    const run = await f.started(native);
    const [interaction] = await f.pending(run.runId, 1);
    const freeText = "Neither: ship it behind a feature flag first";
    expect(
      await f.http("POST", `/runs/${run.runId}/interactions/${interaction!.interactionId}/answer`, {
        answers: [{ questionId: "q1", selectedLabels: [], freeText }],
      }),
    ).toMatchObject({ status: 200, body: { status: "delivered" } });
    expect((await f.terminal(run.id)).state).toBe("succeeded");
    expect(nativeAnswers(run.runDir).map((frame) => frame["response"]["response"])).toEqual([
      {
        behavior: "allow",
        updatedInput: { questions: native, answers: { "Which rollout should I use?": freeText } },
      },
    ]);
    // The tool result the run records comes from the synthetic CLI's lookup
    // by exact question text (the recorded native result format).
    const result = f.harnessEvents
      .get(run.runId)
      ?.find((event) => event.type === "tool_result" && event.tool?.name === "AskUserQuestion");
    expect(result?.tool?.status).toBe("ok");
    expect(result?.tool?.content_summary).toContain(`"Which rollout should I use?"="${freeText}"`);
    expect(result?.tool?.content_summary).not.toContain("did not answer");
    // An answered question has neither a no-answer record nor an observation (#622).
    const events = f.harnessEvents.get(run.runId)!;
    expect(unavailableRecords(events)).toEqual([]);
    expect(questionRecord(events)).toBeUndefined();
  }, 30_000);

  it("keeps an empty answer set as the caller's explicit decline: the native process gets the benign decline", async () => {
    const f = await fixture();
    const native = longQuestions();
    const run = await f.started(native);
    const [interaction] = await f.pending(run.runId, 1);
    expect(
      await f.http("POST", `/runs/${run.runId}/interactions/${interaction!.interactionId}/answer`, {
        answers: [],
      }),
    ).toMatchObject({ status: 200, body: { accepted: true, status: "delivered" } });
    expect((await f.terminal(run.id)).state).toBe("succeeded");
    expect(nativeAnswers(run.runDir).map((frame) => frame["response"]["response"])).toEqual([
      { behavior: "deny", message: DECLINE_MESSAGE, interrupt: false },
    ]);
    // A decline is not an answer: the run records no interaction.answered.
    expect(interactionEvents(run.runDir).map((event) => event["type"])).toEqual([
      "interaction.requested",
    ]);
    // The known decline keeps its benign text and no adapter observation (#622).
    const events = f.harnessEvents.get(run.runId)!;
    expect(unavailableRecords(events)).toEqual([]);
    expect(questionRecord(events)).toMatchObject({
      text: `AskUserQuestion returned an error instead of answers: ${DECLINE_MESSAGE}`,
      payload: { tool: "AskUserQuestion", tool_use_id: "toolu-ask", session_input: "open" },
    });
  }, 30_000);

  it("delivers a partial answer and joined multi-select labels, leaving the unanswered question out", async () => {
    const f = await fixture();
    const native = [
      {
        question: "Which platforms?",
        header: "Platforms",
        options: [{ label: "macOS" }, { label: "Linux" }, { label: "Windows" }],
        multiSelect: true,
      },
      { question: "Which shell?", options: [{ label: "zsh" }], multiSelect: false },
    ];
    const run = await f.started(native);
    const [interaction] = await f.pending(run.runId, 1);
    expect(
      await f.http("POST", `/runs/${run.runId}/interactions/${interaction!.interactionId}/answer`, {
        answers: [{ questionId: "q1", selectedLabels: ["macOS", "Windows"] }],
      }),
    ).toMatchObject({ status: 200, body: { status: "delivered" } });
    expect((await f.terminal(run.id)).state).toBe("succeeded");
    expect(nativeAnswers(run.runDir).map((frame) => frame["response"]["response"])).toEqual([
      {
        behavior: "allow",
        updatedInput: { questions: native, answers: { "Which platforms?": "macOS, Windows" } },
      },
    ]);
  }, 30_000);

  it("lets an MCP controller read the complete long question and answer it; a refused answer changes nothing", async () => {
    const f = await fixture();
    const mcp = mcpWire(cleanups);
    await mcp.start();
    const native = longQuestions();
    const run = await f.started(native);
    await f.pending(run.runId, 1);
    const listed = await mcp.tool("claudexor_run_interactions", { runId: run.runId });
    const interaction = listed.result.structuredContent.interactions[0];
    expect(interaction.questions[0].question).toBe(native[0]!.question);
    expect(interaction.questions[0].options).toEqual(native[0]!.options);
    expect(interaction.questions[1].question).toBe(native[1]!.question);
    const refused = await mcp.tool("claudexor_answer_interaction", {
      runId: run.runId,
      interactionId: interaction.interactionId,
      answers: [{ questionId: "q3", selectedLabels: [interaction.questions[0].options[0].label] }],
    });
    expect(refused.result.isError).toBe(true);
    expect(JSON.stringify(refused.result)).toContain("rejected");
    await f.pending(run.runId, 1);
    const answered = await mcp.tool("claudexor_answer_interaction", {
      runId: run.runId,
      interactionId: interaction.interactionId,
      answers: [
        { questionId: "q1", selectedLabels: [interaction.questions[0].options[0].label] },
        { questionId: "q2", selectedLabels: [], freeText: MULTILINE_FREE_TEXT },
      ],
    });
    expect(answered.result.isError).not.toBe(true);
    expect(answered.result.structuredContent).toMatchObject({ status: "delivered" });
    expect((await f.terminal(run.id)).state).toBe("succeeded");
    expect(nativeAnswers(run.runDir).map((frame) => frame["response"]["response"])).toEqual([
      {
        behavior: "allow",
        updatedInput: {
          questions: native,
          answers: {
            [native[0]!.question]: native[0]!.options[0].label,
            [native[1]!.question]: MULTILINE_FREE_TEXT,
          },
        },
      },
    ]);
  }, 30_000);

  it("lets `claudexor follow` show the complete long question and send the exact long label", async () => {
    const f = await fixture();
    const native = longQuestions();
    const run = await f.started(native);
    await f.pending(run.runId, 1);
    const oldTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    const printed: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      printed.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    tty.prompts.length = 0;
    // A numeric pick, then one line of prose typed with surrounding spaces.
    tty.replies.splice(0, tty.replies.length, "2", "  use the staged rollout  ");
    try {
      await followRun(run.runId, false);
    } finally {
      if (oldTty) Object.defineProperty(process.stdin, "isTTY", oldTty);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
    expect((await f.terminal(run.id)).state).toBe("succeeded");
    expect(tty.prompts).toHaveLength(2);
    const screen = printed.join("");
    expect(screen).toContain(native[0]!.question);
    expect(screen).toContain(native[0]!.header);
    expect(screen).toContain(native[0]!.options[1].label);
    expect(screen).toContain(native[0]!.options[1].description);
    expect(screen).toContain(native[1]!.question);
    expect(nativeAnswers(run.runDir).map((frame) => frame["response"]["response"])).toEqual([
      {
        behavior: "allow",
        updatedInput: {
          questions: native,
          answers: {
            [native[0]!.question]: native[0]!.options[1].label,
            [native[1]!.question]: "  use the staged rollout  ",
          },
        },
      },
    ]);
  }, 30_000);

  it("refuses a late answer after Stop and never writes it to the native process", async () => {
    const f = await fixture();
    const native = longQuestions();
    const run = await f.started(native);
    const [interaction] = await f.pending(run.runId, 1);
    const stop = await f.http("POST", `/runs/${run.runId}/control`, {
      control: { kind: "cancel", reason: "fixture stop", reason_code: "user_cancelled" },
    });
    expect(stop.status).toBe(200);
    expect((await f.terminal(run.id)).state).toBe("cancelled");
    await f.pending(run.runId, 0);
    const late = await f.http(
      "POST",
      `/runs/${run.runId}/interactions/${interaction!.interactionId}/answer`,
      { answers: [{ questionId: "q1", selectedLabels: [native[0]!.options[0].label] }] },
    );
    expect(late).toMatchObject({
      status: 409,
      body: { context: { accepted: false, status: "already_resolved" } },
    });
    // Stop releases the wait; at most the benign decline may reach a process
    // that is being stopped, never an answer.
    for (const frame of nativeAnswers(run.runDir))
      expect(frame["response"]["response"]).toEqual({
        behavior: "deny",
        message: DECLINE_MESSAGE,
        interrupt: false,
      });
    expect(interactionEvents(run.runDir).map((event) => event["type"])).toEqual([
      "interaction.requested",
    ]);
  }, 30_000);

  it("declines benignly when the question expires and refuses the late answer", async () => {
    const f = await fixture();
    const native = longQuestions();
    const run = await f.started(native, { interactionTimeoutMs: 400 });
    // The short window may close before a detail read sees it pending; the
    // durable request event names the question either way.
    expect((await f.terminal(run.id)).state).toBe("succeeded");
    const interactionId = interactionEvents(run.runDir)[0]?.["payload"]?.["interaction_id"];
    expect(interactionId).toBe("ask-1");
    expect(nativeAnswers(run.runDir).map((frame) => frame["response"]["response"])).toEqual([
      { behavior: "deny", message: DECLINE_MESSAGE, interrupt: false },
    ]);
    expect(interactionEvents(run.runDir).map((event) => event["type"])).toEqual([
      "interaction.requested",
      "interaction.timeout",
    ]);
    // The expiry is the typed interaction.timeout above; the adapter's record
    // stays the neutral benign one and adds no observation of its own (#622).
    const events = f.harnessEvents.get(run.runId)!;
    expect(unavailableRecords(events)).toEqual([]);
    expect(questionRecord(events)?.text).toBe(
      `AskUserQuestion returned an error instead of answers: ${DECLINE_MESSAGE}`,
    );
    const late = await f.http("POST", `/runs/${run.runId}/interactions/${interactionId}/answer`, {
      answers: [{ questionId: "q1", selectedLabels: [native[0]!.options[0].label] }],
    });
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ context: { accepted: false, status: "already_resolved" } });
    expect(nativeAnswers(run.runDir)).toHaveLength(1);
  }, 30_000);
});

describe("a Claude question Claudexor could not answer is never a human decline (#622)", () => {
  const fixtureQuestion = [
    {
      question: "Which existing fixture module should the new test use?",
      header: "Fixture",
      options: [
        { label: "Shared", description: "The shared fixture module" },
        { label: "Local", description: "A new local helper" },
        { label: "Inline", description: "Inline data in the test" },
      ],
      multiSelect: false,
    },
  ];

  it("records a question asked after the prompt's final result closed stdin, keeps the real work-tool error, and succeeds", async () => {
    const f = await fixture();
    const run = await f.started(fixtureQuestion, { scenario: "late_question" });
    expect((await f.terminal(run.id)).state).toBe("succeeded");
    const events = f.harnessEvents.get(run.runId)!;

    // Producer -> parser: the unroutable permission request is an explicit
    // observation with its exact native input and both native ids, not a drop.
    const status = {
      code: "interaction_answer_unavailable",
      reason: "input_closed",
      interaction_id: "ask-1",
      tool_use_id: "toolu-ask",
      input: { questions: fixtureQuestion },
    };
    expect(unavailableRecords(events)).toEqual([
      expect.objectContaining({
        type: "status",
        text: "AskUserQuestion ask-1 could not be answered: this session's input was already closed when Claudexor read the request",
        payload: status,
      }),
    ]);
    expect(questionRecord(events)).toMatchObject({
      text: "AskUserQuestion returned an error instead of answers; this session's input was already closed when Claudexor read the question: Tool permission request failed: AbortError: Stream closed",
      payload: { tool: "AskUserQuestion", tool_use_id: "toolu-ask", session_input: "closed" },
    });
    expect(events.at(-1)).toMatchObject({ type: "completed" });
    expect(events.at(-1)?.payload).not.toHaveProperty("dropped_unrecognized_events");
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    // Nothing was registered or written: no lifecycle row, no pending question,
    // no response on the closed stdin.
    expect(interactionEvents(run.runDir)).toEqual([]);
    expect(nativeAnswers(run.runDir)).toEqual([]);
    await f.pending(run.runId, 0);

    // The journal a delegating parent collects carries the same facts.
    const journal = journaledHarness(run.runDir);
    expect(unavailableRecords(journal).map((row) => row["payload"])).toEqual([status]);
    expect(journal.find((row) => row["type"] === "thinking")?.["text"]).toBe(
      questionRecord(events)?.text,
    );

    // The timeline shows both rows; the real work-tool failure stays an error.
    const detail = await f.http("GET", `/runs/${run.runId}`);
    expect(detail.status).toBe(200);
    const timeline = detail.body["timeline"] as Json[];
    expect(timeline).toContainEqual(
      expect.objectContaining({
        type: "harness.event",
        title:
          "AskUserQuestion ask-1 could not be answered: this session's input was already closed when Claudexor read the request",
        severity: "info",
      }),
    );
    expect(timeline).toContainEqual(
      expect.objectContaining({
        textKind: "thinking",
        detail: questionRecord(events)?.text,
        severity: "info",
      }),
    );
    expect(timeline).toContainEqual(
      expect.objectContaining({ toolName: "Bash", severity: "error" }),
    );
    for (const text of [
      ...events.map((event) => event.text ?? ""),
      ...timeline.map((row) => `${row["title"] ?? ""} ${row["detail"] ?? ""}`),
    ])
      expect(text).not.toMatch(DECLINE_CLAIM);

    // Attempt telemetry collects the work-tool error and never the question.
    const telemetry = createAttemptTelemetry("auto", false);
    for (const event of events) observeAttemptTelemetry(telemetry, event);
    expect(unrecoveredToolErrors(telemetry)).toEqual([
      expect.objectContaining({ tool: "Bash", toolUseId: "toolu-bash" }),
    ]);
  }, 30_000);

  it("tells the model and the run that a failed answer channel is not the user's decision, and succeeds", async () => {
    const f = await fixture();
    const native = longQuestions();
    const run = await f.started(native, { scenario: "channel_fails" });
    expect((await f.terminal(run.id)).state).toBe("succeeded");
    const message = unavailableDenyMessage("answer_channel_failed");
    expect(nativeAnswers(run.runDir).map((frame) => frame["response"]["response"])).toEqual([
      { behavior: "deny", message, interrupt: false },
    ]);
    const events = f.harnessEvents.get(run.runId)!;
    // The question reached the run exactly before its channel failed; the
    // tool-use id joins it to its record.
    const requested = events.find((event) => event.type === "interaction_requested");
    expect(requested?.interaction?.questions.map((q) => q.question)).toEqual(
      native.map((q) => q["question"]),
    );
    expect(requested?.payload).toEqual({ tool_use_id: "toolu-ask" });
    expect(unavailableRecords(events)).toEqual([
      expect.objectContaining({
        payload: {
          code: "interaction_answer_unavailable",
          reason: "answer_channel_failed",
          interaction_id: "ask-1",
          tool_use_id: "toolu-ask",
          error: "journal append failed",
        },
      }),
    ]);
    expect(questionRecord(events)).toMatchObject({
      text: `AskUserQuestion returned an error instead of answers: ${message}`,
      payload: { tool_use_id: "toolu-ask", session_input: "open" },
    });
    for (const event of events) expect(event.text ?? "").not.toMatch(DECLINE_CLAIM);
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    const timeline = (await f.http("GET", `/runs/${run.runId}`)).body["timeline"] as Json[];
    expect(timeline).toContainEqual(
      expect.objectContaining({
        title: "AskUserQuestion ask-1 could not be answered: the answer channel failed",
      }),
    );
  }, 30_000);

  it("tells the model and the run that a run without an answer channel cannot answer, and succeeds", async () => {
    const f = await fixture();
    const run = await f.started(fixtureQuestion, { scenario: "no_channel" });
    expect((await f.terminal(run.id)).state).toBe("succeeded");
    const message = unavailableDenyMessage("no_answer_channel");
    expect(nativeAnswers(run.runDir).map((frame) => frame["response"]["response"])).toEqual([
      { behavior: "deny", message, interrupt: false },
    ]);
    const events = f.harnessEvents.get(run.runId)!;
    expect(events.some((event) => event.type === "interaction_requested")).toBe(false);
    expect(unavailableRecords(events)).toEqual([
      expect.objectContaining({
        text: "AskUserQuestion ask-1 could not be answered: this run has no answer channel",
        payload: {
          code: "interaction_answer_unavailable",
          reason: "no_answer_channel",
          interaction_id: "ask-1",
          tool_use_id: "toolu-ask",
        },
      }),
    ]);
    expect(questionRecord(events)?.text).toBe(
      `AskUserQuestion returned an error instead of answers: ${message}`,
    );
    for (const event of events) expect(event.text ?? "").not.toMatch(DECLINE_CLAIM);
    expect(interactionEvents(run.runDir)).toEqual([]);
    await f.pending(run.runId, 0);
  }, 30_000);
});

/** #651's shape: a 2,935-character question whose decisive condition follows
 * character 2,400 (past the former 2,000-character cut), with four options. */
const DECISIVE =
  "Decisive condition: choose the fourth option unless the schema migration has already finished.";

function decisiveQuestions(): Json[] {
  const head = "Which rollout keeps the release safe? ";
  const filler = (length: number) =>
    "Контекст выката и ограничения. ".repeat(Math.ceil(length / 31)).slice(0, length);
  const before = head + filler(2_450 - head.length);
  return [
    {
      question: `${before}${DECISIVE} ${filler(2_935 - before.length - DECISIVE.length - 1)}`,
      header: "Rollout",
      options: [
        { label: "Canary", description: "Shift traffic gradually." },
        { label: "Blue-green", description: "Switch all traffic at once." },
        { label: "Feature flag", description: "Ship dark behind a flag." },
        { label: "Defer to the migration window", description: "Wait until the migration ends." },
      ],
      multiSelect: false,
    },
  ];
}

describe("a long Claude question reaches every reader exactly (#651)", () => {
  it.each(["fourth label", "multi-line free text"] as const)(
    "carries the same bytes on each surface and in the reopened store, answered by its %s",
    async (kind) => {
      const f = await fixture();
      const mcp = mcpWire(cleanups);
      await mcp.start();
      const native = decisiveQuestions();
      const question = native[0]!.question as string;
      expect(question).toHaveLength(2_935);
      expect(question.indexOf(DECISIVE)).toBeGreaterThan(2_400);
      const exact = [
        { id: "q1", question, header: "Rollout", options: native[0]!.options, multi_select: false },
      ];
      const run = await f.started(native);
      const [pending] = await f.pending(run.runId, 1);
      expect(pending!.questions).toEqual(exact);
      // The run journal read back: one log's sequence, the harness.event rows of
      // the native tool call and the interaction, then the channel's own row.
      const journal = await vi.waitFor(() => {
        const rows = jsonl(join(run.runDir, "events.jsonl"));
        expect(rows.map((row) => row["type"])).toContain("interaction.requested");
        return rows;
      });
      expect(journal.map((row) => row["seq"])).toEqual(journal.map((_, index) => index + 1));
      const harnessRow = (type: string) =>
        journal.find(
          (row) =>
            row["type"] === "harness.event" &&
            row["payload"]["type"] === type &&
            (type !== "tool_call" || row["payload"]["tool"]?.["name"] === "AskUserQuestion"),
        )!;
      expect(harnessRow("tool_call")["payload"]["payload"]).toEqual({
        input: { questions: native },
      });
      const requested = harnessRow("interaction_requested");
      expect(requested["payload"]["interaction"]["questions"]).toEqual(exact);
      // Its title and text are only marked display labels.
      expect(requested["payload"]["title"]).toBe(`${question.slice(0, 499)}…`);
      expect(requested["payload"]["text"]).toBe(`${question.slice(0, 499)}…`);
      const channelRow = journal.find((row) => row["type"] === "interaction.requested")!;
      expect(channelRow["payload"]["questions"]).toEqual(exact);
      expect(requested["seq"]).toBeLessThan(channelRow["seq"]);
      const listed = await mcp.tool("claudexor_run_interactions", { runId: run.runId });
      expect(listed.result.structuredContent.interactions[0].questions).toEqual(exact);
      // The bounded wait holds this question whole, in its event and its pending body.
      const waited = (await mcp.tool("claudexor_run_wait", { runId: run.runId, waitMs: 0 })).result
        .structuredContent;
      expect(waited).toMatchObject({ wakeReason: "interactions", omittedInteractions: 0 });
      const waitedEvent = waited.events.find(
        (item: Json) => item.event.type === "interaction.requested",
      );
      expect(waitedEvent.event.payload.questions).toEqual(exact);
      const waitedRequested = waited.events.find(
        (item: Json) => item.seq === requested["seq"] && item.event.type === "harness.event",
      );
      expect(waitedRequested.event.payload.interaction.questions).toEqual(exact);
      expect(waited.pendingInteractions[0].questions).toEqual(exact);

      const fourth = native[0]!.options[3].label as string;
      if (kind === "fourth label") {
        const answered = await mcp.tool("claudexor_answer_interaction", {
          runId: run.runId,
          interactionId: pending!.interactionId,
          answers: [{ questionId: "q1", selectedLabels: [fourth] }],
        });
        expect(answered.result.structuredContent).toMatchObject({ status: "delivered" });
      } else {
        const path = `/runs/${run.runId}/interactions/${pending!.interactionId}/answer`;
        expect(
          await f.http("POST", path, {
            answers: [{ questionId: "q1", selectedLabels: [], freeText: MULTILINE_FREE_TEXT }],
          }),
        ).toMatchObject({ status: 200, body: { status: "delivered" } });
      }
      expect((await f.terminal(run.id)).state).toBe("succeeded");
      // The answer key is the complete native question; the run continues to its answer.
      expect(nativeAnswers(run.runDir).map((frame) => frame["response"]["response"])).toEqual([
        {
          behavior: "allow",
          updatedInput: {
            questions: native,
            answers: { [question]: kind === "fourth label" ? fourth : MULTILINE_FREE_TEXT },
          },
        },
      ]);
      const events = f.harnessEvents.get(run.runId)!;
      const result = events.find(
        (event) => event.type === "tool_result" && event.tool?.name === "AskUserQuestion",
      );
      expect(result?.tool?.content_summary).toContain("Your questions have been answered");
      expect(events.find((event) => event.final)?.text).toBe("DONE");

      // A reopened engine store keeps the same exact question.
      const root = dirname(f.workspace);
      for (const close of cleanups.splice(0).reverse()) await close();
      const store = await EngineStore.open({
        daemonDir: root,
        workerEntry: resolve(import.meta.dirname, "../../daemon/dist/store/flusher-worker.js"),
      });
      cleanups.push(() => store.close());
      const rows = store
        .prepare("SELECT state, request FROM interaction WHERE run_id = ?")
        .all(run.runId) as Array<{ state: string; request: Uint8Array }>;
      expect(
        rows.map((row) => ({
          state: row.state,
          questions: JSON.parse(Buffer.from(row.request).toString("utf8")).questions,
        })),
      ).toEqual([{ state: "resolved", questions: exact }]);
    },
    30_000,
  );
});
