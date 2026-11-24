/**
 * Daemons for the run-deadline/1 fault tests: one over the legacy journal
 * store (whose writes a test may fail) and one over the production SQL store,
 * both with a frozen clock and an injectable record I/O; plus polling and a
 * run's terminal event.
 */
import { join } from "node:path";
import { RunFacts, SCHEMA_VERSION, makeOutcomeFacts } from "@claudexor/schema";
import { DaemonLocalClient } from "../daemon-local-client.js";
import { fileRecordIo, type RecordIo } from "../run-deadline-record.js";
import { DaemonServer, type RunnerFn } from "../server.js";
import { DurableJournal } from "../store/test-support/fixtures/legacy/journal/index.js";
import { CommandStore } from "../store/test-support/fixtures/legacy/daemon/command-store.js";
import { legacyCommandFixture } from "../store/test-support/legacy-command-fixture.js";
import { sqlFixture } from "../store/test-support/sql-fixture.js";
import { temp, type Clock } from "./run-deadline-faults.js";

/** One job at a time. */
export const CAPS = {
  max_concurrent: 1,
  max_concurrent_non_model_jobs: 1,
  max_concurrent_model_operations: 1,
  max_parallel_candidates: 1,
  max_deep_scan_width: 1,
  max_council_members: 2,
};

const deadlineOptions = (dir: string, time: Clock, io: RecordIo = fileRecordIo) => ({
  dir: join(dir, "deadlines"),
  clock: time.clock,
  io,
  spawnWarden: async () => ({ pid: 1 }),
  platform: "linux" as const,
  probeBoundary: async () => ({ kind: "marker" as const, reason: "test" }),
});

export async function legacyDaemon(time: Clock, io: RecordIo, runner: RunnerFn) {
  const dir = temp();
  const journal = new DurableJournal({ rootDir: join(dir, "journal"), partition: "global" });
  const store = new CommandStore(journal);
  store.recoverAfterStartup();
  const server = new DaemonServer({
    socketPath: join(dir, "unused.sock"),
    token: "token",
    commands: legacyCommandFixture({ current: () => store }),
    runtimeConcurrencyCaps: CAPS,
    runDeadlines: deadlineOptions(dir, time, io),
    runner,
  });
  await server.deadlines.startup();
  return {
    dir: join(dir, "deadlines"),
    store,
    server,
    client: new DaemonLocalClient(() => server),
    async close() {
      await server.stop();
      journal.close();
    },
  };
}

export async function sqlDaemon(time: Clock, runner: (sql: SqlFixture) => RunnerFn) {
  const root = temp();
  const sql = await sqlFixture(root);
  const server = new DaemonServer({
    socketPath: join(root, "unused.sock"),
    token: "token",
    commands: sql.graph.commands,
    runtimeConcurrencyCaps: CAPS,
    runDeadlines: deadlineOptions(root, time),
    runner: runner(sql),
  });
  await server.deadlines.startup();
  return {
    root,
    sql,
    server,
    client: new DaemonLocalClient(() => server),
    async close() {
      await server.stop();
      await sql.close();
    },
  };
}
type SqlFixture = Awaited<ReturnType<typeof sqlFixture>>;

export async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  tries = 400,
): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not reached");
}

/** A succeeded run's terminal event, as the runner's EventLog persists it. */
export function terminalEvent(runId: string, jobId: string) {
  const taskId = `task-${jobId}`;
  const facts = RunFacts.parse({
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    task_id: taskId,
    mode: "ask",
    outcome: {
      ...makeOutcomeFacts("succeeded"),
      review_requested: false,
      work_state: { state: "completed", source: "constrained" },
    },
    deliverable: { present: true, kind: "answer", path: "final/answer.md" },
    presentation: { state: "ready", primary: { kind: "answer", path: "final/answer.md" } },
    participants: { planners: 0, attempts: [] },
    gates: { configured: false, required: 0, total: 0, executed: false, state: "not_configured" },
    review: { state: "not_run", blockers: 0, blocker_ids: [] },
    apply: { eligibility: null },
    required_actions: [],
    generated_at: new Date().toISOString(),
  });
  return {
    seq: 1,
    ts: new Date().toISOString(),
    run_id: runId,
    task_id: taskId,
    type: "run.completed" as const,
    payload: { run_facts: facts, facts: facts.outcome, lifecycle: "succeeded", reason: null },
  };
}
