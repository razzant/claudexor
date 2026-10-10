import { expect, it } from "vitest";
import { QuotaRegistry } from "./quota-registry.js";
import type { EventLedger, StoreEvent } from "./store-contracts.js";

it("replays quota through logical events without journal frame or file methods", async () => {
  const rows: StoreEvent[] = [];
  const selections: string[][] = [];
  const ledger: EventLedger = {
    append<T>(type: string, payload: T): StoreEvent<T> {
      const row = {
        partition: "global",
        epoch: "epoch",
        seq: rows.length + 1,
        time: "2026-07-28T00:00:00.000Z",
        type,
        payload,
      };
      rows.push(row);
      return row;
    },
    appendBatch(entries) {
      return entries.map((entry) => this.append(entry.type, entry.payload));
    },
    records<T>(afterSeq: number, types: readonly string[]): StoreEvent<T>[] {
      selections.push([...types]);
      return rows.filter(
        (row) => row.seq > afterSeq && types.includes(row.type),
      ) as StoreEvent<T>[];
    },
    cursorFor(row) {
      return `${row.partition}:${row.epoch}:${row.seq}`;
    },
  };
  ledger.append("unrelated", { private: "never enters quota reducer" });
  const observed = {
    subject: {
      harness: "claude",
      credential_route: "vendor_native" as const,
      plan_label: null,
      subject_id: "test-profile",
    },
    constraints: [
      {
        id: "five_hour",
        label: "5 hour",
        used_ratio: 0.2,
        window_seconds: 18000,
        resets_at: null,
        cooldown_until: null,
      },
    ],
    source: "claude_oauth_usage" as const,
    observed_at: "2026-07-28T00:00:00.000Z",
    freshness: "fresh" as const,
  };
  const now = () => new Date("2026-07-28T00:00:01.000Z");
  const registry = new QuotaRegistry(ledger, [async () => ({ snapshots: [observed] })], now);
  const refreshed = await registry.refreshWithCursor();
  expect(refreshed.quotaEventCursor).toBe(ledger.cursorFor(rows.at(-1)!));
  expect(rows.at(-1)?.type).toBe("quota.projection.updated");
  const reopened = new QuotaRegistry(ledger, [], now);
  expect(reopened.read().snapshots).toEqual(registry.read().snapshots);
  expect(reopened.read().snapshots[0]?.constraints[0]?.used_ratio).toBe(0.2);
  expect(selections).toHaveLength(2);
  expect(
    selections.every(
      (types) => types.includes("quota.projection.updated") && !types.includes("unrelated"),
    ),
  ).toBe(true);
  expect(ledger).not.toHaveProperty("path");
  expect(ledger).not.toHaveProperty("options");
});
