/**
 * #307: the derived final-messages document. Every typed final a harness
 * recorded, in event order, each line the exact event the run's log stores;
 * never a choice, a merge or an inference. Synthetic neutral events only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FINAL_MESSAGES_PATH, FinalMessagesHeader, type RunEvent } from "@claudexor/schema";
import { EventLog } from "./index.js";
import { finalMessagesDocument, writeFinalMessages } from "./final-messages.js";

const TS = "2026-11-17T00:00:00.000Z";
const ACK = "The background check finished; its result is already in the report above.";

function harness(attempt: string, session: string, fields: Record<string, unknown>) {
  return { harness_id: "claude", attempt_id: attempt, session_id: session, ts: TS, ...fields };
}

function event(seq: number, type: RunEvent["type"], payload: Record<string, unknown>): RunEvent {
  return { seq, ts: TS, run_id: "run-final", task_id: "task-final", type, payload };
}

const final = (seq: number, text: string) =>
  event(seq, "harness.event", harness("a01", "s1", { type: "message", text, final: true }));

/** The document's header and record lines; it is UTF-8 and every line ends in LF. */
function lines(bytes: Buffer): { header: FinalMessagesHeader; records: string[] } {
  const text = bytes.toString("utf8");
  expect(Buffer.from(text, "utf8").equals(bytes)).toBe(true);
  expect(text.endsWith("\n")).toBe(true);
  const [first, ...records] = text.slice(0, -1).split("\n");
  return { header: FinalMessagesHeader.parse(JSON.parse(first!)), records };
}

const sha256 = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

