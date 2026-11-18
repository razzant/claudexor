import { appendFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ThreadHistoryRun } from "@claudexor/schema";
import { projectHistoryRun } from "./thread-history-run.js";
import type { DaemonRunRecord } from "./run-record.js";

it("restores Claude turn replies independently of the terminal product and bounded journal tail", () => {
  const runDir = mkdtempSync(join(tmpdir(), "claude-turn-replies-"));
  const event = (seq: number, text: string, fields = {}) => ({
    seq,
    run_id: "run",
    task_id: "task",
    ts: "2026-11-01T13:00:00Z",
    type: "harness.event",
    payload: {
      harness_id: "claude",
      type: "message",
      text,
      final: true,
      attempt_id: "a",
      session_id: "s",
      after_stop: false,
      ...fields,
    },
  });
  const record: DaemonRunRecord = {
    id: "job",
    runId: "run",
    taskId: "task",
    runDir,
    state: "running",
    params: { mode: "ask", primaryHarness: "claude" },
  };
  const read = (include = true) =>
    projectHistoryRun(
      record,
      { waitingOnUser: false, asyncQuestionsOnly: false, childRunIds: [], operator: null },
      include,
    );
  const write = (rows: unknown[]) =>
    writeFileSync(
      join(runDir, "events.jsonl"),
      rows.map((row) => JSON.stringify(row) + "\n").join(""),
    );
  try {
    expect(read().run.claudeTurnReplies).toEqual({ rows: [], partial: true });
    write([
      event(1, "Partial", { final: false }),
      event(2, "First reply"),
      event(3, "Status detail", { type: "status", payload: { non_success_result: true } }),
      event(4, "Other lane", { harness_id: "codex" }),
      event(5, "Corrected reply"),
      event(6, "Corrected reply", { attempt_id: "b", session_id: "t" }),
      event(7, "Drained", { after_stop: true }),
      event(8, "Buffered", { payload: { buffered: true } }),
    ]);
    const source = { attemptId: "a", sessionId: "s", afterStop: false };
    // 6.2 CLI and MCP decode the old strict run object. The opt-in response
    // would break that parser if it leaked to a subsequent default request.
    const legacySchema = ThreadHistoryRun.omit({ claudeTurnReplies: true }).strict();
    expect(legacySchema.safeParse(read(true).run).success).toBe(false);
    expect(legacySchema.parse(read(false).run)).not.toHaveProperty("claudeTurnReplies");
    for (const state of ["running", "failed", "cancelled", "succeeded"] as const) {
      record.state = state;
      const row = read();
      expect(row.run.state).toBe(state);
      expect(row.run.claudeTurnReplies).toEqual({
        rows: [
          { seq: 2, source, text: "First reply", truncated: false },
          { seq: 5, source, text: "Corrected reply", truncated: false },
          {
            seq: 6,
            source: { attemptId: "b", sessionId: "t", afterStop: false },
            text: "Corrected reply",
            truncated: false,
          },
        ],
        partial: false,
      });
      expect(row.primaryOutput).toBeNull();
    }
    write([event(1, "Pending", { final: false })]);
    record.state = "queued";
    expect(read().run.claudeTurnReplies).toEqual({ rows: [], partial: false });
    const { seq: _legacySeq, ...legacy } = event(2, "Legacy reply");
    const path = join(runDir, "events.jsonl");
    for (const tail of [event(3, "Reply without LF"), legacy]) {
      write([event(1, "First reply")]);
      appendFileSync(path, JSON.stringify(tail));
      expect(read().run.claudeTurnReplies).toEqual({
        rows: [{ seq: 1, source, text: "First reply", truncated: false }],
        partial: true,
      });
      appendFileSync(path, "\n");
      expect(read().run.claudeTurnReplies).toMatchObject({
        rows: [{ seq: 1 }, { seq: "seq" in tail ? tail.seq : 2 }],
        partial: false,
      });
    }
    // Tool counts retain their older snapshot contract for valid final JSON.
    writeFileSync(
      path,
      JSON.stringify(event(1, "", { type: "tool_call", tool: { kind: "file" } })),
    );
    expect(read().run.fileCount).toEqual({ value: 1, coverage: "complete" });
    write([event(1, "Pending", { final: false }), legacy]);
    expect(read().run.claudeTurnReplies?.rows[0]?.seq).toBe(2);
    writeFileSync(join(runDir, "events.jsonl"), "broken\n \n\n" + JSON.stringify(legacy) + "\n");
    expect(read().run.claudeTurnReplies).toMatchObject({ rows: [{ seq: 3 }], partial: true });
    const prefix = "a".repeat(8191);
    write([
      event(1, "an older reply"),
      event(2, "x".repeat(300_000), { final: false }),
      event(3, prefix + "🍎"),
    ]);
    expect(read().run.claudeTurnReplies).toEqual({
      rows: [{ seq: 3, source, text: prefix, truncated: true }],
      partial: true,
    });
    record.params = { mode: "ask", primaryHarness: "codex", harnesses: ["codex"] };
    write([
      event(1, "Omitted Claude reply"),
      event(2, "x".repeat(300_000), { harness_id: "codex" }),
    ]);
    expect(read().run.claudeTurnReplies).toEqual({ rows: [], partial: true });
    const damaged = [
      "damaged",
      JSON.stringify(event(2, "Saved", { session_id: undefined })),
      JSON.stringify(event(3, "Old journal", { after_stop: undefined })),
    ];
    writeFileSync(join(runDir, "events.jsonl"), damaged.join("\n") + "\n");
    expect(read().run.claudeTurnReplies).toEqual({
      rows: [
        { seq: 2, source: { ...source, sessionId: null }, text: "Saved", truncated: false },
        { seq: 3, source: { ...source, afterStop: null }, text: "", truncated: true },
      ],
      partial: true,
    });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
