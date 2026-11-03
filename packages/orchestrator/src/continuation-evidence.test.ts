import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVIDENCE_SECTION_BUDGET_BYTES,
  EVIDENCE_TOTAL_BUDGET_BYTES,
  EVIDENCE_TOOL_ROWS,
  buildEvidenceIndex,
  type EvidenceIndexInput,
} from "./continuation-evidence.js";
import {
  collectEvidenceIndexInput,
  diffStatFromPatch,
  steeringFromRunLog,
  toolCallIndex,
} from "./continuation-evidence-io.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })), 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function input(over: Partial<EvidenceIndexInput> = {}): EvidenceIndexInput {
  return {
    cause: "vendor_limit",
    workOrder: "Implement the dashboard mockups.",
    steering: [],
    retainedOutput: "",
    toolCalls: [],
    diffStat: null,
    artifacts: { eventsLog: null, attemptDir: null, patch: null },
    ...over,
  };
}

describe("evidence index (pure)", () => {
  it("is a mechanical index: work order, steering with delivery, output, tools, files, paths", () => {
    const index = buildEvidenceIndex(
      input({
        steering: [
          { text: "Use the blue palette.", delivery: "confirmed" },
          { text: "Also add dark mode.", delivery: "uncertain" },
        ],
        retainedOutput: "Saved two mockups so far.",
        toolCalls: [
          { name: "Write", target: "web/a.html", resolved: true },
          { name: "Bash", target: "npm test", resolved: false },
        ],
        diffStat: "- web/a.html\n- web/b.html",
        artifacts: { eventsLog: "/r/events.jsonl", attemptDir: "/r/attempts/a01", patch: null },
      }),
    );
    expect(index.summarized).toBe(false);
    expect(index.toolCalls).toBe(2);
    expect(index.unresolvedToolCalls).toBe(1);
    const md = index.markdown;
    expect(md).toContain("## Original work order\n\nImplement the dashboard mockups.");
    expect(md).toContain("### Message 1 (delivered)\n\nUse the blue palette.");
    expect(md).toContain(
      "### Message 2 (delivery uncertain — reconcile against the work, do not replay blindly)",
    );
    expect(md).toContain("Saved two mockups so far.");
    expect(md).toContain("- Write — web/a.html (completed)");
    expect(md).toContain("- Bash — npm test (unresolved: no result recorded)");
    expect(md).toContain("- web/a.html\n- web/b.html");
    expect(md).toContain("- Event log: /r/events.jsonl");
    expect(md).toContain("- Attempt artifacts: /r/attempts/a01");
    expect(md).not.toContain("Patch so far");
    expect(md).toContain("(a usage limit on its account)");
  });

  it("truncates honestly: a single cut section flips summarized, the tool index collapses to counts", () => {
    const long = "x".repeat(EVIDENCE_SECTION_BUDGET_BYTES + 100);
    const cut = buildEvidenceIndex(input({ retainedOutput: long }));
    expect(cut.summarized).toBe(true);
    expect(cut.markdown).toContain("…[truncated]");
    const many = buildEvidenceIndex(
      input({
        toolCalls: Array.from({ length: EVIDENCE_TOOL_ROWS + 5 }, (_, i) => ({
          name: `t${i}`,
          target: null,
          resolved: i % 2 === 0,
        })),
      }),
    );
    expect(many.summarized).toBe(true);
    expect(many.markdown).toContain(`${EVIDENCE_TOOL_ROWS + 5} tool calls recorded`);
    expect(many.markdown).not.toContain("- t0 ");
    expect(many.markdown).toContain(`- t${EVIDENCE_TOOL_ROWS + 4} `);
  });
});

