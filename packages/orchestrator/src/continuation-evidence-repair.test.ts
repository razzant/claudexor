/**
 * Review repair controls for the tool-call collector and the Codex edit
 * producer, through the real parsers. The OpenCode stream is its committed
 * SYNTHETIC `basic-run.jsonl`; the Codex frames are synthetic native-format
 * examples. They prove parser -> collector behavior, never vendor behavior.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessEvent } from "@claudexor/schema";
import {
  EVIDENCE_TOTAL_BUDGET_BYTES,
  buildEvidenceIndex,
  uncoveredWorkSection,
} from "./continuation-evidence.js";
import { toolCallIndex } from "./continuation-evidence-io.js";
import { codexFileChangeEvents } from "../../harness-codex/src/file-change.js";
import { parseCodexEvent } from "../../harness-codex/src/parse.js";
import { parseAgyEvent } from "../../harness-agy/src/parse.js";
import { parseOpenCodeEvent } from "../../harness-opencode/src/parse.js";

const here = dirname(fileURLToPath(import.meta.url));
const rows = (events: HarnessEvent[]) =>
  toolCallIndex(events.map((event) => JSON.parse(JSON.stringify(event))));
const render = (calls: ReturnType<typeof toolCallIndex>) =>
  buildEvidenceIndex({
    cause: "transport",
    workOrder: "W",
    steering: [],
    retainedOutput: "",
    toolCalls: calls,
    diffStat: null,
    artifacts: { eventsLog: null, attemptDir: null, patch: null },
  }).markdown;

describe("results recorded without an earlier call", () => {
  it("keep their completion, target and outcome; their companion edit adds nothing (opencode basic-run)", () => {
    const frames = readFileSync(
      join(here, "../../harness-opencode/fixtures/basic-run.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    const events = frames.flatMap((frame) => parseOpenCodeEvent(frame, "s1") ?? []);
    const calls = rows(events);
    expect(calls).toEqual([
      { name: "bash", target: "pnpm test", resolved: true },
      { name: "edit", target: "src/a.ts", resolved: true },
      { name: "webfetch", target: null, resolved: true, outcome: "error" },
    ]);
    const markdown = render(calls);
    expect(markdown).toContain("- edit — src/a.ts (completed)");
    expect(markdown).toContain("- webfetch (completed: error)");
    expect(markdown).toContain("Tool calls: 3; unresolved: 0.");
  });

  it("an ambiguous result closes no earlier start and adds no row; a repeated result adds nothing", () => {
    const call = (id: string) => ({
      type: "tool_call",
      session_id: "s",
      tool: { name: "Run", use_id: id },
    });
    const result = (id: string) => ({
      type: "tool_result",
      session_id: "s",
      tool: { name: "Run", use_id: id, status: "ok" },
    });
    expect(toolCallIndex([call("dup"), call("dup"), result("dup")]).map((c) => c.resolved)).toEqual(
      [false, false],
    );
    expect(toolCallIndex([call("one"), result("one"), result("one")])).toEqual([
      { name: "Run", target: null, resolved: true },
    ]);
  });
});

describe("Codex edit identity and journal size", () => {
  const prefix = `src/${"deeply/nested/".repeat(36)}`;
  const first = `${prefix}${"a".repeat(564 - prefix.length)}`;
  const second = `${prefix}${"b".repeat(564 - prefix.length)}`;

  it("two valid long paths sharing a 500-character prefix stay two edits and never close each other", () => {
    expect(first).toHaveLength(564);
    expect(first).not.toBe(second);
    expect(first.slice(0, 500)).toBe(second.slice(0, 500));
    const completed = parseCodexEvent(
      {
        type: "item.completed",
        item: {
          id: "p1",
          type: "file_change",
          changes: [{ path: first }, { path: second }],
          status: "completed",
        },
      },
      "s1",
      {},
    )!;
    expect(rows(completed)).toHaveLength(2);
    const started = parseCodexEvent(
      {
        type: "item.started",
        item: { id: "p2", type: "file_change", changes: [{ path: first }, { path: second }] },
      },
      "s1",
      {},
    )!;
    const onlyFirst = parseCodexEvent(
      {
        type: "item.completed",
        item: { id: "p2", type: "file_change", changes: [{ path: first }], status: "completed" },
      },
      "s1",
      {},
    )!;
    expect(rows([...started, ...onlyFirst]).map((call) => call.resolved)).toEqual([true, false]);
  });

  it("per-path events carry their own change, so the journal grows linearly with the paths", () => {
    const changes = Array.from({ length: 100 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      kind: "update",
    }));
    const item = { id: "big", type: "file_change", changes, status: "completed" };
    const events = parseCodexEvent({ type: "item.completed", item }, "s1", {})!;
    expect(events).toHaveLength(100);
    const input = JSON.stringify(item).length;
    const normalized = events.reduce((sum, event) => sum + JSON.stringify(event).length, 0);
    // Each event is bounded by its own change, not the whole item.
    expect(normalized).toBeLessThan(input * 10);
    expect(events[7]?.payload).toMatchObject({
      path: "src/file-7.ts",
      change: { path: "src/file-7.ts" },
    });
  });
});

describe("an untyped edit frame proves no completion either way", () => {
  it("a standalone untyped edit reads completion not confirmed, not a certain missing result", () => {
    const calls = toolCallIndex([
      {
        type: "file_change",
        session_id: "s",
        tool: { name: "apply_patch", kind: "file", use_id: "i4", target: "src/a.ts" },
      },
    ]);
    expect(calls).toEqual([
      { name: "apply_patch", target: "src/a.ts", resolved: false, unconfirmed: true },
    ]);
    expect(render(calls)).toContain("- apply_patch — src/a.ts (completion not confirmed)");
  });
});

/*
 * Astra r1 review repros, verbatim assertions (`path-identity.repro.mjs`,
 * `tool-parser-review.mjs`, `tool-lifecycle-review.mjs`; sha256 in
 * .review-evidence/cx-continuity-repair/astra-repro-verbatim.sha256). `assert`
 * became `expect`; observations the scripts only printed are asserted as the
 * repaired contract (marked).
 */
