/**
 * #307 through the real orchestrator terminal: every typed final a harness
 * recorded stays discoverable in order beside an unchanged primary output, and
 * the terminal records the exact address of that document. Scripted fake
 * harness and one recorded Claude stream through its own parser; no vendor call.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactStore } from "@claudexor/artifact-store";
import { AnswerAssembly } from "@claudexor/core";
import { writeFinalMessages } from "@claudexor/event-log";
import {
  FINAL_MESSAGES_PATH,
  FinalMessagesHeader,
  RunEvent,
  type HarnessEvent,
} from "@claudexor/schema";
import { detailFor } from "../../control-api/src/run-projection.js";
import type { DaemonRunRecord } from "../../control-api/src/run-record.js";
import { createClaudeParser } from "../../harness-claude/src/parse.js";
import { crash, run, seedSession } from "./inrun-continuity.test-support.js";
import { harnessEventPayload } from "./runSupport.js";

/**
 * With CLAUDEXOR_TEST_CAPTURE_FINAL_MESSAGES_DIR set to a new or empty absolute
 * path, the read-fixture case keeps a consumer fixture there unmodified: the
 * real terminal's document (`final-messages.jsonl`) and the run detail's
 * `finalMessages` value (`pointer.json`). Captured evidence is never overwritten.
 */
const CAPTURE_DIR = process.env["CLAUDEXOR_TEST_CAPTURE_FINAL_MESSAGES_DIR"];
const here = dirname(fileURLToPath(import.meta.url));
const LIVE_FIXTURE =
  "../../harness-claude/fixtures/stream-json/recorded-live-final-text-2.1.283.jsonl";
const TERMINALS = ["run.completed", "run.failed", "run.blocked"];
const REPORT = [
  "# Review",
  "",
  ...Array.from({ length: 150 }, (_, i) => `- check ${i + 1}: the generated example holds.`),
].join("\n");
const ACK = "The background check finished; its result is already in the report above.";

/** The run's event log as stored: raw lines and their parsed rows. */
function logOf(runDir: string) {
  const lines = readFileSync(join(runDir, "events.jsonl"), "utf8").split("\n").filter(Boolean);
  const rows = lines.map((line) => JSON.parse(line));
  const terminal = rows.find((row) => TERMINALS.includes(row.type));
  // An independent oracle over the stored log: harness messages typed final.
  const finals = lines.filter((_, i) => {
    const p = rows[i].payload;
    return (
      rows[i].type === "harness.event" &&
      p.type === "message" &&
      p.final === true &&
      p.payload?.delta !== true &&
      p.payload?.buffered !== true
    );
  });
  return { lines, rows, terminal, finals };
}

function documentOf(runDir: string) {
  const bytes = readFileSync(join(runDir, FINAL_MESSAGES_PATH));
  const text = bytes.toString("utf8");
  expect(text.endsWith("\n")).toBe(true);
  const [first, ...records] = text.slice(0, -1).split("\n");
  return { bytes, header: FinalMessagesHeader.parse(JSON.parse(first!)), records };
}

const sha256 = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

