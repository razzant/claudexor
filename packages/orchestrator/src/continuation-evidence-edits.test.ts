/**
 * #410: an edit's lifecycle travels as a typed adapter fact into the evidence
 * index. The Codex, AGY write, Claude, Cursor, OpenCode and ACP frames below are
 * SYNTHETIC native-format examples (their fixtures hold no captured live edit
 * event); the Grok frames are its RECORDED `write.jsonl` capture and the AGY
 * read step comes from its recorded `basic-run.jsonl`. They prove the
 * parser -> journal -> packet contract, never vendor behavior.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessEvent } from "@claudexor/schema";
import { buildEvidenceIndex } from "./continuation-evidence.js";
import { collectEvidenceIndexInput, toolCallIndex } from "./continuation-evidence-io.js";
import { harnessEventPayload } from "./runSupport.js";
import { parseCodexEvent } from "../../harness-codex/src/parse.js";
import { codexAppServerEvents } from "../../harness-codex/src/app-server-protocol.js";
import { parseAgyEvent } from "../../harness-agy/src/parse.js";
import { createClaudeParser } from "../../harness-claude/src/parse.js";
import { createCursorParser } from "../../harness-cursor/src/parse.js";
import { parseOpenCodeEvent } from "../../harness-opencode/src/parse.js";
import { createGrokParser } from "../../harness-grok/src/parse.js";
import { AcpEvents } from "../../harness-acp/src/events.js";

const here = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

type Parse = (frame: unknown) => HarnessEvent[] | null;
const run = (parse: Parse, frames: unknown[]) => frames.flatMap((frame) => parse(frame) ?? []);
const rows = (events: HarnessEvent[]) =>
  toolCallIndex(events.map((event) => JSON.parse(JSON.stringify(event))));

/** One run dir holding the events either only in the attempt log or only in the run log. */
function journal(events: HarnessEvent[], where: "attempt" | "run"): string {
  const runDir = mkdtempSync(join(tmpdir(), "cx-edit-journal-"));
  roots.push(runDir);
  mkdirSync(join(runDir, "attempts", "a01"), { recursive: true });
  const safe = events;
  if (where === "attempt") {
    writeFileSync(
      join(runDir, "attempts", "a01", "events.jsonl"),
      safe.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
  } else {
    writeFileSync(
      join(runDir, "events.jsonl"),
      safe
        .map((event, seq) =>
          JSON.stringify({
            seq,
            ts: event.ts,
            run_id: "run-edits",
            task_id: "task-edits",
            type: "harness.event",
            payload: harnessEventPayload("codex", "a01", event),
          }),
        )
        .join("\n") + "\n",
    );
  }
  return runDir;
}

function packet(runDir: string) {
  const input = collectEvidenceIndexInput(
    { runDir, attemptId: "a01", workOrder: "W", steering: [] },
    { cause: "transport", retainedOutput: "", diffStat: null },
  );
  return { calls: input.toolCalls, markdown: buildEvidenceIndex(input).markdown };
}

const codexExec = [
  { type: "thread.started", thread_id: "th-edits" },
  {
    type: "item.started",
    item: {
      id: "p1",
      type: "file_change",
      changes: [
        { path: "A.ts", kind: "update" },
        { path: "B.ts", kind: "update" },
      ],
      status: "in_progress",
    },
  },
  {
    type: "item.completed",
    item: {
      id: "p1",
      type: "file_change",
      changes: [
        { path: "B.ts", kind: "update" },
        { path: "C.ts", kind: "add" },
      ],
      status: "completed",
    },
  },
  {
    type: "item.completed",
    item: { id: "p2", type: "file_change", changes: [{ path: "D.ts" }], status: "failed" },
  },
  {
    type: "item.completed",
    item: { id: "p3", type: "file_change", changes: [{ path: "E.ts" }], status: "declined" },
  },
  { type: "item.completed", item: { id: "p4", type: "file_change", changes: [{ path: "F.ts" }] } },
  { type: "item.completed", item: { id: "p5", type: "file_change", status: "completed" } },
];

const codexRows = [
  { name: "apply_patch", target: "A.ts", resolved: false },
  { name: "apply_patch", target: "B.ts", resolved: true },
  { name: "apply_patch", target: "C.ts", resolved: true },
  { name: "apply_patch", target: "D.ts", resolved: true, outcome: "error" },
  { name: "apply_patch", target: "E.ts", resolved: true, outcome: "denied" },
  { name: "apply_patch", target: "F.ts", resolved: true },
  { name: "apply_patch", target: null, resolved: true },
];

describe("#410 typed edit completion: Codex", () => {
  it("exec frames carry one typed event per changes[] path with the native outcome", () => {
    const events = run((frame) => parseCodexEvent(frame, "s1", {}), codexExec);
    const edits = events.filter((event) => event.type === "file_change");
    expect(
      edits.map((event) => [event.tool?.target ?? null, event.tool?.phase, event.tool?.status]),
    ).toEqual([
      ["A.ts", "started", undefined],
      ["B.ts", "started", undefined],
      ["B.ts", "completed", "ok"],
      ["C.ts", "completed", "ok"],
      ["D.ts", "completed", "error"],
      ["E.ts", "completed", "denied"],
      ["F.ts", "completed", undefined],
      [null, "completed", "ok"],
    ]);
    // The completed frame keeps its raw native item as evidence.
    expect(edits[2]?.payload).toMatchObject({ path: "B.ts", item: { id: "p1" } });
  });

  it.each(["attempt", "run"] as const)(
    "A/B started -> B/C completed keeps exactly the proved facts through a %s-only journal",
    (where) => {
      const events = run((frame) => parseCodexEvent(frame, "s1", {}), codexExec);
      const { calls, markdown } = packet(journal(events, where));
      expect(calls).toEqual(codexRows);
      expect(markdown).toContain("- apply_patch — A.ts (unresolved: no result recorded)");
      expect(markdown).toContain("- apply_patch — C.ts (completed)");
      expect(markdown).toContain("- apply_patch — D.ts (completed: error)");
      expect(markdown).toContain("- apply_patch — E.ts (completed: denied)");
      expect(markdown).toContain("Tool calls: 7; unresolved: 1.");
    },
  );

  it("the completed-only frame of the synthetic exec fixture is completed, not unresolved", () => {
    const fixture = readFileSync(join(here, "../../harness-codex/fixtures/basic-run.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    const calls = rows(run((frame) => parseCodexEvent(frame, "s1", {}), fixture));
    expect(calls.filter((call) => call.name === "apply_patch")).toEqual([
      { name: "apply_patch", target: "src/a.ts", resolved: true },
    ]);
  });

  it("the app-server mapper's per-path split is not enumerated a second time", () => {
    const state = {};
    const item = {
      type: "fileChange",
      id: "patch-1",
      changes: [{ path: "one.ts" }, { path: "two.ts" }],
    };
    const events = [
      ...(codexAppServerEvents({ method: "item/started", params: { item } }, "s1", state) ?? []),
      ...(codexAppServerEvents(
        { method: "item/completed", params: { item: { ...item, status: "completed" } } },
        "s1",
        state,
      ) ?? []),
    ];
    expect(events.map((event) => [event.tool?.target, event.tool?.phase])).toEqual([
      ["one.ts", "started"],
      ["two.ts", "started"],
      ["one.ts", "completed"],
      ["two.ts", "completed"],
    ]);
    expect(rows(events)).toEqual([
      { name: "apply_patch", target: "one.ts", resolved: true },
      { name: "apply_patch", target: "two.ts", resolved: true },
    ]);
  });
});

describe("#410 typed edit completion: AGY step ids", () => {
  const step = (index: number, state: string, info: Record<string, unknown>) => ({
    event: "step_update",
    step_update: {
      step_index: index,
      state,
      step_type: "tool",
      tool_name: info["name"],
      tool_info: info,
    },
  });

  it("the recorded read step pairs its ACTIVE call with its DONE result by step id", () => {
    const fixture = readFileSync(join(here, "../../harness-agy/fixtures/basic-run.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    const events = run((frame) => parseAgyEvent(frame, "s1"), fixture);
    expect(events.filter((event) => event.tool).map((event) => event.tool?.use_id)).toEqual([
      "step-3",
      "step-3",
    ]);
    expect(rows(events)).toEqual([
      { name: "view_file", target: "/workspace/demo", resolved: true },
    ]);
  });

  it("a write's companion is the same completed step: one completed row, its target kept", () => {
    const write = { name: "write_to_file", parameters: { TargetFile: "/workspace/demo/a.txt" } };
    const events = run(
      (frame) => parseAgyEvent(frame, "s1"),
      [step(7, "ACTIVE", write), step(7, "DONE", { ...write, output: "Created file" })],
    );
    expect(events.map((event) => event.type)).toEqual(["tool_call", "tool_result", "file_change"]);
    expect(events[2]?.tool).toMatchObject({
      use_id: "step-7",
      target: "/workspace/demo/a.txt",
      phase: "completed",
      status: "ok",
    });
    expect(rows(events)).toEqual([
      { name: "write_to_file", target: "/workspace/demo/a.txt", resolved: true },
    ]);
  });
});

describe("#410 companion edits of the other adapters keep their true result pairing", () => {
  it("claude: the edit tool_use is the call and its tool_result closes it", () => {
    const parse = createClaudeParser();
    const events = run(
      (frame) => parse(frame, "s1"),
      [
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "tu_edit1", name: "Edit", input: { file_path: "src/a.ts" } },
              { type: "tool_use", id: "tu_edit2", name: "Write", input: { file_path: "src/b.ts" } },
            ],
          },
        },
        {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "tu_edit1", content: "ok" }] },
        },
      ],
    );
    // The untyped call frame without its result proves no completion either way.
    expect(rows(events)).toEqual([
      { name: "Edit", target: "Edit: src/a.ts", resolved: true },
      { name: "Write", target: "Write: src/b.ts", resolved: false, unconfirmed: true },
    ]);
  });

  it("cursor: the write companion after the completed call adds no row", () => {
    const parse = createCursorParser();
    const events = run(
      (frame) => parse(frame, "s1"),
      [
        {
          type: "tool_call",
          subtype: "started",
          call_id: "c1",
          tool_call: { writeToolCall: { args: { path: "src/a.ts" } } },
        },
        {
          type: "tool_call",
          subtype: "completed",
          call_id: "c1",
          tool_call: {
            writeToolCall: { args: { path: "src/a.ts" }, result: { success: { linesCreated: 1 } } },
          },
        },
      ],
    );
    expect(events.map((event) => event.type)).toEqual(["tool_call", "tool_result", "file_change"]);
    expect(rows(events)).toEqual([{ name: "write", target: "src/a.ts", resolved: true }]);
  });

  it("opencode: the pending edit is the call, its result closes it and the companion adds nothing", () => {
    const events = run(
      (frame) => parseOpenCodeEvent(frame, "s1"),
      [
        { type: "tool", tool: "edit", id: "t2", path: "src/a.ts" },
        { type: "tool", tool: "edit", id: "t2", path: "src/a.ts", status: "completed" },
      ],
    );
    expect(events.map((event) => event.type)).toEqual([
      "file_change",
      "tool_result",
      "file_change",
    ]);
    expect(rows(events)).toEqual([{ name: "edit", target: "src/a.ts", resolved: true }]);
  });

  it("grok (recorded write.jsonl): the search_replace companion adds no row", () => {
    const { parseEvent: parse } = createGrokParser();
    const frames = readFileSync(join(here, "../../harness-grok/fixtures/write.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    const events = run((frame) => parse(frame, "s1"), frames);
    expect(events.filter((event) => event.type === "file_change")).toHaveLength(1);
    expect(rows(events)).toEqual([
      { name: "search_replace", target: "/workspace\\probe.txt", resolved: true },
    ]);
  });

  it("acp: a tool-less diff file_change is not a call; the call's result closes it", () => {
    const acp = new AcpEvents("s1");
    const events = [
      ...acp.update({
        sessionUpdate: "tool_call",
        toolCallId: "t",
        kind: "edit",
        title: "Edit",
        status: "in_progress",
      }),
      ...acp.update({
        sessionUpdate: "tool_call_update",
        toolCallId: "t",
        status: "completed",
        content: [{ type: "diff", path: "/work/a", oldText: null, newText: "a" }],
      }),
    ];
    expect(events.map((event) => event.type)).toEqual(["tool_call", "file_change", "tool_result"]);
    expect(rows(events)).toEqual([{ name: "Edit", target: null, resolved: true }]);
  });
});

