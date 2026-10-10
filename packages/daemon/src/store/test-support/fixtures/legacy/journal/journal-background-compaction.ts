import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { encodeJournalPayload } from "./append-batch.js";
import { HASH_BYTES, ZERO_HASH, encodeFrame, type JournalRecord } from "./frame-codec.js";
import { STREAM_BATCH_BYTES, snapshotChunks } from "./journal-compaction-chunks.js";
import {
  capacityCapOf,
  declinedCompaction,
  isCompactionCapacityError,
  logicalRecord,
  type JournalCompactionOutcome,
  type JournalCompactionResult,
} from "./journal-compaction.js";
import { foldStream, type JournalFold } from "./journal-fold.js";

const COMPACTION_FILE_PREFIX = "journal-compaction-";
const FOLD_YIELD_EVERY = STREAM_BATCH_BYTES / 128;

/** `count` is the in-memory entry count (the retained prefix length captured);
 * `nextSeq`/`previousFrameHash`/`knownFileBytes` are disk chain state. The two
 * are different arithmetic once a fold has run at replay. */
export interface CompactionBoundary {
  count: number;
  nextSeq: number;
  previousFrameHash: string;
  knownFileBytes: number;
}

/** The journal owns freshness and installation; this helper owns only its
 * temporary file and immutable logical-record references. */
export async function prepareBackgroundCompaction(input: {
  stagingDir: string;
  signal: AbortSignal;
  partition: string;
  epoch: string;
  time: string;
  entries: readonly JournalRecord[];
  prefix: CompactionBoundary;
  fold?: JournalFold;
  current(): CompactionBoundary;
  install(candidate: JournalCompactionResult, boundary: CompactionBoundary): boolean;
}): Promise<JournalCompactionOutcome> {
  let handle: FileHandle | null = null;
  let path: string | null = null;
  try {
    await setImmediate(undefined, { signal: input.signal });
    // The fold applies uniformly to the captured prefix: records retained at
    // replay and unfolded appends since are judged by the same policy.
    const folded = input.fold
      ? await foldPrefix(input.entries, input.prefix.count, input.fold, input.signal)
      : null;
    const source = folded ? folded.retained : input.entries;
    const count = folded ? folded.retained.length : input.prefix.count;
    input.signal.throwIfAborted();
    path = join(input.stagingDir, `${COMPACTION_FILE_PREFIX}${randomUUID()}.compact`);
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const candidate: JournalCompactionResult = {
      path,
      records: [],
      epoch: input.epoch,
      nextSeq: input.prefix.nextSeq,
      previousFrameHash: ZERO_HASH,
      knownFileBytes: 0,
      receipt: {
        beforeBytes: input.prefix.knownFileBytes,
        afterBytes: 0,
        records: 0,
        retainedCount: count,
        retiredCount: folded?.retiredCount ?? 0,
        retiredBytes: folded?.retiredBytes ?? 0,
      },
    };
    const chunks = snapshotChunks({
      partition: input.partition,
      epoch: input.epoch,
      time: input.time,
      records: source,
      count,
      endSeq: input.prefix.nextSeq - 1,
      signal: input.signal,
    });
    for await (const chunk of chunks) {
      await writeBytes(handle, chunk.frame, input.signal);
      for (let index = 0; index < chunk.count; index += 1) {
        const record = source[chunk.firstIndex + index]!;
        candidate.records.push({
          partition: input.partition,
          epoch: input.epoch,
          seq: record.seq,
          previousFrameHash: index === 0 ? chunk.header.previousFrameHash : chunk.frameHash,
          frameHash: chunk.frameHash,
          time: record.time,
          type: record.type,
          payload: record.payload,
          byteOffset: candidate.knownFileBytes,
        });
      }
      candidate.previousFrameHash = chunk.frameHash;
      candidate.knownFileBytes += chunk.frame.length;
    }
    if (candidate.knownFileBytes >= input.prefix.knownFileBytes) {
      return declinedCompaction("no_reclaim", {
        compressedBytes: candidate.knownFileBytes,
        cap: input.prefix.knownFileBytes,
      });
    }
    let consumed = input.prefix.count;
    for (;;) {
      input.signal.throwIfAborted();
      // appendBatch publishes its entries/counters together, after ACK. Capture
      // only complete batches, even when encoding yields partway through one.
      const boundary = input.current();
      await appendTail(handle, candidate, input.entries, consumed, boundary.count, input.signal);
      consumed = boundary.count;
      await handle.sync();
      input.signal.throwIfAborted();
      if (!sameBoundary(boundary, input.current())) continue;
      // Windows requires both the old canonical writer and stage handle closed
      // before rename. Closing can await; appends during it must be caught too.
      await handle.close();
      handle = null;
      input.signal.throwIfAborted();
      candidate.receipt = {
        ...candidate.receipt,
        beforeBytes: boundary.knownFileBytes,
        afterBytes: candidate.knownFileBytes,
        records: candidate.records.length,
      };
      if (input.install(candidate, boundary)) return candidate.receipt;
      input.signal.throwIfAborted();
      handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    }
  } catch (error) {
    if (
      input.signal.aborted &&
      (error === input.signal.reason || (error instanceof Error && error.name === "AbortError"))
    )
      return declinedCompaction("aborted");
    if (isCompactionCapacityError(error)) {
      const cap = capacityCapOf(error);
      return declinedCompaction("capacity", cap === undefined ? {} : { cap });
    }
    throw error;
  } finally {
    try {
      await handle?.close();
    } finally {
      if (path)
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
    }
  }
}