describe("evidence collector (I/O)", () => {
  it("combines chain evidence without letting another run close a predecessor tool call", () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-evidence-chain-"));
    roots.push(dir);
    const ancestor = join(dir, "ancestor");
    const current = join(dir, "current");
    for (const runDir of [ancestor, current])
      mkdirSync(join(runDir, "attempts", "a01"), { recursive: true });
    writeFileSync(
      join(ancestor, "attempts", "a01", "events.jsonl"),
      JSON.stringify({
        type: "tool_call",
        session_id: "same",
        tool: { name: "Edit", use_id: "shared" },
      }) + "\n",
    );
    writeFileSync(
      join(current, "attempts", "a01", "events.jsonl"),
      JSON.stringify({
        type: "tool_result",
        session_id: "same",
        tool: { use_id: "shared" },
      }) + "\n",
    );
    const collected = collectEvidenceIndexInput(
      {
        runDir: current,
        attemptId: "a01",
        workOrder: "whole chain",
        steering: [],
        predecessors: [
          {
            runDir: ancestor,
            attemptId: "a01",
            workOrder: "first part",
            steering: [{ text: "preserve the interface", delivery: "uncertain" }],
            retainedOutput: "earlier answer",
            diffStat: null,
          },
        ],
      },
      { cause: "transport", retainedOutput: "new answer", diffStat: null },
    );
    expect(collected.toolCalls).toEqual([{ name: "Edit", target: null, resolved: false }]);
    expect(collected.steering).toEqual([{ text: "preserve the interface", delivery: "uncertain" }]);
    expect(collected.retainedOutput).toBe("earlier answer\n\nnew answer");
    expect(collected.predecessorArtifacts?.[0]?.attemptDir).toBe(join(ancestor, "attempts", "a01"));
  });
  it("pairs legacy rows without ids and reads steering delivery from the run log", () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-evidence-"));
    roots.push(dir);
    const row = (type: string, payload: Record<string, unknown>) =>
      JSON.stringify({ ts: "t", run_id: "r", task_id: "k", type, payload });
    writeFileSync(
      join(dir, "events.jsonl"),
      [
        row("harness.event", {
          attempt_id: "a01",
          type: "tool_call",
          tool: { name: "Read", target: "a.txt" },
        }),
        row("harness.event", { attempt_id: "a01", type: "tool_result", tool: { status: "ok" } }),
        row("harness.event", {
          attempt_id: "a01",
          type: "tool_call",
          tool: { name: "Bash", target: "sleep 100" },
        }),
        row("harness.event", { attempt_id: "zz", type: "tool_call", tool: { name: "Other" } }),
        row("message.accepted", { message_id: "m1", text: "first" }),
        row("message.delivered", { message_id: "m1", text: "first" }),
        row("message.accepted", { message_id: "m2", text: "second" }),
        row("message.accepted", { message_id: "m3", text: "third" }),
        row("message.refused", { message_id: "m3", text: "third" }),
        "{not json",
      ].join("\n"),
    );
    mkdirSync(join(dir, "attempts", "a01"), { recursive: true });
    writeFileSync(join(dir, "attempts", "a01", "patch.diff"), "diff");
    const collected = collectEvidenceIndexInput(
      { runDir: dir, attemptId: "a01", workOrder: "W", steering: [] },
      { cause: "transport", retainedOutput: "out", diffStat: null },
    );
    expect(collected.toolCalls).toEqual([
      { name: "Read", target: "a.txt", resolved: true },
      { name: "Bash", target: "sleep 100", resolved: false },
    ]);
    expect(collected.steering).toEqual([
      { text: "first", delivery: "confirmed" },
      { text: "second", delivery: "uncertain" },
    ]);
    expect(collected.artifacts).toEqual({
      eventsLog: join(dir, "events.jsonl"),
      attemptDir: join(dir, "attempts", "a01"),
      patch: join(dir, "attempts", "a01", "patch.diff"),
    });
    expect(steeringFromRunLog(join(dir, "nope"))).toEqual([]);
    expect(toolCallIndex([{ type: "tool_call", text: "Grep for x\nmore" }])).toEqual([
      { name: "Grep for x", target: null, resolved: false },
    ]);
  });

  it("a repeated untyped edit frame (pre-#410 codex log) is one call whose completion is not confirmed", () => {
    const edit = (session: string) => ({
      type: "file_change",
      session_id: session,
      tool: { name: "apply_patch", kind: "file", use_id: "item-7", target: "src/a.ts" },
    });
    // The repeat may be a completion or a second start: its count proves neither.
    expect(toolCallIndex([edit("s1"), edit("s1")])).toEqual([
      { name: "apply_patch", target: "src/a.ts", resolved: false, unconfirmed: true },
    ]);
    // A single untyped frame proves no completion either way; another session's id is its own call.
    expect(toolCallIndex([edit("s1"), edit("s2")])).toEqual([
      { name: "apply_patch", target: "src/a.ts", resolved: false, unconfirmed: true },
      { name: "apply_patch", target: "src/a.ts", resolved: false, unconfirmed: true },
    ]);
  });

  it("one codex item with several paths is one call per path, each resolved by its own typed completion", () => {
    const edit = (path: string, phase?: "started" | "completed") => ({
      type: "file_change",
      session_id: "s1",
      tool: { name: "apply_patch", kind: "file", use_id: "patch-1", target: path, phase },
    });
    expect(toolCallIndex([edit("one.ts", "started"), edit("two.ts", "started")])).toEqual([
      { name: "apply_patch", target: "one.ts", resolved: false },
      { name: "apply_patch", target: "two.ts", resolved: false },
    ]);
    expect(
      toolCallIndex([
        edit("one.ts", "started"),
        edit("two.ts", "started"),
        edit("one.ts", "completed"),
        edit("two.ts", "completed"),
      ]),
    ).toEqual([
      { name: "apply_patch", target: "one.ts", resolved: true },
      { name: "apply_patch", target: "two.ts", resolved: true },
    ]);
    // The same untyped frames from an older log only prove that each path was named.
    expect(toolCallIndex([edit("one.ts"), edit("two.ts"), edit("one.ts"), edit("two.ts")])).toEqual(
      [
        { name: "apply_patch", target: "one.ts", resolved: false, unconfirmed: true },
        { name: "apply_patch", target: "two.ts", resolved: false, unconfirmed: true },
      ],
    );
  });

  it("prefers the attempt's own event log when present and lists changed files from a patch", () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-evidence-"));
    roots.push(dir);
    mkdirSync(join(dir, "attempts", "a01"), { recursive: true });
    writeFileSync(
      join(dir, "attempts", "a01", "events.jsonl"),
      JSON.stringify({ type: "tool_call", tool: { name: "Edit" } }) + "\n",
    );
    writeFileSync(join(dir, "events.jsonl"), "");
    const collected = collectEvidenceIndexInput(
      {
        runDir: dir,
        attemptId: "a01",
        workOrder: "W",
        steering: [{ text: "s", delivery: "confirmed" }],
      },
      { cause: "transport", retainedOutput: "", diffStat: null },
    );
    expect(collected.toolCalls).toEqual([{ name: "Edit", target: null, resolved: false }]);
    expect(collected.steering).toEqual([{ text: "s", delivery: "confirmed" }]);
    expect(
      diffStatFromPatch("diff --git a/src/a.ts b/src/a.ts\n+x\ndiff --git a/b.md b/b.md\n"),
    ).toBe("- src/a.ts\n- b.md");
    expect(diffStatFromPatch("")).toBeNull();
  });
});

