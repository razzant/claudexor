import { describe, expect, it } from "vitest";
import type { QuotaSnapshot, QuotaSubject } from "@claudexor/schema";
import {
  earliestFreshRenewalAt,
  earliestQuotaRenewalAt,
  latestQuotaRenewalObservedAt,
  remainingQuotaRefreshDemand,
} from "./quota-refresh-demand.js";
import { staleAt } from "./quota-registry-support.js";

const subject = (harness: string, subjectId: string | null): QuotaSubject => ({
  harness,
  credential_route: "vendor_native",
  plan_label: null,
  subject_id: subjectId,
});

const snapshot = (owner: QuotaSubject, source: QuotaSnapshot["source"]): QuotaSnapshot => ({
  subject: owner,
  constraints: [],
  source,
  observed_at: "2026-08-09T00:00:00.000Z",
  freshness: "fresh",
});

describe("remainingQuotaRefreshDemand", () => {
  it("ignores subjects without a refresh-capable primary harness", () => {
    expect(remainingQuotaRefreshDemand([], [subject("provider-without-source", "work")])).toEqual(
      new Set(),
    );
    expect(remainingQuotaRefreshDemand([], [subject("cursor", "work")])).toEqual(
      new Set(["cursor\0work"]),
    );
  });

  it("requires matching primary evidence rather than reactive evidence", () => {
    const owner = subject("codex", "work");
    expect(remainingQuotaRefreshDemand([snapshot(owner, "codex_rollout")], [owner])).toEqual(
      new Set(["codex\0work"]),
    );
    expect(remainingQuotaRefreshDemand([snapshot(owner, "codex_app_server")], [owner])).toEqual(
      new Set(),
    );
  });

  it("keeps current-time staleness strict while horizon demand includes TTL equality", () => {
    const owner = subject("codex", "work");
    const primary = snapshot(owner, "codex_app_server");
    const boundary = Date.parse("2026-08-09T00:05:00.000Z");

    expect(staleAt(primary, boundary).freshness).toBe("fresh");
    expect(staleAt(primary, boundary + 1).freshness).toBe("stale");
    expect(remainingQuotaRefreshDemand([primary], [owner])).toEqual(new Set());
    expect(remainingQuotaRefreshDemand([primary], [owner], boundary - 1)).toEqual(new Set());
    expect(remainingQuotaRefreshDemand([primary], [owner], boundary)).toEqual(
      new Set(["codex\0work"]),
    );
  });

  it("treats reset boundaries at or before the horizon as demand", () => {
    const owner = subject("codex", "work");
    const deadline = Date.parse("2026-08-09T00:05:00.000Z");
    const withReset = (resetsAt: string): QuotaSnapshot => ({
      ...snapshot(owner, "codex_app_server"),
      observed_at: "2026-08-09T00:04:00.000Z",
      constraints: [
        {
          id: "primary",
          label: "5 hour",
          used_ratio: 0.2,
          window_seconds: 18_000,
          resets_at: resetsAt,
          cooldown_until: null,
        },
      ],
    });

    expect(
      remainingQuotaRefreshDemand([withReset("2026-08-09T00:05:00.000Z")], [owner], deadline),
    ).toEqual(new Set(["codex\0work"]));
    expect(
      remainingQuotaRefreshDemand([withReset("2026-08-09T00:04:59.999Z")], [owner], deadline),
    ).toEqual(new Set(["codex\0work"]));
    expect(
      remainingQuotaRefreshDemand([withReset("2026-08-09T00:05:00.001Z")], [owner], deadline),
    ).toEqual(new Set());
  });

  it("preserves missing and already-stale demand", () => {
    const owner = subject("codex", "work");
    expect(remainingQuotaRefreshDemand([], [owner], Date.now())).toEqual(new Set(["codex\0work"]));
    expect(
      remainingQuotaRefreshDemand(
        [{ ...snapshot(owner, "codex_app_server"), freshness: "stale" }],
        [owner],
        Date.now(),
      ),
    ).toEqual(new Set(["codex\0work"]));
  });
});

