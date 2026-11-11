import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
vi.mock("@claudexor/schema", () => import("../../../schema/src/index.js"));
import {
  ControlRunStartRequest,
  RunFacts,
  SCHEMA_VERSION,
  makeOutcomeFacts,
} from "@claudexor/schema";
import { sourceSqlFixture } from "./test-support/source-sql-fixture.js";
import { DeferredMessages } from "../deferred-messages.js";
import { admitCommandRequest } from "../command-rpc.js";
import { afterEachClosed } from "../../../cli/src/test-support/after-each-closed.js";

const close: Array<() => void | Promise<void>> = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0).reverse();
  for (const fn of close.splice(0).reverse()) await fn();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});

it.each(["before-promotion", "after-commit", "during-execution"] as const)(
  "holds or recovers the exact receipt across physical close/reopen: %s",
  async (phase) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-deferred-restart-")));
    removals.push(() => rmSync(root, { recursive: true, force: true }));
    const first = await sourceSqlFixture(root);
    close.push(() => first.close());
    const request = ControlRunStartRequest.parse({ mode: "ask", prompt: "first" });
    const commands = first.graph.commands.current();
    commands.accept({
      id: "job-p",
      params: request,
      clientId: "fixture",
      idempotencyKey: "predecessor",
    });
    const runDir = join(root, "predecessor");
    mkdirSync(join(runDir, "final"), { recursive: true });
    commands.update("job-p", { state: "running", runId: "run-p", taskId: "task-p", runDir });
    const facts = RunFacts.parse({
      schema_version: SCHEMA_VERSION,
      run_id: "run-p",
      task_id: "task-p",
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
      "job-p",
      {
        seq: 1,
        ts: new Date().toISOString(),
        run_id: "run-p",
        task_id: "task-p",
        type: "run.completed",
        payload: { run_facts: facts, facts: facts.outcome, lifecycle: "succeeded", reason: null },
      },
      null,
    );
    const owner = first.graph.commands.deferredFor("job-p")!;
    const input = {
      action: "create" as const,
      predecessorId: "job-p",
      prompt: "next",
      attachments: [],
    };
    const draft = owner.mutate(input, "draft", request).draft;
    let successor: string | null = null;
    if (phase !== "before-promotion") {
      successor = owner.promote(
        draft.draftId,
        1,
        owner.request(draft.draftId),
        () => null,
        (start, reserved) => {
          admitCommandRequest(first.graph.commands, start, undefined, undefined, reserved);
        },
      ).record!.id;
      if (phase === "during-execution") {
        const successorDir = join(root, "successor");
        mkdirSync(join(successorDir, "final"), { recursive: true });
        commands.update(successor, {
          state: "running",
          runId: "run-s",
          taskId: "task-s",
          runDir: successorDir,
        });
      }
    }
    await first.close();
    const reopened = await sourceSqlFixture(root);
    close.push(() => reopened.close());
    await reopened.graph.recoverAfterStartup();
    const publish = vi.fn();
    const preparation = vi.fn();
    const observer = new DeferredMessages({
      commands: reopened.graph.commands,
      preparation,
      active: () => false,
      stopped: () => false,
      publish,
    });
    const recovered = observer.read(draft.draftId)!;
    if (phase === "before-promotion")
      expect(recovered).toMatchObject({
        state: "held",
        hold: { code: "restart_requires_controller" },
        successorJobId: null,
      });
    else {
      expect(recovered).toMatchObject({
        state: "dispatched",
        successorJobId: successor,
        dispatchedRevision: 1,
      });
      expect(reopened.graph.commands.findById(successor!)!.get(successor!)?.state).toBe(
        "interrupted",
      );
    }
    const replay = reopened.graph.commands.deferredFor(draft.draftId)!.replay(input, "draft");
    expect(replay).toMatchObject({
      appliedRevision: 1,
      draft: { state: recovered.state, successorJobId: successor },
    });
    await observer.settled("job-p");
    expect(preparation).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(reopened.graph.commands.queries.active()).toEqual([]);
  },
);