describe("review: tool and edit evidence through the actual parsers", () => {
  const frames = (path: string) =>
    readFileSync(join(here, path), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);

  it("path identity: both completed paths survive even when their bounded display targets coincide", () => {
    const prefix = "segment/".repeat(70);
    const paths = [prefix + "A.ts", prefix + "B.ts"];
    const events = codexFileChangeEvents(
      {
        id: "edit-1",
        status: "completed",
        changes: paths.map((path) => ({ path, kind: "update" })),
      },
      "completed",
      "session-1",
      "2026-10-29T00:00:00Z",
    );
    const calls = toolCallIndex(events);
    expect(calls.length).toBe(2);
  });

  it("AGY recorded read ACTIVE/DONE pairing", () => {
    const agy = frames("../../harness-agy/fixtures/basic-run.jsonl").flatMap(
      (frame) => parseAgyEvent(frame, "s1") ?? [],
    );
    expect(agy.filter((event) => event.tool).map((event) => event.tool!.use_id)).toEqual([
      "step-3",
      "step-3",
    ]);
    expect(toolCallIndex(agy)).toEqual([
      { name: "view_file", target: "/workspace/demo", resolved: true },
    ]);
  });

  it("Codex A/B started, B/C failed completion", () => {
    const start = codexFileChangeEvents(
      { id: "p1", changes: [{ path: "A.ts" }, { path: "B.ts" }] },
      "started",
      "s1",
      "2026-10-29",
    );
    const done = codexFileChangeEvents(
      { id: "p1", status: "failed", changes: [{ path: "B.ts" }, { path: "C.ts" }] },
      "completed",
      "s1",
      "2026-10-29",
    );
    expect(toolCallIndex([...start, ...done])).toEqual([
      { name: "apply_patch", target: "A.ts", resolved: false },
      { name: "apply_patch", target: "B.ts", resolved: true, outcome: "error" },
      { name: "apply_patch", target: "C.ts", resolved: true, outcome: "error" },
    ]);
  });

  it("two distinct valid paths sharing a bounded display target stay two edits (repaired contract)", () => {
    const prefix = "segment/".repeat(70);
    const longStart = codexFileChangeEvents(
      { id: "p2", changes: [{ path: prefix + "A.ts" }] },
      "started",
      "s1",
      "2026-10-29",
    );
    const longDone = codexFileChangeEvents(
      { id: "p2", status: "completed", changes: [{ path: prefix + "B.ts" }] },
      "completed",
      "s1",
      "2026-10-29",
    );
    expect(longStart[0]!.payload!["path"]).not.toBe(longDone[0]!.payload!["path"]);
    expect(toolCallIndex([...longStart, ...longDone]).map((call) => call.resolved)).toEqual([
      false,
      true,
    ]);
  });

  it("Codex completed-item serialization stays linear in the path count (repaired contract)", () => {
    const amplification = [10, 100, 1000].map((count) => {
      const item = {
        id: "batch",
        status: "completed",
        changes: Array.from({ length: count }, (_, i) => ({
          path: `file-${i}.ts`,
          kind: "update",
        })),
      };
      const events = codexFileChangeEvents(item, "completed", "s1", "2026-10-29");
      const inputBytes = Buffer.byteLength(JSON.stringify(item));
      const outputBytes = events.reduce(
        (sum, event) => sum + Buffer.byteLength(JSON.stringify(event)),
        0,
      );
      return outputBytes / inputBytes;
    });
    // The review measured 15x, 106x and 1006x: quadratic. A per-path event is bounded by its own change.
    for (const ratio of amplification) expect(ratio).toBeLessThan(12);
  });

  it("lifecycle: OpenCode completed-only edit + companion, legacy Codex completed-only edit, result-only failure (repaired contract)", () => {
    expect(
      toolCallIndex([
        {
          type: "tool_result",
          session_id: "s1",
          text: "tool_result",
          tool: { name: "edit", kind: "file", use_id: "t2", target: "src/a.ts", status: "ok" },
        },
        {
          type: "file_change",
          session_id: "s1",
          tool: { name: "edit", kind: "file", use_id: "t2" },
          payload: { path: "src/a.ts", tool: "edit" },
        },
      ]),
    ).toEqual([{ name: "edit", target: "src/a.ts", resolved: true }]);
    expect(
      toolCallIndex([
        {
          type: "file_change",
          session_id: "s1",
          tool: { name: "apply_patch", kind: "file", use_id: "i4", target: "src/a.ts" },
          payload: { path: "src/a.ts", item: { id: "i4", type: "file_change", path: "src/a.ts" } },
        },
      ]),
    ).toEqual([{ name: "apply_patch", target: "src/a.ts", resolved: false, unconfirmed: true }]);
    expect(
      toolCallIndex([
        {
          type: "tool_result",
          session_id: "s1",
          tool: {
            name: "bash",
            kind: "command",
            use_id: "i3",
            target: "pnpm build",
            status: "error",
            error_summary: "build failed: 1 error",
          },
        },
      ]),
    ).toEqual([{ name: "bash", target: "pnpm build", resolved: true, outcome: "error" }]);
  });
});

