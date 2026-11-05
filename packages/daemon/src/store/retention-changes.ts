import { setImmediate as yieldToAdmission } from "node:timers/promises";
import type { EngineStore } from "./store.js";

// Connection-local observation, not a durable index or a second writer. TEMP
// triggers cover every SQL owner (including import/recovery and direct SQL).
// Rollbacks may cause extra reads; they cannot lose a protection.
const columns = {
  thread: ["id", "state", "body"],
  turn: ["id", "thread_id", "body"],
  session: ["id", "thread_id", "harness_id", "body"],
  command: [
    "id",
    "kind",
    "run_id",
    "run_dir",
    "state",
    "finished_at",
    "continue_from",
    "params_sha",
  ],
  interaction: ["id", "run_id", "state"],
  deferred_message: ["id", "pid", "predecessor_job_id", "successor_job_id", "state"],
  project: ["id", "pid", "root", "status", "current_pid"],
  partition: ["id", "name", "status", "project_id"],
  blob: ["sha256", "size", "inline"],
} as const;
type Table = keyof typeof columns;
type Change = { table: Table; id: string; roots: Set<string> };
type Listener = (change: Change) => void;
const observers = new WeakMap<EngineStore, Set<Listener>>();

function observe(store: EngineStore, listener: Listener): () => void {
  let listeners = observers.get(store);
  if (!listeners) {
    const targets = new Set<Listener>();
    store.db.function("disk_retention_changed", (table, id, root) => {
      // Node 24.15 truncates TEXT at NUL; interaction keys must arrive as bytes.
      const decodedId = Buffer.from(id as Uint8Array).toString("utf8");
      for (const target of targets)
        target({
          table: table as Table,
          id: decodedId,
          roots: new Set(root === null ? [] : [Buffer.from(root as Uint8Array).toString("utf8")]),
        });
      return null;
    });
    for (const [table, fields] of Object.entries(columns)) {
      const key = fields[0];
      for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
        // New immutable bodies precede their command owner, whose INSERT is
        // observed. Only mutation/loss of an existing body needs a recheck.
        if (table === "blob" && operation === "INSERT") continue;
        const changed =
          operation === "UPDATE"
            ? `WHEN ${fields.map((field) => `OLD.${field} IS NOT NEW.${field}`).join(" OR ")}`
            : "";
        const rows =
          operation === "UPDATE" ? ["OLD", "NEW"] : [operation === "DELETE" ? "OLD" : "NEW"];
        store.exec(`CREATE TEMP TRIGGER disk_retention_${table}_${operation}
          AFTER ${operation} ON main.${table} ${changed} BEGIN
          ${rows.map((row) => `SELECT disk_retention_changed('${table}',CAST(${row}.${key} AS BLOB),${table === "project" ? `CAST(${row}.root AS BLOB)` : "NULL"});`).join("\n")}
          END`);
      }
    }
    observers.set(store, targets);
    listeners = targets;
  }
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Subscribe BEFORE the cooperative read. Drain changed row identities only;
 * quota/event traffic and unrelated metadata never restart the full inventory.
 * Project and partition changes reach the reader like every other owner row: it
 * defers the affected namespaces or, only when rows were never inventoried,
 * holds the whole pass (`hold`). A change that cannot be read holds it too. */
export function retentionChanges(store: EngineStore) {
  const pending = new Map<string, Change>();
  let closed = false;
  let held: string | null = null;
  const stop = observe(store, (change) => {
    const key = `${change.table}:${change.id}`;
    for (const root of pending.get(key)?.roots ?? []) change.roots.add(root);
    pending.set(key, change);
  });
  const readOne = (key: string, read: (change: Change) => void) => {
    const change = pending.get(key);
    if (!change) return;
    pending.delete(key);
    try {
      read(change);
    } catch (error) {
      held ??= String(error);
      throw error;
    }
  };
  return {
    /** Why the whole pass holds, once a change named a reason. */
    hold(reason: string) {
      held ??= reason;
    },
    held: () => held,
    async refresh(read: (change: Change) => void, signal?: AbortSignal) {
      // Capture a finite batch; newly arriving work is handled by the final
      // synchronous check or the next cooperative refresh.
      for (const key of [...pending.keys()]) {
        signal?.throwIfAborted();
        readOne(key, read);
        await yieldToAdmission();
      }
    },
    current(read: (change: Change) => void) {
      if (closed || held) return false;
      // Same physical read budget as a SQL inventory page. An exceptional
      // burst stays for the next cooperative pass, never a long admission lock.
      if (pending.size > 100) return false;
      for (const key of pending.keys()) readOne(key, read);
      return !held;
    },
    close() {
      closed = true;
      pending.clear();
      stop();
    },
  };
}