describe("earliestQuotaRenewalAt (#263: renewal is not retry)", () => {
  const owner = subject("codex", "work");
  const observed = Date.parse("2026-08-09T00:00:00.000Z");
  const ttl = 5 * 60_000;
  const primary = snapshot(owner, "codex_app_server");

  it("names the due instant of satisfying evidence due strictly after the horizon", () => {
    expect(earliestQuotaRenewalAt([primary], [owner], observed + 60_000)).toBe(observed + ttl);
    // Evidence already due by the horizon (pre-aged, stale) is unsatisfied
    // demand for the retry ladder, never a renewal — no tight re-poll.
    expect(earliestQuotaRenewalAt([primary], [owner], observed + ttl)).toBeNull();
    expect(
      earliestQuotaRenewalAt([{ ...primary, freshness: "stale" }], [owner], observed),
    ).toBeNull();
    expect(earliestQuotaRenewalAt([], [owner], observed)).toBeNull();
  });

  it("takes the earliest of TTL and reset boundaries across satisfied subjects", () => {
    const other = subject("codex", "other");
    const withReset: QuotaSnapshot = {
      ...snapshot(other, "codex_app_server"),
      constraints: [
        {
          id: "primary",
          label: "5 hour",
          used_ratio: 0.2,
          window_seconds: 18_000,
          resets_at: "2026-08-09T00:01:30.000Z",
          cooldown_until: null,
        },
      ],
    };
    expect(earliestQuotaRenewalAt([primary, withReset], [owner, other], observed)).toBe(
      Date.parse("2026-08-09T00:01:30.000Z"),
    );
    // Past the reset boundary only the TTL of the sibling remains.
    expect(earliestQuotaRenewalAt([primary, withReset], [owner, other], observed + 100_000)).toBe(
      observed + ttl,
    );
  });

  it("ignores reactive evidence and unregistered subjects; legacy universe counts any primary", () => {
    expect(
      earliestQuotaRenewalAt([snapshot(owner, "codex_rollout")], [owner], observed),
    ).toBeNull();
    expect(earliestQuotaRenewalAt([primary], [subject("codex", "other")], observed)).toBeNull();
    expect(earliestQuotaRenewalAt([primary], [], observed)).toBeNull();
    expect(earliestQuotaRenewalAt([primary], undefined, observed)).toBe(observed + ttl);
  });
});

describe("earliestFreshRenewalAt (#263: a window reset within the next tick is renewal, not retry)", () => {
  const owner = subject("codex", "work");
  const observed = Date.parse("2026-08-09T00:00:00.000Z");
  const minute = 60_000;
  const resetting: QuotaSnapshot = {
    ...snapshot(owner, "codex_app_server"),
    constraints: [
      {
        id: "primary",
        label: "5 hour",
        used_ratio: 0.2,
        window_seconds: 18_000,
        resets_at: "2026-08-09T00:00:30.000Z",
        cooldown_until: null,
      },
    ],
  };

  it("names a reset due within (now, deadline] for evidence observed since the cycle began", () => {
    expect(
      earliestFreshRenewalAt([resetting], [owner], observed, observed, observed + minute),
    ).toBe(observed + 30_000);
    // Observed before the cycle began (pre-aged): the ladder's business.
    expect(
      earliestFreshRenewalAt([resetting], [owner], observed + 1, observed, observed + minute),
    ).toBeNull();
    // Already due, or due beyond the deadline: not this cycle's renewal.
    expect(
      earliestFreshRenewalAt([resetting], [owner], observed, observed + 30_000, observed + minute),
    ).toBeNull();
    expect(
      earliestFreshRenewalAt([resetting], [owner], observed, observed, observed + 20_000),
    ).toBeNull();
    expect(earliestFreshRenewalAt([], [owner], observed, observed, observed + minute)).toBeNull();
  });
});

describe("latestQuotaRenewalObservedAt (#263: evidence installed after the ladder was armed)", () => {
  const owner = subject("codex", "work");
  const other = subject("codex", "other");
  const observed = Date.parse("2026-08-09T00:00:00.000Z");
  const minute = 60_000;
  const ttl = 5 * minute;
  const primary = snapshot(owner, "codex_app_server");
  const later: QuotaSnapshot = {
    ...snapshot(other, "codex_app_server"),
    observed_at: "2026-08-09T00:02:00.000Z",
  };

  it("names the latest observation among evidence whose renewal falls in (after, deadline]", () => {
    const both = [primary, later];
    const owners = [owner, other];
    expect(
      latestQuotaRenewalObservedAt(
        both,
        owners,
        observed + 4.5 * minute,
        observed + ttl + 2 * minute,
      ),
    ).toBe(observed + 2 * minute);
    // Only `primary` is due by this deadline.
    expect(latestQuotaRenewalObservedAt(both, owners, observed + 4 * minute, observed + ttl)).toBe(
      observed,
    );
    // Nothing due by the deadline; evidence already due by `after` is the
    // ladder's business (unsatisfied demand), never a renewal.
    expect(
      latestQuotaRenewalObservedAt([primary], [owner], observed, observed + minute),
    ).toBeNull();
    expect(
      latestQuotaRenewalObservedAt([primary], [owner], observed + ttl, observed + ttl + minute),
    ).toBeNull();
  });

  it("ignores reactive evidence and unregistered subjects; legacy universe counts any primary", () => {
    const window = [observed + 4 * minute, observed + ttl] as const;
    expect(
      latestQuotaRenewalObservedAt([snapshot(owner, "codex_rollout")], [owner], ...window),
    ).toBeNull();
    expect(
      latestQuotaRenewalObservedAt([primary], [subject("codex", "other")], ...window),
    ).toBeNull();
    expect(latestQuotaRenewalObservedAt([primary], [], ...window)).toBeNull();
    expect(latestQuotaRenewalObservedAt([primary], undefined, ...window)).toBe(observed);
  });
});
