import { describe, expect, it } from "vitest";
import { foldStream, keepEverything, type FoldRecord, type FoldVerdict } from "./journal-fold.js";

interface Row {
  seq: number;
  type: string;
  key?: string;
}

function run(rows: Row[], verdict: (row: FoldRecord) => FoldVerdict) {
  const stream = foldStream<Row>({ verdict });
  for (const row of rows) {
    stream.push(row, {
      seq: row.seq,
      type: row.type,
      time: "2026-01-01T00:00:00.000Z",
      payload: { key: row.key },
      byteLength: 10 + row.seq,
    });
  }
  const result = stream.finish();
  return { ...result, seqs: result.retained.map((row) => row.seq) };
}

function rows(spec: string): Row[] {
  return spec.split(" ").map((token, index) => {
    const [type, key] = token.split(":");
    return { seq: index + 1, type: type!, key };
  });
}

describe("journal fold engine", () => {
  it("keeps everything in seq order by default and with empty verdicts", () => {
    const input = rows("a b c");
    expect(run(input, () => ({})).seqs).toEqual([1, 2, 3]);
    const identity = foldStream<Row>(keepEverything);
    for (const row of input)
      identity.push(row, { ...row, time: "t", payload: null, byteLength: 1 });
    expect(identity.finish()).toEqual({ retained: input, retiredCount: 0, retiredBytes: 0 });
  });

  it("drops a record and counts its bytes", () => {
    const result = run(rows("a b c"), (row) => ({ drop: row.seq === 2 }));
    expect(result.seqs).toEqual([1, 3]);
    expect(result).toMatchObject({ retiredCount: 1, retiredBytes: 12 });
  });

  it("supersedes the earlier holder of a slot and keeps the last one", () => {
    const result = run(rows("s:x s:y s:x other s:x"), (row) => ({
      slot: row.type === "s" ? `s/${(row.payload as { key: string }).key}` : undefined,
    }));
    expect(result.seqs).toEqual([2, 4, 5]);
    expect(result).toMatchObject({ retiredCount: 2, retiredBytes: 11 + 13 });
  });

  it("registers group members without auto-superseding them", () => {
    const result = run(rows("g:x g:x g:y"), () => ({ group: "g" }));
    expect(result.seqs).toEqual([1, 2, 3]);
    expect(result.retiredCount).toBe(0);
  });

  it("retires every holder registered under slot and group names", () => {
    const result = run(rows("s:1 g:1 g:2 other retire s:2"), (row) => {
      if (row.type === "s") return { slot: "s" };
      if (row.type === "g") return { group: "g" };
      if (row.type === "retire") return { retire: ["s", "g", "absent"], drop: true };
      return {};
    });
    expect(result.seqs).toEqual([4, 6]);
    expect(result).toMatchObject({ retiredCount: 4 });
  });

  it("applies retire before registering the record that carries it", () => {
    const result = run(rows("s s s"), () => ({ retire: ["s"], slot: "s" }));
    expect(result.seqs).toEqual([3]);
    expect(result.retiredCount).toBe(2);
  });

  it("lets a dropped record still supersede a slot holder", () => {
    const result = run(rows("s tomb s"), (row) => ({
      slot: "s",
      drop: row.type === "tomb",
    }));
    expect(result.seqs).toEqual([3]);
    expect(result.retiredCount).toBe(2);
  });

  it("releases a slot whose holder was dropped through its group", () => {
    const result = run(rows("both retire s"), (row) => {
      if (row.type === "both") return { slot: "s", group: "g" };
      if (row.type === "retire") return { retire: ["g"], drop: true };
      return { slot: "s" };
    });
    expect(result.seqs).toEqual([3]);
    expect(result.retiredCount).toBe(2);
  });

  it("counts a record retired at most once even when named twice", () => {
    const result = run(rows("both retire"), (row) =>
      row.type === "both" ? { slot: "k", group: "k" } : { retire: ["k", "k"], drop: true },
    );
    expect(result.seqs).toEqual([]);
    expect(result).toMatchObject({ retiredCount: 2, retiredBytes: 11 + 12 });
  });

  it("refuses pushes after finish", () => {
    const stream = foldStream<Row>();
    stream.finish();
    expect(() =>
      stream.push(
        { seq: 1, type: "t" },
        { seq: 1, type: "t", time: "t", payload: 0, byteLength: 1 },
      ),
    ).toThrow(/finished/);
  });
});