describe("evidence review regressions", () => {
  it("keeps a long predecessor chain within the packet budget with honest truncation", () => {
    const index = buildEvidenceIndex(
      input({
        predecessorArtifacts: Array.from({ length: 200 }, (_, n) => ({
          eventsLog: `/runs/${n}/${"path".repeat(50)}/events.jsonl`,
          attemptDir: null,
          patch: null,
        })),
      }),
    );
    expect(index.summarized).toBe(true);
    expect(index.bytes).toBeLessThanOrEqual(EVIDENCE_TOTAL_BUDGET_BYTES);
    expect(index.markdown).toContain("Tool calls: 0; unresolved: 0.");
  });
  it("pairs results by use id within a try and retains unresolved edit calls", () => {
    const calls = toolCallIndex([
      { session_id: "try-1", type: "file_change", tool: { name: "Write", use_id: "first" } },
      { session_id: "try-1", type: "tool_call", tool: { name: "Read", use_id: "second" } },
      { session_id: "try-1", type: "tool_result", tool: { use_id: "second" } },
      { session_id: "try-2", type: "tool_result", tool: { use_id: "first" } },
      { session_id: "try-1", type: "file_change", tool: { name: "Edit", use_id: "edit" } },
    ]);
    expect(calls).toEqual([
      { name: "Write", target: null, resolved: false, unconfirmed: true },
      { name: "Read", target: null, resolved: true },
      { name: "Edit", target: null, resolved: false, unconfirmed: true },
    ]);
  });

  it("leaves unmatched and ambiguous ids unresolved, with oldest-open fallback only for idless results", () => {
    const rows = [
      { type: "tool_call", tool: { name: "Write", use_id: "duplicate" } },
      { type: "tool_call", tool: { name: "Read", use_id: "duplicate" } },
      { type: "tool_result", tool: { use_id: "missing" } },
      { type: "tool_result", tool: { use_id: "duplicate" } },
    ];
    expect(toolCallIndex(rows).map((c) => c.resolved)).toEqual([false, false]);
    expect(
      toolCallIndex([...rows, { type: "tool_result", tool: {} }]).map((c) => c.resolved),
    ).toEqual([true, false]);
  });

  it("preserves absolute paths and tool counts when the whole index is truncated", () => {
    const index = buildEvidenceIndex(
      input({
        workOrder: "w".repeat(8100),
        steering: [
          { text: "s".repeat(8100), delivery: "confirmed" },
          { text: "t".repeat(8100), delivery: "uncertain" },
        ],
        retainedOutput: "r".repeat(8100),
        toolCalls: [{ name: "Write", target: "pending.txt", resolved: false }],
        artifacts: {
          eventsLog: "/fixture/events.jsonl",
          attemptDir: "/fixture/attempts/a01",
          patch: "/fixture/attempts/a01/patch.diff",
        },
      }),
    );
    expect(index.summarized).toBe(true);
    expect(index.markdown).toContain("/fixture/events.jsonl");
    expect(index.markdown).toContain("/fixture/attempts/a01/patch.diff");
    expect(index.markdown).toContain("Tool calls: 1; unresolved: 1.");
    expect(index.bytes).toBeLessThanOrEqual(EVIDENCE_TOTAL_BUDGET_BYTES);
  });

  it("filters steering by attempt when the log carries an attempt id", () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-evidence-"));
    roots.push(dir);
    writeFileSync(
      join(dir, "events.jsonl"),
      [
        {
          type: "message.accepted",
          payload: { attempt_id: "a01", message_id: "one", text: "mine" },
        },
        {
          type: "message.accepted",
          payload: { attempt_id: "a02", message_id: "two", text: "other attempt" },
        },
        {
          type: "message.delivered",
          payload: { attempt_id: "a02", message_id: "two", text: "other attempt" },
        },
        { type: "message.accepted", payload: { message_id: "global", text: "run steering" } },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );
    const collected = collectEvidenceIndexInput(
      { runDir: dir, attemptId: "a01", workOrder: "W", steering: [] },
      { cause: "transport", retainedOutput: "", diffStat: null },
    );
    expect(collected.steering).toEqual([
      { text: "mine", delivery: "uncertain" },
      { text: "run steering", delivery: "uncertain" },
    ]);
  });
});

