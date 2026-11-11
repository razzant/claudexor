import type { EventLedger } from "../../../daemon/src/store-contracts.js";

/** In-memory global quota journal for registry tests: append order is replay order. */
export function memoryEventLedger(at: string): EventLedger {
  const rows: Array<{ seq: number; type: string; payload: unknown }> = [];
  const event = (type: string, payload: unknown) => {
    const row = { seq: rows.length + 1, type, payload };
    rows.push(row);
    return { ...row, partition: "global", epoch: 1, ts: at } as never;
  };
  return {
    append: (type, payload) => event(type, payload),
    appendBatch: (entries) => entries.map((entry) => event(entry.type, entry.payload)),
    records: (afterSeq, types) =>
      rows
        .filter((row) => row.seq > afterSeq && types.includes(row.type))
        .map((row) => ({ ...row, partition: "global", epoch: 1 }) as never),
    cursorFor: (record) => `global:${record.seq}`,
  };
}
