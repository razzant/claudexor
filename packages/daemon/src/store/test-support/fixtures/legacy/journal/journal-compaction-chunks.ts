import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setImmediate } from "node:timers/promises";
import { createGzip } from "node:zlib";
import { encodeJournalPayload } from "./append-batch.js";
import {
  COMPACTED_SNAPSHOT,
  HASH_BYTES,
  MAX_PAYLOAD_BYTES,
  SNAPSHOT_CHUNK_LOGICAL_BYTES,
  ZERO_HASH,
  encodeFrame,
  type CompactedRecord,
  type CompactedSnapshotPayload,
  type FrameHeader,
  type JournalRecord,
} from "./frame-codec.js";
import { capacityError } from "./journal-compaction.js";

// A working batch, never a history retention limit or a user setting.
export const STREAM_BATCH_BYTES = 64 * 1024;

export interface SnapshotChunk {
  frame: Buffer;
  frameHash: string;
  header: FrameHeader;
  /** Index into the retained source of this chunk's first record. */
  firstIndex: number;
  count: number;
}

/** Emit the seq-preserving chain of `journal.compacted_snapshot` frames that
 * covers logical sequence numbers `1..endSeq` and holds exactly the retained
 * records `[0, count)` in seq order. Every record keeps its original `seq`; a
 * chunk's header names the first sequence it covers and its `logicalSpan`
 * runs up to the next chunk's first retained record (or `endSeq`), so the
 * dropped numbers are accounted for without a record. Chunks are cut by
 * logical bytes so the compressed base64 envelope fits one frame; a single
 * record larger than the cut point becomes its own chunk, and only the
 * compressed-output and envelope caps can refuse it. */
export async function* snapshotChunks(input: {
  partition: string;
  epoch: string;
  time: string;
  records: readonly JournalRecord[];
  count: number;
  endSeq: number;
  signal: AbortSignal;
}): AsyncGenerator<SnapshotChunk> {
  const limit = SNAPSHOT_CHUNK_LOGICAL_BYTES;
  const cursor = { index: 0, pending: null as { json: string; bytes: number } | null };
  let coverStart = 1;
  let previousFrameHash = ZERO_HASH;
  do {
    const firstIndex = cursor.index;
    const compressed = await compressChunk(serializeChunk(input, cursor, limit), input.signal);
    const count = cursor.index - firstIndex;
    const coverEnd =
      cursor.index < input.count ? input.records[cursor.index]!.seq - 1 : input.endSeq;
    const header: FrameHeader = {
      partition: input.partition,
      epoch: input.epoch,
      seq: coverStart,
      previousFrameHash,
      time: input.time,
      type: COMPACTED_SNAPSHOT,
      logicalSpan: coverEnd - coverStart + 1,
    };
    const frame = encodeFrame(header, encodeSnapshotPayload(count, compressed));
    const frameHash = frame.subarray(frame.length - HASH_BYTES).toString("hex");
    yield { frame, frameHash, header, firstIndex, count };
    previousFrameHash = frameHash;
    coverStart = coverEnd + 1;
  } while (cursor.index < input.count);
}

function encodeSnapshotPayload(count: number, compressed: Buffer): Buffer {
  const payload: CompactedSnapshotPayload = {
    version: 1,
    count,
    encoding: "gzip-base64",
    data: compressed.toString("base64"),
  };
  const bytes = encodeJournalPayload(payload);
  if (bytes.length > MAX_PAYLOAD_BYTES) throw capacityError("envelope", MAX_PAYLOAD_BYTES);
  return bytes;
}

/** One chunk's JSON array, record by record. Stops before the record that
 * would push a non-empty chunk past `limit`, leaving it pending for the next
 * chunk; the first record of a chunk is always taken, whatever its size. */
async function* serializeChunk(
  input: { records: readonly JournalRecord[]; count: number; signal: AbortSignal },
  cursor: { index: number; pending: { json: string; bytes: number } | null },
  limit: number,
): AsyncGenerator<string> {
  let totalBytes = 2; // brackets
  let batchBytes = 0;
  let emitted = 0;
  yield "[";
  while (cursor.index < input.count) {
    input.signal.throwIfAborted();
    const next = cursor.pending ?? serializeRecord(input.records[cursor.index]!);
    const bytes = next.bytes + (emitted === 0 ? 0 : 1);
    if (emitted > 0 && totalBytes + bytes > limit) {
      cursor.pending = next;
      break;
    }
    cursor.pending = null;
    cursor.index += 1;
    totalBytes += bytes;
    if (emitted > 0) yield ",";
    yield next.json;
    emitted += 1;
    batchBytes += bytes;
    if (batchBytes >= STREAM_BATCH_BYTES) {
      await setImmediate(undefined, { signal: input.signal });
      batchBytes = 0;
    }
  }
  yield "]";
}

function serializeRecord(record: JournalRecord): { json: string; bytes: number } {
  const logical: CompactedRecord = {
    seq: record.seq,
    time: record.time,
    type: record.type,
    payload: record.payload,
  };
  const json = JSON.stringify(logical);
  return { json, bytes: Buffer.byteLength(json, "utf8") };
}

async function compressChunk(source: AsyncGenerator<string>, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let compressedBytes = 0;
  await pipeline(
    Readable.from(source, { objectMode: false, highWaterMark: STREAM_BATCH_BYTES }),
    createGzip(),
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        compressedBytes += chunk.length;
        if (compressedBytes > MAX_PAYLOAD_BYTES)
          return done(capacityError("compressed bytes", MAX_PAYLOAD_BYTES));
        chunks.push(chunk);
        done();
      },
    }),
    { signal },
  );
  return Buffer.concat(chunks, compressedBytes);
}
