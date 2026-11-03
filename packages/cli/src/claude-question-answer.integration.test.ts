/**
 * #560: a Claude `AskUserQuestion` answered through the production answer
 * path. HTTP control API (and the MCP tools and `claudexor follow`) -> daemon
 * InteractionRegistry over the SQL engine store -> the orchestrator's
 * interaction channel -> the real Claude adapter run and core run loop -> a
 * synthetic Claude CLI child process that speaks the recorded stream-json
 * control protocol. Only the vendor binary is synthetic, and the assertions
 * read what that child process actually received on its stdin. No live Claude
 * CLI runs here; the installed vendor protocol may differ from the recording.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCliHarness, type CliRunLoopOptions } from "@claudexor/core";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { createClaudeAdapter } from "../../harness-claude/src/index.js";
import { DECLINE_MESSAGE } from "../../harness-claude/src/interactive.js";
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
const [questionsPath, capturePath] = process.argv.slice(-2);
const questions = JSON.parse(fs.readFileSync(questionsPath, 'utf8'));
const session = 'native-session-1';
const usage = { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const out = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
let asked = false;
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
    out({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: session, tools: ['AskUserQuestion'], mcp_servers: [], model: 'claude-fable-5-1', permissionMode: 'default', claude_code_version: '2.1.281', uuid: 'init-1' });
    out({ type: 'assistant', message: { id: 'msg-1', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu-ask', name: 'AskUserQuestion', input: { questions } }], model: 'claude-fable-5-1', stop_reason: null, stop_sequence: null, usage }, parent_tool_use_id: null, session_id: session, uuid: 'assistant-1' });
    out({ type: 'control_request', request_id: 'ask-1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion', input: { questions }, tool_use_id: 'toolu-ask', requires_user_interaction: true } });
    return;
  }
  if (frame.type === 'control_response' && frame.response && frame.response.request_id === 'ask-1') {
    const decision = frame.response.response || {};
    const allowed = decision.behavior === 'allow';
    const answers = (allowed && decision.updatedInput && decision.updatedInput.answers) || {};
    const pairs = questions.filter((q) => Object.prototype.hasOwnProperty.call(answers, q.question)).map((q) => '"' + q.question + '"="' + answers[q.question] + '"');
    const text = !allowed ? String(decision.message) : pairs.length ? 'Your questions have been answered: ' + pairs.join(', ') + '. You can now continue with these answers in mind.' : 'The user did not answer the questions.';
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-ask', content: text, ...(allowed ? {} : { is_error: true }) }] }, parent_tool_use_id: null, session_id: session, uuid: 'user-1', ...(allowed ? { tool_use_result: decision.updatedInput } : {}) });
    out({ type: 'assistant', message: { id: 'msg-2', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'DONE' }], model: 'claude-fable-5-1', stop_reason: null, stop_sequence: null, usage }, parent_tool_use_id: null, session_id: session, uuid: 'assistant-2' });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', session_id: session, num_turns: 2, duration_ms: 5, duration_api_ms: 4, total_cost_usd: 0, usage, stop_reason: 'end_turn', terminal_reason: 'completed', uuid: 'result-1' });
  }
});
rl.on('close', () => process.stdout.write('', () => process.exit(0)));
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

async function fixture() {
  const harnessEvents = new Map<string, HarnessEvent[]>();
  const daemon = await startInteractionDaemon({
    cleanups,
    removals,
    harnessId: "claude",
    prompt: "Ask me first",
    waitMs: 10_000,
    execute: async ({ params, runId, runDir, signal, channel }, workspace) => {
      const questionsPath = join(runDir, "native-questions.json");
      writeFileSync(questionsPath, JSON.stringify(params["questions"]));
      const spec = HarnessRunSpec.parse({
        session_id: runId,
        intent: "implement",
        prompt: String(params["prompt"]),
        cwd: workspace,
        access: "full",
        auth_preference: "subscription",
      });
      spec.extra["interactionChannel"] = channel;
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
      for await (const event of adapter.run(spec)) events.push(event);
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
    const late = await f.http("POST", `/runs/${run.runId}/interactions/${interactionId}/answer`, {
      answers: [{ questionId: "q1", selectedLabels: [native[0]!.options[0].label] }],
    });
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ context: { accepted: false, status: "already_resolved" } });
    expect(nativeAnswers(run.runDir)).toHaveLength(1);
  }, 30_000);
});