// #450: a command result that reports a background handoff, an elapsed
// timeout or an unknown outcome carries a recorded result, yet the command did
// not finish; the packet must never list it as completed.
describe("command outcomes in the evidence index (#450)", () => {
  const call = (id: string, target: string) => ({
    type: "tool_call",
    session_id: "s1",
    tool: { name: "shell", kind: "command", use_id: id, target },
  });
  const result = (id: string, extra: Record<string, unknown> = {}) => ({
    type: "tool_result",
    session_id: "s1",
    tool: { name: "shell", kind: "command", use_id: id, status: "ok", ...extra },
  });
  const handoff = {
    state: "backgrounded",
    background_reason: "timeout",
    timeout_ms: 30000,
    shell_id: "3",
    pid: 4242,
  };

  it("forwards the stored result's command facts onto its call", () => {
    const calls = toolCallIndex([
      call("bg", "find /workspace -name '*.log'"),
      result("bg", { command_outcome: handoff }),
      call("ls", "ls"),
      result("ls", { exit_code: 0, command_outcome: { state: "exited" } }),
      call("legacy", "pnpm test"),
      result("legacy"),
    ]);
    expect(calls).toEqual([
      {
        name: "shell",
        target: "find /workspace -name '*.log'",
        resolved: true,
        commandOutcome: handoff,
      },
      { name: "shell", target: "ls", resolved: true, commandOutcome: { state: "exited" } },
      { name: "shell", target: "pnpm test", resolved: true },
    ]);
    expect(calls[2]).not.toHaveProperty("commandOutcome");
  });

  it("labels unconfirmed commands and keeps exits, legacy and cut-off calls as before", () => {
    const md = buildEvidenceIndex(
      input({
        toolCalls: [
          { name: "shell", target: "find /workspace", resolved: true, commandOutcome: handoff },
          {
            name: "shell",
            target: "sleep 120",
            resolved: true,
            commandOutcome: { state: "timed_out", timeout_ms: 30000 },
          },
          { name: "shell", target: "x", resolved: true, commandOutcome: { state: "suspended" } },
          { name: "shell", target: "ls", resolved: true, commandOutcome: { state: "exited" } },
          { name: "shell", target: "pnpm test", resolved: true },
          { name: "shell", target: "pnpm build", resolved: false },
        ],
      }),
    ).markdown;
    expect(md).toContain(
      "- shell — find /workspace (unconfirmed: Moved to background after 30s · still running · shell 3 · pid 4242)",
    );
    expect(md).toContain(
      "- shell — sleep 120 (unconfirmed: Timed out after 30s · exit status unknown)",
    );
    expect(md).toContain("- shell — x (unconfirmed: Command outcome not reported)");
    expect(md).toContain("- shell — ls (completed)");
    expect(md).toContain("- shell — pnpm test (completed)");
    expect(md).toContain("- shell — pnpm build (unresolved: no result recorded)");
    expect(md).not.toContain("find /workspace (completed)");
    expect(md).toContain("Tool calls: 6; unresolved: 1.");
  });
});
