import { closeSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareAppendBatch } from "../test-support/fixtures/legacy/journal/append-batch.js";
import {
  COMPACTED_SNAPSHOT,
  ZERO_HASH,
  encodeFrame,
  replayFrames,
  type JournalRecord,
} from "./frame-codec.js";
import { readFrames, type FrameReadResult } from "./frame-reader.js";
import type { JournalFold } from "./journal-fold.js";

let root: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "journal-frame-reader-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ordinaryFrames(
  count: number,
  start = { nextSeq: 1, previousFrameHash: ZERO_HASH, byteOffset: 0 },
  payload: (n: number) => unknown = (n) => ({ n, text: "record ".repeat(64) }),
) {
  return prepareAppendBatch({
    partition: "global",
    epoch: "epoch-test",
    nextSeq: start.nextSeq,
    previousFrameHash: start.previousFrameHash,
    byteOffset: start.byteOffset,
    now: () => new Date("2026-01-01T00:00:00Z"),
    records: Array.from({ length: count }, (_, n) => ({
      type: `type.${n % 3}`,
      payload: payload(n),
    })),
  });
}

function snapshotFrame(
  records: Record<string, unknown>[],
  header: { seq: number; logicalSpan: number; previousFrameHash?: string },
) {
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      count: records.length,
      encoding: "gzip-base64",
      data: gzipSync(Buffer.from(JSON.stringify(records))).toString("base64"),
    }),
  );
  return encodeFrame(
    {
      partition: "global",
      epoch: "epoch-test",
      seq: header.seq,
      previousFrameHash: header.previousFrameHash ?? ZERO_HASH,
      time: "2026-01-01T00:00:00.000Z",
      type: COMPACTED_SNAPSHOT,
      logicalSpan: header.logicalSpan,
    },
    payload,
  );
}

function hashOf(frame: Buffer): string {
  return frame.subarray(frame.length - 32).toString("hex");
}

function readBytes(bytes: Buffer, options?: Parameters<typeof readFrames>[2]): FrameReadResult {
  const path = join(root, `journal-${Math.random().toString(16).slice(2)}.bin`);
  writeFileSync(path, bytes);
  const fd = openSync(path, "r");
  try {
    return readFrames(fd, "global", options);
  } finally {
    closeSync(fd);
  }
}

function equivalent(bytes: Buffer) {
  const legacy = replayFrames(bytes, "global");
  const positional = readBytes(bytes);
  expect(positional.retained).toEqual(legacy.records);
  expect(positional.incompleteOffset).toBe(legacy.incompleteOffset);
  expect(positional.error).toEqual(legacy.error);
  return { legacy, positional };
}

