/** Historical replay/file contract against the sealed legacy reference.
 * SQL serving behavior is covered by store/terminal-contract.test.ts. */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableJournal } from "./store/test-support/fixtures/legacy/journal/index.js";
import type { RunEvent } from "@claudexor/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandStore } from "./store/test-support/fixtures/legacy/daemon/command-store.js";
import { durableTerminalRunEvents } from "./store/test-support/fixtures/legacy/daemon/run-event-terminal-index.js";
import { RunEventStore } from "./store/test-support/fixtures/legacy/daemon/run-events.js";

const roots: string[] = [];
const journals: DurableJournal[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const journal of journals.splice(0)) journal.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function open(): DurableJournal {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "claudexor-terminal-index-")));
  roots.push(root);
  const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
  journals.push(journal);
  return journal;
}

function event(runId: string, type: RunEvent["type"], seq = 1): RunEvent {
  return {
    seq,
    ts: "2026-09-14T00:00:00.000Z",
    run_id: runId,
    task_id: `task-${runId}`,
    type,
    payload: {},
  };
}

const runEventReads = (reads: { mock: { calls: unknown[][] } }) =>
  reads.mock.calls.filter((call) => (call[1] as string[] | undefined)?.includes("run.event"));

describe("durable terminal run-event index", () => {
  it("parses every run.event once per generation and extends incrementally on append", () => {
    const journal = open();
    const store = new RunEventStore(journal, false);
    store.record(event("run-1", "run.created", 1));
    store.record(event("run-1", "run.completed", 2));
    store.record(event("run-2", "run.created", 1));
    const reads = vi.spyOn(journal, "records");

    const first = durableTerminalRunEvents(journal);
    expect([...first.keys()]).toEqual(["run-1"]);
    expect(runEventReads(reads)).toEqual([[0, ["run.event"]]]);
    expect(durableTerminalRunEvents(journal)).toBe(first);
    expect(runEventReads(reads)).toHaveLength(1);

    const seen = journal.currentSequence();
    store.record(event("run-2", "run.failed", 2));
    expect(durableTerminalRunEvents(journal).get("run-2")?.type).toBe("run.failed");
    expect(runEventReads(reads)).toEqual([
      [0, ["run.event"]],
      [seen, ["run.event"]],
    ]);
  });

  it("is one pass shared by RunEventStore validation and CommandStore terminal recovery", () => {
    const journal = open();
    const commands = new CommandStore(journal);
    commands.accept({ id: "job-1", params: {}, idempotencyKey: "k", clientId: "t" });
    commands.update("job-1", { state: "running", runId: "run-1", taskId: "task-run-1" });
    new RunEventStore(journal, false).record(event("run-1", "run.completed"));
    const seen = journal.currentSequence();
    const reads = vi.spyOn(journal, "records");

    new RunEventStore(journal); // validates on construction: the one full pass
    expect(runEventReads(reads)).toEqual([[0, ["run.event"]]]);
    const replayed = new CommandStore(journal); // command.* types only
    replayed.recoverAfterStartup(); // durable terminal lookup, then an interrupt append
    expect(replayed.get("job-1")).toMatchObject({
      state: "interrupted",
      errorCode: "legacy_terminal_recovery_unavailable",
    });
    replayed.recoverDurableTerminal("job-1");
    // History is never parsed again: every later lookup reads only the tail
    // appended since the pass (here: the interrupt's command.updated frame).
    const [, ...later] = runEventReads(reads);
    expect(later.length).toBeGreaterThan(0);
    for (const [afterSeq] of later) expect(afterSeq).toBeGreaterThanOrEqual(seen);
  });

  it("refuses a second terminal for a run and reports the same failure on every call", () => {
    const journal = open();
    journal.append("run.event", event("run-1", "run.completed"));
    journal.append("run.event", event("run-1", "run.failed"));
    expect(() => durableTerminalRunEvents(journal)).toThrow(
      "multiple durable terminal events for run run-1",
    );
    expect(() => durableTerminalRunEvents(journal)).toThrow(
      "multiple durable terminal events for run run-1",
    );
    const malformed = open();
    journal.close();
    malformed.append("run.event", event("run-2", "run.completed"));
    malformed.append("run.event", { not: "a run event" });
    expect(() => durableTerminalRunEvents(malformed)).toThrow();
    // The failed pass left nothing behind: no phantom terminal for run-2.
    expect(() => durableTerminalRunEvents(malformed)).toThrow(/invalid|Required|expected/i);
    expect(() => new RunEventStore(malformed)).toThrow();
  });
});