describe("work a resumed session never received", () => {
  it("is labelled evidence, bounded, and keeps the full record's path past any cut", () => {
    expect(
      uncoveredWorkSection({
        steering: [],
        retainedOutput: " ",
        toolCalls: [],
        eventsLog: "/r/events.jsonl",
      }),
    ).toBe("");
    const section = uncoveredWorkSection({
      steering: ["keep the API"],
      retainedOutput: "x".repeat(40_000),
      toolCalls: Array.from({ length: 70 }, (_, i) => ({
        name: "Read",
        target: `f${i}`,
        resolved: true,
      })),
      eventsLog: "/r/events.jsonl",
    });
    expect(section).toContain("It is not part of the resumed session's history");
    expect(section).toContain("### Message 1\n\nkeep the API");
    expect(section).toContain("(the last 60 of 70)");
    expect(Buffer.byteLength(section)).toBeLessThanOrEqual(EVIDENCE_TOTAL_BUDGET_BYTES);
    expect(section.endsWith("Full record: /r/events.jsonl")).toBe(true);
  });
});

/*
 * #450 seam joint contract (agreed with its owner): a result's `command_outcome`
 * travels with every closing point, the result-only path included, and the tool
 * row shows an unconfirmed command first, then this collector's own states, then
 * the attempt suffix. Unconfirmed means any command_outcome but `exited`.
 */
