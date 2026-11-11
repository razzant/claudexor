import { RunFacts, SCHEMA_VERSION, makeOutcomeFacts } from "@claudexor/schema";
import type { SqlCommandStore } from "../commands.js";

/** Ordinary persisted terminal receipt, shared by the review regressions. */
export function settleDeferredPredecessor(commands: SqlCommandStore, id: string, runDir: string) {
  const runId = `run-${id}`,
    taskId = `task-${id}`;
  commands.update(id, { state: "running", runId, taskId, runDir });
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
  commands.persistTerminal(
    id,
    {
      seq: 1,
      ts: new Date().toISOString(),
      run_id: runId,
      task_id: taskId,
      type: "run.completed",
      payload: { run_facts: facts, facts: facts.outcome, lifecycle: "succeeded", reason: null },
    },
    null,
  );
}
