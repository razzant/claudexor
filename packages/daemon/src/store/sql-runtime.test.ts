import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DurableJournal } from "./test-support/fixtures/legacy/journal/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonLocalClient } from "../daemon-local-client.js";
import { DaemonServer, type RunnerFn } from "../server.js";
import { quarantineGenerationInTx, setGlobalGenerationInTx } from "./generations.js";
import { createPartition } from "./partitions.js";
import { createSqlDaemonServices } from "./sql-daemon-services.js";
import { EngineStore } from "./store.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture(
  runner: RunnerFn = async () => ({ summary: "done", lifecycle: "succeeded" }),
  recoveryRequired = false,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sql-runtime-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = await EngineStore.open({
    daemonDir: root,
    workerEntry: resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
  });
  cleanups.push(() => store.close());
  const global = store.transaction(() => {
    const generation = createPartition(store, "global");
    setGlobalGenerationInTx(store, generation.pid);
    if (recoveryRequired)
      store
        .prepare("UPDATE partition SET status='recovery_required' WHERE id=?")
        .run(generation.pid);
    return generation;
  });
  const graph = createSqlDaemonServices(store, { purgeFiles: async () => [root] });
  cleanups.push(() => graph.close());
  const server = new DaemonServer({
    commands: graph.commands,
    runner,
    token: "fixture",
    servingMode: () => (recoveryRequired ? "recovery_only" : "normal"),
    socketPath:
      process.platform === "win32"
        ? `\\\\.\\pipe\\sql-runtime-${process.pid}-${Date.now()}`
        : join(root, "daemon.sock"),
  });
  await server.start();
  cleanups.push(() => server.stop());
  const client = new DaemonLocalClient(() => server);
  return { root, store, global, graph, server, client };
}

describe("SQL daemon composition through the existing RPC boundary", () => {
  it("keeps the storage owners available when the global projection needs recovery", async () => {
    const f = await fixture(undefined, true);
    expect(f.graph.store.facts().integrity).toBe("pending");
    expect(() => f.graph.quota).toThrow(
      expect.objectContaining({ code: "journal_recovery_required" }),
    );
    expect(await f.client.health()).toMatchObject({ servingMode: "recovery_only" });
    await expect(f.client.enqueue({ prompt: "must wait" })).rejects.toMatchObject({
      code: "daemon_recovery_only",
    });
    expect(f.store.prepare("SELECT count(*) AS n FROM command").get()).toEqual({ n: 0 });
  });
  it("runs global and project jobs, replays acceptance, and never writes a journal", async () => {
    const observed: unknown[] = [];
    const f = await fixture(async (params) => {
      observed.push(params);
      return { summary: "done", lifecycle: "succeeded" };
    });
    vi.spyOn(DurableJournal.prototype, "append").mockImplementation(() => {
      throw new Error("legacy write in SQL graph");
    });
    vi.spyOn(DurableJournal.prototype, "appendBatch").mockImplementation(() => {
      throw new Error("legacy batch in SQL graph");
    });
    const projectRoot = join(f.root, "project");
    mkdirSync(projectRoot);
    const project = f.graph.projects.register({
      root: projectRoot,
      clientId: "fixture",
      idempotencyKey: "project",
    }).project;
    const first = await f.client.enqueue(
      { prompt: "global" },
      { clientId: "fixture", idempotencyKey: "global" },
    );
    const params = { scope: { kind: "project", root: projectRoot }, prompt: "project" };
    const second = await f.client.enqueue(params, {
      clientId: "fixture",
      idempotencyKey: "project",
    });
    expect(
      await f.client.enqueue(params, { clientId: "fixture", idempotencyKey: "project" }),
    ).toMatchObject({ id: second.id, reused: true });
    await vi.waitFor(async () =>
      expect((await f.client.status(second.id)).state).toBe("succeeded"),
    );
    expect(observed).toHaveLength(2);
    const rows = f.store.prepare("SELECT id,pid FROM command ORDER BY id").all() as Array<{
      id: string;
      pid: number;
    }>;
    expect(rows.find((r) => r.id === first.id)?.pid).toBe(f.global.pid);
    expect(rows.find((r) => r.id === second.id)?.pid).toBe(
      f.graph.projects.partition(project.id)?.pid,
    );
    const read = vi.spyOn(f.graph.blobs, "read");
    expect(await f.client.list({ page: { limit: 100, cursor: null, state: null } })).toHaveLength(
      2,
    );
    expect(read).not.toHaveBeenCalled();
    expect(existsSync(join(f.root, "journal"))).toBe(false);
    expect("all" in f.graph.commands).toBe(false);
  });

  it("routes turns, deliveries and interactions by current generation without a partition-store scan", async () => {
    const f = await fixture();
    const thread = f.graph.threads.createThread({ title: "SQL", workspace: "in_place" });
    const turn = f.graph.threads.createTurn(thread.id, "full prompt", {
      idempotency: { key: "turn", client: "fixture", request: { prompt: "full prompt" } },
    });
    const delivery = f.graph.threads.beginDelivery(
      { threadId: thread.id },
      {
        key: "delivery",
        client: "fixture",
        operation: "apply",
        request: { turnId: turn.id },
      },
    );
    f.graph.threads.completeDelivery(delivery.id, { applied: true });
    expect(f.graph.commands.findById(delivery.id)?.get(delivery.id)?.state).toBe("succeeded");
    const runId = "run-interaction";
    const waiting = f.graph.interactions.register(
      {
        runId,
        taskId: "task",
        attemptId: "a01",
        harnessId: "fake",
        request: {
          interaction_id: "question",
          source_tool: "ask",
          questions: [
            { id: "q", question: "Continue?", header: null, multi_select: false, options: [] },
          ],
        },
        requestedAt: new Date().toISOString(),
        timeoutAt: null,
      },
      { threadId: thread.id },
    );
    expect(f.graph.interactions.pendingForRun(runId)).toHaveLength(1);
    f.graph.interactions.dropForRun(runId);
    await expect(waiting).resolves.toEqual({ kind: "released", reason: "run_terminal" });
    expect(f.graph.interactions.pendingForRun(runId)).toEqual([]);
    expect(f.graph.threads.turnsFor(thread.id)[0]?.prompt).toBe("full prompt");
  });

  it("hides all old generation commands on global quarantine without deleting evidence", async () => {
    const f = await fixture();
    const first = await f.client.enqueue(
      { prompt: "old" },
      { clientId: "fixture", idempotencyKey: "old" },
    );
    await vi.waitFor(async () => expect((await f.client.status(first.id)).state).toBe("succeeded"));
    f.store.transaction(() =>
      quarantineGenerationInTx(f.store, f.global.pid, {
        epoch: "next-global",
        createdAt: new Date().toISOString(),
      }),
    );
    expect(await f.client.list({ page: { limit: 100, cursor: null, state: null } })).toEqual([]);
    expect(f.graph.commands.findById(first.id)).toBeUndefined();
    expect(f.store.prepare("SELECT count(*) AS n FROM command").get()).toEqual({ n: 1 });
    const next = await f.client.enqueue(
      { prompt: "new" },
      { clientId: "fixture", idempotencyKey: "old" },
    );
    expect(next.id).not.toBe(first.id);
    await vi.waitFor(async () => expect((await f.client.status(next.id)).state).toBe("succeeded"));
  });
});
