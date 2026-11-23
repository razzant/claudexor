/**
 * run-deadline/1 and the SQL store: a terminal's deadline facts (its time, a
 * claim, the deadline it ends under) are taken at the SQL commit itself —
 * before the mutation publishes its owners and observers and runs its
 * post-commit callbacks — for a run's terminal (`persistTerminal`) and for a
 * terminal an update commits (a Stop of a queued job).
 */
import { afterAll, describe, expect, it } from "vitest";
import { MutationDelta } from "./store/mutation.js";
import { sqlDaemon, terminalEvent, until } from "./test-support/run-deadline-daemon.js";
import { frozenClock, removeTemps, temp, type Clock } from "./test-support/run-deadline-faults.js";

afterAll(removeTemps, 0);

/** Once armed, the next mutation's publication takes 1.5 s of the clock first (slow observers). */
function slowPublication(time: Clock) {
  const publish = MutationDelta.prototype.publish;
  let armed = false;
  MutationDelta.prototype.publish = function (this: MutationDelta, store) {
    if (armed) {
      armed = false;
      time.advance(1_500);
    }
    return publish.call(this, store);
  };
  return {
    arm: () => void (armed = true),
    restore: () => void (MutationDelta.prototype.publish = publish),
  };
}

const finished = (state: string) => state !== "queued" && state !== "running";

describe("run-deadline/1: a terminal's facts are taken at its SQL commit", () => {
  it("a run's terminal committed before its deadline closes it, however late its publication ends", async () => {
    const time = frozenClock();
    const slow = slowPublication(time);
    const deadlineAt = time.iso(2_000);
    const runDir = temp();
    const d = await sqlDaemon(time, (sql) => async (_params, ctx) => {
      const runId = `run-${ctx.jobId}`;
      ctx.onRunStart({ runId, taskId: `task-${ctx.jobId}`, runDir });
      time.advance(1_000);
      slow.arm(); // the terminal's own mutation publishes slowly
      sql.graph.commands
        .findById(ctx.jobId)!
        .persistTerminal(ctx.jobId, terminalEvent(runId, ctx.jobId), null, () =>
          ctx.deadlineScope?.terminalCommitted(),
        );
      return { lifecycle: "succeeded" };
    });
    try {
      const job = await d.client.enqueue(
        { label: "terminal", deadline: { at: deadlineAt } },
        { idempotencyKey: "t", clientId: "t" },
      );
      await until(
        () => d.client.status(job.id),
        (r) => finished(r.state),
      );
      expect(await d.client.runDeadline(job.id, { action: "read" })).toMatchObject({
        state: "closed",
        at: deadlineAt,
      });
    } finally {
      slow.restore();
      await d.close();
    }
  });

  it("a Stop of a queued job before its deadline closes it, however late the update's publication ends", async () => {
    const time = frozenClock();
    const slow = slowPublication(time);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const d = await sqlDaemon(time, () => async (params) => {
      if ((params as { label: string }).label === "blocker") await blocked;
      return { lifecycle: "succeeded" };
    });
    try {
      const blocker = await d.client.enqueue(
        { label: "blocker" },
        { idempotencyKey: "b", clientId: "t" },
      );
      await until(
        () => d.client.status(blocker.id),
        (r) => r.state === "running",
      );
      const deadlineAt = time.iso(2_000);
      const job = await d.client.enqueue(
        { label: "queued", deadline: { at: deadlineAt } },
        { idempotencyKey: "q", clientId: "t" },
      );
      time.advance(1_000);
      slow.arm(); // the Stop's update publishes slowly
      await d.client.cancel(job.id);
      expect(await d.client.status(job.id)).toMatchObject({ state: "cancelled" });
      expect(await d.client.runDeadline(job.id, { action: "read" })).toMatchObject({
        state: "closed",
        at: deadlineAt,
      });
    } finally {
      slow.restore();
      release();
      await d.close();
    }
  });
});
