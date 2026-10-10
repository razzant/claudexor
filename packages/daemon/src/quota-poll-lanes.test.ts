import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DurableJournal } from "./store/test-support/fixtures/legacy/journal/index.js";
import type { QuotaAbsence, QuotaSnapshot, QuotaSource, QuotaSubject } from "@claudexor/schema";
import { QuotaRegistry } from "./quota-registry.js";
import type { QuotaRefreshCycle, QuotaRefreshResult } from "./quota-poll-lanes.js";

const subjectOf = (harness: string, subjectId: string | null): QuotaSubject => ({
  harness,
  credential_route: "vendor_native",
  plan_label: null,
  subject_id: subjectId,
});

function primarySnapshot(
  subject: QuotaSubject,
  source: QuotaSource,
  observedAtMs: number,
  resetsAtMs: number | null = null,
): QuotaSnapshot {
  return {
    subject,
    constraints: [
      {
        id: "five_hour",
        label: "5 hour",
        used_ratio: 0.2,
        window_seconds: 18_000,
        resets_at: resetsAtMs === null ? null : new Date(resetsAtMs).toISOString(),
        cooldown_until: null,
      },
    ],
    source,
    observed_at: new Date(observedAtMs).toISOString(),
    freshness: "fresh",
  };
}

function absenceOf(
  subject: QuotaSubject,
  reason: QuotaAbsence["reason"],
  observedAtMs: number,
  extra: Partial<QuotaAbsence> = {},
): QuotaAbsence {
  return {
    subject,
    reason,
    detail: null,
    observed_at: new Date(observedAtMs).toISOString(),
    ...extra,
  };
}

/** Drive the daemon's 60-second poll timer for `ticks` minutes; report the
 * ticks a cycle ran on and how many ticks the healthy subject was stale.
 * With `absentReason`, assert on EVERY tick that exactly that absence is
 * stated — the sibling's absence must stay visible throughout, never only at
 * the end. */
async function driveTicks(
  registry: QuotaRegistry,
  clock: { nowMs: number },
  ticks: number,
  calls: () => number,
  healthyId: string,
  absentReason?: QuotaAbsence["reason"],
): Promise<{ cadence: number[]; staleTicks: number }> {
  const cadence: number[] = [];
  let staleTicks = 0;
  let lastCalls = calls();
  for (let tick = 0; tick < ticks; tick += 1) {
    await registry.pollStale();
    if (calls() !== lastCalls) {
      cadence.push(tick);
      lastCalls = calls();
    }
    const { snapshots, absences } = registry.read();
    const healthy = snapshots.find((s) => s.subject.subject_id === healthyId);
    if (!healthy || healthy.freshness !== "fresh") staleTicks += 1;
    if (absentReason !== undefined) {
      expect(
        absences.map((a) => a.reason),
        `tick ${tick}`,
      ).toEqual([absentReason]);
    }
    clock.nowMs += 60_000;
  }
  return { cadence, staleTicks };
}

function withJournal<T>(prefix: string, body: (journal: DurableJournal) => Promise<T>): Promise<T> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const journal = new DurableJournal({ rootDir: root, partition: "global" });
  return body(journal).finally(() => {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  });
}

