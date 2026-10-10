import { fstatSync, readSync } from "node:fs";
import {
  PREFIX_BYTES,
  chainFrame,
  decodeFrameBody,
  newFrameChain,
  readFramePrefix,
  type JournalRecord,
} from "./frame-codec.js";
import { foldStream, type JournalFold } from "./journal-fold.js";

// Read-ahead window; a frame larger than the window gets its own exact buffer.
const WINDOW_BYTES = 4 * 1024 * 1024;

export interface FrameReadOptions {
  /** Treat the file as ending at this byte (an append intent's prefix). */
  limit?: number;
  fold?: JournalFold;
}

/** Disk chain state comes from the LAST FRAME ON DISK, never from the last
 * retained record: a fold may drop that frame, and the next append must still
 * chain to it. */
export interface FrameReadResult {
  retained: JournalRecord[];
  epoch: string | null;
  nextSeq: number;
  previousFrameHash: string;
  knownFileBytes: number;
  incompleteOffset: number | null;
  error: { offset: number; reason: string } | null;
  retiredCount: number;
  retiredBytes: number;
}

/** Positional frame-at-a-time reader over a descriptor: bounded buffers, the
 * same prefix/hash/chain/epoch/seq validation as `replayFrames`, optional fold
 * applied while streaming. Throws when the file shrinks underneath the read. */
export function readFrames(
  fd: number,
  partition: string,
  options: FrameReadOptions = {},
): FrameReadResult {
  const size = descriptorSize(fd);
  const end = options.limit === undefined ? size : Math.min(size, options.limit);
  const window = new PositionalWindow(fd, end);
  const chain = newFrameChain(partition);
  const sink = foldStream<JournalRecord>(options.fold);
  let offset = 0;
  let incompleteOffset: number | null = null;
  let error: FrameReadResult["error"] = null;
  while (offset < end) {
    const remaining = end - offset;
    const prefix = readFramePrefix(
      window.view(offset, Math.min(PREFIX_BYTES, remaining)),
      remaining,
    );
    if (prefix.status === "incomplete") {
      incompleteOffset = offset;
      break;
    }
    if (prefix.status === "corrupt") {
      error = { offset, reason: prefix.reason };
      break;
    }
    const body = decodeFrameBody(
      window.view(offset, prefix.frameLength),
      prefix.headerLength,
      prefix.payloadLength,
    );
    if (body.status === "corrupt") {
      error = { offset, reason: body.reason };
      break;
    }
    const chained = chainFrame(chain, body, offset, prefix.payloadLength);
    if (chained.status === "corrupt") {
      error = { offset, reason: chained.reason };
      break;
    }
    chained.records.forEach((record, index) =>
      sink.push(record, {
        seq: record.seq,
        type: record.type,
        time: record.time,
        payload: record.payload,
        byteLength: chained.byteLengths[index]!,
      }),
    );
    offset += prefix.frameLength;
  }
  const folded = sink.finish();
  return {
    retained: folded.retained,
    epoch: chain.epoch,
    nextSeq: chain.expectedSeq,
    previousFrameHash: chain.previous,
    knownFileBytes: offset,
    incompleteOffset,
    error,
    retiredCount: folded.retiredCount,
    retiredBytes: folded.retiredBytes,
  };
}

export function descriptorSize(fd: number): number {
  const size = Number(fstatSync(fd, { bigint: true }).size);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("journal file size is invalid");
  return size;
}

class PositionalWindow {
  private buffer = Buffer.alloc(0);
  private start = 0;
  private length = 0;

  constructor(
    private readonly fd: number,
    private readonly end: number,
  ) {}

  /** A view of `[offset, offset + length)`; valid until the next call. */
  view(offset: number, length: number): Buffer {
    if (offset >= this.start && offset + length <= this.start + this.length) {
      return this.buffer.subarray(offset - this.start, offset - this.start + length);
    }
    const wanted = Math.min(Math.max(WINDOW_BYTES, length), this.end - offset);
    if (this.buffer.length < wanted) this.buffer = Buffer.allocUnsafe(wanted);
    let filled = 0;
    while (filled < wanted) {
      const read = readSync(this.fd, this.buffer, filled, wanted - filled, offset + filled);
      if (read === 0) throw new Error("journal changed while being read");
      filled += read;
    }
    this.start = offset;
    this.length = wanted;
    return this.buffer.subarray(0, length);
  }
}
