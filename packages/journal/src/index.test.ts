import {
  fsyncSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DurableJournal,
  JournalAppendUncertainError,
  JournalRecoveryRequiredError,
} from "./index.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-journal-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function openJournal(appendAndSync?: (fd: number, bytes: Buffer) => void) {
  return new DurableJournal({
    rootDir: root,
    partition: "global",
    epochFactory: () => "epoch-test",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    ...(appendAndSync ? { appendAndSync } : {}),
  });
}

function overwrite(path: string, mutate: (bytes: Buffer) => void): Buffer {
  const bytes = readFileSync(path);
  mutate(bytes);
  writeFileSync(path, bytes, { mode: 0o600 });
  return bytes;
}

describe("DurableJournal", () => {
  it("replays an fsynced hash chain and resumes an epoch-bound cursor at N+1", () => {
    const journal = openJournal();
    const first = journal.append("setup.job.saved", { id: "one" });
    const second = journal.append("setup.job.saved", { id: "two" });
    const cursor = journal.currentCursor();
    const firstCursor = journal.cursorAt(first.seq);
    expect(second.previousFrameHash).toBe(first.frameHash);
    journal.close();

    const reopened = openJournal();
    expect(reopened.records().map((record) => [record.seq, record.epoch])).toEqual([
      [1, "epoch-test"],
      [2, "epoch-test"],
    ]);
    expect(reopened.sequenceAfter(cursor)).toBe(2);
    expect(reopened.sequenceAfter(firstCursor)).toBe(1);
    expect(reopened.records(1).map((record) => record.seq)).toEqual([2]);
    expect(() => reopened.sequenceAfter(`${cursor}!!!`)).toThrow(/malformed/);
    reopened.close();

    const other = new DurableJournal({
      rootDir: join(root, "other"),
      partition: "global",
      epochFactory: () => "other-epoch",
    });
    expect(() => other.sequenceAfter(cursor)).toThrow(/stale epoch/);
    other.close();
  });

  it("discards an incomplete EOF frame, fsyncs an audit record, and stays replayable", () => {
    const crashed = openJournal((fd, frame) => {
      writeSync(fd, frame, 0, 3);
      fsyncSync(fd);
      throw new Error("simulated partial append");
    });
    expect(() => crashed.append("setup.job.saved", { id: "one" })).toThrow(
      JournalAppendUncertainError,
    );
    crashed.close();

    const recovered = openJournal();
    expect(recovered.state()).toEqual({ status: "ready", discardedTailBytes: 3 });
    expect(recovered.records().map((record) => record.type)).toEqual([
      "journal.recovery_tail_discarded",
    ]);
    recovered.close();
    const restarted = openJournal();
    expect(restarted.records()[0]?.type).toBe("journal.recovery_tail_discarded");
    restarted.close();
  });

  it.each([
    ["complete frame checksum", (bytes: Buffer) => (bytes[Math.floor(bytes.length / 2)] ^= 1)],
    ["protected length prefix", (bytes: Buffer) => bytes.writeUInt32BE(999, 14)],
  ])("fails closed on %s corruption without changing bytes", (_name, mutate) => {
    const journal = openJournal();
    journal.append("setup.job.saved", { id: "one" });
    const path = journal.path;
    journal.close();
    const corrupt = overwrite(path, mutate);
    const reopened = openJournal();
    expect(reopened.state().status).toBe("recovery_required");
    expect(() => reopened.append("setup.job.saved", { id: "two" })).toThrow(
      JournalRecoveryRequiredError,
    );
    expect(readFileSync(path)).toEqual(corrupt);
    reopened.close();
  });

  it("fails closed when a complete middle frame breaks the chain", () => {
    const journal = openJournal();
    journal.append("one", { value: 1 });
    journal.append("two", { value: 2 });
    const path = journal.path;
    journal.close();
    overwrite(path, (bytes) => {
      bytes[Math.floor(bytes.length / 4)] ^= 1;
    });
    const reopened = openJournal();
    expect(reopened.state().status).toBe("recovery_required");
    reopened.close();
  });

  it("poisons the live writer when append or fsync completion is uncertain", () => {
    const journal = openJournal(() => {
      throw new Error("simulated fsync failure");
    });
    expect(() => journal.append("one", { value: 1 })).toThrow(JournalAppendUncertainError);
    expect(journal.state()).toMatchObject({ status: "recovery_required" });
    expect(() => journal.append("two", { value: 2 })).toThrow(JournalRecoveryRequiredError);
    journal.close();
  });

  it("keeps records byte-equivalent when callers mutate input and returned objects", () => {
    const journal = openJournal();
    const payload = { nested: { value: 1 } };
    const returned = journal.append("one", payload);
    payload.nested.value = 2;
    returned.payload.nested.value = 3;
    expect(journal.records<typeof payload>()[0]?.payload.nested.value).toBe(1);
    journal.close();
  });

  it("does not acknowledge before the injected append path has fsynced", () => {
    let synced = false;
    const journal = openJournal((fd, frame) => {
      let offset = 0;
      while (offset < frame.length) offset += writeSync(fd, frame, offset, frame.length - offset);
      fsyncSync(fd);
      synced = true;
    });
    journal.append("one", { value: 1 });
    expect(synced).toBe(true);
    journal.close();
  });

  it("atomically compacts frames, invalidates the old epoch cursor, and remains appendable", () => {
    const journal = openJournal();
    for (let index = 0; index < 100; index += 1) {
      journal.append("probe.saved", { index, repeated: "same-value".repeat(20) });
    }
    const cursor = journal.currentCursor();
    const before = journal.physicalBytes();
    const compacted = journal.compact();
    expect(compacted).toMatchObject({ beforeBytes: before, records: 100 });
    expect(compacted!.afterBytes).toBeLessThan(before);
    expect(() => journal.sequenceAfter(cursor)).toThrow(/stale epoch/);
    expect(journal.append("probe.saved", { index: 100 }).seq).toBe(101);
    journal.close();

    const reopened = openJournal();
    expect(reopened.records()).toHaveLength(101);
    expect(reopened.records()[0]?.payload).toMatchObject({ index: 0 });
    expect(reopened.records()[100]?.payload).toMatchObject({ index: 100 });
    reopened.close();
  });
});
