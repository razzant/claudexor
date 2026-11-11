import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HarnessEvent } from "@claudexor/schema";
import { createClaudeParser, parseClaudeEvent } from "./parse.js";

type Frame = Record<string, unknown>;

const fixture = (name: string): Frame[] =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Frame);

function parseAll(frames: Frame[], parse = createClaudeParser()): HarnessEvent[] {
  return frames.flatMap((frame) => parse(frame, "ses-1") ?? []);
}

/** Speech rows in stream order with keys renamed K1, K2… by first appearance (keys are opaque). */
function speech(events: HarnessEvent[]): unknown[][] {
  const names = new Map<string, string>();
  return events
    .filter((e) => e.type === "message" || e.speech !== undefined)
    .map((e) => {
      const key = e.speech?.key;
      if (key !== undefined && !names.has(key)) names.set(key, `K${names.size + 1}`);
      const label = key === undefined ? null : names.get(key);
      return [e.type, e.text, label, e.speech?.op ?? null, e.final === true];
    });
}

/** Each text message that names a joined run, keys renamed as `speech` renames them. */
function joinedRuns(events: HarnessEvent[]): unknown[][] {
  const names = new Map<string, string>();
  return events
    .filter((e) => e.type === "message" || e.speech !== undefined)
    .flatMap((e) => {
      const key = e.speech?.key;
      if (key !== undefined && !names.has(key)) names.set(key, `K${names.size + 1}`);
      const run = e.payload?.["joined_speech_keys"];
      return Array.isArray(run) ? [[e.text, run.map((k: string) => names.get(k) ?? k)]] : [];
    });
}

const main = { parent_tool_use_id: null };
const start = (id: unknown, extra: Frame = {}): Frame => ({
  type: "stream_event",
  ...main,
  event: { type: "message_start", message: { id } },
  ...extra,
});
const blockStart = (index: number, extra: Frame = {}, type = "text"): Frame => ({
  type: "stream_event",
  ...main,
  event: { type: "content_block_start", index, content_block: { type } },
  ...extra,
});
const delta = (index: number, text: string, extra: Frame = {}): Frame => ({
  type: "stream_event",
  ...main,
  event: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
  ...extra,
});
const blockStop = (index: number, extra: Frame = {}): Frame => ({
  type: "stream_event",
  ...main,
  event: { type: "content_block_stop", index },
  ...extra,
});
const stop = (extra: Frame = {}): Frame => ({
  type: "stream_event",
  ...main,
  event: { type: "message_stop" },
  ...extra,
});
const assistant = (id: unknown, content: unknown[], extra: Frame = {}): Frame => ({
  type: "assistant",
  ...main,
  message: { id, content },
  ...extra,
});
const text = (value: string) => ({ type: "text", text: value });
const success = (result: string): Frame => ({ type: "result", subtype: "success", result });
const abandoned = (id: unknown, from: unknown): Frame =>
  stop({ abandoned_blocks: { api_message_id: id, from_block_index: from } });

