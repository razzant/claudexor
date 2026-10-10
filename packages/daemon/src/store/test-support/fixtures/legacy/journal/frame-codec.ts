import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const MAGIC = Buffer.from([0x43, 0x4c, 0x58, 0x4a, 0x4e, 0x4c, 0x32, 0x00]);
const VERSION = 1;
const PREFIX_CORE_BYTES = MAGIC.length + 2 + 4 + 4;
const PREFIX_CHECKSUM_BYTES = 8;
export const PREFIX_BYTES = PREFIX_CORE_BYTES + PREFIX_CHECKSUM_BYTES;
export const HASH_BYTES = 32;
const MAX_HEADER_BYTES = 64 * 1024;
export const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
// A compacted frame's physical payload is bounded, but gzip expansion is not.
// Keep replay fail-closed before an unbounded allocation while retaining
// headroom for the large single-frame snapshots earlier writers produced.
export const MAX_COMPACTED_LOGICAL_BYTES = 512 * 1024 * 1024;
// Logical bytes per compacted snapshot chunk. Worst-case deflate expansion,
// the base64 4/3 blow-up and the JSON envelope of 11.75 MiB still fit the
// 16 MiB frame payload cap, so a chunk is cut by logical size alone.
export const SNAPSHOT_CHUNK_LOGICAL_BYTES = 11.75 * 1024 * 1024;
export const ZERO_HASH = "0".repeat(64);
export const COMPACTED_SNAPSHOT = "journal.compacted_snapshot";

export interface JournalRecord<T = unknown> {
  partition: string;
  epoch: string;
  seq: number;
  previousFrameHash: string;
  frameHash: string;
  time: string;
  type: string;
  payload: T;
  byteOffset: number;
}

export interface FrameHeader {
  partition: string;
  epoch: string;
  seq: number;
  previousFrameHash: string;
  time: string;
  type: string;
  logicalSpan?: number;
}

export interface CompactedSnapshotPayload {
  version: 1;
  count: number;
  encoding: "gzip-base64";
  data: string;
}

/** A logical record inside a compacted snapshot. `seq` is present in
 * seq-preserving snapshots (a chunk may then cover more sequence numbers than
 * it holds records); its absence means the legacy dense layout. */
export interface CompactedRecord {
  seq?: number;
  time: string;
  type: string;
  payload: unknown;
}

export interface ReplayResult {
  records: JournalRecord[];
  incompleteOffset: number | null;
  error: { offset: number; reason: string } | null;
}

export type FramePrefix =
  | { status: "incomplete" }
  | { status: "corrupt"; reason: string }
  | { status: "frame"; headerLength: number; payloadLength: number; frameLength: number };

export type FrameBody =
  | { status: "corrupt"; reason: string }
  | { status: "frame"; header: FrameHeader; payload: unknown; frameHash: string };

/** Sequential validation state shared by every reader of one partition. */
export interface FrameChain {
  partition: string;
  epoch: string | null;
  expectedSeq: number;
  previous: string;
}

export type ChainedFrame =
  | { status: "corrupt"; reason: string }
  | { status: "frame"; records: JournalRecord[]; byteLengths: number[] };

/** Legacy whole-buffer replay; the positional reader runs the same three steps. */
export function replayFrames(bytes: Buffer, partition: string): ReplayResult {
  const records: JournalRecord[] = [];
  const chain = newFrameChain(partition);
  let offset = 0;
  while (offset < bytes.length) {
    const prefix = readFramePrefix(bytes.subarray(offset), bytes.length - offset);
    if (prefix.status === "incomplete") return { records, incompleteOffset: offset, error: null };
    if (prefix.status === "corrupt") return corrupt(records, offset, prefix.reason);
    const body = decodeFrameBody(
      bytes.subarray(offset, offset + prefix.frameLength),
      prefix.headerLength,
      prefix.payloadLength,
    );
    if (body.status === "corrupt") return corrupt(records, offset, body.reason);
    const chained = chainFrame(chain, body, offset, prefix.payloadLength);
    if (chained.status === "corrupt") return corrupt(records, offset, chained.reason);
    for (const record of chained.records) records.push(record);
    offset += prefix.frameLength;
  }
  return { records, incompleteOffset: null, error: null };
}

