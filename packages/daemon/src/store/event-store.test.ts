import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RunEvent } from "@claudexor/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JOURNALED_RUN_EVENT_TYPES, journaledRunEventCopy } from "../journaled-run-events.js";
import type { EventLedger } from "../store-contracts.js";
import { BlobFiles, INLINE_BODY_MAX_BYTES } from "./blob-files.js";
import { decodeJournalCursor, encodeJournalCursor, readJournalEvents } from "./cursors.js";
import { appendPreparedEventInTx, deleteEventsInTx, SqlEventLedger } from "./event-store.js";
import { bindIdempotencyInTx, lookupIdempotency } from "./idempotency.js";
import { runMutation, type SqlWriteContext } from "./mutation.js";
import { createPartition } from "./partitions.js";
import { insertEventInTx, restoreEventSequenceInTx } from "./retention.js";
import { ensureSchema } from "./schema.js";
import { EngineStore } from "./store.js";

const TIME = "2026-10-10T02:03:04.000Z";
let root: string;
const stores: EngineStore[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-sql-events-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
  rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
    flusherHooks: { manualTick: true },
    now: () => new Date(TIME),
  });
  stores.push(store);
  const partition = store.transaction(() => createPartition(store, "global"));
  const blobs = new BlobFiles(store);
  const ledger = new SqlEventLedger(store, blobs, partition);
  return { store, partition, blobs, ledger };
}

