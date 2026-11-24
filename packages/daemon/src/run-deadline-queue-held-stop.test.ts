/**
 * run-deadline/1: a manual Stop of a queued job its deadline holds, whose SQL
 * terminal commits but whose post-commit notification then fails. The terminal
 * is durable, so the job must leave the queue and give its held place back at
 * once. Left queued and held it keeps the one slot: the scheduler never offers
 * a held job, the renewal can no longer resume it (its deadline closed at that
 * commit), and the job behind waits until somebody stops the same job again.
 */
import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { DaemonServer } from "./server.js";
import { DaemonLocalClient } from "./daemon-local-client.js";
import { sqlFixture } from "./store/test-support/sql-fixture.js";
import { fileRecordIo, type RecordIo } from "./run-deadline-record.js";
import { CAPS, until } from "./test-support/run-deadline-daemon.js";
import { frozenClock, outcome, removeTemps, temp } from "./test-support/run-deadline-faults.js";

afterAll(removeTemps, 0);

interface Observed {
  observations: { publish(changed?: ReadonlySet<string>): void };
}

describe("run-deadline/1: a Stop of a held job whose post-commit notification fails", () => {
  it("frees the held place at once: the job behind starts and the stopped job never does", async () => {
    const time = frozenClock();
    const root = temp();
    const sql = await sqlFixture(root);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const ran: string[] = [];
    let releaseFlush: (() => void) | null = null;
    let flushes: number | null = null;
    const io: RecordIo = {
      ...fileRecordIo,
      // The extension's flush after its rename waits: the job is held meanwhile.
      flush: async (dir) => {
        if (flushes !== null && (flushes += 1) === 2)
          await new Promise<void>((resolve) => (releaseFlush = resolve));
        await fileRecordIo.flush(dir);
      },
    };
    const server = new DaemonServer({
      socketPath: join(root, "unused.sock"),
      token: "token",
      commands: sql.graph.commands,
      runtimeConcurrencyCaps: CAPS,
      runDeadlines: {
        dir: join(root, "deadlines"),
        clock: time.clock,
        io,
        spawnWarden: async () => ({ pid: 1 }),
        platform: "linux" as const,
        probeBoundary: async () => ({ kind: "marker" as const, reason: "test" }),
      },
      runner: async (params) => {
        const label = (params as { label: string }).label;
        ran.push(label);
        if (label === "blocker") await blocked;
        return { lifecycle: "succeeded" };
      },
    });
    await server.deadlines.startup();
    const client = new DaemonLocalClient(() => server);
    // The SQL rows are committed; the mutation's post-commit notification to the
    // store's observers then fails once, after COMMIT, as a write notice that throws.
    const store = sql.store as unknown as Observed;
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
      const blocker = await client.enqueue(
        { label: "blocker" },
        { idempotencyKey: "b", clientId: "t" },
      );
      await until(
        () => Promise.resolve(ran),
        (r) => r.includes("blocker"),
      );
      const job = await client.enqueue(
        { label: "job", deadline: { at: time.iso(10_000) } },
        { idempotencyKey: "j", clientId: "t" },
      );
      const behind = await client.enqueue(
        { label: "behind" },
        { idempotencyKey: "n", clientId: "t" },
      );
      flushes = 0;
      const renewal = outcome(
        client.runDeadline(job.id, { action: "set", at: time.iso(60_000), expectedRevision: 0 }),
      );
      await until(
        () => Promise.resolve(releaseFlush),
        (r) => typeof r === "function",
      );
      flushes = null;
      time.advance(10_500); // past the replaced deadline, inside the head start: held while the extension is pending
      release();
      await until(
        () => client.status(blocker.id),
        (r) => r.state === "succeeded",
      );
      // The held job takes the one slot: the job behind waits.
      const waiting = await until(
        () => Promise.resolve(server.admission(behind.id)),
        (a) => a !== null && a.blockers.length > 0,
      );
      expect(waiting!.blockers).toContainEqual({ kind: "global_limit", limit: 1 });
      expect(ran).toEqual(["blocker"]);
      // A manual Stop: its terminal commits, then the notification after COMMIT fails.
      armed = true;
      const stop = await outcome(client.cancel(job.id));
      expect(stop.ok, "the Stop's notification failed after its terminal committed").toBe(false);
      expect(failures, "the notification failed once").toBe(1);
      expect(await client.status(job.id)).toMatchObject({ state: "cancelled" });
      // The durable terminal frees the place at once, while the extension is still pending.
      await until(
        () => Promise.resolve(ran),
        (r) => r.includes("behind"),
        2_000,
      );
      expect(server.admission(job.id), "the stopped job left the queue").toBeNull();
      releaseFlush!();
      // The Stop came after the replaced deadline: that terminal is the expiry.
      expect(await renewal).toEqual({ ok: false, code: "run_deadline_expired" });
      await until(
        () => client.status(behind.id),
        (r) => r.state === "succeeded",
      );
      expect(ran, "the stopped job never started").toEqual(["blocker", "behind"]);
      expect(await client.status(job.id)).toMatchObject({ state: "cancelled" });
    } finally {
      store.observations.publish = publish;
      release();
      (releaseFlush as (() => void) | null)?.();
      await server.stop();
      await sql.close();
    }
  });
});
