import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observedResourceFacet, quotaSnapshotAvailability } from "@claudexor/schema";
import { QuotaRegistry } from "./quota-registry.js";
import { mergeResources, ageResources } from "./quota-resources.js";
import { resourceRefreshEvidence } from "./quota-resource-demand.js";
import { DurableJournal } from "./store/test-support/fixtures/legacy/journal/index.js";
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()), 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)
const subject = {
  harness: "cursor",
  credential_route: "vendor_native" as const,
  subject_id: "fixture",
  plan_label: null,
};
const target = { harness: "cursor", profile_id: "fixture" };
function observation(at: Date) {
  return {
    target,
    balances: observedResourceFacet(
      [
        {
          id: "team",
          label: "Team",
          scope: "team" as const,
          amount: "100",
          unit: "cents",
          currency: "USD",
          decimal_places: 2,
          has_balance: true,
          unlimited: null,
        },
      ],
      "cursor_dashboard",
      at,
    ),
    spending: observedResourceFacet([], "cursor_dashboard", at),
  };
}
describe("resource-only facts in the existing quota refresh coordinator", () => {
  it("expires a reported billing period without minting a refill or dropping last-known amounts", () => {
    const at = new Date("2026-10-15T12:00:00Z"),
      end = "2026-10-15T12:01:00Z";
    const update = observation(at);
    update.balances.value[0] = {
      ...update.balances.value[0]!,
      period: { starts_at: at.toISOString(), ends_at: end },
    } as (typeof update.balances.value)[0];
    const row = mergeResources(undefined, update);
    expect(resourceRefreshEvidence([row])[0]!.dueAt).toBe(Date.parse(end));
    const aged = ageResources(row, Date.parse(end));
    expect(aged.balances.freshness).toBe("stale");
    expect(aged.balances.value).toEqual(row.balances.value);
    expect(resourceRefreshEvidence([aged])).toEqual([]);
  });
  it("renews resource freshness on existing polls without creating or overriding quota availability", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "resource-demand-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    cleanups.push(() => {
      journal.close();
      rmSync(root, { recursive: true, force: true });
    });
    let now = new Date("2026-10-15T12:00:00Z");
    const refresh = vi.fn(async () => ({ snapshots: [], resources: [observation(now)] }));
    const registry = new QuotaRegistry(
      journal,
      [{ vendor: "cursor", refresh }],
      () => now,
      () => [subject],
    );
    await registry.pollStale();
    expect(refresh).toHaveBeenCalledOnce();
    expect(registry.read().snapshots).toEqual([]);
    now = new Date(now.getTime() + 60_000);
    await registry.pollStale();
    expect(refresh).toHaveBeenCalledOnce();
    registry.ingest("cursor", {
      type: "error",
      session_id: "fixture",
      ts: now.toISOString(),
      credential_profile_id: "fixture",
      credential_route: "vendor_native",
      rate_limit: {
        resets_at: "2026-10-16T00:00:00Z",
        constraint_id: "observed_limit",
        retry_delay_ms: null,
      },
    });
    const blocked = registry.read().snapshots[0]!;
    expect(quotaSnapshotAvailability(blocked, { now }).state).not.toBe("available");
    await registry.refreshResources(target);
    expect(registry.read().snapshots).toHaveLength(1);
    expect(quotaSnapshotAvailability(registry.read().snapshots[0]!, { now }).state).not.toBe(
      "available",
    );
    now = new Date(now.getTime() + 300_000);
    await registry.pollStale();
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(registry.readResources()[0]!.balances.freshness).toBe("fresh");
  });
});
