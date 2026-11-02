import { describe, expect, it } from "vitest";
import { OutputReadyPayload, type RunEvent } from "@claudexor/schema";
import { retainedOutput } from "./retained-output.js";

function event(seq: number, text: string, extra: Record<string, unknown> = {}): RunEvent {
  return {
    seq,
    ts: "2026-10-04T00:00:00.000Z",
    run_id: "run-1",
    task_id: "task-1",
    type: "harness.event",
    payload: {
      attempt_id: "a01",
      harness_id: "cursor",
      session_id: "try-1",
      type: "message",
      text,
      ...extra,
    },
  };
}

describe("retained output evidence", () => {
  it("keeps delta-only Markdown and a late acknowledgement without promoting either", () => {
    const text = retainedOutput([
      event(1, "# Review\n\n- ", { payload: { delta: true } }),
      event(2, "finding\n", { payload: { delta: true } }),
      event(3, "Tests already included.", { final: true }),
    ]);
    expect(text).toContain("# Review\n\n- finding\n");
    expect(text).toContain("Tests already included.");
    expect(text).toContain("not a completion verdict");
  });

  it("collapses exact adjacent flushes but preserves a different or repeated later message", () => {
    const text = retainedOutput([
      event(1, "Hello ", { payload: { delta: true } }),
      event(2, "world", { payload: { delta: true } }),
      event(3, "Hello world", { payload: { buffered: true } }),
      event(4, "Hello world"),
      event(5, "Hello world", { final: true }),
      event(6, "different"),
      event(7, "Hello world"),
    ]);
    expect(text?.match(/Hello world/g)).toHaveLength(2);
    expect(text).toContain("different");
  });

  it("does not duplicate a final-only success but preserves it on failure", () => {
    const events = [event(1, "Normal final", { final: true })];
    expect(retainedOutput(events, 0, true)).toBeNull();
    expect(retainedOutput(events)).toContain("Normal final");
    expect(retainedOutput([event(0, "Earlier draft"), ...events], 0, true)).toContain(
      "Earlier draft",
    );
  });

  it("exposes captured media through attempt-scoped artifact references", () => {
    const output = {
      ...event(2, ""),
      type: "output.ready" as const,
      payload: OutputReadyPayload.parse({
        kind: "artifact",
        state: "diagnostic",
        path: "attempts/a01/produced/image one.png",
      }),
    };
    const text = retainedOutput([event(1, "![Image](image one.png)"), output]);
    expect(text).toContain("../attempts/a01/produced/image%20one.png");
    expect(text).toContain("Captured files · attempt a01");
    expect(
      retainedOutput([{ ...output, payload: { kind: "artifact", path: "screenshot.png" } }]),
    ).toBeNull();
  });

  it("retains a buffered-only frame, all physical tries and interleaved candidates", () => {
    const text = retainedOutput([
      event(1, "first", { payload: { buffered: true } }),
      event(2, "sibling", { attempt_id: "a02", session_id: "try-2" }),
      event(3, "retry", { session_id: "try-3", final: true }),
    ]);
    for (const expected of ["first", "sibling", "retry", "try-1", "try-2", "try-3"])
      expect(text).toContain(expected);
  });

  it("does not retain reasoning, tool output, status, prompt echo or auth disclosures as an answer", () => {
    expect(
      retainedOutput([
        event(1, "thinking secret", { type: "thinking" }),
        event(2, "tool result", { type: "tool_result" }),
        event(3, "error status", { type: "status" }),
        event(4, "route switched", { payload: { auth_switched: true } }),
        event(5, "   "),
      ]),
    ).toBeNull();
  });

  it("keeps text beyond display budgets and discloses damaged source records", () => {
    const text = retainedOutput(
      Array.from({ length: 10001 }, (_, i) =>
        event(i + 1, i === 10000 ? "END" : "x", { payload: { delta: true } }),
      ),
      1,
    );
    expect(text).toContain("x".repeat(10000) + "END");
    expect(text).toContain("1 unreadable record");
  });

  it("stops at the committed terminal instead of incorporating later audit data", () => {
    const terminal = { ...event(2, ""), type: "run.failed" as const, payload: {} };
    const text = retainedOutput([event(1, "before"), terminal, event(3, "after")]);
    expect(text).toContain("before");
    expect(text).not.toContain("after");
  });
});

/** The `### …` blocks of a single-source projection, in order. */
const blocks = (text: string | null) =>
  (text ?? "")
    .split("\n\n### ")
    .slice(1)
    .map((block) => `### ${block.trimEnd()}`);
const represented = { represented: { attempt: "a01", session: "try-1" } };

