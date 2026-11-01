import { join } from "node:path";
import { EngineStore } from "../store.js";
import { createPartition, currentGeneration } from "../partitions.js";
import { setGlobalGenerationInTx } from "../generations.js";
import { createSqlDaemonServices } from "../sql-daemon-services.js";
import { builtWorker } from "./resource-fixture.js";

/** Source integration fixture: the daemon store owners imported here run from
 * current source. It still needs an earlier build: the flusher runs from the
 * daemon's built `dist/store/flusher-worker.js`, used only for its flushing
 * protocol, and the workspace packages these owners import resolve to their
 * built output. `builtWorker` throws when the worker file is absent and does not
 * check its age, so rebuild the daemon after changing the worker or its protocol. */
export async function sourceSqlFixture(root: string) {
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: builtWorker("flusher-worker.js"),
  });
  if (!currentGeneration(store, "global"))
    store.transaction(() => setGlobalGenerationInTx(store, createPartition(store, "global").pid));
  const graph = createSqlDaemonServices(store, { purgeFiles: async () => [root] });
  let closed = false;
  return {
    store,
    graph,
    async close() {
      if (closed) return;
      closed = true;
      await graph.close();
      await store.close();
    },
  };
}
