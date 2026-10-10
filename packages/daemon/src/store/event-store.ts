import type { EventLedger, StoreEvent } from "../store-contracts.js";
import { BlobFiles, INLINE_BODY_MAX_BYTES, type BodyRef } from "./blob-files.js";
import { encodeJournalCursor, readStoredEventPayload } from "./cursors.js";
import { runMutation, type MutationContext } from "./mutation.js";
import type { PartitionGeneration } from "./partitions.js";
import { appendEvent, deleteEventKeysInTx, type AppendedEvent } from "./retention.js";
import type { EngineStore } from "./store.js";

export interface PreparedEvent<T = unknown> {
  type: string;
  time: string;
  payload: T;
  encodedPayload: Buffer;
  body: BodyRef | null;
}

/** Prepare the immutable JSON body before entering a transaction. Large bodies
 * use the existing BlobFiles writer; rollback may leave an unowned file for
 * its existing sweep, never a committed row or an advanced owner generation. */
export function prepareEvent<T>(
  blobs: BlobFiles,
  input: { type: string; time: string; payload: T },
): PreparedEvent<T> {
  const bytes = Buffer.from(JSON.stringify(input.payload ?? null));
  return {
    type: input.type,
    time: input.time,
    payload: JSON.parse(bytes.toString("utf8")) as T,
    encodedPayload: bytes,
    body: bytes.byteLength > INLINE_BODY_MAX_BYTES ? blobs.prepareBody(bytes) : null,
  };
}

/** Composes with the decision's other row writers in one mutation. The fold
 * sees the logical payload, while the row holds JSON null for a referenced body. */
export function appendPreparedEventInTx(
  tx: MutationContext,
  blobs: BlobFiles,
  pid: number,
  event: PreparedEvent,
): AppendedEvent {
  const appended = appendEvent(tx, pid, {
    type: event.type,
    time: event.time,
    payload: event.payload,
    encodedPayload: event.encodedPayload,
    payloadSha: event.body?.sha256,
  });
  if (appended.stored && event.body) {
    blobs.insertRow(event.body);
    tx.changes.blobChanged(event.body.sha256);
  }
  tx.changes.blobChanged(...appended.releasedDigests);
  return appended;
}

/** Prune uses the same addressed key deletion as fold, including owner deltas. */
export function deleteEventsInTx(
  tx: MutationContext,
  pid: number,
  keys: readonly string[],
): string[] {
  const released = deleteEventKeysInTx(tx, pid, keys);
  tx.changes.blobChanged(...released);
  return released;
}

/** The narrow logical event port used by quota/setup reducers. Production
 * composition still chooses the legacy ledger until the importer switch. Run
 * event producers continue to own typed selection and journal-copy redaction. */
export class SqlEventLedger implements EventLedger {
  constructor(
    private readonly store: EngineStore,
    private readonly blobs: BlobFiles,
    readonly generation: Pick<PartitionGeneration, "pid" | "name" | "epoch">,
  ) {}

  prepare<T>(type: string, payload: T): PreparedEvent<T> {
    return prepareEvent(this.blobs, { type, payload, time: this.store.now().toISOString() });
  }

  appendInTx<T>(tx: MutationContext, prepared: PreparedEvent<T>): StoreEvent<T> {
    const result = appendPreparedEventInTx(tx, this.blobs, this.generation.pid, prepared);
    return {
      partition: this.generation.name,
      epoch: this.generation.epoch,
      seq: result.seq,
      time: prepared.time,
      type: prepared.type,
      payload: prepared.payload,
    };
  }

  append<T>(type: string, payload: T): StoreEvent<T> {
    const prepared = this.prepare(type, payload);
    return runMutation(this.store, (tx) => this.appendInTx(tx, prepared));
  }

  appendBatch(entries: readonly { type: string; payload: unknown }[]): StoreEvent[] {
    const prepared = entries.map((entry) => this.prepare(entry.type, entry.payload));
    return runMutation(this.store, (tx) => prepared.map((entry) => this.appendInTx(tx, entry)));
  }

  records<T = unknown>(afterSeq: number, types: readonly string[]): StoreEvent<T>[] {
    if (types.length === 0) return [];
    const rows = this.store
      .prepare(
        `SELECT seq, time, type, payload, payload_sha FROM event
         WHERE pid = ? AND seq > ? AND type IN (${types.map(() => "?").join(",")}) ORDER BY seq`,
      )
      .all(this.generation.pid, afterSeq, ...types) as Array<{
      seq: number | bigint;
      time: string;
      type: string;
      payload: Uint8Array;
      payload_sha: string | null;
    }>;
    return rows.map((row) => ({
      partition: this.generation.name,
      epoch: this.generation.epoch,
      seq: Number(row.seq),
      time: row.time,
      type: row.type,
      payload: readStoredEventPayload(row, this.blobs) as T,
    }));
  }

  cursorFor(record: Pick<StoreEvent, "partition" | "epoch" | "seq">): string {
    return encodeJournalCursor(record.partition, record.epoch, record.seq);
  }
}