describe("claude speech identity: recorded 2.1.311 controlled-endpoint streams", () => {
  it("keys each response incarnation's text block once; fragments and its exact completion share it; the result stays unkeyed", () => {
    const events = parseAll(fixture("recorded-partial-messages.jsonl"));
    expect(speech(events)).toEqual([
      ["message", "Checking", "K1", "fragment", false],
      ["message", " the file", "K1", "fragment", false],
      ["message", " first.", "K1", "fragment", false],
      ["message", "Checking the file first.", "K1", "complete", false],
      ["message", "The file", "K2", "fragment", false],
      ["message", " does not", "K2", "fragment", false],
      ["message", " exist.", "K2", "fragment", false],
      ["message", "The file does not exist.", "K2", "complete", false],
      // Same words as K2's completion, yet no native link: a separate typed final.
      ["message", "The file does not exist.", null, null, true],
    ]);
    const final = events.find((e) => e.final === true)!;
    expect(final.payload?.["final_source"]).toBe("result");
    for (const e of events) expect(HarnessEvent.parse(e).speech).toEqual(e.speech);
    // The legacy fragment flag and the typed op are one decision on keyed text.
    for (const e of events.filter((e) => e.type === "message" && e.speech !== undefined))
      expect(e.payload?.["delta"] === true).toBe(e.speech?.op === "fragment");
  });

  it("gives one response's two text blocks two keys, each completed only by its own contained snapshot (multi-block)", () => {
    const frames = fixture("recorded-partial-multiblock.jsonl");
    const starts = frames.filter(
      (f) => (f["event"] as Frame | undefined)?.["type"] === "message_start",
    );
    expect(starts.map((f) => f["api_message_id"])).toEqual(["msg_mb_A", "msg_mb_B"]);
    const events = parseAll(frames);
    expect(speech(events)).toEqual([
      ["message", "Two checks:", "K1", "fragment", false],
      ["message", " first.", "K1", "fragment", false],
      ["message", "Two checks: first.", "K1", "complete", false],
      ["message", "Then", "K2", "fragment", false],
      ["message", " the second.", "K2", "fragment", false],
      ["message", "Then the second.", "K2", "complete", false],
      ["message", "Both files", "K3", "fragment", false],
      ["message", " are missing.", "K3", "fragment", false],
      ["message", "Both files are missing.", "K3", "complete", false],
      ["message", "Both files are missing.", null, null, true],
    ]);
    expect(events.filter((e) => e.type === "tool_call").every((e) => e.speech === undefined)).toBe(
      true,
    );
  });

  it("never links a same-id replay to the abandoned incarnation; the abandon marker is the CLI's own and keeps the partial text", () => {
    const frames = fixture("recorded-partial-replay.jsonl");
    const starts = frames.filter(
      (f) => (f["event"] as Frame | undefined)?.["type"] === "message_start",
    );
    // Native fact: the retried response reused the abandoned response's id.
    expect(starts.map((f) => f["api_message_id"])).toEqual(["msg_rp_X", "msg_rp_X", "msg_rp_Y"]);
    const events = parseAll(frames);
    expect(speech(events)).toEqual([
      ["message", "Checking", "K1", "fragment", false],
      ["message", " the", "K1", "fragment", false],
      ["status", "streamed text abandoned by the CLI", "K1", "abandoned", false],
      ["message", "Checking", "K2", "fragment", false],
      ["message", " the", "K2", "fragment", false],
      ["message", " file first.", "K2", "fragment", false],
      ["message", "Checking the file first.", "K2", "complete", false],
      ["message", "The file", "K3", "fragment", false],
      ["message", " does not exist.", "K3", "fragment", false],
      ["message", "The file does not exist.", "K3", "complete", false],
      ["message", "The file does not exist.", null, null, true],
    ]);
    const marker = events.find((e) => e.speech?.op === "abandoned")!;
    expect(marker.payload).toEqual({ code: "speech_abandoned", from_block_index: 0 });
    expect(events.find((e) => e.status?.kind === "api_retry")?.speech).toBeUndefined();
  });

  it("never emits a complete link in a text_runs_joined incarnation; each run's one frame names the keys it joins", () => {
    const frames = fixture("recorded-partial-joined.jsonl");
    expect(
      frames
        .filter((f) => (f["event"] as Frame | undefined)?.["type"] === "message_start")
        .map((f) => f["text_runs_joined"]),
    ).toEqual([true, true]);
    const events = parseAll(frames);
    expect(speech(events)).toEqual([
      ["message", "Part one.", "K1", "fragment", false],
      ["message", " Part two.", "K2", "fragment", false],
      ["message", "Part one. Part two.", null, null, false],
      ["message", "Done", "K3", "fragment", false],
      ["message", ".", "K3", "fragment", false],
      ["message", "Done.", null, null, false],
      ["message", "Done.", null, null, true],
    ]);
    // The deferred frame after the run's last stop names that run; the result names none.
    expect(joinedRuns(events)).toEqual([
      ["Part one. Part two.", ["K1", "K2"]],
      ["Done.", ["K3"]],
    ]);
  });

  it("names no run outside a text_runs_joined incarnation", () => {
    for (const name of [
      "recorded-partial-messages.jsonl",
      "recorded-partial-multiblock.jsonl",
      "recorded-partial-replay.jsonl",
    ])
      expect(joinedRuns(parseAll(fixture(name))), name).toEqual([]);
  });
});