export function newFrameChain(partition: string): FrameChain {
  return { partition, epoch: null, expectedSeq: 1, previous: ZERO_HASH };
}

/** Step 1: the fixed prefix. `remaining` is the readable byte count from the
 * frame start; `view` must expose at least `min(remaining, PREFIX_BYTES)`. */
export function readFramePrefix(view: Buffer, remaining: number): FramePrefix {
  if (remaining < PREFIX_BYTES) return { status: "incomplete" };
  if (!view.subarray(0, MAGIC.length).equals(MAGIC)) {
    return { status: "corrupt", reason: "frame magic mismatch" };
  }
  const prefix = view.subarray(0, PREFIX_BYTES);
  const expectedPrefix = createHash("sha256")
    .update(prefix.subarray(0, PREFIX_CORE_BYTES))
    .digest()
    .subarray(0, PREFIX_CHECKSUM_BYTES);
  if (!prefix.subarray(PREFIX_CORE_BYTES).equals(expectedPrefix)) {
    return { status: "corrupt", reason: "frame prefix checksum mismatch" };
  }
  const version = view.readUInt16BE(MAGIC.length);
  const headerLength = view.readUInt32BE(MAGIC.length + 2);
  const payloadLength = view.readUInt32BE(MAGIC.length + 6);
  if (version !== VERSION) {
    return { status: "corrupt", reason: `unsupported frame version ${version}` };
  }
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES || payloadLength > MAX_PAYLOAD_BYTES) {
    return { status: "corrupt", reason: "invalid frame lengths" };
  }
  const frameLength = PREFIX_BYTES + headerLength + payloadLength + HASH_BYTES;
  if (frameLength > remaining) return { status: "incomplete" };
  return { status: "frame", headerLength, payloadLength, frameLength };
}

/** Step 2: hash and JSON of one complete frame (`frame` is exactly its bytes).
 * The payload handed out is the parsed object covered by the verified hash. */
export function decodeFrameBody(
  frame: Buffer,
  headerLength: number,
  payloadLength: number,
): FrameBody {
  const headerStart = PREFIX_BYTES;
  const payloadStart = headerStart + headerLength;
  const bodyEnd = payloadStart + payloadLength;
  const frameHashBytes = createHash("sha256").update(frame.subarray(0, bodyEnd)).digest();
  if (!frame.subarray(bodyEnd, bodyEnd + HASH_BYTES).equals(frameHashBytes)) {
    return { status: "corrupt", reason: "frame checksum mismatch" };
  }
  let header: FrameHeader;
  let payload: unknown;
  try {
    header = JSON.parse(frame.subarray(headerStart, payloadStart).toString("utf8")) as FrameHeader;
    payload = JSON.parse(frame.subarray(payloadStart, bodyEnd).toString("utf8"));
  } catch {
    return { status: "corrupt", reason: "frame JSON is malformed" };
  }
  return { status: "frame", header, payload, frameHash: frameHashBytes.toString("hex") };
}

/** Step 3: partition/epoch/seq/hash-chain semantics, then logical records.
 * A compacted snapshot advances the expected sequence by its logical span. */
export function chainFrame(
  chain: FrameChain,
  body: Extract<FrameBody, { status: "frame" }>,
  byteOffset: number,
  payloadLength: number,
): ChainedFrame {
  const { header, payload, frameHash } = body;
  const semantic = validateHeader(
    header,
    chain.partition,
    chain.epoch,
    chain.expectedSeq,
    chain.previous,
  );
  if (semantic) return { status: "corrupt", reason: semantic };
  const records: JournalRecord[] = [];
  const byteLengths: number[] = [];
  if (header.type === COMPACTED_SNAPSHOT) {
    let compacted: ParsedCompactedRecord[];
    try {
      compacted = decodeCompactedSnapshot(payload, header.logicalSpan, header.seq);
    } catch (error) {
      return { status: "corrupt", reason: `compacted snapshot is invalid: ${String(error)}` };
    }
    compacted.forEach((record, index) => {
      records.push({
        partition: chain.partition,
        epoch: header.epoch,
        seq: record.seq,
        previousFrameHash: index === 0 ? header.previousFrameHash : frameHash,
        frameHash,
        time: record.time,
        type: record.type,
        payload: record.payload,
        byteOffset,
      });
      byteLengths.push(record.byteLength);
    });
    chain.expectedSeq += header.logicalSpan as number;
  } else {
    records.push({
      partition: chain.partition,
      epoch: header.epoch,
      seq: header.seq,
      previousFrameHash: header.previousFrameHash,
      frameHash,
      time: header.time,
      type: header.type,
      payload,
      byteOffset,
    });
    // The `{time,type,payload}` logical form this frame would take in a snapshot.
    byteLengths.push(
      28 +
        Buffer.byteLength(JSON.stringify(header.time)) +
        Buffer.byteLength(JSON.stringify(header.type)) +
        payloadLength,
    );
    chain.expectedSeq += 1;
  }
  chain.epoch ??= header.epoch;
  chain.previous = frameHash;
  return { status: "frame", records, byteLengths };
}

