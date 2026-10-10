import { legacyCommandFixture } from "./store/test-support/legacy-command-fixture.js";
import { journalFoldPolicy } from "./journal-fold-policy.js";
import { AccountResets } from "./account-resets.js";
import { CommandStore } from "./store/test-support/fixtures/legacy/daemon/command-store.js";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DurableJournal } from "./store/test-support/fixtures/legacy/journal/index.js";
import {
  observedResourceFacet,
  type AccountResourceObservation,
  type QuotaSnapshot,
  type AccountTarget,
} from "@claudexor/schema";
import { QuotaRegistry } from "./quota-registry.js";
import { mergeResources, ageResources, quotaProjectionSignature } from "./quota-resources.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});
const target = { harness: "codex", profile_id: "codex-default" };
const sibling = { harness: "codex", profile_id: "other" };
const at = new Date("2026-10-09T12:00:00Z");
function journal() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "quota-resource-test-")));
  const j = new DurableJournal({ rootDir: root, partition: "global" });
  cleanup.push(() => {
    j.close();
    rmSync(root, { recursive: true, force: true });
  });
  return j;
}
function snapshot(target: AccountTarget, time = at): QuotaSnapshot {
  return {
    subject: {
      harness: target.harness,
      subject_id: target.profile_id,
      credential_route: "vendor_native",
      plan_label: null,
    },
    source: "codex_app_server",
    observed_at: time.toISOString(),
    freshness: "fresh",
    constraints: [
      {
        id: "primary",
        label: "5h",
        used_ratio: 1,
        window_seconds: 18000,
        resets_at: "2026-10-09T18:00:00Z",
        cooldown_until: null,
      },
    ],
  };
}
const balance = {
  id: "credits",
  label: "Credits",
  amount: "0",
  unit: "credits",
  currency: null,
  decimal_places: null,
  has_balance: false,
  unlimited: false,
};

