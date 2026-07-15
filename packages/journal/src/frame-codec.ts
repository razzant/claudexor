import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const MAGIC = Buffer.from([0x43, 0x4c, 0x58, 0x4a, 0x4e, 0x4c, 0x32, 0x00]);
const VERSION = 1;
const PREFIX_CORE_BYTES = MAGIC.length + 2 + 4 + 4;
const PREFIX_CHECKSUM_BYTES = 8;
const PREFIX_BYTES = PREFIX_CORE_BYTES + PREFIX_CHECKSUM_BYTES;
export const HASH_BYTES = 32;
const MAX_HEADER_BYTES = 64 * 1024;
export const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
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

export interface CompactedRecord {
  time: string;
  type: string;
  payload: unknown;
}

export interface ReplayResult {
  records: JournalRecord[];
  incompleteOffset: number | null;
  error: { offset: number; reason: string } | null;
}

export function replayFrames(bytes: Buffer, partition: string): ReplayResult {
  const records: JournalRecord[] = [];
  let offset = 0;
  let epoch: string | null = null;
  let expectedSeq = 1;
  let previous = ZERO_HASH;
  while (offset < bytes.length) {
    const remaining = bytes.length - offset;
    if (remaining < PREFIX_BYTES) return { records, incompleteOffset: offset, error: null };
    if (!bytes.subarray(offset, offset + MAGIC.length).equals(MAGIC)) {
      return corrupt(records, offset, "frame magic mismatch");
    }
    const prefix = bytes.subarray(offset, offset + PREFIX_BYTES);
    const expectedPrefix = createHash("sha256")
      .update(prefix.subarray(0, PREFIX_CORE_BYTES))
      .digest()
      .subarray(0, PREFIX_CHECKSUM_BYTES);
    if (!prefix.subarray(PREFIX_CORE_BYTES).equals(expectedPrefix)) {
      return corrupt(records, offset, "frame prefix checksum mismatch");
    }
    const version = bytes.readUInt16BE(offset + MAGIC.length);
    const headerLength = bytes.readUInt32BE(offset + MAGIC.length + 2);
    const payloadLength = bytes.readUInt32BE(offset + MAGIC.length + 6);
    if (version !== VERSION)
      return corrupt(records, offset, `unsupported frame version ${version}`);
    if (
      headerLength === 0 ||
      headerLength > MAX_HEADER_BYTES ||
      payloadLength > MAX_PAYLOAD_BYTES
    ) {
      return corrupt(records, offset, "invalid frame lengths");
    }
    const frameLength = PREFIX_BYTES + headerLength + payloadLength + HASH_BYTES;
    if (frameLength > remaining) return { records, incompleteOffset: offset, error: null };
    const headerStart = offset + PREFIX_BYTES;
    const payloadStart = headerStart + headerLength;
    const bodyEnd = payloadStart + payloadLength;
    const body = bytes.subarray(offset, bodyEnd);
    const frameHashBytes = createHash("sha256").update(body).digest();
    if (!bytes.subarray(bodyEnd, bodyEnd + HASH_BYTES).equals(frameHashBytes)) {
      return corrupt(records, offset, "frame checksum mismatch");
    }
    let header: FrameHeader;
    let payload: unknown;
    try {
      header = JSON.parse(
        bytes.subarray(headerStart, payloadStart).toString("utf8"),
      ) as FrameHeader;
      payload = JSON.parse(bytes.subarray(payloadStart, bodyEnd).toString("utf8"));
    } catch {
      return corrupt(records, offset, "frame JSON is malformed");
    }
    const semantic = validateHeader(header, partition, epoch, expectedSeq, previous);
    if (semantic) return corrupt(records, offset, semantic);
    const frameHash = frameHashBytes.toString("hex");
    if (header.type === COMPACTED_SNAPSHOT) {
      let compacted: CompactedRecord[];
      try {
        compacted = decodeCompactedSnapshot(payload, header.logicalSpan);
      } catch (error) {
        return corrupt(records, offset, `compacted snapshot is invalid: ${String(error)}`);
      }
      compacted.forEach((record, index) =>
        records.push({
          partition,
          epoch: header.epoch,
          seq: header.seq + index,
          previousFrameHash: index === 0 ? header.previousFrameHash : frameHash,
          frameHash,
          time: record.time,
          type: record.type,
          payload: record.payload,
          byteOffset: offset,
        }),
      );
      expectedSeq += compacted.length;
    } else {
      records.push({
        partition,
        epoch: header.epoch,
        seq: header.seq,
        previousFrameHash: header.previousFrameHash,
        frameHash,
        time: header.time,
        type: header.type,
        payload,
        byteOffset: offset,
      });
      expectedSeq += 1;
    }
    epoch ??= header.epoch;
    previous = frameHash;
    offset += frameLength;
  }
  return { records, incompleteOffset: null, error: null };
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

function decodeCompactedSnapshot(
  payload: unknown,
  logicalSpan: number | undefined,
): CompactedRecord[] {
  if (!isRecord(payload) || payload.version !== 1 || payload.encoding !== "gzip-base64") {
    throw new Error("unsupported payload");
  }
  if (!Number.isSafeInteger(payload.count) || payload.count !== logicalSpan) {
    throw new Error("record count mismatch");
  }
  if (typeof payload.data !== "string") throw new Error("encoded data is missing");
  const decoded = JSON.parse(gunzipSync(Buffer.from(payload.data, "base64")).toString("utf8"));
  if (!Array.isArray(decoded) || decoded.length !== payload.count)
    throw new Error("invalid records");
  return decoded.map((record) => {
    if (
      !isRecord(record) ||
      typeof record.time !== "string" ||
      typeof record.type !== "string" ||
      !record.type ||
      record.type === COMPACTED_SNAPSHOT
    ) {
      throw new Error("invalid logical record");
    }
    return { time: record.time, type: record.type, payload: record.payload };
  });
}

function encodeJson(value: unknown): Buffer {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("journal value is not JSON serializable");
  return Buffer.from(encoded);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
