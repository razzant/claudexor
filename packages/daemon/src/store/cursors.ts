import type { ControlJournalEvent } from "@claudexor/schema";
import { BlobFiles } from "./blob-files.js";
import { StoreError } from "./errors.js";
import { currentGeneration, type PartitionGeneration } from "./partitions.js";
import type { EngineStore } from "./store.js";

/** 409 + `resnapshot`, byte-for-byte the journal's refusal of today. */
export class JournalCursorError extends StoreError {
  readonly requiredActions = ["resnapshot"];

  constructor(detail: string) {
    super(
      "journal_cursor_invalid",
      409,
      true,
      `journal cursor is ${detail}; resnapshot is required`,
    );
    this.name = "JournalCursorError";
  }
}

/** The opaque cursor is unchanged: base64url of `{v:1, p, e, s}`. */
export function encodeJournalCursor(partition: string, epoch: string, seq: number): string {
  return Buffer.from(JSON.stringify({ v: 1, p: partition, e: epoch, s: seq })).toString(
    "base64url",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a cursor against the current generation and return the sequence to
 * resume after — the same checks in the same order as the journal package:
 * malformed, unsupported shape, stale partition/epoch, ahead of the durable
 * sequence, non-canonical encoding.
 */
export function decodeJournalCursor(
  cursor: string | null | undefined,
  partition: string,
  epoch: string,
  nextSeq: number,
): number {
  if (!cursor) return 0;
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(cursor)) throw new JournalCursorError("malformed");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new JournalCursorError("malformed");
  }
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "e,p,s,v" || value["v"] !== 1) {
    throw new JournalCursorError("unsupported");
  }
  if (value["p"] !== partition || value["e"] !== epoch) throw new JournalCursorError("stale epoch");
  const seq = value["s"];
  if (!Number.isSafeInteger(seq) || Number(seq) < 0 || Number(seq) >= nextSeq) {
    throw new JournalCursorError("ahead of the durable partition");
  }
  if (encodeJournalCursor(value["p"] as string, value["e"] as string, seq as number) !== cursor) {
    throw new JournalCursorError("not canonically encoded");
  }
  return seq as number;
}

/** Map `{v,p,e,s}` onto the current generation's `pid` and resume sequence. */
export function resolveJournalCursor(
  store: EngineStore,
  partition: string,
  cursor: string | null | undefined,
): { generation: PartitionGeneration; afterSeq: number } {
  const generation = currentGeneration(store, partition);
  if (!generation) throw new JournalCursorError("stale epoch");
  return {
    generation,
    afterSeq: decodeJournalCursor(cursor, partition, generation.epoch, generation.nextSeq),
  };
}

/** The retained events after a cursor, as the global/project SSE replays them today. */
export function readJournalEvents(
  store: EngineStore,
  partition: string,
  afterCursor?: string | null,
  blobs: Pick<BlobFiles, "read"> = new BlobFiles(store),
): ControlJournalEvent[] {
  const { generation, afterSeq } = resolveJournalCursor(store, partition, afterCursor);
  const rows = store
    .prepare(
      "SELECT seq, time, type, payload, payload_sha FROM event WHERE pid = ? AND seq > ? ORDER BY seq",
    )
    .all(generation.pid, afterSeq) as Array<{
    seq: number | bigint;
    time: string;
    type: string;
    payload: Uint8Array;
    payload_sha: string | null;
  }>;
  return rows.map((row) => ({
    schemaVersion: 1,
    cursor: encodeJournalCursor(partition, generation.epoch, Number(row.seq)),
    partition,
    type: row.type,
    observedAt: row.time,
    payload: readStoredEventPayload(row, blobs),
  }));
}

/** Both cursor/SSE and reducer reads hydrate the same logical payload. A digest
 * reference is authoritative; missing or corrupt bytes remain typed failures. */
export function readStoredEventPayload(
  row: { payload: Uint8Array; payload_sha: string | null },
  blobs: Pick<BlobFiles, "read">,
): unknown {
  const bytes = row.payload_sha === null ? Buffer.from(row.payload) : blobs.read(row.payload_sha);
  return JSON.parse(bytes.toString("utf8")) as unknown;
}
