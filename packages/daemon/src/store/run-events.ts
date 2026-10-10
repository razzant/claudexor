import { RunEvent } from "@claudexor/schema";
import { isJournaledRunEvent, journaledRunEventCopy } from "../journaled-run-events.js";
import { requireTransaction, type SqlWriteContext } from "./mutation.js";
import type { SqlEventLedger } from "./event-store.js";

/** Import/runtime authority uses INSERT, never replacement of a first terminal. */
export function applyTerminalInTx(sql: SqlWriteContext, pid: number, event: RunEvent): void {
  requireTransaction(sql);
  sql
    .prepare("INSERT INTO run_terminal(run_id,pid,event) VALUES(?,?,?)")
    .run(event.run_id, pid, Buffer.from(JSON.stringify(event)));
}

export function storedTerminal(
  sql: Pick<SqlWriteContext, "prepare">,
  runId: string,
  pid?: number,
): RunEvent | undefined {
  const row = sql
    .prepare(
      `SELECT event FROM run_terminal WHERE run_id=?${pid === undefined ? "" : " AND pid=?"}`,
    )
    .get(runId, ...(pid === undefined ? [] : [pid])) as { event: Uint8Array } | undefined;
  return row ? RunEvent.parse(JSON.parse(Buffer.from(row.event).toString("utf8"))) : undefined;
}

/** Non-terminal durable copies use the same typed selection/redaction owner.
 * The terminal itself enters through SqlCommandStore.persistTerminal. */
export class SqlRunEventStore {
  constructor(private readonly events: SqlEventLedger) {}
  record(value: RunEvent): RunEvent {
    const event = RunEvent.parse(value);
    if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.blocked"
    )
      throw new Error("terminal events require the command terminal transaction");
    if (isJournaledRunEvent(event)) this.events.append("run.event", journaledRunEventCopy(event));
    return event;
  }
}
