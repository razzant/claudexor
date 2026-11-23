/**
 * run-deadline/1: a cancel whose SQL terminal committed but whose post-commit
 * notification failed leaves the job queued with a durable terminal. The next
 * admission must finish that cancel's cleanup - the job leaves the queue and its
 * hold goes before the queue is offered again - instead of cancelling the same
 * terminal on every pass, which never ends and keeps the job behind it queued.
 */
import { afterAll, describe, expect, it } from "vitest";
import { sqlDaemon, until } from "./test-support/run-deadline-daemon.js";
import { frozenClock, outcome, removeTemps } from "./test-support/run-deadline-faults.js";

afterAll(removeTemps, 0);

interface Observed {
  observations: { publish(changed?: ReadonlySet<string>): void };
}

describe("run-deadline/1: a cancel retry whose terminal is already durable", () => {
  it("finishes the queued cleanup once, never re-cancels the same terminal, and the job behind runs", async () => {
    const time = frozenClock();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const ran: string[] = [];
    const d = await sqlDaemon(time, () => async (params) => {
      const label = (params as { label: string }).label;
      ran.push(label);
      if (label === "blocker") await blocked;
      return { lifecycle: "succeeded" };
    });
    // The SQL rows are committed; the mutation's post-commit notification to the
    // store's observers then fails once, after COMMIT, as a write notice that throws.
    const store = d.sql.store as unknown as Observed;
    const publish = store.observations.publish.bind(store.observations);
    let armed = false;
    let failures = 0;
    store.observations.publish = (changed) => {
      if (armed) {
        armed = false;
        failures += 1;
        throw new Error("injected post-commit notification failure");
      }
      publish(changed);
    };
    try {
      const blocker = await d.client.enqueue(
        { label: "blocker" },
        { idempotencyKey: "b", clientId: "t" },
      );
      await until(
        () => Promise.resolve(ran),
        (r) => r.includes("blocker"),
      );
      const job = await d.client.enqueue(
        { label: "job", deadline: { at: time.iso(60_000) } },
        { idempotencyKey: "j", clientId: "t" },
      );
      await d.client.enqueue({ label: "behind" }, { idempotencyKey: "n", clientId: "t" });
      armed = true;
      const stop = await outcome(d.client.cancel(job.id));
      expect(stop.ok, "the Stop's notification failed after its terminal committed").toBe(false);
      expect(failures, "the notification failed once").toBe(1);
      // The terminal is durable while the job is still in the daemon's queue.
      expect(await d.client.status(job.id)).toMatchObject({ state: "cancelled" });
      release();
      await until(
        () => d.client.status(blocker.id),
        (r) => r.state === "succeeded",
      );
      await until(
        () => Promise.resolve(ran),
        (r) => r.includes("behind"),
        2_000,
      );
      expect(ran, "the cancelled job never started").toEqual(["blocker", "behind"]);
      expect(await d.client.status(job.id)).toMatchObject({ state: "cancelled" });
    } finally {
      store.observations.publish = publish;
      release();
      await d.close();
    }
  });
});
