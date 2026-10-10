import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableJournal } from "./store/test-support/fixtures/legacy/journal/index.js";
import {
  RunEvent,
  SCHEMA_VERSION,
  makeOutcomeFacts,
  requiredActionsFor,
  validateRunFactsInvariants,
} from "@claudexor/schema";
import { afterEach, describe, expect, it } from "vitest";
import { CommandStore } from "./store/test-support/fixtures/legacy/daemon/command-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function failureFacts(runId: string, taskId: string) {
  const outcome = makeOutcomeFacts("failed", { reason: "harness_failed" });
  return validateRunFactsInvariants({
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    task_id: taskId,
    mode: "agent",
    outcome,
    deliverable: { present: false, kind: null, path: null, producer_attempt_id: null },
    participants: { planners: 0, attempts: [] },
    gates: {
      configured: false,
      required: 0,
      total: 0,
      executed: false,
      state: "not_configured",
      receipt_attempt_id: null,
    },
    review: { state: "not_run", blocker_ids: [], blockers: 0 },
    apply: { eligibility: null, operator_decision_present: false },
    required_actions: requiredActionsFor(outcome, false),
    generated_at: "2026-09-26T12:00:00.000Z",
  });
}

/**
 * A run whose terminal is durably journaled, with a per-run events.jsonl that
 * carries one more row AFTER the terminal: the shape a live-message receipt
 * takes when the adapter answers after the run's terminal commit (the route
 * file-tail-stamps it). Returns the reopened store's recovery thunk.
 */
function fixture(afterTerminal: { type: string; payload: Record<string, unknown> }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-live-message-terminal-")));
  roots.push(dir);
  const runId = "run-lm";
  const taskId = "task-lm";
  const runDir = join(dir, runId);
  mkdirSync(join(runDir, "final"), { recursive: true });
  const journal = new DurableJournal({ rootDir: join(dir, "journal"), partition: "global" });
  const store = new CommandStore(journal);
  store.recoverAfterStartup();
  store.accept({ id: "job-lm", params: { value: 1 }, idempotencyKey: "lm", clientId: "test" });
  store.update("job-lm", { state: "running", runId, taskId, runDir });
  const facts = failureFacts(runId, taskId);
  const terminal = RunEvent.parse({
    seq: 2,
    ts: "2026-09-26T12:00:01.000Z",
    run_id: runId,
    task_id: taskId,
    type: "run.failed",
    payload: {
      lifecycle: "failed",
      facts: facts.outcome,
      reason: "harness_failed",
      run_facts: facts,
    },
  });
  journal.append("run.event", terminal);
  const late = RunEvent.parse({
    seq: 3,
    ts: "2026-09-26T12:00:02.000Z",
    run_id: runId,
    task_id: taskId,
    type: afterTerminal.type,
    payload: afterTerminal.payload,
  });
  const created = RunEvent.parse({
    seq: 1,
    ts: "2026-09-26T12:00:00.000Z",
    run_id: runId,
    task_id: taskId,
    type: "run.created",
    payload: { mode: "agent" },
  });
  const eventsPath = join(runDir, "events.jsonl");
  writeFileSync(
    eventsPath,
    [created, terminal, late].map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  journal.close();
  return {
    eventsPath,
    late,
    reopen: () => {
      const reopened = new DurableJournal({ rootDir: join(dir, "journal"), partition: "global" });
      const second = new CommandStore(reopened);
      try {
        second.recoverAfterStartup();
        return second.get("job-lm");
      } finally {
        reopened.close();
      }
    },
  };
}

describe("live-message receipts after a run's terminal (CONTRACT A1/A23)", () => {
  it("terminal recovery accepts a message.delivered row that landed after the terminal and keeps it", () => {
    const fx = fixture({
      type: "message.delivered",
      payload: {
        message_id: "msg-1",
        attempt_id: "a01",
        harness_id: "codex",
        outcome: "delivered",
        text_sha256: "a".repeat(64),
        text_bytes: 9,
        text: "use MANGO",
        title: "Live message delivered (9 bytes)",
      },
    });
    expect(fx.reopen()).toMatchObject({ state: "failed" });
    const lines = readFileSync(fx.eventsPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2] as string)).toEqual(fx.late);
  });

  it("terminal recovery accepts message.accepted and message.refused after the terminal too", () => {
    for (const type of ["message.accepted", "message.refused"]) {
      const fx = fixture({
        type,
        payload: { message_id: "msg-2", outcome: "not_active", reason: "run_terminal" },
      });
      expect(fx.reopen()).toMatchObject({ state: "failed" });
    }
  });

  it("still refuses a non-audit row after the terminal (the allowlist is exact)", () => {
    const fx = fixture({ type: "harness.event", payload: { type: "message", text: "late" } });
    expect(() => fx.reopen()).toThrow(/after terminal authority/);
  });
});
