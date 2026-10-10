import type { CommandBackend } from "../../command-authority.js";
import type { CommandStorePort } from "../../store-contracts.js";
import type { CommandStore } from "./fixtures/legacy/daemon/command-store.js";
import { selectCommandRecords } from "./fixtures/legacy/daemon/command-list-select.js";
import { publicCommandList } from "./fixtures/legacy/daemon/command-list-projection.js";
import { prunableCommandIds } from "./fixtures/legacy/daemon/command-retention.js";

/** Explicit injection for boundary tests whose evidence is a frozen journal.
 * This adapter is test-only; production has no enumerable command authority. */
export function legacyCommandFixture(authority: {
  current?(): CommandStore;
  all?(): CommandStore[];
  forRequest?(params: unknown): CommandStore;
  findById?(id: string): CommandStore | undefined;
}): CommandBackend {
  const stores = () => authority.all?.() ?? (authority.current ? [authority.current()] : []);
  const records = () => stores().flatMap((store) => store.records());
  const port = (store: CommandStore): CommandStorePort => ({
    accept: (input) => store.accept(input),
    find: (input) => store.find(input),
    get: (id) => store.get(id),
    update: (id, patch) => store.update(id, patch),
    prune: (ids) => store.prune(ids),
    prunedScopeRoots: () => store.prunedScopeRoots(),
    recoverDurableTerminal: (id) => store.recoverDurableTerminal(id),
    // Every mutation in the sealed writer has already fsynced before it returns.
    flushed: async () => {},
  });
  return {
    forRequest: (params) => port(authority.forRequest?.(params) ?? authority.current!()),
    findById: (id) => {
      const store = authority.findById?.(id) ?? stores().find((value) => value.get(id));
      return store && port(store);
    },
    queries: {
      getByRunId: (id) => records().find((row) => row.id === id || row.runId === id),
      select: (query) => selectCommandRecords(records(), query),
      publicList: (query) => publicCommandList(records(), query),
      active: () => records().filter((row) => row.state === "queued" || row.state === "running"),
      count: () => stores().reduce((n, store) => n + store.count, 0),
    },
    pruneHistory: (cap, retentionMs, now) => {
      const ids = prunableCommandIds(records(), cap, retentionMs, now);
      for (const store of stores()) store.prune(ids.filter((id) => store.get(id)));
      return ids;
    },
  };
}
