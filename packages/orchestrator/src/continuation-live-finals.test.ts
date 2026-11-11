/**
 * A represented try's carried answer is the LAST typed final AnswerAssembly
 * accepts: a live message after a result runs the next native turn of the same
 * process (packages/harness-claude/src/live-input-fixtures.test.ts, "final
 * text"), so one physical try can record several finals. Only the carried one
 * and its repeats are left out of the evidence; an earlier native turn's
 * distinct final reaches the packet once, attributed like other retained output.
 *
 * Astra r4 coupling finding (`.review-evidence/astra-r4/parser-output-probe.mjs`):
 * the recorded fixture through the actual Claude parser, readContinuationEvidence
 * and buildEvidenceIndex. The single-final stream and structured-envelope fixtures
 * of the same probe keep their carried final exactly once.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AnswerAssembly } from "@claudexor/core";
import { retainedOutput } from "@claudexor/event-log";
import { RunTelemetry, SCHEMA_VERSION, type HarnessEvent } from "@claudexor/schema";
import {
  readContinuationEvidence,
  runExecutionFacts,
  unrepresentedOutput,
} from "@claudexor/workspace";
import { buildEvidenceIndex } from "./continuation-evidence.js";
import { createClaudeParser } from "../../harness-claude/src/parse.js";
import { parseCodexEvent } from "../../harness-codex/src/parse.js";

const here = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
afterEach(
  () => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
  0,
); // synchronous removal: no deadline (#376, see vitest.setup.ts)
const count = (text: string, needle: string) => text.split(needle).length - 1;

/** A recorded fixture through its real parser, as the run log stores it. */
function recorded(
  harness: "claude" | "codex",
  name: string,
  parse: (frame: unknown) => HarnessEvent[] | null,
) {
  const frames = readFileSync(join(here, `../../harness-${harness}/fixtures/${name}`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { direction?: string; frame?: unknown })
    .flatMap((row) => (row.frame ? (row.direction === "cli->client" ? [row.frame] : []) : [row]));
  const events = frames.flatMap((frame) => parse(frame) ?? []);
  const answer = new AnswerAssembly();
  for (const event of events) answer.observe(event);
  const rows = events.map((event, seq) => ({
    seq: seq + 1,
    ts: event.ts,
    run_id: "run-p",
    task_id: "task-p",
    type: "harness.event" as const,
    payload: { ...event, attempt_id: "a01", harness_id: harness },
  }));
  const finals = events.filter((event) => event.type === "message" && event.final === true);
  return { rows, finals, carried: answer.text() };
}

/** A completed run whose final answer is `answer`, recorded by `rows`. */
function completedRun(rows: unknown[], answer: string) {
  const runDir = mkdtempSync(join(tmpdir(), "cx-live-finals-"));
  roots.push(runDir);
  mkdirSync(join(runDir, "final"));
  writeFileSync(
    join(runDir, "events.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  writeFileSync(join(runDir, "final/answer.md"), answer);
  const web = {
    required: false,
    policy: "off",
    effective_mode: "off",
    attempted: false,
    satisfied: false,
    status: "none",
    tool: null,
    target: null,
    error_summary: null,
  };
  writeFileSync(
    join(runDir, "final/telemetry.yaml"),
    JSON.stringify(
      RunTelemetry.parse({
        schema_version: SCHEMA_VERSION,
        run_id: "run-p",
        task_id: "task-p",
        mode: "ask",
        requested_access: "readonly",
        effective_access: "readonly",
        external_context_policy: "auto",
        effective_web_mode: "off",
        web,
        final_attempt_id: "a01",
        attempts: [],
        generated_at: "2026-10-29T00:00:00.000Z",
      }),
    ),
  );
  return runDir;
}

describe("a represented try with several native-turn finals (Claude live message)", () => {
  it("keeps the earlier distinct final once beside the carried last final, which is not repeated", () => {
    const parse = createClaudeParser();
    const live = recorded("claude", "stream-json/recorded-live-final-text-2.1.283.jsonl", (frame) =>
      parse(frame, "process-1"),
    );
    expect(live.finals).toHaveLength(2);
    expect(live.carried).toBe("MANGO");
    const firstFinal = live.finals[0]!.text!;
    expect(Buffer.byteLength(firstFinal)).toBe(7115);
    expect(firstFinal).not.toContain("MANGO");

    const runDir = completedRun(live.rows, live.carried);
    const evidence = readContinuationEvidence(runDir);
    expect(count(evidence.output, firstFinal)).toBe(1);
    expect(evidence.output).toContain("## Attempt a01 · claude");
    const index = buildEvidenceIndex({
      cause: "other",
      completed: true,
      workOrder: "Continue the investigation",
      steering: [],
      retainedOutput: evidence.output,
      toolCalls: [],
      diffStat: null,
      artifacts: { eventsLog: join(runDir, "events.jsonl"), attemptDir: null, patch: null },
    });
    expect(count(index.markdown, firstFinal)).toBe(1);
    expect(count(index.markdown, "MANGO")).toBe(1);
    expect(index.markdown.indexOf("Final answer (final/answer.md, attempt a01):")).toBeLessThan(
      index.markdown.indexOf(firstFinal),
    );
    // Both finals fit the existing section budget: nothing was cut, and the flag says so.
    expect(index.summarized).toBe(false);
  });

  it("single-final stream and structured-envelope fixtures keep their carried final exactly once", () => {
    for (const name of [
      "recorded-partial-messages.jsonl",
      "recorded-partial-multiblock.jsonl",
      "recorded-partial-joined.jsonl",
      "recorded-partial-replay.jsonl",
    ]) {
      const parse = createClaudeParser();
      const { rows, finals, carried } = recorded("claude", name, (frame) =>
        parse(frame, "process-1"),
      );
      expect(finals, name).toHaveLength(1);
      const additional =
        unrepresentedOutput(rows as never, runExecutionFacts(rows as never), "a01") ?? "";
      expect(count(`${carried}\n${additional}`, carried.trim()), name).toBe(1);
    }
    const state = { envelopeActive: true };
    const codex = recorded("codex", "structured-envelope-intermediate.jsonl", (frame) =>
      parseCodexEvent(frame, "process-1", state),
    );
    const additional =
      unrepresentedOutput(codex.rows as never, runExecutionFacts(codex.rows as never), "a01") ?? "";
    expect(count(`${codex.carried}\n${additional}`, codex.carried.trim())).toBe(1);
    expect(additional).toContain("Использую навык OpenAI Docs");
    expect(additional).not.toContain("work_report");
  });
});

/** Parser events as the run log stores them, with what AnswerAssembly carries. */
function journaled(harness: "claude" | "codex", events: HarnessEvent[]) {
  const answer = new AnswerAssembly();
  for (const event of events) answer.observe(event);
  const rows = events.map((event, seq) => ({
    seq: seq + 1,
    ts: event.ts,
    run_id: "run-p",
    task_id: "task-p",
    type: "harness.event" as const,
    payload: { ...event, attempt_id: "a01", harness_id: harness },
  }));
  const additional =
    unrepresentedOutput(rows as never, runExecutionFacts(rows as never), "a01") ?? "";
  return { carried: answer.text(), additional };
}
/** The text of each single-line retained block, in order. */
const blockTexts = (text: string) =>
  [...text.matchAll(/^### .+\n\n([^\n]*)$/gm)].map((match) => match[1]);

describe("real parser streams keep evidence by identity, never by words (#568)", () => {
  // Frame shapes of the recorded 2.1.311 partial-message streams (speech.test.ts).
  const main = { parent_tool_use_id: null };
  const frame = (event: unknown, id: string) => ({
    type: "stream_event",
    ...main,
    event,
    api_message_id: id,
  });
  const response = (id: string, deltas: string[], complete: string) => [
    { type: "stream_event", ...main, event: { type: "message_start", message: { id } } },
    frame({ type: "content_block_start", index: 0, content_block: { type: "text" } }, id),
    ...deltas.map((text) =>
      frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, id),
    ),
    { type: "assistant", ...main, message: { id, content: [{ type: "text", text: complete }] } },
    frame({ type: "content_block_stop", index: 0 }, id),
    frame({ type: "message_stop" }, id),
  ];

  it("Claude: a keyed block's complete text supersedes its fragments; equal words under another key stay", () => {
    const parse = createClaudeParser();
    const events = [
      // The start names the try, as every recorded stream's init frame does.
      { type: "system", subtype: "init", session_id: "native-1", model: "claude-opus-5-5" },
      ...response("msg_a", ["Do", "ne"], "Done."), // a revision: the complete text differs
      ...response("msg_b", ["Done."], "Done."),
      { type: "result", subtype: "success", result: "Done." },
    ].flatMap((native) => parse(native, "process-1") ?? []);
    const ops = events
      .filter((event) => event.type === "message")
      .map((event) => [event.speech?.op ?? null, event.final === true]);
    expect(ops).toEqual([
      ["fragment", false],
      ["fragment", false],
      ["complete", false],
      ["fragment", false],
      ["complete", false],
      [null, true],
    ]);
    const { carried, additional } = journaled("claude", events);
    expect(carried).toBe("Done.");
    // The first response's block once, as its complete text; the carried final not again.
    expect(blockTexts(additional)).toEqual(["Done."]);
    expect(additional).not.toMatch(/^Done$/m);
  });

  it("Claude joined text runs: the run's one frame is its complete form, once beside the carried final", () => {
    const parse = createClaudeParser();
    // The recorded 2.1.311 joined stream: two text blocks, a tool call, then "Done.".
    const { rows, carried } = recorded("claude", "recorded-partial-joined.jsonl", (frame) =>
      parse(frame, "process-1"),
    );
    expect(carried).toBe("Done.");
    expect(blockTexts(retainedOutput(rows as never) ?? "")).toEqual([
      "Part one. Part two.",
      "Done.",
    ]);
    const additional =
      unrepresentedOutput(rows as never, runExecutionFacts(rows as never), "a01") ?? "";
    expect(blockTexts(additional)).toEqual(["Part one. Part two."]);
  });

  it("Claude joined text runs: a joined final leaves nothing of its blocks beside the carried answer", () => {
    // The same recorded frames, with the joined message as the try's last: its
    // tool block, the next response and other plumbing are left out, and the
    // recorded result repeats the joined text as Claude's result repeats its last message.
    const frames = readFileSync(
      join(here, "../../harness-claude/fixtures/recorded-partial-joined.jsonl"),
      "utf8",
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>);
    const first = frames.filter(
      (f) =>
        (f["type"] === "system" && f["subtype"] === "init") ||
        (f["api_message_id"] === "msg_jn_A" && f["event"]?.index !== 2) ||
        (f["message"]?.id === "msg_jn_A" && f["message"].content[0].type === "text"),
    );
    const result = { ...frames.at(-1), result: "Part one. Part two." };
    const parse = createClaudeParser();
    const events = [...first, result].flatMap((native) => parse(native, "process-1") ?? []);
    const { carried, additional } = journaled("claude", events);
    expect(carried).toBe("Part one. Part two.");
    expect(additional).toBe("");
  });

  it("Claude: independent responses' uncompleted blocks stay beside a final equal to their words", () => {
    const parse = createClaudeParser();
    const cut = (id: string, text: string) => [
      { type: "stream_event", ...main, event: { type: "message_start", message: { id } } },
      frame({ type: "content_block_start", index: 0, content_block: { type: "text" } }, id),
      frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, id),
      frame({ type: "content_block_stop", index: 0 }, id),
      frame({ type: "message_stop" }, id),
    ];
    const events = [
      { type: "system", subtype: "init", session_id: "native-1", model: "claude-opus-5-5" },
      ...cut("msg_a", "Part one."),
      ...cut("msg_b", " Part two."),
      { type: "result", subtype: "success", result: "Part one. Part two." },
    ].flatMap((native) => parse(native, "process-1") ?? []);
    expect(events.some((event) => event.payload?.["joined_speech_keys"])).toBe(false);
    const { carried, additional } = journaled("claude", events);
    expect(carried).toBe("Part one. Part two.");
    expect(blockTexts(additional)).toEqual(["Part one.", " Part two."]);
  });

  it("Codex: repeated messages and words inside the final stay beside it", () => {
    const state = {};
    const events = [
      { type: "thread.started", thread_id: "th-1" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "i1", type: "agent_message", text: "OK" } },
      { type: "item.completed", item: { id: "i2", type: "agent_message", text: "OK" } },
      { type: "item.completed", item: { id: "i3", type: "agent_message", text: "NOT OK" } },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ].flatMap((native) => parseCodexEvent(native, "process-1", state) ?? []);
    const { carried, additional } = journaled("codex", events);
    expect(carried).toBe("NOT OK");
    expect(blockTexts(additional)).toEqual(["OK", "OK"]);
  });
});
