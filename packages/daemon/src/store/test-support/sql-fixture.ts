import { join } from "node:path";
import {
  EngineStore,
  createPartition,
  currentGeneration,
  setGlobalGenerationInTx,
  createSqlDaemonServices,
} from "@claudexor/daemon";
import { builtWorker } from "./resource-fixture.js";

/** Real SQL owners on an existing private test root, with exact worker cleanup. */
export async function sqlFixture(root: string, now?: () => Date) {
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: builtWorker("flusher-worker.js"),
    ...(now ? { now } : {}),
  });
  if (!currentGeneration(store, "global"))
    store.transaction(() => setGlobalGenerationInTx(store, createPartition(store, "global").pid));
  const graph = createSqlDaemonServices(store, { purgeFiles: async () => [root] });
  let closing: Promise<void> | undefined;
  return {
    store,
    graph,
    records: () =>
      (store.prepare("SELECT id FROM command ORDER BY rowid").all() as Array<{ id: string }>).map(
        ({ id }) => graph.commands.findById(id)!.get(id)!,
      ),
    /** One close: a later caller gets its outcome, not a success it never saw (#376). */
    close() {
      return (closing ??= (async () => {
        await graph.close();
        await store.close();
      })());
    },
  };
}
