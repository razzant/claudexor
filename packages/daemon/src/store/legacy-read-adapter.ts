/** Explicit legacy composition: existing scans and pruning behind addressed ports.
 * The SQL factory supplies its own CommandBackend and never imports this adapter. */
import {
  commandStoreForId,
  commandStoreForRequest,
  commandStores,
  type CommandBackend,
  type LegacyCommandAuthority,
} from "../command-authority.js";
import { selectCommandRecords } from "../command-list-select.js";
import { publicCommandList } from "../command-list-projection.js";
import { prunableCommandIds } from "../command-retention.js";

export function legacyCommandBackend(authority: LegacyCommandAuthority): CommandBackend {
  const records = () => commandStores(authority).flatMap((store) => store.records());
  return {
    forRequest: (params) => commandStoreForRequest(authority, params),
    findById: (id) => commandStoreForId(authority, id),
    queries: {
      getByRunId: (id) => records().find((record) => record.runId === id),
      select: (query) => selectCommandRecords(records(), query),
      publicList: (query) => publicCommandList(records(), query),
      active: () =>
        records().filter((record) => record.state === "queued" || record.state === "running"),
      count: () => commandStores(authority).reduce((count, store) => count + store.count, 0),
    },
    pruneHistory(cap, retentionMs, now) {
      const removed = prunableCommandIds(records(), cap, retentionMs, now);
      for (const store of commandStores(authority)) {
        store.prune(removed.filter((id) => store.get(id)));
      }
      return removed;
    },
  };
}