describe("SQL EventLedger body and fold contract", () => {
  it("addresses group, sequence and type before hydrating setup bodies", async () => {
    const { store, blobs, ledger, partition } = await fixture();
    const wanted = ledger.append("setup.job.saved", {
      job: { jobId: "one", state: "running" },
      text: "a".repeat(80000),
    });
    ledger.append("setup.job.saved", {
      job: { jobId: "two", state: "running" },
      text: "b".repeat(80000),
    });
    ledger.append("setup.job.log", { jobId: "one", line: "log" });
    const read = vi.spyOn(blobs, "read");
    const prepare = vi.spyOn(store, "prepare");
    expect(ledger.recordsInGroup("s:one:saved", 0, ["setup.job.saved"])).toEqual([wanted]);
    const query = prepare.mock.calls.find(([sql]) => sql.includes("SELECT seq, time, type"))![0];
    expect(read).toHaveBeenCalledTimes(1);
    expect(ledger.recordsInGroup("s:one:saved", wanted.seq, ["setup.job.saved"])).toEqual([]);
    expect(ledger.recordsInGroup("s:one:saved", 0, ["setup.job.log"])).toEqual([]);
    expect(ledger.recordsInGroup("s:two:saved", 0, [])).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
    const plan = (
      store
        .prepare(`EXPLAIN QUERY PLAN ${query}`)
        .all(partition.pid, 0, "setup.job.saved", "s:one:saved") as Array<{ detail: string }>
    )
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain("event_group");
    expect(plan).not.toMatch(/SCAN event|TEMP B-TREE/);
  });
  it("stores exactly 64 KiB inline and a larger UTF-8 payload once, with hydrated reducer and SSE reads", async () => {
    const { store, blobs, ledger, partition } = await fixture();
    const inline = "x".repeat(INLINE_BODY_MAX_BYTES - 2); // JSON quotes occupy two bytes.
    const large = { text: "🍐".repeat(20_000), untouched: { nested: [1, false, null] } };
    const first = ledger.append("small", inline);
    const prepare = vi.spyOn(blobs, "prepareBody");
    const body = ledger.prepare("large", large);
    expect(store.inTransaction).toBe(false);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(existsSync(body.body!.file!)).toBe(true);
    const stringify = vi.spyOn(JSON, "stringify");
    const second = runMutation(store, (tx) => ledger.appendInTx(tx, body));
    expect(stringify.mock.calls.some(([value]) => value === body.payload)).toBe(false);
    stringify.mockRestore();
    const rows = store
      .prepare("SELECT seq, payload, payload_sha FROM event ORDER BY seq")
      .all() as Array<{ seq: number; payload: Uint8Array; payload_sha: string | null }>;
    expect(Buffer.from(rows[0]!.payload).byteLength).toBe(INLINE_BODY_MAX_BYTES);
    expect(rows[0]!.payload_sha).toBeNull();
    expect(Buffer.from(rows[1]!.payload).toString()).toBe("null");
    expect(rows[1]!.payload_sha).toBe(body.body!.sha256);
    expect(store.prepare("SELECT size, inline FROM blob").get()).toEqual({
      size: Buffer.byteLength(JSON.stringify(large)),
      inline: null,
    });
    expect(store.owners.generationOf(`blob:${body.body!.sha256}`)).toBeGreaterThan(0);
    const port: EventLedger = ledger;
    expect(port.records(0, ["small", "large"])).toEqual([first, second]);
    expect(
      readJournalEvents(store, "global", undefined, blobs).map((event) => event.payload),
    ).toEqual([inline, large]);
    expect(port.cursorFor(second)).toBe(encodeJournalCursor("global", partition.epoch, 2));
    // A reference cannot silently fall back to JSON null when its file is bad.
    writeFileSync(body.body!.file!, "corrupt");
    expect(() => port.records(1, ["large"])).toThrow(
      expect.objectContaining({ code: "blob_digest_mismatch" }),
    );
    rmSync(body.body!.file!);
    expect(() => readJournalEvents(store, "global", port.cursorFor(first))).toThrow(
      expect.objectContaining({ code: "blob_unavailable" }),
    );
  });

  it("fold evaluates full large payloads; rollback restores the old slot and owner generations", async () => {
    const { store, ledger, blobs, partition } = await fixture();
    const original = ledger.prepare("command.updated", {
      record: { id: "command-1", state: "running", detail: "x".repeat(80_000) },
    });
    runMutation(store, (tx) => ledger.appendInTx(tx, original));
    const oldKey = `blob:${original.body!.sha256}` as const;
    const oldGeneration = store.owners.generationOf(oldKey);
    const replacement = ledger.prepare("command.updated", {
      record: { id: "command-1", state: "succeeded", detail: "y".repeat(80_000) },
    });
    const newKey = `blob:${replacement.body!.sha256}` as const;
    const replace = (fail: boolean) =>
      runMutation(store, (tx) => {
        const result = appendPreparedEventInTx(tx, blobs, partition.pid, replacement);
        expect(result.releasedDigests).toEqual([original.body!.sha256]);
        if (fail) throw new Error("rollback replacement");
        return result;
      });
    expect(() => replace(true)).toThrow(/rollback replacement/);
    expect(store.owners.generationOf(oldKey)).toBe(oldGeneration);
    expect(store.owners.generationOf(newKey)).toBeUndefined();
    expect(ledger.records(0, ["command.updated"]).map((record) => record.payload)).toEqual([
      original.payload,
    ]);
    expect(replace(false)).toMatchObject({
      seq: 2,
      stored: true,
      verdict: { slot: "c:command-1:u" },
    });
    expect(store.owners.generationOf(oldKey)).toBeGreaterThan(oldGeneration!);
    expect(store.owners.generationOf(newKey)).toBeGreaterThan(0);
    expect(readJournalEvents(store, "global").map((event) => event.payload)).toEqual([
      replacement.payload,
    ]);
    // The old cursor still resumes the retained suffix; a poll never re-delivers the old slot.
    const cursor = encodeJournalCursor("global", partition.epoch, 1);
    expect(readJournalEvents(store, "global", cursor)).toEqual(readJournalEvents(store, "global"));
    const committedGeneration = store.owners.generationOf(newKey);
    expect(() =>
      runMutation(store, (tx) => {
        expect(deleteEventsInTx(tx, partition.pid, ["c:command-1:u"])).toEqual([
          replacement.body!.sha256,
        ]);
        throw new Error("rollback prune");
      }),
    ).toThrow(/rollback prune/);
    expect(store.owners.generationOf(newKey)).toBe(committedGeneration);
    expect(ledger.records(0, ["command.updated"])).toHaveLength(1);
    expect(
      runMutation(store, (tx) => deleteEventsInTx(tx, partition.pid, ["c:command-1:u"])),
    ).toEqual([replacement.body!.sha256]);
    expect(store.owners.generationOf(newKey)).toBeGreaterThan(committedGeneration!);
    expect(ledger.records(0, ["command.updated"])).toEqual([]);
  });

  it("consumes dropped entity sequence and preserves every setup save while retiring only its logs", async () => {
    const { store, ledger } = await fixture();
    const records = ledger.appendBatch([
      { type: "thread.entities_upserted", payload: { body: "x".repeat(80_000) } },
      { type: "setup.job.log", payload: { jobId: "job-1", line: "progress" } },
      { type: "setup.job.saved", payload: { job: { jobId: "job-1", state: "running" } } },
      { type: "setup.job.log", payload: { jobId: "job-2", line: "other job" } },
      { type: "setup.job.saved", payload: { job: { jobId: "job-1", state: "succeeded" } } },
      { type: "future.event", payload: { kept: true } },
      { type: "setup.job.saved", payload: null },
    ]);
    expect(records.map((record) => record.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(store.prepare("SELECT next_seq FROM partition").get()).toEqual({ next_seq: 8 });
    expect(store.prepare("SELECT count(*) AS n FROM blob").get()).toEqual({ n: 0 });
    expect(store.prepare("SELECT seq, group_key FROM event ORDER BY seq").all()).toEqual([
      { seq: 3, group_key: "s:job-1:saved" },
      { seq: 4, group_key: "s:job-2:log" },
      { seq: 5, group_key: "s:job-1:saved" },
      { seq: 6, group_key: null },
      { seq: 7, group_key: null },
    ]);
    expect(ledger.records(0, ["setup.job.saved"]).map((record) => record.payload)).toEqual([
      records[2]!.payload,
      records[4]!.payload,
      null,
    ]);
    expect(ledger.records(0, ["thread.entities_upserted"])).toEqual([]);
  });

  it("stores all eleven typed run-event copies with the existing producer's redaction", async () => {
    const { ledger } = await fixture();
    const expected = [...JOURNALED_RUN_EVENT_TYPES].map((type, index) => {
      const source = RunEvent.parse({
        seq: 1,
        ts: TIME,
        run_id: `run-${index}`,
        task_id: "task",
        type,
        payload:
          type === "run.created"
            ? { mode: "agent", prompt: "private prompt" }
            : type.startsWith("message.")
              ? { text: "private steering", text_sha256: "digest", text_bytes: 16 }
              : { evidence: type },
      });
      return journaledRunEventCopy(source);
    });
    for (const event of expected) ledger.append("run.event", event);
    const actual = ledger.records<RunEvent>(0, ["run.event"]).map((record) => record.payload);
    expect(actual).toEqual(expected);
    expect(actual).toHaveLength(11);
    expect(actual.find((event) => event.type === "run.created")?.payload).toMatchObject({
      prompt_bytes: 14,
    });
    expect(JSON.stringify(actual)).not.toContain("private prompt");
    expect(JSON.stringify(actual)).not.toContain("private steering");
    // A terminal folds only its own live group, preserving every other run.
    ledger.append(
      "run.event",
      RunEvent.parse({
        seq: 2,
        ts: TIME,
        run_id: "run-0",
        task_id: "task",
        type: "run.completed",
        payload: {},
      }),
    );
    expect(ledger.records<RunEvent>(0, ["run.event"]).map((record) => record.payload)).toHaveLength(
      11,
    );
  });

  it("hydrates only requested types and pid, preserving sparse sequence order and atomic batches", async () => {
    const { store, blobs, ledger } = await fixture();
    ledger.append("unrelated", { text: "x".repeat(100_000) });
    const batch = ledger.appendBatch([
      { type: "wanted", payload: { n: 1 } },
      { type: "unrelated", payload: { text: "y".repeat(100_000) } },
      { type: "wanted", payload: { n: 2 } },
    ]);
    const read = vi.spyOn(blobs, "read");
    expect(ledger.records(0, ["wanted"]).map((event) => event.seq)).toEqual([2, 4]);
    expect(ledger.records(2, ["wanted"])).toEqual([batch[2]]);
    expect(read).not.toHaveBeenCalled();
    const other = store.transaction(() => createPartition(store, "project:other"));
    new SqlEventLedger(store, blobs, other).append("wanted", { elsewhere: true });
    expect(ledger.records(0, ["wanted"])).toHaveLength(2);
    expect(ledger.records(0, [])).toEqual([]);
    store.transaction(() =>
      store.exec(
        "CREATE TRIGGER fixture_event_failure BEFORE INSERT ON event WHEN NEW.type = 'fault' BEGIN SELECT RAISE(ABORT, 'event failure'); END",
      ),
    );
    expect(() =>
      ledger.appendBatch([
        { type: "wanted", payload: { n: 3 } },
        { type: "fault", payload: {} },
      ]),
    ).toThrow(/event failure/);
    expect(ledger.records(0, ["wanted"]).map((event) => event.seq)).toEqual([2, 4]);
    expect(ledger.append("wanted", { n: 3 }).seq).toBe(5);
  });
});

describe("pure importer seams", () => {
  it("uses one SQL connection, original seq/time and frame nextSeq, including a dropped tail", async () => {
    const { store } = await fixture();
    const db = new store.runtime.sqlite.DatabaseSync(":memory:");
    try {
      ensureSchema(db);
      const sql: SqlWriteContext = {
        prepare: (statement) => db.prepare(statement),
        get inTransaction() {
          return db.isTransaction;
        },
      };
      db.exec("BEGIN IMMEDIATE");
      db.prepare(
        "INSERT INTO partition(id,name,epoch,status,next_seq,created_at) VALUES(7,'legacy','original-epoch','ready',1,?)",
      ).run(TIME);
      for (const [seq, revision] of [
        [4, 1],
        [19, 2],
      ] as const) {
        insertEventInTx(sql, 7, {
          seq,
          time: TIME,
          type: "thread.head.updated",
          payload: { thread_id: "t", revision },
        });
      }
      insertEventInTx(sql, 7, {
        seq: 40,
        time: TIME,
        type: "thread.entities_upserted",
        payload: {},
      });
      restoreEventSequenceInTx(sql, 7, 41);
      const legacy = {
        owner: "command" as const,
        pid: 7,
        keyDigest: "unchanged:key",
        requestDigest: "unchanged:request",
        operation: "legacy",
        targetId: "old-command",
        createdAt: TIME,
      };
      bindIdempotencyInTx(sql, legacy);
      db.exec("COMMIT");
      expect(db.prepare("SELECT seq,time FROM event").all()).toEqual([{ seq: 19, time: TIME }]);
      expect(db.prepare("SELECT epoch,next_seq FROM partition").get()).toEqual({
        epoch: "original-epoch",
        next_seq: 41,
      });
      expect(lookupIdempotency(sql, legacy, legacy.requestDigest)).toEqual(legacy);
      expect(
        decodeJournalCursor(
          encodeJournalCursor("legacy", "original-epoch", 40),
          "legacy",
          "original-epoch",
          41,
        ),
      ).toBe(40);
      expect(() =>
        decodeJournalCursor(
          encodeJournalCursor("legacy", "original-epoch", 41),
          "legacy",
          "original-epoch",
          41,
        ),
      ).toThrow(/ahead/);
      expect(() =>
        insertEventInTx(sql, 7, { seq: 41, time: TIME, type: "outside", payload: {} }),
      ).toThrow(/transaction/);
    } finally {
      db.close();
    }
  });
});