describe("final-messages document", () => {
  let runDir: string;
  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), "cx-final-messages-"));
    mkdirSync(join(runDir, "final"));
  });
  afterEach(() => rmSync(runDir, { recursive: true, force: true }), 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

  it("keeps every typed final in log order as the exact line the run's log stores", () => {
    const eventsPath = join(runDir, "events.jsonl");
    const log = new EventLog(eventsPath, "run-final", "task-final");
    const report = ["# Review", "", ...Array.from({ length: 120 }, (_, i) => `- check ${i + 1}`)];
    const envelope = JSON.stringify({
      work_report: { state: "completed", required_inputs: [] },
      output: "Envelope output.",
    });
    const message = (text: string | null, fields: Record<string, unknown> = {}) => ({
      type: "message",
      ...(text === null ? {} : { text }),
      ...fields,
    });
    // [kept?, attempt, session, harness fields]
    const rows: Array<[boolean, string, string, Record<string, unknown>]> = [
      // Narration and a fragment are never finals, even a fragment typed final.
      [false, "a01", "s1", message("Reviewing the change.")],
      [false, "a01", "s1", message("# Rev", { final: true, payload: { delta: true } })],
      [
        true,
        "a01",
        "s1",
        message(report.join("\n"), { final: true, payload: { final_source: "result" } }),
      ],
      // A result Claude Code reported for another turn is a status, never a final.
      [
        false,
        "a01",
        "s1",
        {
          type: "status",
          text: "Another turn's answer",
          payload: { code: "foreign_result", event_type: "message", user_message_uuids: ["u-9"] },
        },
      ],
      // A buffered snapshot is a copy, not a final of its own.
      [false, "a01", "s1", message("Same.", { final: true, payload: { buffered: true } })],
      [true, "a01", "s1", message("Same.", { final: true })],
      [true, "a01", "s1", message("Same.", { final: true })],
      [true, "a01", "s1", message("", { final: true })],
      [
        true,
        "a01",
        "s1",
        message(null, {
          final: true,
          payload: { final_source: "result", work_report_envelope: envelope },
        }),
      ],
      [
        true,
        "a02",
        "s2",
        message("Résumé: naïve café — ✓", {
          final: true,
          payload: { final_source: "result", native_turn_id: "turn-7" },
        }),
      ],
      [true, "a01", "s1", message(ACK, { final: true, payload: { final_source: "result" } })],
      [false, "a01", "s1", { type: "usage", usage: { input_tokens: 10 } }],
    ];
    try {
      log.emit("run.created", { mode: "ask", prompt: "Review the change." });
      const kept: number[] = [];
      for (const [keep, attempt, session, fields] of rows) {
        const written = log.emit("harness.event", harness(attempt, session, fields));
        if (keep) kept.push(written.seq!);
      }
      log.emit("budget.observation", { harness_id: "claude", kind: "spend", usd: 0 });
      const pointer = writeFinalMessages(runDir, "run-final", log.readAll());

      const logLines = readFileSync(eventsPath, "utf8").split("\n").filter(Boolean);
      const lineBySeq = new Map(logLines.map((line) => [JSON.parse(line).seq as number, line]));
      const bytes = readFileSync(join(runDir, FINAL_MESSAGES_PATH));
      const { header, records } = lines(bytes);
      expect(header).toEqual({
        schemaVersion: 1,
        runId: "run-final",
        state: "complete",
        count: kept.length,
        throughEventSeq: Math.max(...lineBySeq.keys()),
      });
      // No dedupe, trim or choice: the exact recorded lines, identical and empty ones included.
      expect(records).toEqual(kept.map((seq) => lineBySeq.get(seq)));
      const parsed = records.map((line) => JSON.parse(line));
      expect(parsed.map((row) => row.payload.text)).toEqual([
        report.join("\n"),
        "Same.",
        "Same.",
        "",
        undefined,
        "Résumé: naïve café — ✓",
        ACK,
      ]);
      // The machine envelope rides verbatim; it is never unwrapped or re-read.
      expect(parsed[4].payload.payload).toEqual({
        final_source: "result",
        work_report_envelope: envelope,
      });
      // Attempts, sessions and a native turn stay exactly as recorded; none is minted.
      expect(parsed.map((row) => `${row.payload.attempt_id}/${row.payload.session_id}`)).toEqual([
        "a01/s1",
        "a01/s1",
        "a01/s1",
        "a01/s1",
        "a01/s1",
        "a02/s2",
        "a01/s1",
      ]);
      expect(parsed.filter((row) => row.payload.payload?.native_turn_id)).toEqual([parsed[5]]);
      expect(pointer).toEqual({
        path: FINAL_MESSAGES_PATH,
        state: "complete",
        count: kept.length,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        throughEventSeq: header.throughEventSeq,
      });
    } finally {
      log.dispose();
    }
  });

  it("stops at the first terminal: a row after it is never the run's final", () => {
    const { header, bytes } = finalMessagesDocument("run-final", {
      events: [
        event(1, "run.created", { mode: "ask" }),
        final(2, "Answer."),
        event(3, "run.completed", { lifecycle: "succeeded" }),
        final(8, "Post-terminal noise."),
        event(9, "control.requested", { kind: "cancel" }),
      ],
      malformed: 0,
    });
    expect(header).toMatchObject({ state: "complete", count: 1, throughEventSeq: 2 });
    expect(lines(bytes).records.map((line) => JSON.parse(line).payload.text)).toEqual(["Answer."]);
  });

  it("states a checked log without a typed final as an empty complete list, never a guessed answer", () => {
    const { header, bytes } = finalMessagesDocument("run-final", {
      events: [
        event(1, "run.created", { mode: "ask" }),
        event(2, "harness.event", harness("a01", "s1", { type: "message", text: "Narration." })),
        event(
          3,
          "harness.event",
          harness("a01", "s1", { type: "message", text: "Partial", payload: { delta: true } }),
        ),
      ],
      malformed: 0,
    });
    expect(header).toEqual({
      schemaVersion: 1,
      runId: "run-final",
      state: "complete",
      count: 0,
      throughEventSeq: 3,
    });
    expect(bytes.toString("utf8")).toBe(`${JSON.stringify(header)}\n`);
  });

  it.each([2, 3])("is partial when a record could not be read (last seq %i)", (seq) => {
    const { header } = finalMessagesDocument("run-final", {
      events: [event(1, "run.created", { mode: "ask" }), final(seq, "Answer.")],
      malformed: 1,
    });
    expect(header).toMatchObject({ state: "partial", count: 1, throughEventSeq: seq });
  });

  it.each([
    ["at the start", [final(2, "Saved note.")], 2],
    [
      "between readable events",
      [event(1, "run.created", {}), final(2, "Saved note."), event(4, "control.requested", {})],
      4,
    ],
    [
      "just before the first terminal",
      [event(1, "run.created", {}), final(2, "Saved note."), event(4, "run.failed", {})],
      2,
    ],
  ] as const)("marks a readable log with a gap %s partial", (_where, events, seq) => {
    const { header, bytes } = finalMessagesDocument("run-final", { events, malformed: 0 });
    expect(header).toMatchObject({ state: "partial", count: 1, throughEventSeq: seq });
    expect(lines(bytes).records).toEqual([JSON.stringify(final(2, "Saved note."))]);
  });

  it("counts unsequenced legacy rows by position while preserving their original records", () => {
    const legacy = final(1, "Earlier note.");
    delete legacy.seq;
    for (const [events, state, seq] of [
      [[legacy], "complete", 0],
      [[legacy, final(2, ACK)], "complete", 2],
      [[event(1, "run.created", {}), legacy, event(3, "run.completed", {})], "complete", 1],
      [[legacy, final(3, ACK)], "partial", 3],
    ] as const) {
      const { header, bytes } = finalMessagesDocument("run-final", { events, malformed: 0 });
      expect(header).toMatchObject({ state, throughEventSeq: seq });
      expect(lines(bytes).records).toContain(JSON.stringify(legacy));
    }
  });

  it.each([0, 2])(
    "refuses a log with no readable event (%i unreadable) and writes nothing",
    (malformed) => {
      expect(() => writeFinalMessages(runDir, "run-final", { events: [], malformed })).toThrow(
        "no readable event",
      );
      expect(readdirSync(join(runDir, "final"))).toEqual([]);
    },
  );

  it("leaves neither a partial document nor a temporary file when the write fails", () => {
    mkdirSync(join(runDir, FINAL_MESSAGES_PATH));
    expect(() =>
      writeFinalMessages(runDir, "run-final", {
        events: [event(1, "run.created", { mode: "ask" }), final(2, "Answer.")],
        malformed: 0,
      }),
    ).toThrow();
    expect(statSync(join(runDir, FINAL_MESSAGES_PATH)).isDirectory()).toBe(true);
    expect(readdirSync(join(runDir, "final"))).toEqual(["final-messages.jsonl"]);
  });

  it("replaces an earlier document whole, so its pointer always names the bytes on disk", () => {
    const first = writeFinalMessages(runDir, "run-final", {
      events: [event(1, "run.created", { mode: "ask" }), final(2, "First.")],
      malformed: 0,
    });
    const second = writeFinalMessages(runDir, "run-final", {
      events: [event(1, "run.created", { mode: "ask" }), final(2, "First."), final(3, "Second.")],
      malformed: 0,
    });
    const bytes = readFileSync(join(runDir, FINAL_MESSAGES_PATH));
    expect(second).toMatchObject({ count: 2, bytes: bytes.byteLength, sha256: sha256(bytes) });
    expect(second.sha256).not.toBe(first.sha256);
    expect(readdirSync(join(runDir, "final"))).toEqual(["final-messages.jsonl"]);
  });
});
