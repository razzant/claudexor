import type { EngineStore } from "./store.js";
import { retentionPages } from "./retention-pages.js";

type Row = {
  id: string;
  pid: number;
  predecessor_job_id: string;
  successor_job_id: string | null;
  state: string;
};
const COLUMNS = "id,pid,predecessor_job_id,successor_job_id,state";

/** Pending/held drafts own their predecessor evidence. Dispatched receipts own
 * both identities until command retention removes receipt and bindings together.
 * Quarantined generations have evidence, never restored execution authority. */
export async function deferredRetentionReferences(
  store: EngineStore,
  retained: (pid: number) => boolean,
  add: (id: string) => void,
  signal?: AbortSignal,
) {
  const read = (row: Row) => {
    if (!retained(row.pid) || row.state === "cleared") return;
    for (const id of [row.predecessor_job_id, row.successor_job_id]) {
      if (!id) continue;
      add(id);
      const command = store
        .prepare("SELECT run_id FROM command WHERE id=? AND pid=?")
        .get(id, row.pid) as { run_id: string | null } | undefined;
      if (command?.run_id) add(command.run_id);
    }
  };
  for await (const rows of retentionPages<Row>(store, "deferred_message", COLUMNS, signal))
    for (const row of rows) read(row);
  return (id: string) => {
    const row = store.prepare(`SELECT ${COLUMNS} FROM deferred_message WHERE id=?`).get(id) as
      Row | undefined;
    if (row) read(row); // Releasing a dependency waits for the next inventory.
  };
}