describe("QuotaRegistry poll sweep: renewal is never postponed by a sibling's retry ladder (#263)", () => {
  it.each([
    ["claude", "claude_oauth_usage", "auth_revoked"],
    ["claude", "claude_oauth_usage", "not_logged_in"],
    ["codex", "codex_app_server", "not_logged_in"],
    ["codex", "codex_app_server", "refresh_failed"],
  ] as const)(
    "%s lane (%s): a healthy profile stays fresh beside a permanently %s sibling, whose absence stays stated on every tick",
    async (vendor, source, reason) =>
      withJournal("claudexor-quota-263-", async (journal) => {
        const clock = { nowMs: Date.parse("2026-09-03T17:00:00.000Z") };
        let calls = 0;
        const healthy = subjectOf(vendor, "healthy");
        const absent = subjectOf(vendor, "absent");
        const registry = new QuotaRegistry(
          journal,
          [
            {
              vendor,
              refresh: async () => {
                calls += 1;
                return {
                  snapshots: [primarySnapshot(healthy, source, clock.nowMs)],
                  absences: [absenceOf(absent, reason, clock.nowMs)],
                };
              },
            },
          ],
          () => new Date(clock.nowMs),
          () => [healthy, absent],
        );
        const { cadence, staleTicks } = await driveTicks(
          registry,
          clock,
          60,
          () => calls,
          "healthy",
          reason,
        );
        // Contract: healthy evidence is renewed on the last tick before its
        // 5-minute TTL expires — every 4–5 ticks once the retry ladder has
        // outgrown the renewal horizon — and the lane is neither pinned to the
        // 15-minute retry ceiling nor tight-polled every tick. On the tree
        // before #263 the ladder pinned this lane (poll ticks 0,1,3,7,15,30,45)
        // and the healthy snapshot was stale for 29 of these 60 ticks.
        expect(staleTicks).toBe(0);
        const gaps = cadence.slice(1).map((tick, index) => tick - cadence[index]!);
        const steady = gaps.filter((_, index) => cadence[index + 1]! >= 10);
        expect(steady.length).toBeGreaterThan(5);
        expect(steady.every((gap) => gap >= 4 && gap <= 5)).toBe(true);
      }),
  );

  it.each([
    [
      "an explicit foreground refresh",
      async (registry: QuotaRegistry): Promise<void> => {
        await registry.refresh();
      },
    ],
    [
      "an ingested harness snapshot",
      async (registry: QuotaRegistry, snapshot: QuotaSnapshot): Promise<void> => {
        registry.upsert(snapshot);
      },
    ],
  ])(
    "evidence installed by %s while the ladder is armed is renewed on time, never postponed to the rung",
    async (_kind, install) =>
      withJournal("claudexor-quota-263-armed-", async (journal) => {
        const clock = { nowMs: Date.parse("2026-09-03T17:00:00.000Z") };
        let calls = 0;
        let loggedIn = false;
        const healthy = subjectOf("claude", "healthy");
        const dead = subjectOf("claude", "dead");
        const registry = new QuotaRegistry(
          journal,
          [
            {
              vendor: "claude",
              refresh: async () => {
                calls += 1;
                return {
                  snapshots: loggedIn
                    ? [primarySnapshot(healthy, "claude_oauth_usage", clock.nowMs)]
                    : [],
                  absences: [
                    absenceOf(dead, "auth_revoked", clock.nowMs),
                    ...(loggedIn ? [] : [absenceOf(healthy, "not_logged_in", clock.nowMs)]),
                  ],
                };
              },
            },
          ],
          () => new Date(clock.nowMs),
          () => [healthy, dead],
        );
        // Absence-only polls at ticks 0, 1, 3 and 7 arm the ladder until 15.
        const armed = await driveTicks(registry, clock, 8, () => calls, "healthy");
        expect(armed.cadence).toEqual([0, 1, 3, 7]);
        // Tick 8: the user logs in; the evidence installed now is due at 13.
        loggedIn = true;
        await install(registry, primarySnapshot(healthy, "claude_oauth_usage", clock.nowMs));
        const installedCalls = calls;
        const after = await driveTicks(registry, clock, 8, () => calls, "healthy");
        // The lane renews it at tick 12, the last tick before expiry — not at
        // the ladder's 15, which left the healthy subject stale at 13 and 14
        // before #263. Ticks 8–11 stay quiet: the evidence is not due yet.
        expect(after.cadence).toEqual([4]);
        expect(calls).toBe(installedCalls + 1);
        expect(after.staleTicks).toBe(0);
      }),
  );

  it("a vendor window reset within the next tick is picked up on that tick, not at the sibling's rung", async () =>
    withJournal("claudexor-quota-263-reset-", async (journal) => {
      const clock = { nowMs: Date.parse("2026-09-03T17:00:00.000Z") };
      let calls = 0;
      const healthy = subjectOf("claude", "healthy");
      const dead = subjectOf("claude", "dead");
      // The vendor's five-hour window resets at tick 20; afterwards it reports
      // the next window. Real evidence carries `resets_at` — the renewal
      // observed on the last tick before the reset is born due at the reset.
      const resetAt = clock.nowMs + 20 * 60_000;
      const registry = new QuotaRegistry(
        journal,
        [
          {
            vendor: "claude",
            refresh: async () => {
              calls += 1;
              const window = clock.nowMs < resetAt ? resetAt : resetAt + 5 * 3_600_000;
              return {
                snapshots: [primarySnapshot(healthy, "claude_oauth_usage", clock.nowMs, window)],
                absences: [absenceOf(dead, "auth_revoked", clock.nowMs)],
              };
            },
          },
        ],
        () => new Date(clock.nowMs),
        () => [healthy, dead],
      );
      const { cadence, staleTicks } = await driveTicks(
        registry,
        clock,
        40,
        () => calls,
        "healthy",
        "auth_revoked",
      );
      // The renewal at tick 19 observes evidence that resets at 20 — due by
      // the next tick, yet observed by that very cycle, so it is renewal due
      // at 20, never ladder demand: the lane polls at 20 and the healthy
      // subject is never stale. Before this fix the ladder (rung 15) took
      // over and the healthy subject was stale from tick 20 to 33.
      expect(staleTicks).toBe(0);
      expect(cadence).toContain(19);
      expect(cadence).toContain(20);
    }));

  it("a cycle that throws keeps the renewal cap: the satisfied sibling's renewal is not postponed to the rung", async () =>
    withJournal("claudexor-quota-263-throw-", async (journal) => {
      const clock = { nowMs: Date.parse("2026-09-03T17:00:00.000Z") };
      let calls = 0;
      const healthy = subjectOf("codex", "healthy");
      const absent = subjectOf("codex", "absent");
      const registry = new QuotaRegistry(
        journal,
        [
          {
            vendor: "codex",
            refresh: async () => {
              calls += 1;
              if (calls > 1) throw new Error("app-server unreachable");
              return {
                snapshots: [primarySnapshot(healthy, "codex_app_server", clock.nowMs)],
                absences: [absenceOf(absent, "not_logged_in", clock.nowMs)],
              };
            },
          },
        ],
        () => new Date(clock.nowMs),
        () => [healthy, absent],
      );
      const { cadence } = await driveTicks(
        registry,
        clock,
        22,
        () => calls,
        "healthy",
        "not_logged_in",
      );
      // Ladder retries at 1 and 3; the renewal cap (healthy evidence due at 5)
      // brings the lane back at 4, where the pure ladder would have waited
      // until 7. That renewal attempt fails too, the evidence expires at 5 and,
      // with no satisfied evidence left to cap it, the lane continues at the
      // rung it has earned (8 minutes → 12) — never tight-polled at the due
      // instant, never abandoned.
      expect(cadence).toEqual([0, 1, 3, 4, 12]);
    }));

  it("a subject rate-limit floor never pauses a healthy sibling's renewal", async () =>
    withJournal("claudexor-quota-subject-floor-", async (journal) => {
      const clock = { nowMs: Date.parse("2026-10-04T10:00:00Z") };
      const healthy = subjectOf("claude", "healthy");
      const limited = subjectOf("claude", "limited");
      let calls = 0;
      let limitedCalls = 0;
      const registry = new QuotaRegistry(
        journal,
        [
          {
            vendor: "claude",
            refresh: async (cycle) => {
              calls += 1;
              const until = cycle?.pacing?.cooldownUntil(limited, clock.nowMs);
              if (!until) limitedCalls += 1;
              return {
                snapshots: [primarySnapshot(healthy, "claude_oauth_usage", clock.nowMs)],
                absences: [
                  absenceOf(
                    limited,
                    until ? "poll_paced" : "rate_limited",
                    clock.nowMs,
                    until ? {} : { retry_after_ms: 3_600_000 },
                  ),
                ],
              };
            },
          },
        ],
        () => new Date(clock.nowMs),
        () => [healthy, limited],
      );
      const observed = await driveTicks(registry, clock, 50, () => calls, "healthy");
      expect(limitedCalls).toBe(1);
      expect(observed.staleTicks).toBe(0);
      expect(observed.cadence).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48]);
      const refreshed = await registry.refresh();
      expect(limitedCalls).toBe(1);
      expect(refreshed.refresh_skipped?.map((row) => row.subject?.subject_id)).toEqual(["limited"]);
    }));

  it("a lane whose last satisfied subject disappears continues at the retry rung it earned", async () =>
    withJournal("claudexor-quota-263-last-healthy-", async (journal) => {
      const clock = { nowMs: Date.parse("2026-09-03T17:00:00.000Z") };
      let calls = 0;
      let healthyAlive = true;
      const healthy = subjectOf("claude", "healthy");
      const absent = subjectOf("claude", "absent");
      const registry = new QuotaRegistry(
        journal,
        [
          {
            vendor: "claude",
            refresh: async () => {
              calls += 1;
              return {
                snapshots: healthyAlive
                  ? [primarySnapshot(healthy, "claude_oauth_usage", clock.nowMs)]
                  : [],
                absences: [
                  absenceOf(absent, "not_logged_in", clock.nowMs),
                  ...(healthyAlive ? [] : [absenceOf(healthy, "not_logged_in", clock.nowMs)]),
                ],
              };
            },
          },
        ],
        () => new Date(clock.nowMs),
        () => [healthy, absent],
      );
      // Long enough for the retry ladder to sit at its 15-minute ceiling
      // while renewals keep the healthy subject fresh.
      await driveTicks(registry, clock, 40, () => calls, "healthy");
      healthyAlive = false;
      const after = await driveTicks(registry, clock, 40, () => calls, "healthy");
      // No renewal is due any more, so the ladder alone paces the lane: the
      // first retry waits out the earned rung (<= 15 minutes), the lane is
      // never tight-polled, and it is never abandoned either.
      const gaps = after.cadence.slice(1).map((tick, index) => tick - after.cadence[index]!);
      expect(after.cadence.length).toBeGreaterThanOrEqual(2);
      expect(gaps.every((gap) => gap >= 6 && gap <= 16)).toBe(true);
    }));

  it("tells every refresher whether the cycle is a foreground refresh or a background poll", async () =>
    withJournal("claudexor-quota-263-cycle-", async (journal) => {
      const clock = { nowMs: Date.parse("2026-09-03T17:00:00.000Z") };
      const seen: Array<QuotaRefreshCycle | undefined> = [];
      const healthy = subjectOf("codex", "healthy");
      const refresh = async (cycle?: QuotaRefreshCycle): Promise<QuotaRefreshResult> => {
        seen.push(cycle);
        return { snapshots: [primarySnapshot(healthy, "codex_app_server", clock.nowMs)] };
      };
      const registry = new QuotaRegistry(
        journal,
        [{ vendor: "codex", refresh }],
        () => new Date(clock.nowMs),
        () => [healthy],
      );
      await expect(registry.pollStale()).resolves.toBe(true);
      await registry.refresh();
      expect(seen.map((cycle) => cycle?.foreground)).toEqual([false, true]);
    }));
});
