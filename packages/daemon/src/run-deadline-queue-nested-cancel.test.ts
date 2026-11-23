/**
 * run-deadline/1: a Stop whose durable terminal synchronously cancels another
 * queued job (the post-commit observer nests a second cancelJob) must remove
 * only its own queue slot. The nested cancel splices the queue first, so an
 * index captured before the terminal write points at a neighbour afterwards:
 * splicing it drops an innocent job from the daemon queue while its SQL row
 * stays queued, and the queue drains empty with that job never admitted.
 */
import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { DaemonServer } from "./server.js";
import { DaemonLocalClient } from "./daemon-local-client.js";
import { sqlFixture } from "./store/test-support/sql-fixture.js";
import { fileRecordIo } from "./run-deadline-record.js";
import { CAPS, until } from "./test-support/run-deadline-daemon.js";
import { frozenClock, outcome, removeTemps, temp } from "./test-support/run-deadline-faults.js";

afterAll(removeTemps, 0);

describe("run-deadline/1: a Stop whose terminal nests another cancel", () => {
  it("removes only its own slot: the neighbour behind it still starts and succeeds", async () => {
    const time = frozenClock();
    const root = temp();
    const sql = await sqlFixture(root);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const ran: string[] = [];
    let aId = "";
    let bId = "";
    let server!: DaemonServer;
    server = new DaemonServer({
      socketPath: join(root, "unused.sock"),
      token: "token",
      commands: sql.graph.commands,
      runtimeConcurrencyCaps: CAPS,
      runDeadlines: {
        dir: join(root, "deadlines"),
        clock: time.clock,
        io: fileRecordIo,
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
      // The durable terminal of B synchronously cancels A, shifting the queue
      // while B's own cancelJob is still between its write and its splice.
      onCommandTerminal: (record) => {
        if (record.id === bId) server.cancelJob(aId);
      },
    });
    await server.deadlines.startup();
    const client = new DaemonLocalClient(() => server);
    try {
      const blocker = await client.enqueue(
        { label: "blocker" },
        { idempotencyKey: "b", clientId: "t" },
      );
      await until(
        () => Promise.resolve(ran),
        (r) => r.includes("blocker"),
      );
      const a = await client.enqueue({ label: "a" }, { idempotencyKey: "a", clientId: "t" });
      const b = await client.enqueue({ label: "b" }, { idempotencyKey: "s", clientId: "t" });
      const c = await client.enqueue({ label: "c" }, { idempotencyKey: "c", clientId: "t" });
      aId = a.id;
      bId = b.id;
      const stop = await outcome(client.cancel(b.id));
      expect(stop.ok, "the Stop's terminal committed").toBe(true);
      expect(await client.status(a.id)).toMatchObject({ state: "cancelled" });
      expect(await client.status(b.id)).toMatchObject({ state: "cancelled" });
      release();
      await until(
        () => client.status(blocker.id),
        (r) => r.state === "succeeded",
      );
      await until(
        () => Promise.resolve(ran),
        (r) => r.includes("c"),
        2_000,
      );
      expect(ran, "only the blocker and the innocent neighbour ran").toEqual(["blocker", "c"]);
      expect(await client.status(c.id)).toMatchObject({ state: "succeeded" });
    } finally {
      release();
      await server.stop();
      await sql.close();
    }
  });
});