export function encodeFrame(header: FrameHeader, payload: Buffer): Buffer {
  const headerBytes = encodeJson(header);
  if (headerBytes.length > MAX_HEADER_BYTES) throw new Error("journal header is too large");
  const prefix = Buffer.alloc(PREFIX_BYTES);
  MAGIC.copy(prefix);
  prefix.writeUInt16BE(VERSION, MAGIC.length);
  prefix.writeUInt32BE(headerBytes.length, MAGIC.length + 2);
  prefix.writeUInt32BE(payload.length, MAGIC.length + 6);
  createHash("sha256")
    .update(prefix.subarray(0, PREFIX_CORE_BYTES))
    .digest()
    .subarray(0, PREFIX_CHECKSUM_BYTES)
    .copy(prefix, PREFIX_CORE_BYTES);
  const body = Buffer.concat([prefix, headerBytes, payload]);
  return Buffer.concat([body, createHash("sha256").update(body).digest()]);
}

function corrupt(records: JournalRecord[], offset: number, reason: string): ReplayResult {
  return { records, incompleteOffset: null, error: { offset, reason } };
}

function validateHeader(
  header: FrameHeader,
  partition: string,
  epoch: string | null,
  seq: number,
  previous: string,
): string | null {
  if (!header || typeof header !== "object") return "frame header is not an object";
  if (header.partition !== partition) return "frame partition mismatch";
  if (typeof header.epoch !== "string" || !header.epoch) return "frame epoch is invalid";
  if (epoch !== null && header.epoch !== epoch) return "frame epoch changed";
  if (header.seq !== seq) return "frame sequence mismatch";
  if (header.previousFrameHash !== previous) return "frame hash-chain mismatch";
  if (typeof header.time !== "string" || !header.time) return "frame timestamp is invalid";
  if (typeof header.type !== "string" || !header.type) return "frame type is invalid";
  if (header.type === COMPACTED_SNAPSHOT) {
    if (!Number.isSafeInteger(header.logicalSpan) || Number(header.logicalSpan) <= 0) {
      return "compacted snapshot logical span is invalid";
    }
  } else if (header.logicalSpan !== undefined) return "ordinary frame declares a logical span";
  return null;
}

interface ParsedCompactedRecord extends CompactedRecord {
  seq: number;
  byteLength: number;
}

/** Legacy snapshots carry no `seq`: exactly `logicalSpan` records numbered from
 * the header. Seq-preserving snapshots carry one per record, strictly
 * increasing inside the covered span, so `count <= logicalSpan`. Mixing the two
 * inside one frame is corruption. */
function decodeCompactedSnapshot(
  payload: unknown,
  logicalSpan: number | undefined,
  firstSeq: number,
): ParsedCompactedRecord[] {
  if (!isRecord(payload) || payload.version !== 1 || payload.encoding !== "gzip-base64") {
    throw new Error("unsupported payload");
  }
  const span = logicalSpan as number;
  const count = payload.count;
  if (!Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > span) {
    throw new Error("record count mismatch");
  }
  if (typeof payload.data !== "string") throw new Error("encoded data is missing");
  const decoded = gunzipSync(Buffer.from(payload.data, "base64"), {
    maxOutputLength: MAX_COMPACTED_LOGICAL_BYTES,
  });
  const records = parseCompactedRecords(decoded, count as number);
  // An empty covering chunk can only come from the seq-preserving writer.
  const numbered = records.length === 0 || records[0]!.seq !== undefined;
  let previous = firstSeq - 1;
  for (const record of records) {
    if ((record.seq !== undefined) !== numbered) throw new Error("mixed record sequence");
    if (!numbered) {
      previous += 1;
      record.seq = previous;
      continue;
    }
    const seq = record.seq as number;
    if (seq <= previous || seq > firstSeq + span - 1) throw new Error("record sequence is invalid");
    previous = seq;
  }
  if (!numbered && records.length !== span) throw new Error("record count mismatch");
  return records as ParsedCompactedRecord[];
}

