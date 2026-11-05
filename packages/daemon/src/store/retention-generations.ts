import type { EngineStore } from "./store.js";
import type { GcHold } from "@claudexor/schema";

const PARTITIONS = `SELECT q.id,q.name,q.status,q.project_id,p.root,g.status AS registry_status
  FROM partition q LEFT JOIN project p ON p.id=q.project_id LEFT JOIN partition g ON g.id=p.pid`;
type PartitionRow = {
  id: number;
  name: string;
  status: string;
  root: string | null;
  project_id: string | null;
  registry_status: string | null;
};

/** Quarantine completes recovery: those rows are evidence, never live owners.
 * Archived generations remain restorable owners. Unknown/pending states cannot
 * prove absence and hold run retirement install-wide. A partition created after
 * the snapshot (a late registration's fresh generation) is read on demand; its
 * rows were all written after the change observer subscribed, so they reach the
 * pass through its queue. */
export function retentionGenerations(store: EngineStore) {
  const rows = store.prepare(PARTITIONS).all() as PartitionRow[];
  const known = new Map(rows.map((row) => [row.id, row]));
  const read = (pid: number) =>
    store.prepare(`${PARTITIONS} WHERE q.id=?`).get(pid) as PartitionRow | undefined;
  // A completed global quarantine also retires its project descendants. Their
  // own ready/archived/pending bits are historical, not an independent owner.
  const retired = (row: PartitionRow) =>
    row.status === "quarantined" || row.registry_status === "quarantined";
  const owns = (row: PartitionRow) =>
    !retired(row) &&
    (!row.project_id || row.registry_status === "ready" || row.registry_status === "archived") &&
    (row.status === "ready" || row.status === "archived");
  const retained = (pid: number) => {
    let row = known.get(pid);
    if (!row) {
      row = read(pid);
      if (row) {
        known.set(pid, row);
        observe(row);
      }
    }
    if (!row) throw new Error(`retention owner names missing partition ${pid}`);
    return owns(row);
  };
  /** A partition row changed during the pass. A generation the pass excluded that
   * now owns rows was never inventoried: the reason holds the whole pass. Growth
   * of protection, and a fresh partition, need nothing more. */
  const changed = (pid: number): string | null => {
    const before = known.get(pid);
    const after = read(pid);
    if (!after) return null;
    observe(after);
    if (blocked) return blocked;
    if (!before) {
      known.set(pid, after);
      return null;
    }
    if (!owns(before) && owns(after))
      return `partition ${after.name} (${pid}) became a retained owner during inventory`;
    // A registry's status decides many generations at once: none is rechecked alone.
    if (
      before.status !== after.status &&
      store.prepare("SELECT 1 FROM project WHERE pid=? LIMIT 1").get(pid)
    )
      return `registry partition ${after.name} (${pid}) changed during inventory`;
    return null;
  };
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
  const observe = (row: PartitionRow) => {
    if (owns(row) || retired(row) || recoveryHolds.has(row.id)) return;
    recoveryHolds.add(row.id);
    const reason = `partition ${row.name} (${row.id}, ${row.status}) awaits journal recovery`;
    blocked ??= reason;
    errors.push(`all namespaces kept: ${reason}`);
    holds.push({ class: "recovery_pending", count: 1, example: reason });
  };
  for (const row of rows) observe(row);
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
    changed,
    refreshProject,
    registeredProjectRoots,
    archivedProjectRoots,
    protectedProjectRoots,
    errors,
    holds,
    get blocked() {
      return blocked;
    },
  };
}
