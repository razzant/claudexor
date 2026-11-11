import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ThreadHistoryInput,
  THREAD_HISTORY_PROMPT_BYTES,
  THREAD_HISTORY_METADATA_BYTES,
} from "@claudexor/schema";
import { SqlThreadHistoryRead } from "@claudexor/daemon";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { applyCommandInTx, prepareCommandRow } from "../../daemon/src/store/command-rows.js";
import { assertPlanAnswerSubmission } from "../../control-api/src/thread-plan-answer.js";
import { sqlThreadHistoryReads } from "./sql-thread-history.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

const cleanup: (() => Promise<void>)[] = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0);
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) await close();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cx-history-plan-"));
  const f = await sqlFixture(root);
  removals.push(() => rmSync(root, { recursive: true, force: true }));
  cleanup.push(async () => {
    await f.close();
  });
  const thread = f.graph.threads.createThread({ title: "plan history" });
  const pid = f.graph.threads.generationForThread(thread.id)!.pid;
  const reader = new SqlThreadHistoryRead(f.store, f.graph.blobs);
  const reads = sqlThreadHistoryReads(() => f.graph);
  const turn = (prompt: string, answersPlanRunId?: string) =>
    f.graph.threads.createTurn(thread.id, prompt, { answersPlanRunId });
  const bind = (id: string) => {
    const runId = `${id}-run`;
    const prepared = prepareCommandRow(
      {
        id: `${id}-job`,
        runId,
        state: "running",
        createdAt: "2026-10-26T12:00:00Z",
        params: { mode: "plan", threadId: thread.id, turnId: id },
      },
      { pid, live: true, operation: "plan", clientId: null },
      (bytes) => f.graph.blobs.prepareBody(bytes),
    );
    f.store.transaction(() => applyCommandInTx(f.store, prepared, "accept"));
    f.graph.threads.bindTurnRun(id, runId);
    return runId;
  };
  const refuse = (id: string, retryable: boolean) =>
    f.graph.threads.setTurnEnqueueError(id, {
      message: "fixture refusal",
      retryable,
      code: null,
      required_actions: [],
      context: {},
    });
  const plan = turn("plan");
  const planRunId = bind(plan.id);
  const page = (extra: Partial<ThreadHistoryInput> = {}) =>
    reads.threadHistory(
      ThreadHistoryInput.parse({ threadId: thread.id, aroundTurnId: plan.id, limit: 1, ...extra }),
    );
  return { ...f, thread, reader, turn, bind, refuse, plan, planRunId, page };
}

