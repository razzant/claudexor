import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonServer } from "../server.js";
import { DaemonLocalClient } from "../daemon-local-client.js";
import type { DaemonServingMode } from "../serving-admission.js";
import { EngineStore } from "./store.js";
import { createSqlDaemonServices } from "./sql-daemon-services.js";
import { createPartition } from "./partitions.js";
import { setGlobalGenerationInTx } from "./generations.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sql-admission-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = await EngineStore.open({
    daemonDir: root,
    workerEntry: resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
  });
  cleanups.push(() => store.close());
  store.transaction(() => setGlobalGenerationInTx(store, createPartition(store, "global").pid));
  const graph = createSqlDaemonServices(store, { purgeFiles: async () => [root] });
  cleanups.push(() => graph.close());
  return { root, store, graph };
}
describe("SQL recovery and the existing queue", () => {
  it("does not start a queued job after a storage fault closes admission", async () => {
    const f = await fixture();
    let mode: DaemonServingMode = "normal",
      release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = vi.fn(async () => {
      await gate;
      return { lifecycle: "succeeded" };
    });
    const server = new DaemonServer({
      commands: f.graph.commands,
      token: "fixture",
      socketPath: join(f.root, "unused.sock"),
      maxConcurrent: 1,
      servingMode: () => mode,
      runner,
    });
    cleanups.push(() => server.stop());
    const client = new DaemonLocalClient(() => server);
    await client.enqueue({ prompt: "first" });
    const queued = await client.enqueue({ prompt: "second" });
    mode = "recovery_only";
    release();
    await vi.waitFor(async () => expect(await client.health()).toMatchObject({ active: 0 }));
    expect(runner).toHaveBeenCalledTimes(1);
    expect(f.graph.commands.findById(queued.id)!.get(queued.id)!.state).toBe("queued");
    await expect(client.enqueue({ prompt: "third" })).rejects.toMatchObject({
      code: "daemon_recovery_only",
    });
  });
  it.each(["store_corrupt", "store_flush_unavailable", "runner_termination_unconfirmed"])(
    "allows physical replacement only after settled storage failures: %s",
    async (code) => {
      const f = await fixture();
      const problem = Object.assign(new Error(code), { code });
      const prune = vi.spyOn(f.graph.commands, "pruneHistory").mockImplementation(() => {
        throw problem;
      });
      const server = new DaemonServer({
        commands: f.graph.commands,
        token: "fixture",
        socketPath: join(f.root, "unused.sock"),
        runner: async () => ({ lifecycle: "succeeded" }),
      });
      const client = new DaemonLocalClient(() => server);
      await client.enqueue({ prompt: "finish before repair" });
      await vi.waitFor(async () => expect(await client.health()).toMatchObject({ active: 0 }));
      // The rejection microtask has recorded the terminal failure before stop.
      await Promise.resolve();
      if (code === "runner_termination_unconfirmed")
        await expect(server.stopForStoreRecovery()).rejects.toMatchObject({
          code: "daemon_shutdown_unconfirmed",
        });
      else await expect(server.stopForStoreRecovery()).resolves.toBeUndefined();
      prune.mockRestore();
    },
  );
});
