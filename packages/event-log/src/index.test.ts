import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventLog, appendRunEvent, lastSeqInFile } from "./index.js";
import { rmSync as __rmSyncReap } from "node:fs";
import { afterAll as __afterAllReap } from "vitest";

// W-h: reap every temp dir this suite creates so the gate stops leaking tmpdirs.
const __reapDirs: string[] = [];
function reapMk(...args: Parameters<typeof mkdtempSync>): string {
  const dir = mkdtempSync(...args);
  __reapDirs.push(dir);
  return dir;
}
__afterAllReap(() => {
  for (const dir of __reapDirs.splice(0)) __rmSyncReap(dir, { recursive: true, force: true });
});

describe("EventLog seq stamping", () => {
  it("fails the producer when the configured durable sink rejects an event", () => {
    const path = join(reapMk(join(tmpdir(), "claudexor-eventlog-")), "events.jsonl");
    const log = new EventLog(path, "run-1", "task-1", () => {
      throw new Error("journal append failed");
    });
    expect(() => log.emit("run.created", {})).toThrow(/journal append failed/);
    expect(lastSeqInFile(path)).toBe(1);
  });

  it("stamps a strictly monotonic seq starting at 1", () => {
    const path = join(reapMk(join(tmpdir(), "claudexor-eventlog-")), "events.jsonl");
    const log = new EventLog(path, "run-1", "task-1");
    const a = log.emit("run.created", {});
    const b = log.emit("output.ready", { path: "final/answer.md" });
    const c = log.emit("run.completed", { status: "success" });
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    const lines = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { seq?: number });
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3]);
  });

  it("defers a Delegate terminal so late child cash stays before the final event", () => {
    const path = join(reapMk(join(tmpdir(), "claudexor-eventlog-")), "events.jsonl");
    const log = new EventLog(path, "run-1", "task-1");
    let preparations = 0;
    log.setBeforeTerminal((type, payload) => {
      preparations += 1;
      return { type, payload };
    });
    log.emit("run.created", {});
    log.deferTerminal();
    const preview = log.emit("run.completed", { lifecycle: "succeeded" });
    expect(preview.seq).toBe(2);
    expect(preparations).toBe(0);
    expect(log.terminalCommitted()).toBe(false);
    log.emit("budget.cash", { cash_spend_usd: 0.4, valuation_usd: 0 });
    const terminal = log.flushDeferredTerminal();
    expect(terminal?.seq).toBe(3);
    expect(preparations).toBe(1);
    expect(log.terminalCommitted()).toBe(true);
    const lines = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { seq: number; type: string });
    expect(lines.map(({ seq, type }) => [seq, type])).toEqual([
      [1, "run.created"],
      [2, "budget.cash"],
      [3, "run.completed"],
    ]);
  });

  it("runs terminal preparation before the event is persisted or published", () => {
    const dir = reapMk(join(tmpdir(), "claudexor-eventlog-"));
    const path = join(dir, "events.jsonl");
    const marker = join(dir, "run_facts.yaml");
    const observed: boolean[] = [];
    const log = new EventLog(path, "run-1", "task-1", (event) => {
      if (event.type === "run.completed") observed.push(existsSync(marker));
    });
    let calls = 0;
    log.setBeforeTerminal(() => {
      calls += 1;
      expect(lastSeqInFile(path)).toBe(1);
      writeFileSync(marker, "run_id: run-1\n");
    });
    log.emit("run.created", {});
    log.emit("run.completed", {});
    expect(calls).toBe(1);
    expect(observed).toEqual([true]);
    expect(lastSeqInFile(path)).toBe(2);
  });

  it("persists authority, commits the receipt, then publishes the terminal", () => {
    const dir = reapMk(join(tmpdir(), "claudexor-eventlog-"));
    const path = join(dir, "events.jsonl");
    const marker = join(dir, "run_facts.yaml");
    const order: string[] = [];
    const log = new EventLog(
      path,
      "run-1",
      "task-1",
      (event) => {
        if (event.type !== "run.completed") return;
        order.push("persist");
        expect(existsSync(marker)).toBe(false);
        expect(lastSeqInFile(path)).toBe(0);
      },
      undefined,
      (event) => {
        if (event.type !== "run.completed") return;
        order.push("publish");
        expect(existsSync(marker)).toBe(true);
        expect(lastSeqInFile(path)).toBe(1);
      },
    );
    log.setBeforeTerminal(() => ({
      type: "run.completed",
      payload: {},
      commit: () => {
        order.push("commit");
        writeFileSync(marker, "run_id: run-1\n");
      },
    }));

    log.emit("run.completed", {});
    expect(order).toEqual(["persist", "commit", "publish"]);
  });

  it("commits a prepared terminal type and payload atomically to disk and the live sink", () => {
    const path = join(reapMk(join(tmpdir(), "claudexor-eventlog-")), "events.jsonl");
    const observed: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const log = new EventLog(path, "run-1", "task-1", (event) => {
      observed.push({ type: event.type, payload: event.payload });
    });
    let calls = 0;
    log.setBeforeTerminal((_type, payload) => {
      calls += 1;
      return {
        type: "run.blocked",
        payload: { ...payload, lifecycle: "succeeded", canonical: true },
      };
    });

    const terminal = log.emit("run.completed", {
      lifecycle: "succeeded",
      canonical: false,
    });
    const persisted = JSON.parse(readFileSync(path, "utf8")) as {
      type: string;
      payload: Record<string, unknown>;
    };

    expect(calls).toBe(1);
    expect(terminal).toMatchObject({
      type: "run.blocked",
      payload: { lifecycle: "succeeded", canonical: true },
    });
    expect(persisted).toMatchObject({
      type: "run.blocked",
      payload: { lifecycle: "succeeded", canonical: true },
    });
    expect(observed).toEqual([
      {
        type: "run.blocked",
        payload: { lifecycle: "succeeded", canonical: true },
      },
    ]);
  });

  it("does not append a terminal whose preparation rejected, and permits the safety-net retry", () => {
    const path = join(reapMk(join(tmpdir(), "claudexor-eventlog-")), "events.jsonl");
    const log = new EventLog(path, "run-1", "task-1");
    let calls = 0;
    log.setBeforeTerminal(() => {
      calls += 1;
      if (calls === 1) throw new Error("contradictory receipt");
    });
    expect(() => log.emit("run.completed", {})).toThrow(/contradictory receipt/);
    expect(lastSeqInFile(path)).toBe(0);
    expect(log.emit("run.failed", {}).seq).toBe(1);
    expect(calls).toBe(2);
  });

  it("validates the terminal event before running its preparation hook", () => {
    const path = join(reapMk(join(tmpdir(), "claudexor-eventlog-")), "events.jsonl");
    const log = new EventLog(path, "run-1", "task-1");
    let calls = 0;
    log.setBeforeTerminal(() => {
      calls += 1;
    });
    expect(() => log.emit("not-a-run-event" as Parameters<EventLog["emit"]>[0], {})).toThrow();
    expect(calls).toBe(0);
    expect(lastSeqInFile(path)).toBe(0);
  });

  it("keeps terminal preparation retryable until the event append is durable", () => {
    const dir = reapMk(join(tmpdir(), "claudexor-eventlog-"));
    const path = join(dir, "events.jsonl");
    // A pre-existing directory makes appendLine fail while leaving the exact
    // pre-commit path state intact, so rollback is complete and retry is safe.
    mkdirSync(path);
    const log = new EventLog(path, "run-1", "task-1");
    let calls = 0;
    log.setBeforeTerminal(() => {
      calls += 1;
    });
    expect(() => log.emit("run.completed", {})).toThrow();
    expect(lastSeqInFile(path)).toBe(0);
    rmSync(path, { recursive: true });
    expect(log.emit("run.failed", {}).seq).toBe(1);
    expect(calls).toBe(2);
    expect(lastSeqInFile(path)).toBe(1);
  });

  it("rolls back terminal artifacts when the configured durable sink rejects, then retries once", () => {
    const dir = reapMk(join(tmpdir(), "claudexor-eventlog-"));
    const path = join(dir, "events.jsonl");
    const marker = join(dir, "run_facts.yaml");
    const observed: string[] = [];
    let rejectTerminal = true;
    const log = new EventLog(path, "run-1", "task-1", (event) => {
      observed.push(event.type);
      if (
        rejectTerminal &&
        (event.type === "run.completed" ||
          event.type === "run.blocked" ||
          event.type === "run.failed")
      ) {
        throw new Error("durable journal unavailable");
      }
    });
    let hookCalls = 0;
    log.setBeforeTerminal(() => {
      hookCalls += 1;
      writeFileSync(marker, `attempt: ${hookCalls}\n`);
      return {
        type: "run.completed",
        payload: {},
        rollback: () => rmSync(marker, { force: true }),
      };
    });
    log.emit("run.created", {});
    expect(() => log.emit("run.completed", {})).toThrow(/durable journal unavailable/);
    expect(log.terminalCommitted()).toBe(false);
    expect(existsSync(marker)).toBe(false);
    rejectTerminal = false;
    expect(log.emit("run.failed", {}).seq).toBe(2);
    expect(log.terminalCommitted()).toBe(true);
    const events = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.map((event) => event.type)).toEqual(["run.created", "run.completed"]);
    expect(observed).toEqual(["run.created", "run.completed", "run.completed"]);
    expect(hookCalls).toBe(2);
    expect(existsSync(marker)).toBe(true);
    expect(() => log.emit("run.failed", {})).toThrow(/already committed/);
  });

  it("fences a re-entrant sink from appending inside the terminal commit", () => {
    const path = join(reapMk(join(tmpdir(), "claudexor-eventlog-")), "events.jsonl");
    let log!: EventLog;
    log = new EventLog(path, "run-1", "task-1", (event) => {
      if (event.type === "run.completed") {
        expect(() => log.emit("run.failed", {})).toThrow(/commit is already in progress/);
      }
    });
    log.emit("run.created", {});
    log.emit("run.completed", {});

    const events = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.map((event) => event.type)).toEqual(["run.created", "run.completed"]);
    expect(log.terminalCommitted()).toBe(true);
  });

  it("poisons the writer when rollback is incomplete instead of retrying over split truth", () => {
    const path = join(reapMk(join(tmpdir(), "claudexor-eventlog-")), "events.jsonl");
    const log = new EventLog(path, "run-1", "task-1", (event) => {
      if (event.type === "run.completed") throw new Error("durable journal unavailable");
    });
    log.setBeforeTerminal(() => ({
      type: "run.completed",
      payload: {},
      rollback: () => {
        throw new Error("receipt restore failed");
      },
    }));
    log.emit("run.created", {});

    expect(() => log.emit("run.completed", {})).toThrow(/rollback was incomplete/);
    expect(log.terminalCommitted()).toBe(false);
    expect(() => log.emit("run.failed", {})).toThrow(/writer is poisoned/);
    const events = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.map((event) => event.type)).toEqual(["run.created"]);
  });

  it("releases a poisoned live writer after durable recovery restores the terminal tail", () => {
    const dir = reapMk(join(tmpdir(), "claudexor-eventlog-"));
    const path = join(dir, "events.jsonl");
    mkdirSync(path);
    let durableTerminal: ReturnType<EventLog["emit"]> | null = null;
    const log = new EventLog(path, "run-1", "task-1", (event) => {
      durableTerminal = event;
    });
    log.setBeforeTerminal((type, payload) => ({ type, payload, commit: () => undefined }));

    let terminalError: unknown;
    try {
      log.emit("run.completed", {});
    } catch (error) {
      terminalError = error;
    }
    expect(terminalError).toMatchObject({ code: "terminal_recovery_required" });
    expect(durableTerminal).not.toBeNull();

    rmSync(path, { recursive: true });
    writeFileSync(path, `${JSON.stringify(durableTerminal)}\n`);
    const audit = appendRunEvent(path, "run-1", "task-1", "control.rejected", {
      reason: "run is terminal",
    });
    expect(audit.seq).toBe(2);
    expect(() => appendRunEvent(path, "run-1", "task-1", "run.failed", {})).toThrow(
      /already committed/,
    );
  });

  it("continues the sequence when reopening an existing log (no cursor reuse)", () => {
    const path = join(reapMk(join(tmpdir(), "claudexor-eventlog-")), "events.jsonl");
    const first = new EventLog(path, "run-1", "task-1");
    first.emit("run.created", {});
    first.dispose();
    const reopened = new EventLog(path, "run-1", "task-1");
    expect(reopened.emit("output.ready", {}).seq).toBe(2);
  });

  it("rejects a concurrent writer for an actively owned event path", () => {
    const path = join(reapMk(join(tmpdir(), "claudexor-eventlog-")), "events.jsonl");
    const owner = new EventLog(path, "run-1", "task-1");
    owner.emit("run.created", {});

    expect(() => new EventLog(path, "run-1", "task-1")).toThrow(/already owns this event path/);

    owner.emit("run.completed", {});
    expect(() => new EventLog(path, "run-1", "task-1").emit("run.failed", {})).toThrow(
      /already committed/,
    );
  });

  it("restores the terminal fence when reopening a completed event log", () => {
    const path = join(reapMk(join(tmpdir(), "claudexor-eventlog-")), "events.jsonl");
    new EventLog(path, "run-1", "task-1").emit("run.completed", {});
    const reopened = new EventLog(path, "run-1", "task-1");
    expect(reopened.terminalCommitted()).toBe(true);
    expect(() => reopened.emit("run.failed", {})).toThrow(/already committed/);
    expect(() => reopened.emit("output.ready", {})).toThrow(/already committed/);
  });

  it("continues past LEGACY lines without seq by line position", () => {
    const path = join(reapMk(join(tmpdir(), "claudexor-eventlog-")), "events.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({
          ts: "t",
          run_id: "run-1",
          task_id: "task-1",
          type: "run.created",
          payload: {},
        }),
        JSON.stringify({
          ts: "t",
          run_id: "run-1",
          task_id: "task-1",
          type: "harness.started",
          payload: {},
        }),
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
    const path = join(reapMk(join(tmpdir(), "claudexor-eventlog-")), "events.jsonl");
    const log = new EventLog(path, "run-1", "task-1");
    const a = log.emit("run.created", {});
    // Out-of-band audit append while the run is ACTIVE: a file-tail stamp
    // would also pick seq 2 here and collide with the next live emit.
    const audit = appendRunEvent(path, "run-1", "task-1", "control.requested", {
      control: { kind: "cancel" },
    });
    const b = log.emit("output.ready", {});
    const c = log.emit("run.completed", {});
    const seqs = [a.seq, audit.seq, b.seq, c.seq];
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect(new Set(seqs).size).toBe(4);
  });

  it("falls back to file-tail stamping once the run is terminal (self-dispose)", () => {
    const path = join(reapMk(join(tmpdir(), "claudexor-eventlog-")), "events.jsonl");
    const log = new EventLog(path, "run-1", "task-1");
    log.emit("run.created", {});
    log.emit("run.failed", { reason: "x" }); // terminal -> live counter released
    const audit = appendRunEvent(path, "run-1", "task-1", "control.rejected", {
      reason: "run is terminal",
    });
    expect(audit.seq).toBe(3);
    const lines = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { seq?: number });
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3]);
  });

  it("rejects a second out-of-band terminal after the live writer disposes", () => {
    const path = join(reapMk(join(tmpdir(), "claudexor-eventlog-")), "events.jsonl");
    const log = new EventLog(path, "run-1", "task-1");
    log.emit("run.completed", {});
    expect(() => appendRunEvent(path, "run-1", "task-1", "run.failed", {})).toThrow(
      /already committed/,
    );
  });

  it("dispose() is idempotent and releases ownership for a successor log", () => {
    const path = join(reapMk(join(tmpdir(), "claudexor-eventlog-")), "events.jsonl");
    const first = new EventLog(path, "run-1", "task-1");
    first.emit("run.created", {});
    first.dispose();
    first.dispose();
    const second = new EventLog(path, "run-1", "task-1");
    expect(appendRunEvent(path, "run-1", "task-1", "control.requested", {}).seq).toBe(2);
    expect(second.emit("run.completed", {}).seq).toBe(3);
  });
});
