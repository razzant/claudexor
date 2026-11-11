import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DurableJournal,
  JournalCursorError as LegacyCursorError,
} from "./test-support/fixtures/legacy/journal/index.js";
import { ControlJournalEvent } from "@claudexor/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { BlobFiles } from "./blob-files.js";
import {
  JOURNAL_PAGE_BYTES,
  JOURNAL_PAGE_READ_SQL,
  JOURNAL_PAGE_ROWS,
  JOURNAL_PAGE_SIZE_SQL,
  JournalCursorError,
  decodeJournalCursor,
  encodeJournalCursor,
  readJournalEventPage,
  readJournalEvents,
  type JournalEventPage,
} from "./cursors.js";
import { SqlEventLedger } from "./event-store.js";
import { createPartition, currentGeneration } from "./partitions.js";
import { appendEvent } from "./retention.js";
import { EngineStore } from "./store.js";
import { afterEachClosed } from "../../../cli/src/test-support/after-each-closed.js";

/** The store runs only where `node:sqlite` exists; elsewhere these cases are skipped, not failed. */
const sqliteAvailable = await import("node:sqlite").then(
  () => true,
  () => false,
);
const describeStore = sqliteAvailable ? describe : describe.skip;

function builtWorkerEntry(name: string): string {
  const entry = resolve(import.meta.dirname, "../../dist/store", name);
  if (!existsSync(entry)) throw new Error(`built worker missing at ${entry}; run pnpm build first`);
  return entry;
}

let root: string;
const stores: EngineStore[] = [];
const journals: DurableJournal[] = [];
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "cx-cursors-")));
});
afterEachClosed(async () => {
  for (const journal of journals.splice(0)) journal.close();
  for (const store of stores.splice(0)) await store.close();
  return () => {
    rmSync(root, { recursive: true, force: true });
  };
});
async function openStore(): Promise<EngineStore> {
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: builtWorkerEntry("flusher-worker.js"),
    flusherHooks: { manualTick: true },
  });
  stores.push(store);
  return store;
}
const failure = (fn: () => unknown): unknown => {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
};

describeStore("journal cursors over partition generations (SYNTHESIS_R5 §5 rules)", () => {
  it("encodes and validates byte-for-byte like the journal package", () => {
    const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "project:p" });
    journals.push(journal);
    for (let i = 0; i < 3; i += 1) journal.append("history", { i });
    const epoch = journal.currentEpoch();
    const nextSeq = journal.currentSequence() + 1;
    for (const seq of [0, 1, 2, 3]) {
      const cursor = encodeJournalCursor("project:p", epoch, seq);
      expect(cursor).toBe(journal.cursorAt(seq));
      expect(decodeJournalCursor(cursor, "project:p", epoch, nextSeq)).toBe(
        journal.sequenceAfter(cursor),
      );
    }
    expect(decodeJournalCursor(undefined, "project:p", epoch, nextSeq)).toBe(0);
    const stale = encodeJournalCursor("project:p", "other-epoch", 1);
    const ahead = encodeJournalCursor("project:p", epoch, 3 + 1);
    const foreign = encodeJournalCursor("global", epoch, 1);
    const sloppy = Buffer.from(JSON.stringify({ s: 1, v: 1, p: "project:p", e: epoch })).toString(
      "base64url",
    );
    for (const [cursor, detail] of [
      [stale, "stale epoch"],
      [foreign, "stale epoch"],
      [ahead, "ahead of the durable partition"],
      ["not base64url!", "malformed"],
      [Buffer.from("[1]").toString("base64url"), "unsupported"],
      [sloppy, "not canonically encoded"],
    ] as const) {
      const ours = failure(() =>
        decodeJournalCursor(cursor, "project:p", epoch, nextSeq),
      ) as JournalCursorError;
      const theirs = failure(() => journal.sequenceAfter(cursor)) as LegacyCursorError;
      expect(ours).toBeInstanceOf(JournalCursorError);
      expect(theirs).toBeInstanceOf(LegacyCursorError);
      expect(ours.message).toBe(theirs.message);
      expect(ours.message).toContain(detail);
      expect([ours.code, ours.status, ours.retryable, ours.requiredActions]).toEqual([
        theirs.code,
        theirs.status,
        theirs.retryable,
        theirs.requiredActions,
      ]);
    }
  });

  it("maps a cursor to the current generation's pid and replays the retained suffix", async () => {
    const store = await openStore();
    const generation = store.transaction(() => createPartition(store, "project:p"));
    store.transaction(() => {
      appendEvent(store, generation.pid, {
        type: "thread.head.updated",
        payload: { thread_id: "t", revision: 1 },
        time: "2026-10-10T00:00:01.000Z",
      });
      appendEvent(store, generation.pid, {
        type: "history",
        payload: { n: 2 },
        time: "2026-10-10T00:00:02.000Z",
      });
      appendEvent(store, generation.pid, {
        type: "thread.head.updated",
        payload: { thread_id: "t", revision: 3 },
        time: "2026-10-10T00:00:03.000Z",
      });
    });
    const all = readJournalEvents(store, "project:p");
    expect(all.map((event) => ControlJournalEvent.parse(event))).toHaveLength(2);
    expect(all.map((event) => [event.type, event.payload])).toEqual([
      ["history", { n: 2 }],
      ["thread.head.updated", { thread_id: "t", revision: 3 }],
    ]);
    expect(all[0]!.cursor).toBe(encodeJournalCursor("project:p", generation.epoch, 2));
    expect(all[0]!.observedAt).toBe("2026-10-10T00:00:02.000Z");
    // Resume after the superseded seq 1: still valid (consumed), yields the suffix.
    expect(
      readJournalEvents(store, "project:p", encodeJournalCursor("project:p", generation.epoch, 1)),
    ).toEqual(all);
    expect(readJournalEvents(store, "project:p", all[1]!.cursor)).toEqual([]);
    // A quarantine replaces the generation: the old epoch's cursor is refused with resnapshot.
    store.transaction(() => {
      store.prepare("UPDATE partition SET status = 'quarantined' WHERE id = ?").run(generation.pid);
      createPartition(store, "project:p");
    });
    const refused = failure(() =>
      readJournalEvents(store, "project:p", all[0]!.cursor),
    ) as JournalCursorError;
    expect(refused).toMatchObject({
      code: "journal_cursor_invalid",
      status: 409,
      requiredActions: ["resnapshot"],
    });
    expect(refused.message).toBe("journal cursor is stale epoch; resnapshot is required");
    expect(failure(() => readJournalEvents(store, "project:missing"))).toMatchObject({
      code: "journal_cursor_invalid",
    });
  });
});

