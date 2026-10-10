import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DurableJournal, JournalCursorError as LegacyCursorError } from "@claudexor/journal";
import { ControlJournalEvent } from "@claudexor/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JournalCursorError,
  decodeJournalCursor,
  encodeJournalCursor,
  readJournalEvents,
} from "./cursors.js";
import { createPartition } from "./partitions.js";
import { appendEvent } from "./retention.js";
import { EngineStore } from "./store.js";

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
afterEach(async () => {
  for (const journal of journals.splice(0)) journal.close();
  for (const store of stores.splice(0)) await store.close();
  rmSync(root, { recursive: true, force: true });
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
