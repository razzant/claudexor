import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DurableJournal } from "./store/test-support/fixtures/legacy/journal/index.js";
import { quotaSnapshotIdentity, type QuotaConstraint, type QuotaSnapshot } from "@claudexor/schema";
import { QuotaRegistry } from "./quota-registry.js";
import { journalFoldPolicy } from "./journal-fold-policy.js";
import { remainingQuotaRefreshDemand } from "./quota-refresh-demand.js";

const roots: string[] = [];
const journals: DurableJournal[] = [];
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const NOW = Date.parse("2026-10-04T00:00:00Z");
const subject = {
  harness: "claude",
  credential_route: "vendor_native" as const,
  subject_id: "work",
  plan_label: null,
};
const window = (id: string, used_ratio = 0.2): QuotaConstraint => ({
  id,
  label: id,
  used_ratio,
  window_seconds: id === "five_hour" ? 18000 : 604800,
  resets_at: "2026-10-05T00:00:00Z",
  cooldown_until: null,
});
const partial = (id: string, at = NOW, ratio = 0.2): QuotaSnapshot => ({
  subject,
  source: "claude_rate_limit_event",
  observed_at: new Date(at).toISOString(),
  freshness: "fresh",
  constraints: [window(id, ratio)],
});
function open(root?: string, folded = false): DurableJournal {
  if (!root) {
    root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-window-observations-")));
    roots.push(root);
  }
  const journal = new DurableJournal({
    rootDir: root,
    partition: "global",
    fold: folded ? journalFoldPolicy : undefined,
    deferCompaction: true,
  });
  journals.push(journal);
  return journal;
}

describe("incremental quota observations", () => {
  it("preserves siblings and their own ages while replacing one window", () => {
    let now = NOW;
    const journal = open();
    const registry = new QuotaRegistry(journal, [], () => new Date(now));
    registry.upsert(partial("seven_day"));
    now += 240000;
    registry.upsert(partial("five_hour", now));
    now += 120000;
    registry.upsert(partial("five_hour", now, 0.6));
    const rows = registry.read().snapshots;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.constraints[0]?.id === "seven_day")).toMatchObject({
      observed_at: new Date(NOW).toISOString(),
      freshness: "stale",
    });
    expect(rows.find((r) => r.constraints[0]?.id === "five_hour")).toMatchObject({
      observed_at: new Date(now).toISOString(),
      freshness: "fresh",
      constraints: [{ used_ratio: 0.6 }],
    });
    expect(
      journal.records(0, ["quota.snapshot.upserted", "quota.snapshot.scoped_prepared"]),
    ).toEqual([]);
    expect(journal.records(0, ["quota.window.observed"])).toHaveLength(3);
  });

  it("splits an incremental batch once but still replaces a full source inventory", () => {
    const registry = new QuotaRegistry(open(), [], () => new Date(NOW));
    registry.upsert({
      ...partial("five_hour"),
      constraints: [window("five_hour"), window("seven_day")],
    });
    expect(registry.read().snapshots).toHaveLength(2);
    registry.upsert({
      ...partial("five_hour"),
      source: "claude_oauth_usage",
      constraints: [window("five_hour"), window("seven_day")],
    });
    registry.upsert({ ...partial("five_hour"), source: "claude_oauth_usage", constraints: [] });
    expect(registry.read().snapshots).toHaveLength(3);
    expect(
      registry.read().snapshots.find((r) => r.source === "claude_oauth_usage")?.constraints,
    ).toEqual([]);
  });

  it.each(["refresh_failed", "rate_limited", "probe_skipped_rate_limited"] as const)(
    "a partial observation does not hide %s or satisfy full demand",
    async (reason) => {
      const registry = new QuotaRegistry(
        open(),
        [
          async () => ({
            snapshots: [],
            absences: [
              {
                subject,
                reason,
                observed_at: new Date(NOW).toISOString(),
                detail: "full read did not answer",
                ...(reason === "rate_limited" ? { retry_after_ms: 3600000 } : {}),
              },
            ],
          }),
        ],
        () => new Date(NOW),
        () => [subject],
      );
      registry.upsert(partial("five_hour"));
      const result = await registry.refresh();
      expect(result.snapshots).toHaveLength(1);
      expect(result.absences[0]?.reason).toBe(reason);
      expect(remainingQuotaRefreshDemand(result.snapshots, [subject]).size).toBe(1);
      registry.upsert({ ...partial("five_hour"), source: "claude_oauth_usage" });
      expect(registry.read().absences).toEqual([]);
      expect(remainingQuotaRefreshDemand(registry.read().snapshots, [subject]).size).toBe(0);
    },
  );

  it("preserves a persisted polling floor even when a fresh partial window arrives", () => {
    const registry = new QuotaRegistry(
      open(),
      [{ vendor: "claude", refresh: async () => ({ snapshots: [] }) }],
      () => new Date(NOW),
      () => [subject],
      { load: () => NOW + 3600000 },
    );
    registry.upsert(partial("five_hour"));
    expect(registry.read().absences[0]?.reason).toBe("poll_paced");
  });

  it("replays and folds independent windows, retiring them on remove/recreate", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-window-replay-")));
    roots.push(root);
    const first = open(root);
    const registry = new QuotaRegistry(first, [], () => new Date(NOW));
    registry.upsert(partial("five_hour"));
    registry.upsert(partial("seven_day"));
    registry.upsert(partial("five_hour", NOW + 1000, 0.7));
    const expected = registry.read();
    first.close();
    const folded = open(root, true);
    const reconstructed = new QuotaRegistry(folded, [], () => new Date(NOW)).read();
    // As for full sources, arrays use Map insertion order, not positional authority.
    const ordered = (rows: QuotaSnapshot[]) =>
      [...rows].sort((a, b) => quotaSnapshotIdentity(a).localeCompare(quotaSnapshotIdentity(b)));
    expect(ordered(reconstructed.snapshots)).toEqual(ordered(expected.snapshots));
    expect(reconstructed.absences).toEqual(expected.absences);
    expect(folded.records(0, ["quota.window.observed"])).toHaveLength(2);
    await folded.compactInBackground({ stagingDir: join(root, "compaction") });
    const current = new QuotaRegistry(folded, [], () => new Date(NOW));
    current.removeSubject("claude", "work");
    current.upsert(partial("seven_day", NOW + 2000, 0.9));
    folded.close();
    const replayed = new QuotaRegistry(open(root, true), [], () => new Date(NOW));
    expect(replayed.read().snapshots).toHaveLength(1);
    expect(replayed.read().snapshots[0]?.constraints[0]?.used_ratio).toBe(0.9);
  });

  it("attributes incremental events to the managed profile and preserves each window", () => {
    const registry = new QuotaRegistry(open(), [], () => new Date(NOW));
    registry.ingest("claude", {
      type: "status",
      session_id: "s",
      ts: new Date(NOW).toISOString(),
      credential_route: "vendor_native",
      credential_profile_id: "exact-profile",
      quota: {
        source: "claude_rate_limit_event",
        plan_label: null,
        subject_id: "native-guess",
        constraints: [window("five_hour"), window("seven_day")],
      },
    });
    expect(registry.read().snapshots).toHaveLength(2);
    expect(
      registry.read().snapshots.every((row) => row.subject.subject_id === "exact-profile"),
    ).toBe(true);
  });
});
