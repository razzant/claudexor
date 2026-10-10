import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { COMPACTED_SNAPSHOT, encodeFrame, replayFrames, ZERO_HASH } from "./frame-codec.js";

function compactedFrame(
  records: unknown[],
  encodedRecords = JSON.stringify(records),
  header: { seq?: number; logicalSpan?: number; previousFrameHash?: string } = {},
): Buffer {
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      count: records.length,
      encoding: "gzip-base64",
      data: gzipSync(Buffer.from(encodedRecords)).toString("base64"),
    }),
  );
  return encodeFrame(
    {
      partition: "global",
      epoch: "epoch-test",
      seq: header.seq ?? 1,
      previousFrameHash: header.previousFrameHash ?? ZERO_HASH,
      time: "2026-01-01T00:00:00.000Z",
      type: COMPACTED_SNAPSHOT,
      logicalSpan: header.logicalSpan ?? records.length,
    },
    payload,
  );
}

function hashOf(frame: Buffer): string {
  return frame.subarray(frame.length - 32).toString("hex");
}

const at = (seq: number, extra: Record<string, unknown> = {}) => ({
  ...extra,
  time: "2026-01-01T00:00:00.000Z",
  type: "kept",
  payload: { seq },
});

describe("compacted journal frames", () => {
  it("replays nested records with escaped delimiters and Unicode payloads", () => {
    const records = [
      {
        time: "2026-01-01T00:00:00.000Z",
        type: "probe.saved",
        payload: {
          text: 'braces { } and brackets [ ] and comma, quote " and slash \\',
          nested: [{ value: "Привет 🌍" }],
        },
      },
      {
        time: "2026-01-01T00:00:01.000Z",
        type: "probe.finished",
        payload: { ok: true },
      },
    ];

    const result = replayFrames(compactedFrame(records), "global");

    expect(result.error).toBeNull();
    expect(result.incompleteOffset).toBeNull();
    expect(result.records.map(({ time, type, payload }) => ({ time, type, payload }))).toEqual(
      records,
    );
  });

  it("rejects trailing JSON after the declared compacted array", () => {
    const records = [
      { time: "2026-01-01T00:00:00.000Z", type: "probe.saved", payload: { value: 1 } },
    ];

    const result = replayFrames(
      compactedFrame(records, `${JSON.stringify(records)} trailing`),
      "global",
    );

    expect(result.records).toEqual([]);
    expect(result.error?.reason).toContain("compacted snapshot is invalid");
  });

  it("replays a multi-megabyte logical snapshot without a whole-array parse", () => {
    const records = Array.from({ length: 40_000 }, (_, index) => ({
      time: "2026-01-01T00:00:00.000Z",
      type: "grown.history",
      payload: { index, repeated: "same-value".repeat(40) },
    }));
    const frame = compactedFrame(records);
    // Keep the physical frame small so the guard below only catches the old
    // whole-decompressed-buffer conversion, not ordinary frame decoding.
    expect(frame.length).toBeLessThan(1024 * 1024);
    const originalToString = Buffer.prototype.toString;
    Buffer.prototype.toString = function (
      encoding?: BufferEncoding,
      start?: number,
      end?: number,
    ): string {
      if (this.length > 1024 * 1024) throw new Error("whole snapshot conversion");
      return originalToString.call(this, encoding, start, end);
    };

    const result = (() => {
      try {
        return replayFrames(frame, "global");
      } finally {
        Buffer.prototype.toString = originalToString;
      }
    })();

    expect(result.error).toBeNull();
    expect(result.records).toHaveLength(records.length);
    expect(result.records.at(-1)?.payload).toEqual(records.at(-1)?.payload);
  });
});

describe("seq-preserving compacted snapshots", () => {
  it("accepts count below the logical span when every record carries its seq", () => {
    const frame = compactedFrame([at(2, { seq: 2 }), at(5, { seq: 5 })], undefined, {
      logicalSpan: 6,
    });
    const result = replayFrames(frame, "global");
    expect(result.error).toBeNull();
    expect(result.records.map((record) => record.seq)).toEqual([2, 5]);
    expect(result.records[0]?.previousFrameHash).toBe(ZERO_HASH);
    expect(result.records[1]?.previousFrameHash).toBe(hashOf(frame));
  });

  it("chains consecutive snapshot frames and an ordinary tail by logical span", () => {
    const first = compactedFrame([at(1, { seq: 1 }), at(3, { seq: 3 })], undefined, {
      seq: 1,
      logicalSpan: 4,
    });
    const second = compactedFrame([at(5, { seq: 5 })], undefined, {
      seq: 5,
      logicalSpan: 3,
      previousFrameHash: hashOf(first),
    });
    const empty = compactedFrame([], undefined, {
      seq: 8,
      logicalSpan: 2,
      previousFrameHash: hashOf(second),
    });
    const tail = encodeFrame(
      {
        partition: "global",
        epoch: "epoch-test",
        seq: 10,
        previousFrameHash: hashOf(empty),
        time: "2026-01-01T00:00:00.000Z",
        type: "ordinary",
      },
      Buffer.from("null"),
    );
    const result = replayFrames(Buffer.concat([first, second, empty, tail]), "global");
    expect(result.error).toBeNull();
    expect(result.records.map((record) => record.seq)).toEqual([1, 3, 5, 10]);
  });

  it("still decodes a legacy dense snapshot without seq fields", () => {
    const result = replayFrames(compactedFrame([at(1), at(2), at(3)]), "global");
    expect(result.error).toBeNull();
    expect(result.records.map((record) => record.seq)).toEqual([1, 2, 3]);
  });

  it.each([
    ["legacy count below span", [at(1), at(2)], { logicalSpan: 3 }, "record count mismatch"],
    [
      "count above span",
      [at(1, { seq: 1 }), at(2, { seq: 2 })],
      { logicalSpan: 1 },
      "record count mismatch",
    ],
    ["mixed seq presence", [at(1, { seq: 1 }), at(2)], { logicalSpan: 2 }, "mixed record sequence"],
    [
      "non-increasing seq",
      [at(2, { seq: 2 }), at(2, { seq: 2 })],
      { logicalSpan: 3 },
      "record sequence is invalid",
    ],
    ["seq before the header", [at(0, { seq: 0 })], { logicalSpan: 2 }, "invalid logical record"],
    [
      "seq past the span",
      [at(1, { seq: 1 }), at(9, { seq: 9 })],
      { logicalSpan: 3 },
      "record sequence is invalid",
    ],
    ["seq not an integer", [at(1, { seq: 1.5 })], { logicalSpan: 2 }, "invalid logical record"],
  ])("rejects a snapshot with %s", (_name, records, header, reason) => {
    const result = replayFrames(compactedFrame(records, undefined, header), "global");
    expect(result.records).toEqual([]);
    expect(result.error?.reason).toBe(`compacted snapshot is invalid: Error: ${reason}`);
  });
});
