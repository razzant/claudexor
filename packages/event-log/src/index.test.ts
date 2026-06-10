import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventLog, appendRunEvent, lastSeqInFile } from "./index.js";

describe("EventLog seq stamping", () => {
  it("stamps a strictly monotonic seq starting at 1", () => {
    const path = join(mkdtempSync(join(tmpdir(), "claudexor-eventlog-")), "events.jsonl");
    const log = new EventLog(path, "run-1", "task-1");
    const a = log.emit("run.created", {});
    const b = log.emit("output.ready", { path: "final/answer.md" });
    const c = log.emit("run.completed", { status: "success" });
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { seq?: number });
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3]);
  });

  it("continues the sequence when reopening an existing log (no cursor reuse)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "claudexor-eventlog-")), "events.jsonl");
    new EventLog(path, "run-1", "task-1").emit("run.created", {});
    const reopened = new EventLog(path, "run-1", "task-1");
    expect(reopened.emit("output.ready", {}).seq).toBe(2);
  });

  it("continues past LEGACY lines without seq by line position", () => {
    const path = join(mkdtempSync(join(tmpdir(), "claudexor-eventlog-")), "events.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ ts: "t", run_id: "run-1", task_id: "task-1", type: "run.created", payload: {} }),
        JSON.stringify({ ts: "t", run_id: "run-1", task_id: "task-1", type: "harness.started", payload: {} }),
      ].join("\n") + "\n",
    );
    expect(lastSeqInFile(path)).toBe(2);
    const log = new EventLog(path, "run-1", "task-1");
    expect(log.emit("run.completed", {}).seq).toBe(3);
  });

  it("lastSeqInFile is 0 for a missing file", () => {
    expect(lastSeqInFile(join(tmpdir(), "claudexor-nonexistent", "events.jsonl"))).toBe(0);
  });
});

describe("appendRunEvent single-counter invariant", () => {
  it("routes out-of-band appends through the LIVE log (no duplicate seq under interleave)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "claudexor-eventlog-")), "events.jsonl");
    const log = new EventLog(path, "run-1", "task-1");
    const a = log.emit("run.created", {});
    // Out-of-band audit append while the run is ACTIVE: a file-tail stamp
    // would also pick seq 2 here and collide with the next live emit.
    const audit = appendRunEvent(path, "run-1", "task-1", "control.requested", { control: { kind: "cancel" } });
    const b = log.emit("output.ready", {});
    const c = log.emit("run.completed", {});
    const seqs = [a.seq, audit.seq, b.seq, c.seq];
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect(new Set(seqs).size).toBe(4);
  });

  it("falls back to file-tail stamping once the run is terminal (self-dispose)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "claudexor-eventlog-")), "events.jsonl");
    const log = new EventLog(path, "run-1", "task-1");
    log.emit("run.created", {});
    log.emit("run.failed", { reason: "x" }); // terminal -> live counter released
    const audit = appendRunEvent(path, "run-1", "task-1", "control.rejected", { reason: "run is terminal" });
    expect(audit.seq).toBe(3);
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { seq?: number });
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3]);
  });

  it("dispose() is idempotent and releases ownership for a successor log", () => {
    const path = join(mkdtempSync(join(tmpdir(), "claudexor-eventlog-")), "events.jsonl");
    const first = new EventLog(path, "run-1", "task-1");
    first.emit("run.created", {});
    first.dispose();
    first.dispose();
    const second = new EventLog(path, "run-1", "task-1");
    expect(appendRunEvent(path, "run-1", "task-1", "control.requested", {}).seq).toBe(2);
    expect(second.emit("run.completed", {}).seq).toBe(3);
  });
});