describe("final messages (#307) through the run terminal", () => {
  it("keeps a recorded Claude report discoverable when a later native turn ends with a short final", () => {
    const parse = createClaudeParser();
    const frames = readFileSync(join(here, LIVE_FIXTURE), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { direction?: string; frame?: unknown })
      .flatMap((row) => (row.frame ? (row.direction === "cli->client" ? [row.frame] : []) : [row]));
    const events: HarnessEvent[] = frames.flatMap((frame) => parse(frame, "process-1") ?? []);
    const answer = new AnswerAssembly();
    for (const event of events) answer.observe(event);
    const rows = [
      RunEvent.parse({
        seq: 1,
        ts: "2026-11-17T00:00:00.000Z",
        run_id: "run-live",
        task_id: "task-live",
        type: "run.created",
        payload: { mode: "ask" },
      }),
      ...events.map((event, i) =>
        RunEvent.parse({
          seq: i + 2,
          ts: event.ts,
          run_id: "run-live",
          task_id: "task-live",
          type: "harness.event",
          payload: harnessEventPayload("claude", "a01", event),
        }),
      ),
    ];
    const runDir = mkdtempSync(join(tmpdir(), "cx-final-messages-live-"));
    try {
      writeFinalMessages(runDir, "run-live", { events: rows, malformed: 0 });
      const { header, records } = documentOf(runDir);
      const typed = events.filter((event) => event.type === "message" && event.final === true);
      expect(typed).toHaveLength(2);
      expect(header).toMatchObject({ state: "complete", count: 2 });
      const texts = records.map((line) => JSON.parse(line).payload.text as string);
      expect(texts).toEqual(typed.map((event) => event.text));
      // The substantive report stays discoverable; the primary answer is still the last final.
      expect(Buffer.byteLength(texts[0]!)).toBe(7115);
      expect(texts[1]).toBe("MANGO");
      expect(answer.text()).toBe("MANGO");
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("ask: a long report then a late short acknowledgement — the primary is unchanged, both finals are addressed", async () => {
    const o = await run({
      mode: "ask",
      profiles: ["a"],
      script: function* ({ emit }) {
        yield emit({ type: "started" });
        yield emit({ type: "message", text: "Reviewing the change." });
        yield emit({
          type: "message",
          text: REPORT,
          final: true,
          payload: { final_source: "result" },
        });
        yield emit({ type: "status", text: "background task finished" });
        yield emit({
          type: "message",
          text: ACK,
          final: true,
          payload: { final_source: "result", native_turn_id: "turn-2" },
        });
        yield emit({ type: "completed" });
      },
    });
    expect(o.result.lifecycle, o.result.summary).toBe("succeeded");
    const runDir = o.result.runDir;
    // The primary output and its presentation are exactly what they were.
    expect(readFileSync(join(runDir, "final/answer.md"), "utf8")).toBe(`# Answer\n\n${ACK}\n`);
    const facts = new ArtifactStore(runDir).readYaml<Record<string, unknown>>(
      join(runDir, "final/run_facts.yaml"),
    );
    expect(facts?.["presentation"]).toEqual({
      state: "ready",
      primary: { kind: "answer", path: "final/answer.md" },
    });
    expect(facts).not.toHaveProperty("final_messages");

    const log = logOf(runDir);
    const { bytes, header, records } = documentOf(runDir);
    expect(log.finals).toHaveLength(2);
    expect(records).toEqual(log.finals);
    const [report, ack] = records.map((line) => JSON.parse(line));
    expect(report.payload.text).toBe(REPORT);
    expect(report.payload.payload).not.toHaveProperty("native_turn_id");
    expect(ack.payload.text).toBe(ACK);
    expect(ack.payload.payload).toMatchObject({ native_turn_id: "turn-2" });
    expect(header).toEqual({
      schemaVersion: 1,
      runId: o.result.runId,
      state: "complete",
      count: 2,
      throughEventSeq: expect.any(Number),
    });
    expect(header.throughEventSeq).toBeGreaterThanOrEqual(ack.seq);
    expect(header.throughEventSeq).toBeLessThan(log.terminal.seq);
    // The terminal records the exact served bytes once; nothing announces them as output.
    expect(log.terminal.payload.final_messages).toEqual({
      path: FINAL_MESSAGES_PATH,
      state: "complete",
      count: 2,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      throughEventSeq: header.throughEventSeq,
    });
    expect(
      log.rows.filter((row) => row.type === "output.ready").map((row) => row.payload.path),
    ).not.toContain(FINAL_MESSAGES_PATH);
  });

  it("ask: identical, empty and envelope-only finals all stay; fragments, snapshots and another turn's result never enter", async () => {
    const envelope = JSON.stringify({
      work_report: { state: "completed", required_inputs: [] },
      output: "Envelope output.",
    });
    const o = await run({
      mode: "ask",
      profiles: ["a"],
      script: function* ({ emit }) {
        yield emit({ type: "started" });
        yield emit({ type: "message", text: "Same", final: true, payload: { delta: true } });
        yield emit({ type: "message", text: "Same answer.", final: true });
        yield emit({ type: "message", text: "", final: true });
        yield emit({
          type: "message",
          final: true,
          payload: { final_source: "result", work_report_envelope: envelope },
        });
        yield emit({
          type: "status",
          text: "Another turn's answer",
          payload: { code: "foreign_result", event_type: "message", user_message_uuids: ["u-9"] },
        });
        yield emit({
          type: "message",
          text: "Same answer.",
          final: true,
          payload: { buffered: true },
        });
        yield emit({ type: "message", text: "Same answer.", final: true });
        yield emit({ type: "completed" });
      },
    });
    expect(o.result.lifecycle, o.result.summary).toBe("succeeded");
    const runDir = o.result.runDir;
    expect(readFileSync(join(runDir, "final/answer.md"), "utf8")).toBe(
      "# Answer\n\nSame answer.\n",
    );
    const log = logOf(runDir);
    const { header, records } = documentOf(runDir);
    expect(records).toEqual(log.finals);
    const rows = records.map((line) => JSON.parse(line));
    expect(rows.map((row) => row.payload.text)).toEqual([
      "Same answer.",
      "",
      undefined,
      "Same answer.",
    ]);
    expect(rows[2].payload.payload).toEqual({
      final_source: "result",
      work_report_envelope: envelope,
    });
    expect(header).toMatchObject({ state: "complete", count: 4 });
    expect(log.terminal.payload.final_messages).toMatchObject({ count: 4, state: "complete" });
  });

  it("agent: finals of two sessions of one attempt keep their order and their own sessions", async () => {
    const o = await run({
      mode: "agent",
      profiles: ["a"],
      maxRetries: 2,
      script: function* ({ spec, emit, tryOfProfile }) {
        if (tryOfProfile === 1) {
          seedSession(spec.cwd, "a", "sid-A");
          yield emit({ type: "started", payload: { native_session_id: "sid-A" } });
          writeFileSync(join(spec.cwd, "part1.txt"), "x\n");
          yield emit({ type: "file_change", payload: { path: "part1.txt" } });
          yield emit({
            type: "message",
            text: "Part one is written.",
            final: true,
            payload: { final_source: "result" },
          });
          yield* crash(emit);
          return;
        }
        yield emit({ type: "started", payload: { native_session_id: "sid-A" } });
        yield emit({
          type: "message",
          text: "Both parts are written.",
          final: true,
          payload: { final_source: "result" },
        });
        yield emit({ type: "completed" });
      },
    });
    expect(o.result.lifecycle, o.result.summary).toBe("succeeded");
    expect(o.spawns).toHaveLength(2);
    const log = logOf(o.result.runDir);
    const { header, records } = documentOf(o.result.runDir);
    expect(records).toEqual(log.finals);
    const rows = records.map((line) => JSON.parse(line));
    expect(rows.map((row) => row.payload.text)).toEqual([
      "Part one is written.",
      "Both parts are written.",
    ]);
    expect(rows[0].seq).toBeLessThan(rows[1].seq);
    expect(rows[0].payload.attempt_id).toBe(rows[1].payload.attempt_id);
    expect(rows[0].payload.session_id).not.toBe(rows[1].payload.session_id);
    expect(header).toMatchObject({ state: "complete", count: 2 });
  });

  it("a document that cannot be saved settles a typed gap: no address, a status, the primary intact", async () => {
    const o = await run({
      mode: "ask",
      profiles: ["a"],
      input: {
        // A directory where the document belongs: its atomic rename must fail.
        onRunStart: ({ runDir }) => mkdirSync(join(runDir, FINAL_MESSAGES_PATH)),
      },
      script: function* ({ emit }) {
        yield emit({ type: "started" });
        yield emit({ type: "message", text: REPORT, final: true });
        yield emit({ type: "completed" });
      },
    });
    expect(o.result.lifecycle, o.result.summary).toBe("succeeded");
    const runDir = o.result.runDir;
    expect(readFileSync(join(runDir, "final/answer.md"), "utf8")).toBe(`# Answer\n\n${REPORT}\n`);
    const log = logOf(runDir);
    // The terminal records only the typed reason; the diagnostic stays in the run's status.
    expect(log.terminal.payload.final_messages).toEqual({
      state: "unavailable",
      reason: "publication_failed",
    });
    expect(
      log.rows.filter(
        (row) =>
          row.type === "harness.event" &&
          row.payload.type === "status" &&
          String(row.payload.text).startsWith("Final messages could not be saved"),
      ),
    ).toHaveLength(1);
    expect(statSync(join(runDir, FINAL_MESSAGES_PATH)).isDirectory()).toBe(true);
    expect(readdirSync(join(runDir, "final")).filter((name) => name.startsWith("."))).toEqual([]);
  });

  it("read fixture: the real terminal's header, two canonical finals and the detail's pointer", async () => {
    if (CAPTURE_DIR && existsSync(CAPTURE_DIR) && readdirSync(CAPTURE_DIR).length > 0)
      throw new Error("CLAUDEXOR_TEST_CAPTURE_FINAL_MESSAGES_DIR must be new or empty");
    const o = await run({
      mode: "ask",
      profiles: ["a"],
      script: function* ({ emit }) {
        yield emit({ type: "started" });
        yield emit({
          type: "message",
          text: "Generated example report: both checks passed.",
          final: true,
          payload: { final_source: "result" },
        });
        yield emit({
          type: "message",
          text: "Generated example acknowledgement: the report above stands.",
          final: true,
          payload: { final_source: "result" },
        });
        yield emit({ type: "completed" });
      },
    });
    expect(o.result.lifecycle, o.result.summary).toBe("succeeded");
    const runDir = o.result.runDir;
    const log = logOf(runDir);
    const { bytes, header, records } = documentOf(runDir);
    expect(header).toMatchObject({ state: "complete", count: 2 });
    expect(records).toEqual(log.finals);
    const record: DaemonRunRecord = {
      id: "job-fixture",
      runId: o.result.runId,
      taskId: o.result.taskId,
      state: "succeeded",
      runDir,
      params: { mode: "ask", scope: { kind: "project", root: o.root }, prompt: "fixture" },
    };
    // The Control API's value is the terminal's record, naming exactly these bytes.
    const pointer = detailFor(record, [], undefined, null, [], {
      includeFinalMessages: true,
    }).finalMessages;
    expect(pointer).toEqual(log.terminal.payload.final_messages);
    expect(pointer).toMatchObject({ bytes: bytes.byteLength, sha256: sha256(bytes) });
    if (!CAPTURE_DIR) return;
    mkdirSync(CAPTURE_DIR, { recursive: true });
    writeFileSync(join(CAPTURE_DIR, "final-messages.jsonl"), bytes);
    writeFileSync(join(CAPTURE_DIR, "pointer.json"), `${JSON.stringify(pointer, null, 2)}\n`);
  });
});
