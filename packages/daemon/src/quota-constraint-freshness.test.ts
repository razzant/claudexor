import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DurableJournal } from "./store/test-support/fixtures/legacy/journal/index.js";
import {
  ControlQuotaResponse,
  QuotaSnapshot,
  withQuotaAvailability,
  type QuotaConstraint,
  type QuotaFreshness,
} from "@claudexor/schema";
import { QuotaRegistry } from "./quota-registry.js";
import {
  activeQuotaSnapshots,
  activeQuotaSnapshotsWithConstraintFreshness,
} from "./quota-registry-support.js";

const observed = Date.parse("2026-10-10T12:00:00.000Z");
const iso = (delta: number) => new Date(observed + delta).toISOString();
const window = (id: string, reset: number | null): QuotaConstraint => ({
  id,
  label: id,
  used_ratio: 0.8,
  window_seconds: id === "five_hour" ? 18_000 : 604_800,
  resets_at: reset === null ? null : iso(reset),
  cooldown_until: null,
});
const snapshot = (
  constraints: QuotaConstraint[],
  freshness: QuotaFreshness = "fresh",
): QuotaSnapshot => ({
  subject: {
    harness: "claude",
    credential_route: "vendor_native",
    subject_id: "fixture",
    plan_label: null,
  },
  source: "claude_oauth_usage",
  observed_at: iso(0),
  freshness,
  constraints,
});