describe("claude speech identity: ambiguity stays unlinked", () => {
  it("does not link a deferred prior snapshot while the next block is open in a joined incarnation (amendment 1)", () => {
    const events = parseAll([
      start("m1", { text_runs_joined: true }),
      blockStart(0),
      delta(0, "a"),
      blockStop(0),
      blockStart(1),
      delta(1, "b"),
      assistant("m1", [text("a")]),
      assistant("m1", [text("b")]),
      blockStop(1),
      stop(),
    ]);
    expect(speech(events)).toEqual([
      ["message", "a", "K1", "fragment", false],
      ["message", "b", "K2", "fragment", false],
      ["message", "a", null, null, false],
      ["message", "b", null, null, false],
    ]);
    // Frames inside the run, before its last stop, name nothing.
    expect(joinedRuns(events)).toEqual([]);
  });

  it("names a joined run only when its lifecycle is exact; any other text frame ends it unnamed", () => {
    const joined = { text_runs_joined: true };
    const events = parseAll([
      // A block of the run whose start names another response: not exactly observed.
      start("m1", joined),
      blockStart(0),
      delta(0, "a"),
      blockStop(0),
      blockStart(1, { api_message_id: "m2" }),
      delta(1, "b"),
      blockStop(1),
      assistant("m1", [text("ab")]),
      stop(),
      // Another block started after the run: its frame comes too late to name it.
      start("m3", joined),
      blockStart(0),
      delta(0, "c"),
      blockStop(0),
      blockStart(1, {}, "tool_use"),
      assistant("m3", [text("c")]),
      blockStop(1),
      stop(),
      // Another response's id ends the run; the late frame of the right id names nothing.
      start("m4", joined),
      blockStart(0),
      delta(0, "d"),
      blockStop(0),
      assistant("m9", [text("d")]),
      assistant("m4", [text("d")]),
      stop(),
      // An interrupted partial names nothing.
      start("m5", joined),
      blockStart(0),
      delta(0, "e"),
      blockStop(0),
      assistant("m5", [text("e")], { aborted: true }),
      stop(),
      // A run is named once: a second frame names nothing.
      start("m6", joined),
      blockStart(0),
      delta(0, "f"),
      blockStop(0),
      assistant("m6", [text("f")]),
      assistant("m6", [text("f")]),
      stop(),
      // A frame whose own api_message_id names another response is not authoritative.
      start("m7", { ...joined, api_message_id: "m7" }),
      blockStart(0, { api_message_id: "m7" }),
      delta(0, "g", { api_message_id: "m7" }),
      blockStop(0, { api_message_id: "m7" }),
      assistant("m7", [text("g")], { api_message_id: "m8" }),
      stop({ api_message_id: "m7" }),
    ]);
    expect(joinedRuns(events)).toEqual([["f", ["K5"]]]);
    expect(events.every((e) => e.speech?.op !== "complete")).toBe(true);
  });

  it("invalidates an index on a duplicate block start: no reuse, no late completion of the old key (amendment 2)", () => {
    const events = parseAll([
      start("m1"),
      blockStart(0),
      delta(0, "a"),
      blockStart(0),
      delta(0, "b"),
      assistant("m1", [text("ab")]),
      blockStop(0),
      blockStart(0),
      delta(0, "c"),
      blockStop(0),
      blockStart(1),
      delta(1, "d"),
      assistant("m1", [text("d")]),
      blockStop(1),
      abandoned("m1", 0),
    ]);
    expect(speech(events)).toEqual([
      ["message", "a", "K1", "fragment", false],
      ["message", "b", null, null, false],
      ["message", "ab", null, null, false],
      ["message", "c", null, null, false],
      ["message", "d", "K2", "fragment", false],
      ["message", "d", "K2", "complete", false],
    ]);
  });

  it("keeps keys unique across repeated parsers for the same session (amendment 3)", () => {
    const frames = [start("m1"), blockStart(0), delta(0, "a"), assistant("m1", [text("a")])];
    const first = parseAll(frames);
    const second = parseAll(frames);
    const keys = (events: HarnessEvent[]) => events.map((e) => e.speech?.key);
    expect(new Set(keys(first)).size).toBe(1);
    expect(new Set(keys(second)).size).toBe(1);
    expect(keys(first)[0]).not.toBe(keys(second)[0]);
    expect(keys(first)[0]).toMatch(/^claude:[0-9a-f]{12}:1:0$/);
  });

  it("refuses identity on id disagreement, missing ids and unopened blocks", () => {
    const events = parseAll([
      start("m1"),
      blockStart(0, { api_message_id: "m2" }),
      delta(0, "start mismatch"),
      assistant("m1", [text("start mismatch")]),
      blockStop(0),
      blockStart(1),
      delta(1, "keyed"),
      delta(1, "delta mismatch", { api_message_id: "m2" }),
      assistant("m1", [text("keyeddelta mismatch")]),
      blockStop(1),
      blockStart(2),
      delta(2, "x"),
      assistant("m9", [text("x")]),
      blockStop(2),
      delta(3, "unopened"),
      stop(),
      start(""),
      blockStart(0),
      delta(0, "no id"),
      assistant("", [text("no id")]),
      stop(),
    ]);
    expect(speech(events)).toEqual([
      ["message", "start mismatch", null, null, false],
      ["message", "start mismatch", null, null, false],
      ["message", "keyed", "K1", "fragment", false],
      ["message", "delta mismatch", null, null, false],
      ["message", "keyeddelta mismatch", null, null, false],
      ["message", "x", "K2", "fragment", false],
      ["message", "x", null, null, false],
      ["message", "unopened", null, null, false],
      ["message", "no id", null, null, false],
      ["message", "no id", null, null, false],
    ]);
  });

  it("links at most one exactly contained single-text snapshot per key", () => {
    const events = parseAll([
      start("m1"),
      blockStart(0),
      delta(0, "a"),
      assistant("m1", [text("a")]),
      assistant("m1", [text("a")]),
      blockStop(0),
      blockStart(1),
      delta(1, "b"),
      assistant("m1", [text("b"), text("c")]),
      blockStop(1),
      blockStart(2),
      delta(2, "d"),
      assistant("m1", [text("d")], { aborted: true }),
      blockStop(2),
      blockStart(3),
      delta(3, "e"),
      blockStop(3),
      assistant("m1", [text("e")]),
      stop(),
    ]);
    expect(speech(events)).toEqual([
      ["message", "a", "K1", "fragment", false],
      ["message", "a", "K1", "complete", false],
      ["message", "a", null, null, false],
      ["message", "b", "K2", "fragment", false],
      ["message", "b", null, null, false],
      ["message", "c", null, null, false],
      ["message", "d", "K3", "fragment", false],
      ["message", "d", null, null, false],
      ["message", "e", "K4", "fragment", false],
      ["message", "e", null, null, false],
    ]);
  });

  it("starts a new incarnation on a replayed message_start without message_stop and never infers abandonment", () => {
    const events = parseAll([
      start("m1"),
      blockStart(0),
      delta(0, "a"),
      start("m1"),
      blockStart(0),
      delta(0, "a"),
      assistant("m1", [text("a")]),
      blockStop(0),
      stop(),
    ]);
    expect(speech(events)).toEqual([
      ["message", "a", "K1", "fragment", false],
      ["message", "a", "K2", "fragment", false],
      ["message", "a", "K2", "complete", false],
    ]);
  });

  it("isolates subagent stream frames from the main scope", () => {
    const sub = { parent_tool_use_id: "tu_sub" };
    const events = parseAll([
      start("main"),
      blockStart(0),
      start("sub", sub),
      blockStart(0, sub),
      delta(0, "subagent", sub),
      assistant("sub", [text("subagent")], sub),
      blockStop(0, sub),
      stop(sub),
      delta(0, "main"),
      assistant("main", [text("main")]),
    ]);
    expect(speech(events)).toEqual([
      ["message", "main", "K1", "fragment", false],
      ["message", "main", "K1", "complete", false],
    ]);
  });

  it("marks abandonment only for the stating incarnation's uncompleted keyed blocks at or above from_block_index", () => {
    const run = (stopFrame: Frame) =>
      parseAll([
        start("m1"),
        blockStart(0),
        delta(0, "done"),
        assistant("m1", [text("done")]),
        blockStop(0),
        blockStart(1, {}, "tool_use"),
        blockStop(1),
        blockStart(2),
        delta(2, "partial"),
        blockStop(2),
        stopFrame,
      ]).filter((e) => e.speech?.op === "abandoned");
    const marked = run(abandoned("m1", 0));
    expect(marked).toHaveLength(1);
    expect(marked[0]?.payload).toEqual({ code: "speech_abandoned", from_block_index: 0 });
    expect(run(abandoned("m2", 0))).toEqual([]);
    expect(run(abandoned("m1", 3))).toEqual([]);
    for (const bad of [-1, "0", 1.5, null]) expect(run(abandoned("m1", bad))).toEqual([]);
    expect(run(stop())).toEqual([]);
  });

  it("never keys thinking, the ExitPlanMode plan, tool events or anything a result emits", () => {
    const events = parseAll([
      start("m1"),
      blockStart(0, {}, "thinking"),
      assistant("m1", [{ type: "thinking", thinking: "Plan it." }]),
      blockStop(0),
      blockStart(1, {}, "tool_use"),
      assistant("m1", [
        { type: "tool_use", id: "tu_p", name: "ExitPlanMode", input: { plan: "# Plan" } },
      ]),
      blockStop(1),
      stop(),
      success("# Plan"),
      { type: "result", subtype: "success", result: "x", structured_output: { answer: 1 } },
      { type: "result", subtype: "error_during_execution", result: "partial" },
    ]);
    expect(events.every((e) => e.speech === undefined)).toBe(true);
    expect(events.filter((e) => e.final === true).map((e) => e.payload?.["final_source"])).toEqual([
      "result",
      "structured_output",
    ]);
  });

  it("keeps the stateless helper unkeyed: it observes no lifecycle", () => {
    expect(parseClaudeEvent(start("m1"), "ses-1")).toEqual([]);
    expect(parseClaudeEvent(delta(0, "t", { api_message_id: "m1" }), "ses-1")?.[0]?.speech).toBe(
      undefined,
    );
  });

  it("keeps a typed speech through the schema and refuses malformed ones", () => {
    const base = { type: "message", session_id: "s1", ts: "t", text: "x" };
    const speechOf = (value: unknown) => HarnessEvent.safeParse({ ...base, speech: value });
    expect(speechOf({ key: "claude:0123456789ab:1:0", op: "fragment" }).success).toBe(true);
    expect(speechOf({ key: "", op: "fragment" }).success).toBe(false);
    expect(speechOf({ key: "k", op: "merge" }).success).toBe(false);
    expect(speechOf({ key: "k", op: "complete", block: 0 }).success).toBe(false);
  });
});

