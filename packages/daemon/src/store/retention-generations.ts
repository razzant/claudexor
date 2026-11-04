import type { SqlWriteContext } from "./mutation.js";
import type { GcHold } from "@claudexor/schema";

/** Quarantine completes recovery: those rows are evidence, never live owners.
 * Archived generations remain restorable owners. Unknown/pending states cannot
 * prove absence and hold run retirement install-wide. */
export function retentionGenerations(store: Pick<SqlWriteContext, "prepare">) {
  const query = `SELECT q.id,q.name,q.status,q.project_id,p.root,g.status AS registry_status FROM partition q
    LEFT JOIN project p ON p.id=q.project_id LEFT JOIN partition g ON g.id=p.pid`;
  const rows = store.prepare(query).all() as Array<{
    id: number;
    name: string;
    status: string;
    root: string | null;
    project_id: string | null;
    registry_status: string | null;
  }>;
  const known = new Map(rows.map((row) => [row.id, row]));
  const protectedLaneRoots = new Set<string>();
  const refreshLaneRoots = (pid?: number) => {
    for (const row of store
      .prepare(
        `SELECT p.root FROM project p
      JOIN partition g ON g.id=p.pid LEFT JOIN partition q ON q.id=p.current_pid
      WHERE (q.status='quarantined' OR g.status='quarantined')
      ${pid === undefined ? "" : "AND (p.pid=? OR p.current_pid=?)"}`,
      )
      .all(...(pid === undefined ? [] : [pid, pid])) as Array<{ root: string }>)
      protectedLaneRoots.add(row.root);
  };
  refreshLaneRoots();
  // A completed global quarantine also retires its project descendants. Their
  // own ready/archived/pending bits are historical, not an independent owner.
  const retired = (row: (typeof rows)[number]) =>
    row.status === "quarantined" || row.registry_status === "quarantined";
  const isRetained = (row: (typeof rows)[number]) =>
    !retired(row) &&
    (!row.project_id || row.registry_status === "ready" || row.registry_status === "archived") &&
    (row.status === "ready" || row.status === "archived");
  const registered = store
    .prepare(
      `SELECT p.root,p.status FROM project p
    JOIN partition g ON g.id=p.pid LEFT JOIN partition q ON q.id=p.current_pid
    WHERE p.status IN ('active','archived') AND g.status IN ('ready','archived')
      AND (q.id IS NULL OR q.status<>'quarantined')`,
    )
    .all() as Array<{ root: string; status: string }>;
  const registeredProjectRoots = new Set(registered.map((row) => row.root));
  const activeRoots = new Set(
    registered.filter((row) => row.status === "active").map((row) => row.root),
  );
  const archivedProjectRoots = new Set(
    registered
      .filter((row) => row.status === "archived" && !activeRoots.has(row.root))
      .map((row) => row.root),
  );
  const protectedProjectRoots = new Set<string>();
  const errors: string[] = [];
  const holds: GcHold[] = [];
  let blocked: string | undefined;
  const recoveryHolds = new Set<number>();
  const observe = (row: (typeof rows)[number]) => {
    if (isRetained(row) || retired(row) || recoveryHolds.has(row.id)) return;
    recoveryHolds.add(row.id);
    const reason = `partition ${row.name} (${row.id}, ${row.status}) awaits journal recovery`;
    // Scope roots do not bound dependencies: a continuation may name any namespace.
    blocked ??= reason;
    errors.push(`all namespaces kept: ${reason}`);
    holds.push({ class: "recovery_pending", count: 1, example: reason });
  };
  for (const row of rows) observe(row);
  const refreshPartition = (pid: number) => {
    const row = store.prepare(`${query} WHERE q.id=?`).get(pid) as
      (typeof rows)[number] | undefined;
    if (!row) throw new Error(`retention owner names missing partition ${pid}`);
    known.set(pid, row);
    refreshLaneRoots(pid);
    observe(row);
    return row;
  };
  // A cooperative inventory can see owners born after its opening snapshot.
  // The live read joins the same registry; the observer still rechecks their references.
  const retained = (pid: number) => isRetained(known.get(pid) ?? refreshPartition(pid));
  const bindingHolds = new Set<string>();
  const refreshProject = (id?: string) => {
    for (const row of store
      .prepare(
        `SELECT p.root,p.current_pid FROM project p
    JOIN partition g ON g.id=p.pid LEFT JOIN partition q ON q.id=p.current_pid
    WHERE g.status IN ('ready','archived') AND
      ((p.current_pid IS NOT NULL AND q.id IS NULL) OR
       (p.status='active' AND p.current_pid IS NULL))${id === undefined ? "" : " AND p.id=?"}`,
      )
      .all(...(id === undefined ? [] : [id])) as Array<{
      root: string;
      current_pid: number | null;
    }>) {
      const reason = row.current_pid === null ? "unbound_active_registration" : "missing_partition";
      const holdKey = `${reason}\0${row.root}`;
      if (bindingHolds.has(holdKey)) continue;
      holds.push({ class: reason, count: 1, example: row.root });
      bindingHolds.add(holdKey);
      protectedProjectRoots.add(row.root);
      errors.push(`namespace ${row.root} kept: ${reason} (${row.current_pid ?? "NULL"})`);
    }
  };
  refreshProject();
  return {
    retained,
    refreshPartition,
    refreshProject,
    registeredProjectRoots,
    archivedProjectRoots,
    protectedProjectRoots,
    protectedLaneRoots,
    errors,
    holds,
    get blocked() {
      return blocked;
    },
  };
}