describe("passive per-constraint freshness", () => {
  it.each([
    ["expired 5h", 30_000, 86400_000, ["stale", "fresh"]],
    ["expired weekly", 86400_000, 30_000, ["fresh", "stale"]],
  ] as const)(
    "separates %s from its sibling without changing the legacy aggregate",
    (_label, short, week, expected) => {
      const raw = snapshot([window("five_hour", short), window("weekly", week)]);
      const before = structuredClone(raw);
      const [projected] = activeQuotaSnapshotsWithConstraintFreshness([raw], observed + 60_000);
      expect(projected!.freshness).toBe("stale");
      expect(projected!.constraints.map((constraint) => constraint.freshness)).toEqual(expected);
      const stripped = {
        ...projected,
        constraints: projected!.constraints.map(({ freshness, ...rest }) => rest),
      };
      expect(stripped).toEqual(activeQuotaSnapshots([raw], observed + 60_000)[0]);
      expect(raw).toEqual(before);
    },
  );

  it("keeps model-scoped siblings independent, including repeated vendor window ids", () => {
    const raw = snapshot([
      { ...window("weekly", 30_000), applies_to_models: ["fable"] },
      { ...window("weekly", 86400_000), applies_to_model_prefixes: ["opus-"] },
      {
        ...window("five_hour", 86400_000),
        applies_to_models: ["sonnet"],
        applies_to_unspecified_model: true,
      },
    ]);
    const [projected] = activeQuotaSnapshotsWithConstraintFreshness([raw], observed + 60_000);
    expect(projected!.constraints.map((constraint) => constraint.freshness)).toEqual([
      "stale",
      "fresh",
      "fresh",
    ]);
  });

  it.each([
    ["before TTL", 299_999, null, "fresh", "fresh"],
    ["exact TTL", 300_000, null, "fresh", "fresh"],
    ["after TTL", 300_001, null, "fresh", "stale"],
    ["reset before", 60_000, 59_999, "fresh", "stale"],
    ["reset equal", 60_000, 60_000, "fresh", "stale"],
    ["reset future", 60_000, 60_001, "fresh", "fresh"],
    ["future observation", -1, null, "fresh", "fresh"],
    ["raw stale", 60_000, 86400_000, "stale", "stale"],
    ["raw unknown", 60_000, 86400_000, "unknown", "unknown"],
    ["unknown after reset and TTL", 300_001, 30_000, "unknown", "unknown"],
  ] as const)(
    "preserves existing aging boundaries: %s",
    (_label, age, reset, rawFreshness, expected) => {
      const raw = snapshot([window("five_hour", reset)], rawFreshness);
      const [projected] = activeQuotaSnapshotsWithConstraintFreshness([raw], observed + age);
      expect(projected!.constraints[0]!.freshness).toBe(expected);
      expect(projected!.observed_at).toBe(raw.observed_at);
    },
  );

  it("never converts unknown usage, elapsed resets, or cooldowns into refill evidence", () => {
    const raw = snapshot([
      { ...window("five_hour", 30_000), used_ratio: 1 },
      { ...window("weekly", null), used_ratio: null, cooldown_until: iso(30_000) },
    ]);
    const [projected] = activeQuotaSnapshotsWithConstraintFreshness([raw], observed + 60_000);
    expect(projected!.constraints).toEqual([
      { ...raw.constraints[0], freshness: "stale" },
      { ...raw.constraints[1], freshness: "fresh" },
    ]);
    const legacy = {
      snapshots: activeQuotaSnapshots([raw], observed + 60_000),
      absences: [],
      refreshed_at: null,
    };
    expect(
      withQuotaAvailability(
        { ...legacy, snapshots: [projected!] },
        { now: new Date(observed + 60_000) },
      ).snapshots[0]!.availability,
    ).toEqual(
      withQuotaAvailability(legacy, { now: new Date(observed + 60_000) }).snapshots[0]!
        .availability,
    );
  });

  it("preserves 24h retention and expired scoped cooldown pruning", () => {
    const now = observed + 25 * 3600_000;
    const raws = [
      snapshot([window("five_hour", null)]),
      snapshot([window("weekly", 7 * 86400_000)]),
      {
        ...snapshot([window("cooldown:fable", 30_000), window("cooldown:opus", 7 * 86400_000)]),
        source: "claude_api_retry" as const,
      },
    ];
    const actual = activeQuotaSnapshotsWithConstraintFreshness(raws, now);
    expect(
      actual.map((item) => ({
        ...item,
        constraints: item.constraints.map(({ freshness, ...rest }) => rest),
      })),
    ).toEqual(activeQuotaSnapshots(raws, now));
    expect(actual).toHaveLength(2);
    expect(actual[1]!.constraints.map((constraint) => constraint.id)).toEqual(["cooldown:opus"]);
    expect(
      actual
        .flatMap((item) => item.constraints)
        .every((constraint) => constraint.freshness === "stale"),
    ).toBe(true);
  });

  it.each(["fresh", "stale", "unknown"] as const)(
    "replays raw %s and reads without refresh, writes, or observation changes",
    (freshness) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "quota-freshness-")));
      let journal = new DurableJournal({ rootDir: root, partition: "global" });
      let now = observed + 60_000;
      const refresh = vi.fn(async () => ({ snapshots: [] }));
      try {
        const raw = snapshot(
          [
            { ...window("five_hour", 30_000), used_ratio: 1 },
            { ...window("weekly", 86400_000), applies_to_models: ["fable"] },
          ],
          freshness,
        );
        new QuotaRegistry(journal, [], () => new Date(observed)).upsert(raw);
        journal.close();
        journal = new DurableJournal({ rootDir: root, partition: "global" });
        const registry = new QuotaRegistry(journal, [refresh], () => new Date(now));
        const files = () =>
          Object.fromEntries(
            readdirSync(root, { recursive: true })
              .map(String)
              .filter((path) => statSync(join(root, path)).isFile())
              .map((path) => [path, readFileSync(join(root, path)).toString("base64")]),
          );
        const before = files();
        const records = structuredClone(journal.records());
        const legacy = registry.read();
        const projected = registry.readConstraintFreshness();
        expect(
          projected.snapshots[0]!.constraints.map((constraint) => constraint.freshness),
        ).toEqual(freshness === "fresh" ? ["stale", "fresh"] : [freshness, freshness]);
        expect(projected.snapshots[0]!.observed_at).toBe(raw.observed_at);
        expect(ControlQuotaResponse.parse(legacy)).toEqual(legacy);
        expect(() => ControlQuotaResponse.parse(projected)).toThrow();
        expect(() => QuotaSnapshot.parse(projected.snapshots[0])).toThrow();
        // Caller-owned projection data cannot mutate the raw registry.
        projected.snapshots[0]!.constraints[1]!.applies_to_models!.push("other");
        projected.snapshots[0]!.constraints[0]!.used_ratio = 0;
        expect(registry.read()).toEqual(legacy);
        now = observed + 300_001;
        const aged = registry.readConstraintFreshness();
        expect(aged.snapshots[0]!.constraints[1]!.freshness).toBe(
          freshness === "unknown" ? "unknown" : "stale",
        );
        expect(aged.snapshots[0]!.constraints[0]!.used_ratio).toBe(1);
        expect(aged.snapshots[0]!.observed_at).toBe(raw.observed_at);
        expect(refresh).not.toHaveBeenCalled();
        expect(journal.records()).toEqual(records);
        expect(files()).toEqual(before);
      } finally {
        journal.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("treats evidence before an account reset cutoff as historical for every window", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "quota-freshness-cutoff-")));
    let journal = new DurableJournal({ rootDir: root, partition: "global" });
    let now = observed;
    const target = { harness: "claude", profile_id: "fixture" };
    const raw = snapshot([window("five_hour", 30_000), window("weekly", 86400_000)]);
    const freshnessOf = (registry: QuotaRegistry) =>
      registry.readConstraintFreshness().snapshots.map((item) => ({
        snapshot: item.freshness,
        constraints: item.constraints.map((constraint) => constraint.freshness),
      }));
    try {
      const registry = new QuotaRegistry(journal, [], () => new Date(now));
      registry.upsert(raw);
      now = observed + 60_000;
      expect(freshnessOf(registry)).toEqual([
        { snapshot: "stale", constraints: ["stale", "fresh"] },
      ]);
      registry.invalidateAccountResources(target);
      expect(freshnessOf(registry)).toEqual([
        { snapshot: "stale", constraints: ["stale", "stale"] },
      ]);
      // A late raw-fresh delivery of the pre-reset observation stays historical.
      registry.upsert(raw);
      const retired = [{ snapshot: "stale", constraints: ["stale", "stale"] }];
      expect(freshnessOf(registry)).toEqual(retired);
      expect(registry.read().snapshots.map((item) => item.freshness)).toEqual(["stale"]);
      journal.close();
      journal = new DurableJournal({ rootDir: root, partition: "global" });
      expect(freshnessOf(new QuotaRegistry(journal, [], () => new Date(now)))).toEqual(retired);
      // A post-reset observation renews each window under its own reset again.
      const renewed = new QuotaRegistry(journal, [], () => new Date(now));
      renewed.upsert({ ...raw, observed_at: iso(60_000) });
      expect(freshnessOf(renewed)).toEqual([
        { snapshot: "stale", constraints: ["stale", "fresh"] },
      ]);
    } finally {
      journal.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
