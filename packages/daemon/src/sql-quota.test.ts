import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DurableJournal } from "@claudexor/journal";
import {
  ControlQuotaResponse,
  QuotaSnapshot,
  observedResourceFacet,
  type QuotaFreshness,
} from "@claudexor/schema";
import { QuotaRegistry } from "./quota-registry.js";
import { quotaSnapshotRecords } from "./quota-registry-support.js";
import { BlobFiles } from "./store/blob-files.js";
import { SqlEventLedger } from "./store/event-store.js";
import { EngineStore } from "./store/store.js";
import { createPartition, currentGeneration } from "./store/partitions.js";
import { insertEventInTx, restoreEventSequenceInTx } from "./store/retention.js";
import { decodeJournalCursor } from "./store/cursors.js";

const START = Date.parse("2026-10-10T12:00:00.000Z");
const at = (delta = 0) => new Date(START + delta).toISOString();
const TYPES = [
  "quota.resources.observed",
  "quota.resources.invalidated",
  "quota.snapshot.scoped_prepared",
  "quota.snapshot.upserted",
  "quota.window.observed",
  "quota.window.superseded",
  "quota.subject.removed",
  "quota.projection.updated",
];
let root: string;
let time: number;
const opened: EngineStore[] = [];
const journals: DurableJournal[] = [];
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sql-quota-")));
  time = START;
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const j of journals.splice(0)) j.close();
  for (const store of opened.splice(0)) await store.close();
  rmSync(root, { recursive: true, force: true });
});

function snapshot(freshness: QuotaFreshness = "fresh"): QuotaSnapshot {
  return {
    subject: {
      harness: "claude",
      subject_id: "fixture",
      credential_route: "vendor_native",
      plan_label: null,
    },
    source: "claude_oauth_usage",
    observed_at: at(),
    freshness,
    constraints: [
      {
        id: "five_hour",
        label: "5h",
        used_ratio: 1,
        window_seconds: 18000,
        resets_at: at(30_000),
        cooldown_until: null,
      },
      {
        id: "weekly",
        label: "weekly",
        used_ratio: 0.5,
        window_seconds: 604800,
        resets_at: at(86400_000),
        cooldown_until: null,
        applies_to_models: ["fable"],
      },
    ],
  };
}

async function fixture() {
  const store = await EngineStore.open({
    daemonDir: join(root, "sql"),
    workerEntry: resolve(import.meta.dirname, "../dist/store/flusher-worker.js"),
    flusherHooks: { manualTick: true },
    now: () => new Date(time),
  });
  opened.push(store);
  const generation =
    currentGeneration(store, "global") ?? store.transaction(() => createPartition(store, "global"));
  const ledger = new SqlEventLedger(store, new BlobFiles(store), generation);
  return { store, generation, ledger };
}

