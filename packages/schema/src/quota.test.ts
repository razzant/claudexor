import { describe, expect, it } from "vitest";
import {
  QUOTA_SOURCE_TRAITS,
  QuotaSource,
  quotaRefreshDemandHarnesses,
  quotaSnapshotAvailability,
  quotaSourcesProducedByRefreshers,
  withQuotaAvailability,
  type ControlQuotaResponse,
  type QuotaConstraint,
} from "./quota.js";

const NOW = new Date("2026-08-07T00:00:00.000Z");
const FUTURE = "2026-08-08T00:00:00.000Z";
const LATER = "2026-08-09T00:00:00.000Z";
const PAST = "2026-08-06T00:00:00.000Z";

function constraint(overrides: Partial<QuotaConstraint> & { id: string }): QuotaConstraint {
  return {
    label: overrides.id,
    used_ratio: null,
    window_seconds: null,
    resets_at: null,
    cooldown_until: null,
    ...overrides,
  };
}

describe("quotaSnapshotAvailability", () => {
  it("keeps one exhaustive source-trait registry with orthogonal capabilities", () => {
    expect(Object.keys(QUOTA_SOURCE_TRAITS).sort()).toEqual([...QuotaSource.options].sort());
    expect(quotaRefreshDemandHarnesses().sort()).toEqual(["agy", "claude", "codex", "grok"]);
    expect(quotaSourcesProducedByRefreshers().sort()).toEqual([
      "agy_command_usage",
      "claude_oauth_usage",
      "claude_statusline",
      "codex_app_server",
      "grok_local_usage",
    ]);
    expect(QUOTA_SOURCE_TRAITS.claude_statusline).toEqual({
      snapshotMode: "full",
      vendorAuthenticated: false,
      refreshDemandHarness: null,
      producedByRefresher: true,
    });
    expect(QUOTA_SOURCE_TRAITS.claude_api_retry).toEqual({
      snapshotMode: "full",
      vendorAuthenticated: false,
      refreshDemandHarness: null,
      producedByRefresher: false,
    });
  });

  it("a model-scoped exhaustion alone keeps state available and is disclosed", () => {
    // The exact live shape that made a consumer bury a whole claude route:
    // weekly_scoped:Fable spent while every other window is healthy.
    const availability = quotaSnapshotAvailability(
      {
        constraints: [
          constraint({ id: "five_hour", used_ratio: 0.4, resets_at: FUTURE }),
          constraint({
            id: "weekly_scoped:Fable",
            applies_to_models: ["fable", "claude-fable-5", "best"],
            used_ratio: 1,
            resets_at: FUTURE,
          }),
        ],
      },
      { now: NOW },
    );
    expect(availability.state).toBe("available");
    expect(availability.blocking_constraints).toEqual([]);
    expect(availability.resets_at).toBeNull();
    expect(availability.model_scoped_exhaustions).toEqual([
      {
        constraint_id: "weekly_scoped:Fable",
        applies_to_models: ["fable", "claude-fable-5", "best"],
        resets_at: FUTURE,
      },
    ]);
  });

  it("an unscoped exhaustion makes the subject exhausted with its reset", () => {
    const availability = quotaSnapshotAvailability(
      {
        constraints: [
          constraint({ id: "five_hour", used_ratio: 1, resets_at: FUTURE }),
          constraint({ id: "seven_day", used_ratio: 0.4, resets_at: LATER }),
        ],
      },
      { now: NOW },
    );
    expect(availability.state).toBe("exhausted");
    expect(availability.blocking_constraints).toEqual(["five_hour"]);
    expect(availability.resets_at).toBe(FUTURE);
    expect(availability.model_scoped_exhaustions).toEqual([]);
  });

  it("an unscoped active cooldown reports cooldown, and exhausted outranks it", () => {
    const cooling = quotaSnapshotAvailability(
      { constraints: [constraint({ id: "cooldown", cooldown_until: FUTURE })] },
      { now: NOW },
    );
    expect(cooling.state).toBe("cooldown");
    expect(cooling.blocking_constraints).toEqual(["cooldown"]);
    expect(cooling.resets_at).toBe(FUTURE);
    const mixed = quotaSnapshotAvailability(
      {
        constraints: [
          constraint({ id: "cooldown", cooldown_until: LATER }),
          constraint({ id: "five_hour", used_ratio: 1, resets_at: FUTURE }),
        ],
      },
      { now: NOW },
    );
    expect(mixed.state).toBe("exhausted");
    expect(mixed.blocking_constraints).toEqual(["cooldown", "five_hour"]);
    expect(mixed.resets_at).toBe(FUTURE);
  });

  it("the model parameter turns a matching scoped exhaustion into a real block", () => {
    const constraints = [
      constraint({
        id: "weekly_scoped:Fable",
        applies_to_models: ["fable", "claude-fable-5", "best"],
        used_ratio: 1,
        resets_at: FUTURE,
      }),
    ];
    // Case-insensitive containment in BOTH directions: the consumer's longer
    // route id contains the vendor alias, and a short query hits long aliases.
    for (const model of ["claude-fable-5", "Fable", "claude-fable-5[1m]"]) {
      const availability = quotaSnapshotAvailability({ constraints }, { now: NOW, model });
      expect(availability.state).toBe("exhausted");
      expect(availability.blocking_constraints).toEqual(["weekly_scoped:Fable"]);
      expect(availability.resets_at).toBe(FUTURE);
    }
    // A different model keeps the subject spendable.
    const other = quotaSnapshotAvailability({ constraints }, { now: NOW, model: "gpt-5.6-sol" });
    expect(other.state).toBe("available");
    expect(other.model_scoped_exhaustions).toHaveLength(1);
  });

  it("a scoped spent window with an unknown reset is disclosed but never blocks", () => {
    const constraints = [
      constraint({
        id: "weekly_scoped:Fable",
        applies_to_models: ["fable", "claude-fable-5", "best"],
        used_ratio: 1,
        // resets_at stays null: the vendor reported the spend without a reset.
      }),
      // A scoped spend whose reset ELAPSED is provably released: undisclosed.
      constraint({
        id: "weekly_scoped:Opus",
        applies_to_models: ["opus", "claude-opus-5", "best"],
        used_ratio: 1,
        resets_at: PAST,
      }),
    ];
    const availability = quotaSnapshotAvailability({ constraints }, { now: NOW });
    expect(availability.state).toBe("available");
    expect(availability.blocking_constraints).toEqual([]);
    expect(availability.resets_at).toBeNull();
    expect(availability.model_scoped_exhaustions).toEqual([
      {
        constraint_id: "weekly_scoped:Fable",
        applies_to_models: ["fable", "claude-fable-5", "best"],
        resets_at: null,
      },
    ]);
    // Naming the covered model does not turn stale data into a live block —
    // the BudgetLedger mirror holds even under a model-scoped query.
    const named = quotaSnapshotAvailability({ constraints }, { now: NOW, model: "claude-fable-5" });
    expect(named.state).toBe("available");
    expect(named.blocking_constraints).toEqual([]);
    expect(named.model_scoped_exhaustions).toHaveLength(1);
  });

  it("elapsed resets, unknown resets, and empty scopes stay honest", () => {
    // Spent ratio whose reset already elapsed (stale data) or is unknown does
    // not block — mirroring the router's BudgetLedger semantics.
    const stale = quotaSnapshotAvailability(
      {
        constraints: [
          constraint({ id: "elapsed", used_ratio: 1, resets_at: PAST }),
          constraint({ id: "unknown_reset", used_ratio: 1 }),
        ],
      },
      { now: NOW },
    );
    expect(stale.state).toBe("available");
    expect(stale.model_scoped_exhaustions).toEqual([]);
    // An EMPTY applies_to_models list is a vendor-wide window, not a scoped one.
    const emptyScope = quotaSnapshotAvailability(
      {
        constraints: [
          constraint({ id: "global", applies_to_models: [], used_ratio: 1, resets_at: FUTURE }),
        ],
      },
      { now: NOW },
    );
    expect(emptyScope.state).toBe("exhausted");
    expect(emptyScope.model_scoped_exhaustions).toEqual([]);
    // No constraints at all = available with nothing to disclose.
    expect(quotaSnapshotAvailability({ constraints: [] }, { now: NOW })).toEqual({
      state: "available",
      blocking_constraints: [],
      resets_at: null,
      model_scoped_exhaustions: [],
    });
  });

  it("withQuotaAvailability decorates every snapshot and leaves the rest intact", () => {
    const response: ControlQuotaResponse = {
      snapshots: [
        {
          subject: {
            harness: "claude",
            credential_route: "vendor_native",
            plan_label: null,
            subject_id: "abstractdl",
          },
          constraints: [
            constraint({
              id: "weekly_scoped:Fable",
              applies_to_models: ["fable"],
              used_ratio: 1,
              resets_at: FUTURE,
            }),
          ],
          source: "claude_oauth_usage",
          observed_at: "2026-08-07T00:00:00.000Z",
          freshness: "fresh",
        },
      ],
      absences: [],
      refreshed_at: null,
    };
    const decorated = withQuotaAvailability(response, { now: NOW });
    expect(decorated.snapshots[0]?.availability?.state).toBe("available");
    expect(decorated.snapshots[0]?.availability?.model_scoped_exhaustions).toHaveLength(1);
    expect(decorated.absences).toEqual([]);
    expect(decorated.refreshed_at).toBeNull();
    // The input response is not mutated.
    expect(response.snapshots[0]).not.toHaveProperty("availability");
    const scoped = withQuotaAvailability(response, { now: NOW, model: "fable" });
    expect(scoped.snapshots[0]?.availability?.state).toBe("exhausted");
  });

  it("decorates every source independently without mutating the raw multi-source response", () => {
    const response: ControlQuotaResponse = {
      snapshots: [
        {
          subject: {
            harness: "claude",
            credential_route: "vendor_native",
            plan_label: null,
            subject_id: "work",
          },
          constraints: [constraint({ id: "global", used_ratio: 0.4, resets_at: FUTURE })],
          source: "claude_oauth_usage",
          observed_at: NOW.toISOString(),
          freshness: "fresh",
        },
        {
          subject: {
            harness: "claude",
            credential_route: "vendor_native",
            plan_label: null,
            subject_id: "work",
          },
          constraints: [
            constraint({
              id: "fable_only",
              applies_to_models: ["fable"],
              used_ratio: 1,
              resets_at: FUTURE,
            }),
          ],
          source: "claude_statusline",
          observed_at: NOW.toISOString(),
          freshness: "fresh",
        },
      ],
      absences: [],
      refreshed_at: null,
    };
    const raw = JSON.stringify(response);
    const decorated = withQuotaAvailability(response, { now: NOW });
    expect(decorated.snapshots.map((snapshot) => snapshot.availability)).toEqual([
      expect.objectContaining({ state: "available", model_scoped_exhaustions: [] }),
      expect.objectContaining({
        state: "available",
        model_scoped_exhaustions: [expect.objectContaining({ constraint_id: "fable_only" })],
      }),
    ]);
    expect(JSON.stringify(response)).toBe(raw);
  });
});

it("declared model prefixes share blocking semantics without inventing unknown families", () => {
  const snapshot = {
    constraints: [
      constraint({
        id: "third-party",
        applies_to_model_prefixes: ["claude-", "gpt-"],
        used_ratio: 1,
        resets_at: FUTURE,
      }),
    ],
  };
  expect(quotaSnapshotAvailability(snapshot, { now: NOW, model: "claude-new-high" }).state).toBe(
    "exhausted",
  );
  expect(quotaSnapshotAvailability(snapshot, { now: NOW, model: "gemini-new-high" }).state).toBe(
    "available",
  );
  expect(quotaSnapshotAvailability(snapshot, { now: NOW }).state).toBe("available");
  expect(quotaSnapshotAvailability(snapshot, { now: NOW }).model_scoped_exhaustions).toEqual([
    {
      constraint_id: "third-party",
      applies_to_models: [],
      applies_to_model_prefixes: ["claude-", "gpt-"],
      resets_at: FUTURE,
    },
  ]);
});