function parseCompactedRecords(
  bytes: Buffer,
  count: number,
): (CompactedRecord & { byteLength: number })[] {
  let cursor = skipJsonWhitespace(bytes, 0);
  if (bytes[cursor] !== 0x5b) throw new Error("invalid records");
  cursor += 1;
  const records: (CompactedRecord & { byteLength: number })[] = [];
  for (let index = 0; index < count; index += 1) {
    cursor = skipJsonWhitespace(bytes, cursor);
    const end = scanCompactedRecord(bytes, cursor);
    let value: unknown;
    try {
      // Parse one logical record at a time. Converting the complete decompressed
      // array to a JavaScript string is what overflows on large valid journals.
      value = JSON.parse(bytes.subarray(cursor, end).toString("utf8"));
    } catch {
      throw new Error("invalid records");
    }
    records.push({ ...validateCompactedRecord(value), byteLength: end - cursor });
    cursor = skipJsonWhitespace(bytes, end);
    const separator = bytes[cursor];
    if (index + 1 < count) {
      if (separator !== 0x2c) throw new Error("invalid records");
      cursor += 1;
    } else {
      if (separator !== 0x5d) throw new Error("invalid records");
      cursor += 1;
    }
  }
  if (count === 0) {
    cursor = skipJsonWhitespace(bytes, cursor);
    if (bytes[cursor] !== 0x5d) throw new Error("invalid records");
    cursor += 1;
  }
  cursor = skipJsonWhitespace(bytes, cursor);
  if (cursor !== bytes.length) throw new Error("invalid records");
  return records;
}

function validateCompactedRecord(record: unknown): CompactedRecord {
  if (
    !isRecord(record) ||
    typeof record.time !== "string" ||
    typeof record.type !== "string" ||
    !record.type ||
    record.type === COMPACTED_SNAPSHOT ||
    (record.seq !== undefined && (!Number.isSafeInteger(record.seq) || Number(record.seq) < 1))
  ) {
    throw new Error("invalid logical record");
  }
  const logical: CompactedRecord = {
    time: record.time,
    type: record.type,
    payload: record.payload,
  };
  if (record.seq !== undefined) logical.seq = record.seq as number;
  return logical;
}

function scanCompactedRecord(bytes: Buffer, start: number): number {
  if (bytes[start] !== 0x7b) throw new Error("invalid records");
  const stack: number[] = [];
  let inString = false;
  let escaped = false;
  for (let cursor = start; cursor < bytes.length; cursor += 1) {
    const value = bytes[cursor];
    if (inString) {
      if (escaped) escaped = false;
      else if (value === 0x5c) escaped = true;
      else if (value === 0x22) inString = false;
      continue;
    }
    if (value === 0x22) {
      inString = true;
      continue;
    }
    if (value === 0x7b || value === 0x5b) {
      stack.push(value);
      continue;
    }
    if (value !== 0x7d && value !== 0x5d) continue;
    const opening = stack.pop();
    if ((value === 0x7d && opening !== 0x7b) || (value === 0x5d && opening !== 0x5b)) {
      throw new Error("invalid records");
    }
    if (stack.length === 0) return cursor + 1;
  }
  throw new Error("invalid records");
}

function skipJsonWhitespace(bytes: Buffer, start: number): number {
  let cursor = start;
  while (
    cursor < bytes.length &&
    (bytes[cursor] === 0x20 ||
      bytes[cursor] === 0x09 ||
      bytes[cursor] === 0x0a ||
      bytes[cursor] === 0x0d)
  ) {
    cursor += 1;
  }
  return cursor;
}

function encodeJson(value: unknown): Buffer {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("journal value is not JSON serializable");
  return Buffer.from(encoded);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
