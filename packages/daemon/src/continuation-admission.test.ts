import { legacyCommandFixture } from "./store/test-support/legacy-command-fixture.js";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableJournal } from "./store/test-support/fixtures/legacy/journal/index.js";
import { afterAll, describe, expect, it } from "vitest";
import { DaemonClient } from "./client.js";
import { CommandStore } from "./store/test-support/fixtures/legacy/daemon/command-store.js";
import { DaemonServer, type JobRecord } from "./server.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-continue-admission-")));
  dirs.push(dir);
  return dir;
}

function openCommands(dir: string) {
  const journal = new DurableJournal({ rootDir: join(dir, "journal"), partition: "global" });
  const store = new CommandStore(journal);
  store.recoverAfterStartup();
  return { journal, store, slot: { current: () => store } };
}

/** A terminal predecessor run accepted and settled by an earlier daemon life. */
function seedPredecessor(store: CommandStore, state = "failed"): void {
  store.accept({
    id: "job-p",
    params: { prompt: "build it", mode: "agent" },
    idempotencyKey: "pred",
    clientId: "test",
  });
  store.update("job-p", {
    state: state as JobRecord["state"],
    runId: "run-p",
    taskId: "task-p",
    runDir: "/tmp/run-p",
  });
}

async function terminal(client: DaemonClient, id: string): Promise<JobRecord> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const record = (await client.status(id)) as JobRecord;
    if (record.state !== "queued" && record.state !== "running") return record;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`job ${id} did not settle`);
}

describe("continueFrom admission in the daemon enqueue RPC", () => {
  it("accepts exactly one of two concurrent successors and keeps the claim across a restart", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "daemon.sock");
    const first = openCommands(dir);
    seedPredecessor(first.store);
    // The successor runs (binds a run) and then fails: a claimed successor
    // that fails stays the head of the chain.
    const runner = async (_params: unknown, ctx: { onRunStart: (info: never) => void }) => {
      ctx.onRunStart({ runId: "run-s", taskId: "task-s", runDir: "/tmp/run-s" } as never);
      return { lifecycle: "failed" };
    };
    const server = new DaemonServer({
      socketPath,
      token: "token",
      commands: legacyCommandFixture(first.slot),
      runner,
    });
    await server.start();
    const request = { prompt: "", mode: "agent", continueFrom: "run-p" };
    let winner: string;
    try {
      const client = new DaemonClient(socketPath, "token");
      const settled = await Promise.allSettled([
        client.enqueue(request, { idempotencyKey: "succ-a", clientId: "test" }),
        client.enqueue(request, { idempotencyKey: "succ-b", clientId: "test" }),
      ]);
      const accepted = settled.filter((r) => r.status === "fulfilled");
      const refused = settled.filter((r) => r.status === "rejected");
      expect(accepted).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
        code: "continuation_superseded",
        status: 409,
        retryable: false,
      });
      winner = (accepted[0] as PromiseFulfilledResult<{ id: string }>).value.id;
      expect(await terminal(client, winner)).toMatchObject({ state: "failed", runId: "run-s" });
      // The exact replay of the accepted successor returns its handle.
      const firstWon = settled[0]!.status === "fulfilled";
      const replay = await client.enqueue(request, {
        idempotencyKey: firstWon ? "succ-a" : "succ-b",
        clientId: "test",
      });
      expect(replay).toMatchObject({ id: winner, reused: true });
    } finally {
      await server.stop();
      first.journal.close();
    }

    // A new daemon life replays the accepted successor from the journal: the
    // claim is durable, and the predecessor stays superseded.
    const second = openCommands(dir);
    const restarted = new DaemonServer({
      socketPath,
      token: "token",
      commands: legacyCommandFixture(second.slot),
      runner: async () => ({ lifecycle: "succeeded" }),
    });
    await restarted.start();
    try {
      const client = new DaemonClient(socketPath, "token");
      await expect(
        client.enqueue(request, { idempotencyKey: "succ-c", clientId: "test" }),
      ).rejects.toMatchObject({ code: "continuation_superseded", status: 409 });
      // The head itself (terminal, with a run) can be continued.
      const next = await client.enqueue(
        { ...request, continueFrom: "run-s" },
        { idempotencyKey: "succ-d", clientId: "test" },
      );
      expect(next.id).not.toBe(winner);
    } finally {
      await restarted.stop();
      second.journal.close();
    }
  });

  it("refuses a live predecessor and an unknown one typed", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "daemon.sock");
    const commands = openCommands(dir);
    seedPredecessor(commands.store, "running");
    const server = new DaemonServer({
      socketPath,
      token: "token",
      commands: legacyCommandFixture(commands.slot),
      runner: async () => ({ lifecycle: "succeeded" }),
    });
    await server.start();
    try {
      const client = new DaemonClient(socketPath, "token");
      await expect(
        client.enqueue(
          { prompt: "", continueFrom: "run-p" },
          { idempotencyKey: "live", clientId: "test" },
        ),
      ).rejects.toMatchObject({ code: "predecessor_live", status: 409 });
      await expect(
        client.enqueue(
          { prompt: "", continueFrom: "run-other-daemon" },
          { idempotencyKey: "foreign", clientId: "test" },
        ),
      ).rejects.toMatchObject({ code: "predecessor_unknown", status: 404 });
    } finally {
      await server.stop();
      commands.journal.close();
    }
  });
});