describe("claude speech identity: a frame naming another response is never authoritative", () => {
  it("issues no key in an incarnation whose message_start names another response than its message id", () => {
    const events = parseAll([
      start("m1", { api_message_id: "different" }),
      blockStart(0),
      delta(0, "abc"),
      assistant("m1", [text("ABC")]),
      blockStop(0),
      stop(),
      start("m2", { api_message_id: "m2" }),
      blockStart(0),
      delta(0, "ok"),
      assistant("m2", [text("ok")]),
      blockStop(0),
      stop({ api_message_id: "m2" }),
    ]);
    expect(speech(events)).toEqual([
      ["message", "abc", null, null, false],
      ["message", "ABC", null, null, false],
      ["message", "ok", "K1", "fragment", false],
      ["message", "ok", "K1", "complete", false],
    ]);
  });

  it("never lets a content_block_stop naming another response close its block or enable a link", () => {
    const events = parseAll([
      start("m1"),
      blockStart(0),
      delta(0, "a"),
      blockStop(0, { api_message_id: "other" }),
      delta(0, "b"),
      blockStart(1),
      delta(1, "c"),
      assistant("m1", [text("c")]),
      blockStop(1),
      stop(),
    ]);
    expect(speech(events)).toEqual([
      ["message", "a", "K1", "fragment", false],
      ["message", "b", null, null, false],
      ["message", "c", "K2", "fragment", false],
      ["message", "c", null, null, false],
    ]);
  });

  it("never lets a message_stop naming another response state abandonment or end the incarnation", () => {
    const frames = (stopExtra: Frame) => [
      start("m1"),
      blockStart(0),
      delta(0, "a"),
      blockStop(0),
      stop({ ...stopExtra, abandoned_blocks: { api_message_id: "m1", from_block_index: 0 } }),
      assistant("m1", [text("a")]),
      stop(),
      start("m3"),
      blockStart(0),
      delta(0, "z"),
      assistant("m3", [text("z")]),
    ];
    // Control: the CLI's own stop (agreeing frame id) states the abandonment.
    expect(
      speech(parseAll(frames({ api_message_id: "m1" }))).filter((row) => row[3] === "abandoned"),
    ).toHaveLength(1);
    expect(speech(parseAll(frames({ api_message_id: "other" })))).toEqual([
      ["message", "a", "K1", "fragment", false],
      ["message", "a", null, null, false],
      ["message", "z", "K2", "fragment", false],
      ["message", "z", "K2", "complete", false],
    ]);
  });
});