export function sameBoundary(a: CompactionBoundary, b: CompactionBoundary): boolean {
  return (
    a.count === b.count &&
    a.nextSeq === b.nextSeq &&
    a.previousFrameHash === b.previousFrameHash &&
    a.knownFileBytes === b.knownFileBytes
  );
}

async function foldPrefix(
  entries: readonly JournalRecord[],
  count: number,
  fold: JournalFold,
  signal: AbortSignal,
): Promise<{ retained: JournalRecord[]; retiredCount: number; retiredBytes: number }> {
  const sink = foldStream<JournalRecord>(fold);
  for (let index = 0; index < count; index += 1) {
    const record = entries[index]!;
    sink.push(record, {
      seq: record.seq,
      type: record.type,
      time: record.time,
      payload: record.payload,
      byteLength: Buffer.byteLength(JSON.stringify(logicalRecord(record)), "utf8"),
    });
    if ((index + 1) % FOLD_YIELD_EVERY === 0) await setImmediate(undefined, { signal });
  }
  return sink.finish();
}

async function appendTail(
  handle: FileHandle,
  candidate: JournalCompactionResult,
  entries: readonly JournalRecord[],
  from: number,
  to: number,
  signal: AbortSignal,
): Promise<void> {
  for (let index = from; index < to; index += 1) {
    signal.throwIfAborted();
    const record = entries[index]!;
    const header = {
      partition: record.partition,
      epoch: record.epoch,
      seq: record.seq,
      previousFrameHash: candidate.previousFrameHash,
      time: record.time,
      type: record.type,
    };
    const frame = encodeFrame(header, encodeJournalPayload(record.payload));
    const frameHash = frame.subarray(frame.length - HASH_BYTES).toString("hex");
    await writeBytes(handle, frame, signal);
    candidate.records.push({
      ...header,
      frameHash,
      payload: record.payload,
      byteOffset: candidate.knownFileBytes,
    });
    candidate.previousFrameHash = frameHash;
    candidate.knownFileBytes += frame.length;
    candidate.nextSeq = record.seq + 1;
  }
}

async function writeBytes(handle: FileHandle, bytes: Buffer, signal: AbortSignal): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    signal.throwIfAborted();
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    if (bytesWritten === 0) throw new Error("journal compaction write made no progress");
    offset += bytesWritten;
  }
}