describe("retained output identity (#568): speech keys and native turns, never words", () => {
  const keyed = (seq: number, text: string, key: string, op: "fragment" | "complete") =>
    event(seq, text, {
      speech: { key, op },
      ...(op === "fragment" ? { payload: { delta: true } } : {}),
    });

  it("keeps one block per speech key, whose complete text supersedes its fragments", () => {
    const events = [
      keyed(1, "Hel", "k1", "fragment"),
      keyed(2, "lo wrld", "k1", "fragment"),
      keyed(3, "Hello world", "k1", "complete"),
      // Another key with equal words is another block.
      keyed(4, "Hello world", "k2", "fragment"),
      keyed(5, "Hello world", "k2", "complete"),
      // An unkeyed typed final exactly repeating the block just completed is its final form.
      event(6, "Hello world", { final: true }),
      keyed(7, "Cut short", "k3", "fragment"),
      event(8, "streamed text abandoned by the CLI", {
        type: "status",
        speech: { key: "k3", op: "abandoned" },
      }),
    ];
    const all = retainedOutput(events);
    expect(all).not.toContain("wrld");
    expect(blocks(all)).toEqual([
      "### Assistant message · events 1–3\n\nHello world",
      "### Observed final message · events 4–6\n\nHello world",
      "### Streamed text · events 7–7\n\nCut short",
    ]);
    // Carrying that final leaves out its own block only, not the equal words of key k1.
    expect(blocks(retainedOutput(events, 0, false, represented))).toEqual([
      "### Assistant message · events 1–3\n\nHello world",
      "### Streamed text · events 7–7\n\nCut short",
    ]);
  });

  it("keeps each native turn's final and contained words beside the carried last final", () => {
    const events = [
      event(1, "OK", { final: true }),
      // The next native turn's final: a block holding a final is closed.
      event(2, "OK", { final: true }),
      event(3, "OK"),
      event(4, "NOT OK", { final: true }),
    ];
    expect(blocks(retainedOutput(events))).toEqual([
      "### Observed final message · events 1–1\n\nOK",
      "### Observed final message · events 2–2\n\nOK",
      "### Assistant message · events 3–3\n\nOK",
      "### Observed final message · events 4–4\n\nNOT OK",
    ]);
    expect(blocks(retainedOutput(events, 0, false, represented))).toEqual([
      "### Observed final message · events 1–1\n\nOK",
      "### Observed final message · events 2–2\n\nOK",
      "### Assistant message · events 3–3\n\nOK",
    ]);
  });

  it("keeps the separate text blocks a multi-block final concatenates; no key links them", () => {
    const events = [
      event(1, "Part A"),
      event(2, "Part B"),
      event(3, "Part APart B", { final: true }),
    ];
    expect(blocks(retainedOutput(events, 0, false, represented))).toEqual([
      "### Assistant message · events 1–1\n\nPart A",
      "### Assistant message · events 2–2\n\nPart B",
    ]);
  });

  const joinedFrame = (seq: number, text: string, keys: unknown) =>
    event(seq, text, { payload: { joined_speech_keys: keys } });

  it("a frame naming the keyed run it joins is that run's one block; its final repeat is the answer", () => {
    const events = [
      keyed(1, "Part one.", "k1", "fragment"),
      keyed(2, " Part two.", "k2", "fragment"),
      joinedFrame(3, "Part one. Part two.", ["k1", "k2"]),
      event(4, "Part one. Part two.", { final: true }),
    ];
    expect(blocks(retainedOutput(events))).toEqual([
      "### Observed final message · events 1–4\n\nPart one. Part two.",
    ]);
    // A final-only success needs no retained document, and carrying it leaves nothing.
    expect(retainedOutput(events, 0, true)).toBeNull();
    expect(retainedOutput(events, 0, false, represented)).toBeNull();
  });

  it("keeps every block when a named run is not exactly the frame's words or not the last blocks", () => {
    const run = [keyed(1, "Part one.", "k1", "fragment"), keyed(2, " Part two.", "k2", "fragment")];
    const kept = (frame: RunEvent, between: RunEvent[] = []) =>
      blocks(retainedOutput([...run, ...between, frame]));
    // Words that differ from the run: the frame is its own segment, nothing is dropped.
    expect(kept(joinedFrame(3, "Part one. Part 2.", ["k1", "k2"]))).toEqual([
      "### Streamed text · events 1–1\n\nPart one.",
      "### Streamed text · events 2–2\n\n Part two.",
      "### Assistant message · events 3–3\n\nPart one. Part 2.",
    ]);
    // A named key that is not the last block, or a run named out of order or in part.
    for (const frame of [
      joinedFrame(3, "Part one.", ["k1"]),
      joinedFrame(3, " Part two.Part one.", ["k2", "k1"]),
      joinedFrame(3, "Part one. Part two.", ["k0", "k1", "k2"]),
    ])
      expect(kept(frame)).toHaveLength(3);
    expect(
      kept(joinedFrame(4, "Part one. Part two.", ["k1", "k2"]), [event(3, "aside")]),
    ).toHaveLength(4);
    // A key whose complete text already arrived is not completed again.
    expect(
      kept(joinedFrame(4, "Part one. Part two.", ["k1", "k2"]), [
        keyed(3, " Part two.", "k2", "complete"),
      ]),
    ).toHaveLength(3);
  });

  it("never joins keyed blocks no adapter names, even when a later final equals their words", () => {
    // Two independent native messages cut short (no complete text), then a final
    // whose words happen to be both: identity is unknown, so all of it stays.
    const events = [
      keyed(1, "Part one.", "k1", "fragment"),
      keyed(2, " Part two.", "k2", "fragment"),
      event(3, "Part one. Part two.", { final: true }),
    ];
    expect(blocks(retainedOutput(events, 0, false, represented))).toEqual([
      "### Streamed text · events 1–1\n\nPart one.",
      "### Streamed text · events 2–2\n\n Part two.",
    ]);
  });
});
