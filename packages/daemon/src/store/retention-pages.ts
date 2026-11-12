import { setImmediate as yieldToAdmission } from "node:timers/promises";
import type { EngineStore } from "./store.js";

type Table = "thread" | "command" | "deferred_message";

/** Existing rows one synchronous filtered read may examine (#638). Windows
 * count rows, not rowid values, so gaps left by deleted history cost nothing. */
export const RETENTION_ROW_WINDOW = 1000;

/** How often eligibility by age is looked at again: the interval of the
 * scheduled pass, and the soonest a finished age scan repeats. */
export const RETENTION_AGE_REVISIT_MS = 60 * 60 * 1000;

/** Rowid of the last of the next `window` existing rows after `after`, or null
 * when none remain: a keyset seek, so a window never spans a rowid gap's width. */
export function occupiedWindowEnd(
  store: EngineStore,
  table: Table,
  after: number,
  window = RETENTION_ROW_WINDOW,
): number | null {
  const row = store
    .prepare(
      `SELECT max(r) AS n FROM (SELECT rowid AS r FROM ${table} NOT INDEXED
       WHERE rowid>? ORDER BY rowid LIMIT ?)`,
    )
    .get(after, window) as { n: number | bigint | null };
  return row.n === null ? null : Number(row.n);
}

/** Bound each synchronous SQLite read, without holding a cursor/transaction
 * across admission. Unfiltered pages read 100 rows. A `where` predicate is
 * evaluated in SQL within one occupied window, so rows it rejects never reach
 * the caller and no read examines more than the window. This is an I/O batch,
 * not a retention policy: both forms end once no row follows the keyset,
 * including rows appended during the pass. */
export async function* retentionPages<T>(
  store: EngineStore,
  table: Table,
  columns: string,
  signal?: AbortSignal,
  where?: string,
): AsyncGenerator<T[]> {
  const filtered = where !== undefined;
  const page = store.prepare(
    `SELECT rowid AS retention_rowid,${columns} FROM ${table} NOT INDEXED
     WHERE rowid>?1${filtered ? ` AND rowid<=?2 AND (${where}) ORDER BY rowid` : " ORDER BY rowid LIMIT 100"}`,
  );
  let after = 0;
  for (;;) {
    signal?.throwIfAborted();
    let rows: Array<T & { retention_rowid: number }>;
    if (filtered) {
      const end = occupiedWindowEnd(store, table, after);
      if (end === null) return;
      rows = page.all(after, end) as typeof rows;
      after = end;
    } else {
      rows = page.all(after) as typeof rows;
      if (!rows.length) return;
      after = rows[rows.length - 1]!.retention_rowid;
    }
    if (rows.length) yield rows;
    await yieldToAdmission();
  }
}
