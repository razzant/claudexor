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

/** Work units of one retained-journal read, not a history limit: a replay
 * continues page by page. A page holds at most this many rows and this many
 * stored payload bytes (the inline row bytes, or a referenced body's recorded
 * size), measured before any body is read. One event above the byte budget is
 * a page by itself; no event is dropped or shortened. */
export const JOURNAL_PAGE_ROWS = 256;
export const JOURNAL_PAGE_BYTES = 1024 * 1024;

export interface JournalEventPageRequest {
  /** A delivered event cursor or an earlier page `position`; absent starts the generation. */
  after?: string | null;
  /** An earlier page's `through`; absent captures the partition's durable head now. */
  through?: string | null;
}

export interface JournalEventPage {
  events: ControlJournalEvent[];
  /** Where the next page starts: the last event's cursor, else the request position. */
  position: string;
  /** The head this walk reads through, in the same `{v,p,e,s}` encoding. */
  through: string;
  /** Retained rows remain after `position`, at or before `through`. */
  more: boolean;
}

/** Page sizing reads lengths only; query-plan tests pin both primary-key range reads. */
export const JOURNAL_PAGE_SIZE_SQL = `SELECT e.seq, coalesce(b.size, length(e.payload)) AS bytes
  FROM event e LEFT JOIN blob b ON b.sha256 = e.payload_sha
  WHERE e.pid = ? AND e.seq > ? AND e.seq <= ? ORDER BY e.seq LIMIT ?`;
export const JOURNAL_PAGE_READ_SQL =
  "SELECT seq, time, type, payload, payload_sha FROM event WHERE pid = ? AND seq > ? AND seq <= ? ORDER BY seq";

/**
 * One bounded keyset page of the current generation's retained events, as the
 * global/project SSE replays them. Both positions are cursors checked against
 * the generation serving now, so a replaced or retired generation is refused
 * (409 `resnapshot`) instead of continuing in another epoch. Sizes are chosen
 * first; only the selected rows are read and hydrated, in the same synchronous
 * turn on the owner connection.
 */
export function readJournalEventPage(
  store: EngineStore,
  partition: string,
  request: JournalEventPageRequest = {},
  blobs: Pick<BlobFiles, "read"> = new BlobFiles(store),
): JournalEventPage {
  const { generation, afterSeq } = resolveJournalCursor(store, partition, request.after);
  const throughSeq = request.through
    ? decodeJournalCursor(request.through, partition, generation.epoch, generation.nextSeq)
    : generation.nextSeq - 1;
  const sizes = store
    .prepare(JOURNAL_PAGE_SIZE_SQL)
    .all(generation.pid, afterSeq, throughSeq, JOURNAL_PAGE_ROWS + 1) as Array<{
    seq: number | bigint;
    bytes: number | bigint;
  }>;
  let count = 0;
  let bytes = 0;
  for (const row of sizes) {
    if (count === JOURNAL_PAGE_ROWS) break;
    if (count > 0 && bytes + Number(row.bytes) > JOURNAL_PAGE_BYTES) break;
    count += 1;
    bytes += Number(row.bytes);
  }
  const lastSeq = count === 0 ? afterSeq : Number(sizes[count - 1]!.seq);
  const rows = (
    count === 0 ? [] : store.prepare(JOURNAL_PAGE_READ_SQL).all(generation.pid, afterSeq, lastSeq)
  ) as Array<{
    seq: number | bigint;
    time: string;
    type: string;
    payload: Uint8Array;
    payload_sha: string | null;
  }>;
  return {
    events: rows.map((row) => ({
      schemaVersion: 1,
      cursor: encodeJournalCursor(partition, generation.epoch, Number(row.seq)),
      partition,
      type: row.type,
      observedAt: row.time,
      payload: readStoredEventPayload(row, blobs),
    })),
    position: encodeJournalCursor(partition, generation.epoch, lastSeq),
    through: encodeJournalCursor(partition, generation.epoch, throughSeq),
    more: count < sizes.length,
  };
}

/** The complete retained suffix after a cursor, collected through the same
 * pages, for in-process readers that need the whole history (store
 * equivalence, tests). Network replay streams page by page instead. */
export function readJournalEvents(
  store: EngineStore,
  partition: string,
  afterCursor?: string | null,
  blobs: Pick<BlobFiles, "read"> = new BlobFiles(store),
): ControlJournalEvent[] {
  let page = readJournalEventPage(store, partition, { after: afterCursor }, blobs);
  const events = [...page.events];
  while (page.more) {
    page = readJournalEventPage(
      store,
      partition,
      { after: page.position, through: page.through },
      blobs,
    );
    events.push(...page.events);
  }
  return events;
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