describe("#450 command outcomes at every closing point of the collector", () => {
  const call = (id: string, target: string) => ({
    type: "tool_call",
    session_id: "s1",
    tool: { name: "shell", kind: "command", use_id: id, target },
  });
  const result = (id: string, extra: Record<string, unknown>, target?: string) => ({
    type: "tool_result",
    session_id: "s1",
    tool: {
      name: "shell",
      kind: "command",
      use_id: id,
      status: "ok",
      ...(target ? { target } : {}),
      ...extra,
    },
  });
  const backgrounded = {
    state: "backgrounded",
    background_reason: "timeout",
    timeout_ms: 30000,
    shell_id: "7",
  };

  it("a backgrounded command is unconfirmed on the result-only path and after a normal call", () => {
    const calls = toolCallIndex([
      result("only", { command_outcome: backgrounded }, "sleep 300"),
      call("paired", "find / -name '*.log'"),
      result("paired", { command_outcome: backgrounded }),
    ]);
    expect(calls).toEqual([
      { name: "shell", target: "sleep 300", resolved: true, commandOutcome: backgrounded },
      {
        name: "shell",
        target: "find / -name '*.log'",
        resolved: true,
        commandOutcome: backgrounded,
      },
    ]);
    const markdown = render(calls);
    expect(markdown).toContain(
      "- shell — sleep 300 (unconfirmed: Handed off to background after its 30s timeout; completion not observed · shell 7)",
    );
    expect(markdown).toContain(
      "- shell — find / -name '*.log' (unconfirmed: Handed off to background after its 30s timeout; completion not observed · shell 7)",
    );
    expect(markdown).not.toContain("(completed)");
  });

  it("positive controls: an observed exit is completed (a nonzero exit keeps its error status); timed_out and unknown stay unconfirmed", () => {
    const calls = toolCallIndex([
      call("ok", "ls"),
      result("ok", { exit_code: 0, command_outcome: { state: "exited" } }),
      call("bad", "pnpm test"),
      result("bad", { status: "error", exit_code: 2, command_outcome: { state: "exited" } }),
      result("late", { command_outcome: { state: "timed_out", timeout_ms: 30000 } }, "sleep 120"),
      call("lost", "make"),
      result("lost", { command_outcome: { state: "unknown" } }),
    ]);
    const markdown = render(calls);
    expect(markdown).toContain("- shell — ls (completed)");
    expect(markdown).toContain("- shell — pnpm test (completed: error)");
    expect(markdown).not.toContain("pnpm test (unconfirmed");
    expect(markdown).toContain(
      "- shell — sleep 120 (unconfirmed: Timed out after 30s · exit status unknown)",
    );
    expect(markdown).toContain("- shell — make (unconfirmed: Command outcome not reported)");
    expect(markdown).toContain("Tool calls: 4; unresolved: 0.");
  });

  it("orders the unconfirmed command first and the attempt suffix last", () => {
    const markdown = render([
      {
        name: "shell",
        target: "watch",
        resolved: true,
        outcome: "error",
        commandOutcome: { state: "backgrounded" },
        attempt: "a02",
      },
      { name: "shell", target: "cat x", resolved: false, attempt: "a01" },
    ]);
    expect(markdown).toContain(
      "- shell — watch (unconfirmed: Handed off to background; completion not observed) · attempt a02",
    );
    expect(markdown).toContain("- shell — cat x (unresolved: no result recorded) · attempt a01");
  });
});

describe("tool rows end on a whole character at their unit limits (#577 class)", () => {
  // U+1F600 is one character in two UTF-16 units.
  const emoji = "\u{1F600}";
  const call = (target: string | undefined, text?: string) => ({
    type: "tool_call",
    session_id: "s",
    ...(text === undefined ? { tool: { name: "Read", target } } : { text }),
  });
  const lone = /\p{Surrogate}/u;

  it("a target straddling unit 160 and a name straddling unit 80 drop that character whole", () => {
    const calls = toolCallIndex([
      call(`${"t".repeat(159)}${emoji} tail`),
      call(undefined, `${"n".repeat(79)}${emoji} rest\nsecond line`),
    ]);
    expect(calls[1]!.name).toBe("n".repeat(79));
    const markdown = render(calls);
    expect(markdown).toContain(`- Read — ${"t".repeat(159)} (unresolved: no result recorded)`);
    expect(markdown).toContain(`- ${"n".repeat(79)} (unresolved: no result recorded)`);
    expect(lone.test(markdown)).toBe(false);
    expect(Buffer.from(markdown, "utf8").toString("utf8")).not.toContain("�");
  });

  it("keeps a character inside the limit, text that fits and a source's own lone surrogate", () => {
    const inside = `${"t".repeat(158)}${emoji}tail`;
    const exact = "e".repeat(160);
    const malformed = `${"m".repeat(159)}\uD83Dx`;
    const calls = toolCallIndex([
      call(inside),
      call(exact),
      call(malformed),
      call(undefined, `${"n".repeat(78)}${emoji}rest`),
    ]);
    expect(calls[3]!.name).toBe(`${"n".repeat(78)}${emoji}`);
    const markdown = render(calls);
    expect(markdown).toContain(`- Read — ${"t".repeat(158)}${emoji} (unresolved`);
    expect(markdown).toContain(`- Read — ${exact} (unresolved`);
    // The limits are unchanged and malformed source text is not repaired.
    expect(markdown).toContain(`- Read — ${malformed.slice(0, 160)} (unresolved`);
  });
});