describe("positional frame reader", () => {
  it("matches replayFrames on a clean multi-frame journal and reports disk chain state", () => {
    const batch = ordinaryFrames(40);
    const { positional } = equivalent(batch.bytes);
    expect(positional.retained).toHaveLength(40);
    expect(positional).toMatchObject({
      epoch: "epoch-test",
      nextSeq: 41,
      previousFrameHash: batch.previousFrameHash,
      knownFileBytes: batch.bytes.length,
      retiredCount: 0,
      retiredBytes: 0,
    });
  });

  it("matches replayFrames on a torn tail (incomplete offset, no error)", () => {
    const batch = ordinaryFrames(5);
    const torn = batch.bytes.subarray(0, batch.bytes.length - 7);
    const { legacy } = equivalent(torn);
    expect(legacy.records).toHaveLength(4);
    expect(legacy.incompleteOffset).toBe(batch.records[4]!.byteOffset);
    const prefixTorn = batch.bytes.subarray(0, batch.records[1]!.byteOffset + 3);
    expect(equivalent(prefixTorn).legacy.incompleteOffset).toBe(batch.records[1]!.byteOffset);
  });

  it.each([
    ["prefix checksum", (bytes: Buffer, at: number) => bytes.writeUInt32BE(999, at + 14)],
    ["frame hash", (bytes: Buffer, at: number) => (bytes[at + 60] ^= 1)],
    ["magic", (bytes: Buffer, at: number) => (bytes[at] ^= 0xff)],
  ])("matches replayFrames on mid-file %s corruption", (_name, mutate) => {
    const batch = ordinaryFrames(6);
    const bytes = Buffer.from(batch.bytes);
    mutate(bytes, batch.records[3]!.byteOffset);
    const { legacy } = equivalent(bytes);
    expect(legacy.records).toHaveLength(3);
    expect(legacy.error?.offset).toBe(batch.records[3]!.byteOffset);
  });

  it("matches replayFrames on a broken hash chain", () => {
    const first = ordinaryFrames(2);
    const detached = ordinaryFrames(1, {
      nextSeq: 3,
      previousFrameHash: ZERO_HASH,
      byteOffset: first.bytes.length,
    });
    const { legacy } = equivalent(Buffer.concat([first.bytes, detached.bytes]));
    expect(legacy.error).toEqual({
      offset: first.bytes.length,
      reason: "frame hash-chain mismatch",
    });
  });

  it("matches replayFrames on a legacy snapshot followed by ordinary frames", () => {
    const logical = Array.from({ length: 3 }, (_, n) => ({
      time: "2026-01-01T00:00:00.000Z",
      type: "legacy",
      payload: { n },
    }));
    const snapshot = snapshotFrame(logical, { seq: 1, logicalSpan: 3 });
    const tail = ordinaryFrames(2, {
      nextSeq: 4,
      previousFrameHash: hashOf(snapshot),
      byteOffset: snapshot.length,
    });
    const { positional } = equivalent(Buffer.concat([snapshot, tail.bytes]));
    expect(positional.retained.map((record) => record.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(positional.nextSeq).toBe(6);
  });

  it("treats the limit as the end of the file", () => {
    const batch = ordinaryFrames(4);
    const limited = readBytes(batch.bytes, { limit: batch.records[2]!.byteOffset });
    expect(limited.retained).toHaveLength(2);
    expect(limited).toMatchObject({
      incompleteOffset: null,
      error: null,
      nextSeq: 3,
      knownFileBytes: batch.records[2]!.byteOffset,
      previousFrameHash: batch.records[1]!.frameHash,
    });
    const torn = readBytes(batch.bytes, { limit: batch.records[2]!.byteOffset + 5 });
    expect(torn.incompleteOffset).toBe(batch.records[2]!.byteOffset);
  });

  it("reads frames larger than the read-ahead window through an exact buffer", () => {
    const batch = ordinaryFrames(3, undefined, (n) => ({ n, blob: "x".repeat(5 * 1024 * 1024) }));
    const { positional } = equivalent(batch.bytes);
    expect(positional.retained).toHaveLength(3);
    expect((positional.retained[2]!.payload as { blob: string }).blob).toHaveLength(
      5 * 1024 * 1024,
    );
  });

  it("applies the fold while streaming and keeps disk chain state when the last frame is dropped", () => {
    const batch = ordinaryFrames(9);
    const fold: JournalFold = {
      verdict: (record) => ({
        drop: record.type === "type.2",
        slot: record.type === "type.0" ? "latest-0" : undefined,
      }),
    };
    const folded = readBytes(batch.bytes, { fold });
    // type.0 at seq 1,4,7 -> only 7 survives; type.1 at 2,5,8 stay; type.2 at 3,6,9 dropped.
    expect(folded.retained.map((record) => record.seq)).toEqual([2, 5, 7, 8]);
    expect(folded.retained.map((record) => record.type)).toEqual([
      "type.1",
      "type.1",
      "type.0",
      "type.1",
    ]);
    expect(folded).toMatchObject({
      epoch: "epoch-test",
      nextSeq: 10,
      previousFrameHash: batch.records[8]!.frameHash,
      knownFileBytes: batch.bytes.length,
      retiredCount: 5,
    });
    expect(folded.retiredBytes).toBeGreaterThan(0);
    const untouched = readBytes(batch.bytes);
    expect(untouched.previousFrameHash).toBe(folded.previousFrameHash);
    expect(untouched.nextSeq).toBe(folded.nextSeq);
  });

  it("reports a file truncated before the read as a torn tail, never a partial world", () => {
    const batch = ordinaryFrames(3);
    const path = join(root, "shrunk.bin");
    writeFileSync(path, batch.bytes);
    const fd = openSync(path, "r");
    try {
      writeFileSync(path, batch.bytes.subarray(0, batch.records[2]!.byteOffset + 10));
      const result = readFrames(fd, "global");
      expect(result.retained).toHaveLength(2);
      expect(result.incompleteOffset).toBe(batch.records[2]!.byteOffset);
      expect(result.nextSeq).toBe(3);
    } finally {
      closeSync(fd);
    }
  });

  it("returns records detached from the read buffer", () => {
    const batch = ordinaryFrames(2, undefined, (n) => ({ n, nested: { deep: [n] } }));
    const result = readBytes(batch.bytes);
    const payloads = result.retained.map((record) => JSON.stringify(record.payload));
    const again = readBytes(batch.bytes);
    expect(again.retained.map((record: JournalRecord) => JSON.stringify(record.payload))).toEqual(
      payloads,
    );
  });
});