describe("account resources inside quota owner", () => {
  it("ages facets independently and retains last-known balance after a 403 or sparse read", () => {
    const original = mergeResources(undefined, {
      target,
      balances: observedResourceFacet([balance], "claude_prepaid", at),
    });
    const later = new Date(at.getTime() + 600_000);
    const next = mergeResources(original, {
      target,
      spending: observedResourceFacet([], "claude_oauth_usage", later),
    });
    expect(ageResources(next, later.getTime())).toMatchObject({
      balances: { freshness: "stale", value: [{ amount: "0" }], observed_at: at.toISOString() },
      spending: { freshness: "fresh" },
    });
    const failed = mergeResources(next, {
      target,
      balances: {
        value: null,
        source: "claude_prepaid",
        observed_at: null,
        freshness: "unknown",
        last_attempt_at: later.toISOString(),
        last_error: "balance_read_unavailable",
      },
    });
    expect(failed.balances).toMatchObject({
      value: [{ amount: "0" }],
      freshness: "stale",
      observed_at: at.toISOString(),
      last_error: "balance_read_unavailable",
    });
    const nonzero = mergeResources(undefined, {
      target,
      balances: observedResourceFacet([{ ...balance, amount: "25.5000" }], "claude_prepaid", at),
    });
    expect(
      mergeResources(nonzero, {
        target,
        balances: {
          value: null,
          source: "claude_prepaid",
          observed_at: null,
          freshness: "unknown",
          last_attempt_at: later.toISOString(),
          last_error: "balance_read_unavailable",
        },
      }).balances.value?.[0]?.amount,
    ).toBe("25.5000");
    expect(mergeResources(undefined, { target }).balances.value).toBeNull();
  });

  it("serializes disjoint exact targets and preserves other-account snapshots and absence claims", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const seen: string[] = [];
    const registry = new QuotaRegistry(
      journal(),
      [
        {
          vendor: "codex",
          refresh: async (cycle) => {
            const id = cycle!.target!.profile_id;
            seen.push(id);
            if (id === target.profile_id) await held;
            return {
              snapshots: id === target.profile_id ? [snapshot(target)] : [],
              absences:
                id === sibling.profile_id
                  ? [
                      {
                        subject: snapshot(sibling).subject,
                        reason: "not_logged_in" as const,
                        detail: null,
                        observed_at: at.toISOString(),
                      },
                    ]
                  : [],
            };
          },
        },
      ],
      () => at,
      () => [snapshot(target).subject, snapshot(sibling).subject],
    );
    const a = registry.refresh(target);
    const b = registry.refresh(sibling);
    release();
    await Promise.all([a, b]);
    expect(seen).toEqual([target.profile_id, sibling.profile_id]);
    expect(registry.read().snapshots.map((s) => s.subject.subject_id)).toEqual([target.profile_id]);
    expect(registry.read().absences).toContainEqual(
      expect.objectContaining({
        reason: "not_logged_in",
        subject: expect.objectContaining({ subject_id: sibling.profile_id }),
      }),
    );
  });

  it("old poll completing after reset cannot make historical quota fresh when the new read fails, including replay", async () => {
    const j = journal();
    let now = at;
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const registry = new QuotaRegistry(
      j,
      [
        {
          vendor: "codex",
          refresh: async () => {
            calls++;
            if (calls === 1) {
              await held;
              return {
                snapshots: [snapshot(target, now), snapshot(sibling)],
                resources: [
                  { target, balances: observedResourceFacet([balance], "codex_app_server", at) },
                ],
              };
            }
            throw new Error("post-reset offline");
          },
        },
      ],
      () => now,
    );
    const before = registry.refresh();
    now = new Date(at.getTime() + 1000);
    registry.invalidateAccountResources(target);
    const after = registry.refreshResources(target, true, true);
    now = new Date(at.getTime() + 2000);
    release();
    await before;
    await expect(after).rejects.toThrow("post-reset offline");
    expect(calls).toBe(2);
    for (const view of [registry, new QuotaRegistry(j, [], () => now)]) {
      expect(
        view.read().snapshots.find((s) => s.subject.subject_id === target.profile_id)?.freshness,
      ).toBe("stale");
      expect(
        view.read().snapshots.find((s) => s.subject.subject_id === sibling.profile_id)?.freshness,
      ).toBe("fresh");
      expect(view.readResources()[0]?.balances).toMatchObject({
        freshness: "stale",
        value: [{ amount: "0" }],
      });
    }
  });

  it("uses a versioned resource journal event and returns an atomic resource fence", async () => {
    const j = journal();
    const resource: AccountResourceObservation = {
      target,
      balances: observedResourceFacet([balance], "codex_app_server", at),
    };
    const registry = new QuotaRegistry(
      j,
      [async () => ({ snapshots: [snapshot(target)], resources: [resource] })],
      () => at,
    );
    const result = await registry.refreshWithCursor();
    expect(result.resources[0]?.balances.value?.[0]?.amount).toBe("0");
    expect(j.records().find((r) => r.type === "quota.resources.observed")?.payload).toMatchObject({
      version: 1,
    });
    expect(
      j.records().find((r) => r.type === "quota.snapshot.upserted")?.payload,
    ).not.toHaveProperty("resources");
    registry.removeSubject(target.harness, target.profile_id);
    expect(new QuotaRegistry(j).readResources()).toEqual([]);
  });
  it("preserves fresh admission evidence after a confirmed no-effect reset and a failed source read", async () => {
    const j = journal();
    const registry = new QuotaRegistry(
      j,
      [
        async () => {
          throw new Error("offline");
        },
      ],
      () => at,
    );
    registry.upsert(snapshot(target));
    const store = new CommandStore(j);
    const operations = new AccountResets({
      commands: () => legacyCommandFixture({ current: () => store }).forRequest!({}),
      resolve: async () => ({
        harness: "codex",
        locator: "/fixture",
        fingerprint: "one",
        program: "rate_limit_reset_credit",
        grant_id: null,
        native_request_id: "one",
      }),
      verify: async () => {},
      consume: async () => ({ outcome: "no_credit", detail: null }),
      invalidate: (target) => registry.invalidateAccountResources(target),
      refresh: (target, effect) => registry.refreshResources(target, true, effect),
      read: () => ({ ...registry.read(), resources: registry.readResources() }),
      now: () => at,
    });
    const receipt = await operations.create({
      request: { target, offer_id: "codex_granted" },
      idempotencyKey: "one",
      clientId: "fixture",
    });
    expect(receipt.readback.state).toBe("failed");
    expect(registry.read().snapshots[0]).toMatchObject({
      freshness: "fresh",
      constraints: [{ used_ratio: 1 }],
    });
  });

  it("accepts a successful post-reset read at the same millisecond, including journal replay", async () => {
    const j = journal();
    const registry = new QuotaRegistry(
      j,
      [
        async () => ({
          snapshots: [snapshot(target)],
          resources: [
            { target, balances: observedResourceFacet([balance], "codex_app_server", at) },
          ],
        }),
      ],
      () => at,
    );
    registry.upsert(snapshot(target));
    registry.invalidateAccountResources(target);
    expect(registry.read().snapshots[0]?.freshness).toBe("stale");
    await registry.refreshResources(target, true, true);
    for (const view of [registry, new QuotaRegistry(j, [], () => at)]) {
      expect(view.read().snapshots[0]?.freshness).toBe("fresh");
      expect(view.readResources()[0]?.balances.freshness).toBe("fresh");
    }
  });

  it("drains a failed old poll before making the reset readback attempt", async () => {
    const j = journal();
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const registry = new QuotaRegistry(
      j,
      [
        async () => {
          if (++calls === 1) {
            await held;
            throw new Error("old poll failed");
          }
          return { snapshots: [snapshot(target)] };
        },
      ],
      () => at,
    );
    const before = registry.refresh().catch(() => null);
    const after = registry.refreshResources(target, true, true);
    release();
    await before;
    expect((await after).snapshots[0]?.freshness).toBe("fresh");
    expect(calls).toBe(2);
  });
  it("folded journal retains independent facets and the reset cutoff", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "resource-fold-test-")));
    const original = new DurableJournal({ rootDir: root, partition: "global" });
    let reopened: DurableJournal | undefined;
    cleanup.push(() => {
      original.close();
      reopened?.close();
      rmSync(root, { recursive: true, force: true });
    });
    let iteration = 0;
    let now = at;
    const registry = new QuotaRegistry(
      original,
      [
        async () => ({
          snapshots: [snapshot(target)],
          resources: [
            iteration++ === 0
              ? { target, balances: observedResourceFacet([balance], "codex_app_server", at) }
              : { target, spending: observedResourceFacet([], "codex_app_server", now) },
          ],
        }),
      ],
      () => now,
    );
    await registry.refresh();
    now = new Date(at.getTime() + 1000);
    await registry.refresh();
    registry.invalidateAccountResources(target);
    const expected = registry.readResources();
    original.close();
    reopened = new DurableJournal({ rootDir: root, partition: "global", fold: journalFoldPolicy });
    expect(new QuotaRegistry(reopened, [], () => now).readResources()).toEqual(expected);
    expect(expected[0]?.balances).toMatchObject({
      value: [{ amount: "0" }],
      freshness: "stale",
      observed_at: at.toISOString(),
    });
    expect(expected[0]?.spending.value).toEqual([]);
  });
  it("captures resources at the quota epoch and uses the identical rows for its cursor marker", async () => {
    const j = journal();
    const registry = new QuotaRegistry(
      j,
      [
        async () => ({
          snapshots: [snapshot(target)],
          resources: [
            { target, balances: observedResourceFacet([balance], "codex_app_server", at) },
          ],
        }),
      ],
      () =>
        new Date(
          at.getTime() + (j.records(0, ["quota.projection.updated"]).length ? 300000 : 299999),
        ),
    );
    const result = await registry.refreshWithCursor();
    expect(result.response.snapshots[0]?.freshness).toBe("fresh");
    expect(result.resources[0]?.balances.freshness).toBe("fresh");
    const marker = j
      .records<{ projection_signature: string }>()
      .findLast((record) => record.type === "quota.projection.updated")!;
    expect(marker.payload.projection_signature).toBe(
      quotaProjectionSignature(result.response, result.resources),
    );
    expect(j.cursorFor(marker)).toBe(result.quotaEventCursor);
    expect(registry.readResources()[0]?.balances.freshness).toBe("stale");
  });
});