describe("#410 edit lifecycle rules", () => {
  const edit = (
    phase: "started" | "completed" | undefined,
    target: string | null,
    id: string | null,
    status?: string,
  ) => ({
    type: "file_change",
    session_id: "s1",
    tool: {
      name: "apply_patch",
      kind: "file",
      ...(id ? { use_id: id } : {}),
      ...(target ? { target } : {}),
      ...(phase ? { phase } : {}),
      ...(status ? { status } : {}),
    },
  });

  it("explicit starts never close each other and duplicates add no row", () => {
    expect(toolCallIndex([edit("started", "a.ts", "x"), edit("started", "a.ts", "x")])).toEqual([
      { name: "apply_patch", target: "a.ts", resolved: false },
    ]);
    expect(
      toolCallIndex([
        edit("started", "a.ts", "x"),
        edit("completed", "a.ts", "x"),
        edit("completed", "a.ts", "x"),
      ]),
    ).toEqual([{ name: "apply_patch", target: "a.ts", resolved: true }]);
  });

  it("a null-target completion never closes a named start; a missing id is no reason to drop it", () => {
    expect(toolCallIndex([edit("started", "a.ts", "x"), edit("completed", null, "x")])).toEqual([
      { name: "apply_patch", target: "a.ts", resolved: false },
      { name: "apply_patch", target: null, resolved: true },
    ]);
    expect(
      toolCallIndex([edit("started", "a.ts", null), edit("completed", "a.ts", null, "error")]),
    ).toEqual([
      { name: "apply_patch", target: "a.ts", resolved: false },
      { name: "apply_patch", target: "a.ts", resolved: true, outcome: "error" },
    ]);
  });

  it("renders ambiguity as unconfirmed, never as a failure or a missing result", () => {
    const calls = toolCallIndex([edit(undefined, "a.ts", "x"), edit(undefined, "a.ts", "x")]);
    const index = buildEvidenceIndex({
      cause: "transport",
      workOrder: "W",
      steering: [],
      retainedOutput: "",
      toolCalls: calls,
      diffStat: null,
      artifacts: { eventsLog: null, attemptDir: null, patch: null },
    });
    expect(index.markdown).toContain("- apply_patch — a.ts (completion not confirmed)");
    expect(index.markdown).not.toContain("no result recorded");
    expect(index.markdown).toContain("Tool calls: 1; unresolved: 1 (completion not confirmed: 1).");
  });
});
