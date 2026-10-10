import {
  HASH_BYTES,
  MAX_PAYLOAD_BYTES,
  encodeFrame,
  type FrameHeader,
  type JournalRecord,
} from "./frame-codec.js";

interface AppendBatchPlanInput {
  partition: string;
  epoch: string;
  nextSeq: number;
  previousFrameHash: string;
  byteOffset: number;
  now: () => Date;
  records: readonly { type: string; payload: unknown }[];
}

export function prepareAppendBatch(input: AppendBatchPlanInput): {
  bytes: Buffer;
  records: JournalRecord[];
  nextSeq: number;
  previousFrameHash: string;
} {
  let nextSeq = input.nextSeq;
  let previousFrameHash = input.previousFrameHash;
  let byteOffset = input.byteOffset;
  const frames: Buffer[] = [];
  const records: JournalRecord[] = [];
  for (const record of input.records) {
    const payloadBytes = encodeJournalPayload(record.payload);
    if (payloadBytes.length > MAX_PAYLOAD_BYTES) throw new Error("journal payload is too large");
    const header: FrameHeader = {
      partition: input.partition,
      epoch: input.epoch,
      seq: nextSeq,
      previousFrameHash,
      time: input.now().toISOString(),
      type: record.type,
    };
    const frame = encodeFrame(header, payloadBytes);
    const frameHash = frame.subarray(frame.length - HASH_BYTES).toString("hex");
    frames.push(frame);
    records.push({
      ...header,
      frameHash,
      payload: JSON.parse(payloadBytes.toString("utf8")) as unknown,
      byteOffset,
    });
    nextSeq += 1;
    previousFrameHash = frameHash;
    byteOffset += frame.length;
  }
  return { bytes: Buffer.concat(frames), records, nextSeq, previousFrameHash };
}

export function encodeJournalPayload(value: unknown): Buffer {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("journal value is not JSON serializable");
  return Buffer.from(encoded);
}

/** Detach a JSON value from every caller-held reference. */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