describe("indexed off-page plan answers", () => {
  it("finds the answer on the next page and refreshes a frozen replay after an append", async () => {
    const f = await fixture();
    const initial = f.page();
    expect(initial.turns[0]).toMatchObject({
      answeredByTurnId: null,
      answeredByPrompt: null,
      planAnswerComplete: true,
    });
    const answer = f.turn("Use SQLite", f.planRunId);
    f.bind(answer.id);
    const page = f.page({ aroundTurnId: undefined, cursor: initial.replayCursor! });
    expect(page.turns.map((t) => t.id)).toEqual([f.plan.id]);
    expect(page.turns[0]).toMatchObject({
      answeredByTurnId: answer.id,
      answeredByPrompt: { id: answer.id, prompt: "Use SQLite" },
      planAnswerComplete: true,
    });
    const next = f.page({ aroundTurnId: undefined, afterTurnId: f.plan.id });
    expect(next.turns[0]?.id).toBe(answer.id);
  });

  it.each(["bound", "queued", "retryable"] as const)(
    "skips hard refusals and unrelated queued turns before the %s answer",
    async (kind) => {
      const f = await fixture();
      for (let i = 0; i < 3; i++) {
        const refused = f.turn(`refused-${i}`, f.planRunId);
        f.refuse(refused.id, false);
      }
      f.turn("still queued, unrelated to the plan");
      const answer = f.turn("Accepted answer", f.planRunId);
      if (kind === "bound") f.bind(answer.id);
      if (kind === "retryable") f.refuse(answer.id, true);
      expect(f.page().turns[0]).toMatchObject({
        answeredByTurnId: answer.id,
        planAnswerComplete: true,
      });
    },
  );

  it("keeps the first matching queued turn even if a later answer has already bound", async () => {
    const f = await fixture();
    const queued = f.turn("first queued answer", f.planRunId);
    const later = f.turn("later bound answer", f.planRunId);
    f.bind(later.id);
    expect(f.page().turns[0]?.answeredByTurnId).toBe(queued.id);
    f.refuse(queued.id, false);
    expect(f.page().turns[0]?.answeredByTurnId).toBe(later.id);
  });

  it("retains the relation for a superseded plan and keeps different plans and threads separate", async () => {
    const f = await fixture();
    const answer = f.turn("old answer", f.planRunId);
    f.bind(answer.id);
    const newerPlan = f.turn("new plan");
    const newerId = f.bind(newerPlan.id);
    const newerAnswer = f.turn("new answer", newerId);
    const other = f.graph.threads.createThread({ title: "other" });
    f.graph.threads.createTurn(other.id, "foreign answer", { answersPlanRunId: f.planRunId });
    expect(f.page().header.headRun?.runId).toBe(newerId);
    expect(f.page().turns[0]?.answeredByTurnId).toBe(answer.id);
    expect(f.page({ aroundTurnId: newerPlan.id }).turns[0]?.answeredByTurnId).toBe(newerAnswer.id);
    f.refuse(answer.id, false); // The bound run still owns submission despite this refusal.
    expect(f.page().turns[0]?.answeredByTurnId).toBe(answer.id);
  });

  it("matches the admission predicate for non-retryable, retryable, queued and bound turns", async () => {
    const f = await fixture();
    const answer = f.turn("retry me", f.planRunId);
    const assertBoth = (accepted: boolean) => {
      const turns = f.graph.threads.turnsFor(f.thread.id);
      const admission = () =>
        assertPlanAnswerSubmission({
          sourcePlanRunId: f.planRunId,
          implementPlanRunId: null,
          mode: "plan",
          headRunId: f.planRunId,
          threadRunIds: [f.planRunId],
          turns: turns as unknown as Record<string, unknown>[],
        });
      if (accepted)
        expect(admission).toThrow(
          expect.objectContaining({ code: "plan_answers_already_submitted" }),
        );
      else expect(admission).not.toThrow();
      expect(f.page().turns[0]).toMatchObject({
        answeredByTurnId: accepted ? answer.id : null,
        planAnswerComplete: true,
      });
    };
    assertBoth(true); // Queued, no refusal.
    f.refuse(answer.id, false);
    assertBoth(false);
    f.refuse(answer.id, true);
    assertBoth(true);
    f.refuse(answer.id, false);
    f.bind(answer.id);
    f.refuse(answer.id, false);
    assertBoth(true); // Bound wins, even if the original refusal was false.
  });

  it("uses the expression index among thousands of unrelated turns without decoding their bodies", async () => {
    const f = await fixture();
    f.store.transaction(() => {
      const insert = f.store.prepare(
        "INSERT INTO turn(id,pid,thread_id,ordinal,run_id,created_at,prompt_sha,body) SELECT ?,pid,thread_id,?,NULL,created_at,prompt_sha,x'00' FROM turn WHERE id=?",
      );
      for (let i = 1; i <= 3000; i++) insert.run(`raw-${i}`, i, f.plan.id);
    });
    const answer = f.turn("indexed answer", f.planRunId);
    const prepare = vi.spyOn(f.store, "prepare");
    expect(f.reader.planAnswer(f.thread.id, f.planRunId).answeredByTurnId).toBe(answer.id);
    const sql = prepare.mock.calls.find(([sql]) =>
      sql.includes("FROM turn INDEXED BY turn_plan_answer"),
    )![0];
    const queryPlan = f.store
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(f.thread.id, f.planRunId, THREAD_HISTORY_METADATA_BYTES);
    expect(JSON.stringify(queryPlan)).toContain(
      "SEARCH turn USING INDEX turn_plan_answer (thread_id=? AND <expr>=?)",
    );
    expect(JSON.stringify(queryPlan)).not.toContain("TEMP B-TREE");
    expect(prepare.mock.calls.some(([sql]) => sql.includes("SELECT body FROM turn"))).toBe(false);
  });

  it("bounds off-page answer prompts and refuses missing or oversized relation evidence", async () => {
    const f = await fixture();
    const answer = f.turn("🐍".repeat(20000), f.planRunId);
    const row = f.page().turns[0]!;
    expect(row.answeredByPrompt?.promptInfo).toEqual({
      textBytes: THREAD_HISTORY_PROMPT_BYTES,
      totalTextBytes: 80000,
      truncated: true,
    });
    expect(row.planAnswerComplete).toBe(true);
    const original = f.store.prepare("SELECT body FROM turn WHERE id=?").get(answer.id) as {
      body: Uint8Array;
    };
    f.store.transaction(() =>
      f.store
        .prepare(
          "UPDATE turn SET body=CAST(json_set(CAST(body AS TEXT),'$.padding',?) AS BLOB) WHERE id=?",
        )
        .run("x".repeat(THREAD_HISTORY_METADATA_BYTES), answer.id),
    );
    expect(() => f.page()).toThrow(
      expect.objectContaining({ code: "thread_history_metadata_too_large", status: 503 }),
    );
    f.store.transaction(() =>
      f.store.prepare("UPDATE turn SET body=? WHERE id=?").run(original.body, answer.id),
    );
    expect(f.page().turns[0]?.answeredByTurnId).toBe(answer.id);
    f.store.transaction(() =>
      f.store
        .prepare("DELETE FROM blob WHERE sha256=(SELECT prompt_sha FROM turn WHERE id=?)")
        .run(answer.id),
    );
    expect(() => f.page()).toThrow(
      expect.objectContaining({ code: "thread_history_unavailable", status: 503 }),
    );
  });
});