describe("QuotaRegistry over SQL EventLedger", () => {
  it.each(["fresh", "stale", "unknown"] as const)(
    "T-QUOTA-1 preserves #436 %s evidence on restart and passive reads",
    async (freshness) => {
      const first = await fixture();
      const raw = snapshot(freshness);
      new QuotaRegistry(first.ledger, [], () => new Date(time)).upsert(raw);
      await first.store.close();
      time += 60_000;
      const { store, ledger } = await fixture();
      const refresh = vi.fn(async () => ({ snapshots: [] }));
      const registry = new QuotaRegistry(ledger, [refresh], () => new Date(time));
      const rows = ledger.records(0, TYPES);
      const seq = currentGeneration(store, "global")!.nextSeq;
      const legacy = registry.read();
      const projected = registry.readConstraintFreshness();
      expect(projected.snapshots[0]!.constraints.map((c) => c.freshness)).toEqual(
        freshness === "fresh" ? ["stale", "fresh"] : [freshness, freshness],
      );
      expect(projected.snapshots[0]!.observed_at).toBe(raw.observed_at);
      expect(ControlQuotaResponse.parse(legacy)).toEqual(legacy);
      expect(() => ControlQuotaResponse.parse(projected)).toThrow();
      expect(() => QuotaSnapshot.parse(projected.snapshots[0])).toThrow();
      projected.snapshots[0]!.constraints[1]!.applies_to_models!.push("other");
      projected.snapshots[0]!.constraints[0]!.used_ratio = 0;
      expect(registry.read()).toEqual(legacy);
      time = START + 300_001;
      const aged = registry.readConstraintFreshness();
      expect(aged.snapshots[0]!.constraints[1]!.freshness).toBe(
        freshness === "unknown" ? "unknown" : "stale",
      );
      expect(aged.snapshots[0]!.constraints[0]!.used_ratio).toBe(1);
      expect(aged.snapshots[0]!.observed_at).toBe(raw.observed_at);
      expect(refresh).not.toHaveBeenCalled();
      expect(ledger.records(0, TYPES)).toEqual(rows);
      expect(currentGeneration(store, "global")!.nextSeq).toBe(seq);
    },
  );

  it("rolls back a real mid-batch SQLite failure before quota maps or cursor advance", async () => {
    const { store, ledger } = await fixture();
    const registry = new QuotaRegistry(ledger, [], () => new Date(time));
    registry.upsert(snapshot());
    const before = registry.read();
    const records = ledger.records(0, TYPES);
    const next = currentGeneration(store, "global")!.nextSeq;
    store.transaction(() =>
      store
        .prepare(
          "CREATE TEMP TRIGGER fail_quota BEFORE INSERT ON event WHEN NEW.type = 'quota.snapshot.upserted' BEGIN SELECT RAISE(ABORT, 'quota rollback probe'); END",
        )
        .run(),
    );
    const update = {
      ...snapshot(),
      observed_at: at(1000),
      constraints: snapshot().constraints.map((c) => ({ ...c, used_ratio: 0.2 })),
    };
    expect(() => registry.upsert(update)).toThrow(/quota rollback probe/);
    expect(registry.read()).toEqual(before);
    expect(ledger.records(0, TYPES)).toEqual(records);
    expect(currentGeneration(store, "global")!.nextSeq).toBe(next);
    expect(store.inTransaction).toBe(false);
    store.transaction(() => store.prepare("DROP TRIGGER fail_quota").run());
    registry.upsert(update);
    expect(registry.read().snapshots[0]!.constraints.every((c) => c.used_ratio === 0.2)).toBe(true);
    const saved = ledger.records(0, TYPES);
    const prepare = saved.find((r) => r.type === "quota.snapshot.scoped_prepared")!;
    const upsert = saved.find((r) => r.type === "quota.snapshot.upserted")!;
    expect(upsert.seq).toBe(prepare.seq + 1);
    expect(new QuotaRegistry(ledger, [], () => new Date(time)).read()).toEqual(registry.read());
  });

  it("imports sparse original sequences without turning an interrupted scoped pair into an adjacent pair", async () => {
    const { store, ledger, generation } = await fixture();
    const gap = snapshot();
    const adjacent = { ...snapshot(), subject: { ...snapshot().subject, subject_id: "adjacent" } };
    const missingPair = quotaSnapshotRecords(gap);
    const validPair = quotaSnapshotRecords(adjacent);
    expect(missingPair).toHaveLength(2);
    store.transaction(() => {
      insertEventInTx(store, generation.pid, { ...missingPair[0]!, seq: 5, time: at(5) });
      insertEventInTx(store, generation.pid, {
        type: "thread.entities_upserted",
        payload: {},
        seq: 6,
        time: at(6),
      });
      insertEventInTx(store, generation.pid, { ...missingPair[1]!, seq: 7, time: at(7) });
      insertEventInTx(store, generation.pid, { ...validPair[0]!, seq: 20, time: at(20) });
      insertEventInTx(store, generation.pid, { ...validPair[1]!, seq: 21, time: at(21) });
      restoreEventSequenceInTx(store, generation.pid, 100);
    });
    expect(ledger.records(0, TYPES).map((r) => [r.seq, r.time])).toEqual([
      [5, at(5)],
      [7, at(7)],
      [20, at(20)],
      [21, at(21)],
    ]);
    const registry = new QuotaRegistry(ledger, [], () => new Date(time));
    const rows = registry.read().snapshots;
    expect(
      rows.find((r) => r.subject.subject_id === "fixture")!.constraints[1]!.applies_to_models,
    ).toBeUndefined();
    expect(
      rows.find((r) => r.subject.subject_id === "adjacent")!.constraints[1]!.applies_to_models,
    ).toEqual(["fable"]);
    registry.recoverAfterStartup();
    expect(ledger.records(99, ["quota.projection.updated"])[0]?.seq).toBe(100);
  });

  it("retains all eight event kinds, supersession, resource cutoffs and the exact response marker", async () => {
    const { store, ledger, generation } = await fixture();
    const legacy = new DurableJournal({
      rootDir: join(root, "legacy"),
      partition: "global",
      now: () => new Date(time),
    });
    journals.push(legacy);
    const resources = () => ({
      target: { harness: "claude", profile_id: "fixture" },
      spending: observedResourceFacet([], "claude_oauth_usage", new Date(time)),
    });
    const refresh = async () => ({ snapshots: [] as QuotaSnapshot[], resources: [resources()] });
    const sql = new QuotaRegistry(ledger, [refresh], () => new Date(time));
    const old = new QuotaRegistry(legacy, [refresh], () => new Date(time));
    const seen = new Set<string>();
    const originalAppend = ledger.append.bind(ledger);
    const originalBatch = ledger.appendBatch.bind(ledger);
    vi.spyOn(ledger, "append").mockImplementation((type, payload) => {
      seen.add(type);
      return originalAppend(type, payload);
    });
    vi.spyOn(ledger, "appendBatch").mockImplementation((rows) => {
      rows.forEach((r) => seen.add(r.type));
      return originalBatch(rows);
    });
    const compare = () => {
      expect(sql.read()).toEqual(old.read());
      expect(sql.readResources()).toEqual(old.readResources());
      expect(sql.readConstraintFreshness()).toEqual(old.readConstraintFreshness());
    };
    for (const registry of [sql, old]) registry.upsert(snapshot());
    time += 1000;
    const partial: QuotaSnapshot = {
      ...snapshot(),
      source: "claude_rate_limit_event",
      observed_at: at(1000),
      constraints: [{ ...snapshot().constraints[0]!, resets_at: at(86400_000), used_ratio: 1 }],
    };
    for (const registry of [sql, old]) registry.upsert(partial);
    compare();
    time += 1000;
    const renewed = {
      ...snapshot(),
      observed_at: at(2000),
      constraints: snapshot().constraints.map((c) => ({
        ...c,
        resets_at: at(86400_000),
        used_ratio: 0.1,
      })),
    };
    for (const registry of [sql, old]) registry.upsert(renewed);
    compare();
    await sql.refresh();
    await old.refresh();
    compare();
    time += 60_000;
    for (const registry of [sql, old])
      registry.invalidateAccountResources({ harness: "claude", profile_id: "fixture" });
    compare();
    expect(
      sql
        .readConstraintFreshness()
        .snapshots.every((s) => s.constraints.every((c) => c.freshness === "stale")),
    ).toBe(true);
    const response = await sql.refreshWithCursor();
    const sequence = decodeJournalCursor(
      response.quotaEventCursor,
      "global",
      generation.epoch,
      currentGeneration(store, "global")!.nextSeq,
    );
    expect(ledger.records(sequence - 1, ["quota.projection.updated"])[0]?.seq).toBe(sequence);
    expect(response.response.snapshots).toEqual(sql.read().snapshots);
    const replay = new QuotaRegistry(ledger, [], () => new Date(time));
    expect(replay.read()).toEqual(sql.read());
    expect(replay.readResources()).toEqual(sql.readResources());
    for (const registry of [sql, old]) registry.removeSubject("claude", "fixture");
    expect([...seen].sort()).toEqual([...TYPES].sort());
    expect(sql.read().snapshots).toEqual([]);
    expect(new QuotaRegistry(ledger, [], () => new Date(time)).read().snapshots).toEqual([]);
  });
});
