import type { CommandBackend, EngineStore } from "@claudexor/daemon";

/** Storage is attached after import; callers keep the same command boundary.
 * Recovery admission refuses product calls before any of these dereference SQL. */
export function deferredCommands(current: () => CommandBackend): CommandBackend {
  return {
    current: () => current().current!(),
    forRequest: (params) => current().forRequest!(params),
    findById: (id) => current().findById!(id),
    pruneHistory: (...args) => current().pruneHistory(...args),
    queries: {
      getByRunId: (id) => current().queries.getByRunId(id),
      select: (query) => current().queries.select(query),
      publicList: (query) => current().queries.publicList(query),
      active: () => current().queries.active(),
      count: () => current().queries.count(),
    },
  };
}

/** Startup and retention consume metadata, never command body blobs. */
export function sqlStartupRoots(store: EngineStore) {
  const roots = (query: string) =>
    (store.prepare(query).all() as Array<{ root: string }>).map((row) => row.root);
  return {
    projects: () =>
      roots(
        "SELECT scope_root AS root FROM command WHERE live=1 AND scope_root IS NOT NULL UNION SELECT root FROM pruned_root",
      ),
    execution: () =>
      roots(`SELECT DISTINCT json_extract(CAST(summary AS TEXT),'$.params.execution.workspaceRoot') AS root
      FROM command WHERE live=1 AND json_type(CAST(summary AS TEXT),'$.params.execution.workspaceRoot')='text'`),
  };
}
export function sqlActivityRecords(store: EngineStore) {
  return (
    store
      .prepare(
        `SELECT run_id AS runId,state,finished_at AS finishedAt,scope_root AS root,thread_id AS threadId
    FROM command WHERE live=1 AND kind='product'`,
      )
      .all() as Array<{
      runId: string | null;
      state: string;
      finishedAt: string | null;
      root: string | null;
      threadId: string | null;
    }>
  ).map((row) => ({
    runId: row.runId ?? undefined,
    state: row.state,
    finishedAt: row.finishedAt ?? undefined,
    params: {
      scope: row.root ? { kind: "project", root: row.root } : { kind: "global" },
      threadId: row.threadId ?? undefined,
    },
  }));
}