describeStore("bounded journal pages for global/project replay (#312)", () => {
  const storedBytes = (event: ControlJournalEvent) =>
    Buffer.byteLength(JSON.stringify(event.payload));
  const walk = (store: EngineStore, blobs: BlobFiles, after?: string): JournalEventPage[] => {
    const pages = [readJournalEventPage(store, "project:p", { after }, blobs)];
    while (pages.at(-1)!.more) {
      const { position, through } = pages.at(-1)!;
      pages.push(readJournalEventPage(store, "project:p", { after: position, through }, blobs));
    }
    return pages;
  };

  it("pages by rows and stored bytes, keeps an oversized body whole, and replays every retained row", async () => {
    const store = await openStore();
    const blobs = new BlobFiles(store);
    const generation = store.transaction(() => createPartition(store, "project:p"));
    const ledger = new SqlEventLedger(store, blobs, generation);
    // One thread's pings fold to the newest, leaving sparse retained sequences.
    ledger.appendBatch(
      Array.from({ length: 600 }, (_, i) =>
        i % 3 === 0
          ? { type: "thread.head.updated", payload: { thread_id: "t", revision: i + 1 } }
          : { type: "history", payload: { i } },
      ),
    );
    ledger.appendBatch(
      Array.from({ length: 20 }, (_, i) => ({
        type: "inline",
        payload: { i, text: "x".repeat(60 * 1024) },
      })),
    );
    const oversized = { text: "y".repeat(3 * JOURNAL_PAGE_BYTES) };
    ledger.append("oversized", oversized);
    ledger.appendBatch([1, 2, 3].map((tail) => ({ type: "history", payload: { tail } })));

    const pages = walk(store, blobs);
    const replayed = pages.flatMap((page) => page.events);
    const nextSeq = currentGeneration(store, "project:p")!.nextSeq;
    const seqOf = (cursor: string) =>
      decodeJournalCursor(cursor, "project:p", generation.epoch, nextSeq);
    const retained = (
      store
        .prepare("SELECT seq FROM event WHERE pid = ? ORDER BY seq")
        .all(generation.pid) as Array<{
        seq: number;
      }>
    ).map((row) => Number(row.seq));
    expect(retained.length).toBeLessThan(nextSeq - 1);
    expect(replayed.map((event) => seqOf(event.cursor))).toEqual(retained);
    expect(replayed).toEqual(readJournalEvents(store, "project:p", undefined, blobs));
    expect(pages[0]!.events).toHaveLength(JOURNAL_PAGE_ROWS);
    for (const [index, page] of pages.entries()) {
      const bytes = page.events.reduce((sum, event) => sum + storedBytes(event), 0);
      expect(page.events.length).toBeLessThanOrEqual(JOURNAL_PAGE_ROWS);
      if (page.events.length > 1) expect(bytes).toBeLessThanOrEqual(JOURNAL_PAGE_BYTES);
      expect(page.through).toBe(pages[0]!.through);
      expect(page.position).toBe(page.events.at(-1)!.cursor);
      expect(page.more).toBe(index < pages.length - 1);
      // Greedy prefixes: a page ends only where the next row would break a bound.
      const next = pages[index + 1]?.events[0];
      if (next)
        expect(
          page.events.length === JOURNAL_PAGE_ROWS ||
            bytes + storedBytes(next) > JOURNAL_PAGE_BYTES,
        ).toBe(true);
    }
    const alone = pages.find((page) => page.events.some((event) => event.type === "oversized"))!;
    expect(alone.events).toHaveLength(1);
    expect(alone.events[0]!.payload).toEqual(oversized);
    expect(
      pages.filter((page) => page.events.some((event) => event.type === "inline")).length,
    ).toBe(2);

    // Resuming from any delivered cursor continues the same ordered suffix.
    for (const at of [0, 1, JOURNAL_PAGE_ROWS - 1, JOURNAL_PAGE_ROWS, replayed.length - 2]) {
      expect(walk(store, blobs, replayed[at]!.cursor).flatMap((page) => page.events)).toEqual(
        replayed.slice(at + 1),
      );
    }
    expect(walk(store, blobs, replayed.at(-1)!.cursor)).toEqual([
      { events: [], position: replayed.at(-1)!.cursor, through: pages[0]!.through, more: false },
    ]);
  });

  it("binds a page walk to its captured head and to the generation serving now", async () => {
    const store = await openStore();
    const blobs = new BlobFiles(store);
    const generation = store.transaction(() => createPartition(store, "project:p"));
    const start = encodeJournalCursor("project:p", generation.epoch, 0);
    const empty = readJournalEventPage(store, "project:p", {}, blobs);
    expect(empty).toEqual({ events: [], position: start, through: start, more: false });
    new SqlEventLedger(store, blobs, generation).append("history", { n: 1 });
    // The captured head excludes later rows; the next walk captures them.
    expect(
      readJournalEventPage(store, "project:p", { after: start, through: empty.through }, blobs),
    ).toEqual({ events: [], position: start, through: start, more: false });
    const tail = readJournalEventPage(store, "project:p", { after: start }, blobs);
    expect(tail.events.map((event) => event.payload)).toEqual([{ n: 1 }]);
    expect(tail.through).toBe(tail.position);

    for (const key of ["after", "through"] as const)
      for (const [cursor, detail] of [
        [encodeJournalCursor("project:p", "other-epoch", 0), "stale epoch"],
        [encodeJournalCursor("global", generation.epoch, 0), "stale epoch"],
        [encodeJournalCursor("project:p", generation.epoch, 2), "ahead of the durable partition"],
        ["not base64url!", "malformed"],
      ] as const)
        expect(
          failure(() => readJournalEventPage(store, "project:p", { [key]: cursor }, blobs)),
        ).toMatchObject({
          code: "journal_cursor_invalid",
          status: 409,
          requiredActions: ["resnapshot"],
          message: `journal cursor is ${detail}; resnapshot is required`,
        });

    // A replaced generation refuses the old position; it never continues in the new epoch.
    store.transaction(() => {
      store.prepare("UPDATE partition SET status = 'quarantined' WHERE id = ?").run(generation.pid);
      createPartition(store, "project:p");
    });
    const next = currentGeneration(store, "project:p")!;
    new SqlEventLedger(store, blobs, next).append("history", { n: 2 });
    for (const request of [{ after: start }, { after: tail.position, through: tail.through }])
      expect(failure(() => readJournalEventPage(store, "project:p", request, blobs))).toMatchObject(
        {
          code: "journal_cursor_invalid",
          message: "journal cursor is stale epoch; resnapshot is required",
        },
      );
    expect(readJournalEventPage(store, "project:p", {}, blobs).events).toEqual([
      expect.objectContaining({ cursor: encodeJournalCursor("project:p", next.epoch, 1) }),
    ]);
  });

  it("sizes and reads pages as primary-key ranges", async () => {
    const store = await openStore();
    const plan = (sql: string, ...args: number[]) =>
      (store.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map(
        (row) => row.detail,
      );
    expect(plan(JOURNAL_PAGE_SIZE_SQL, 1, 0, 10, 5)).toEqual([
      "SEARCH e USING PRIMARY KEY (pid=? AND seq>? AND seq<?)",
      "SEARCH b USING INDEX sqlite_autoindex_blob_1 (sha256=?) LEFT-JOIN",
    ]);
    expect(plan(JOURNAL_PAGE_READ_SQL, 1, 0, 10)).toEqual([
      "SEARCH event USING PRIMARY KEY (pid=? AND seq>? AND seq<?)",
    ]);
  });
});
