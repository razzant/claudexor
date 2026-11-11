import { describe, expect, it } from "vitest";
import { REOPENING_UNKNOWN_COOLDOWN_ID, quotaSnapshotAvailability } from "@claudexor/schema";
import type { QuotaConstraint, QuotaSnapshot } from "@claudexor/schema";
import { withoutSupersededQuotaConstraints } from "./quota-registry-support.js";

const now = new Date("2026-10-04T12:00:00Z");
const reset = "2026-10-11T12:00:00Z";
const oldTime = "2026-10-04T11:59:00Z";
const window = (id: string, extra: Partial<QuotaConstraint> = {}): QuotaConstraint => ({
  id,
  label: id,
  used_ratio: 0.2,
  window_seconds: 300 * 60,
  resets_at: reset,
  cooldown_until: null,
  ...extra,
});
const cooldown = window("cooldown", { used_ratio: null, cooldown_until: reset });
const snapshot = (extra: Partial<QuotaSnapshot> = {}): QuotaSnapshot => ({
  subject: {
    harness: "codex",
    credential_route: "vendor_native",
    subject_id: "work",
    plan_label: "pro",
  },
  source: "codex_rollout",
  observed_at: oldTime,
  freshness: "fresh",
  constraints: [cooldown],
  ...extra,
});
const primary = (extra: Partial<QuotaSnapshot> = {}): QuotaSnapshot =>
  snapshot({
    source: "codex_app_server",
    observed_at: now.toISOString(),
    constraints: [window("codex:primary")],
    ...extra,
  });

describe("primary quota recovery", () => {
  it("retires a generic refusal after an early reset, without waiting for or advancing its date", () => {
    const old = snapshot();
    const current = primary({ constraints: [window("codex:primary", { resets_at: reset })] });
    const recovered = withoutSupersededQuotaConstraints(old, current, now);
    expect(recovered.constraints).toEqual([]);
    expect(recovered.observed_at).toBe(oldTime);
    expect(old.constraints).toEqual([cooldown]);
    expect(current.constraints[0]?.used_ratio).toBe(0.2);
  });

  it.each([{ constraints: [] }, { constraints: [window("codex:primary", { used_ratio: null })] }])(
    "recognized successful unknown quota permits the next attempt without inventing usage: %j",
    ({ constraints }) => {
      const current = primary({ constraints });
      expect(withoutSupersededQuotaConstraints(snapshot(), current, now).constraints).toEqual([]);
      expect(current.constraints).toEqual(constraints);
    },
  );

  it.each([
    primary({ freshness: "unknown" }),
    primary({ freshness: "stale" }),
    primary({ observed_at: oldTime }),
    primary({ observed_at: "2026-10-04T11:58:00Z" }),
    primary({ observed_at: "2026-10-04T10:00:00Z" }),
    primary({ source: "codex_rollout" }),
    primary({ source: "claude_oauth_usage" }),
    primary({ constraints: [window("codex:primary", { resets_at: oldTime })] }),
  ])("does not accept late, stale or non-primary evidence: %j", (current) => {
    const old = snapshot();
    expect(withoutSupersededQuotaConstraints(old, current, now)).toBe(old);
  });

  it.each([
    { subject_id: "other" },
    { subject_id: null },
    { credential_route: "managed_api_key" as const },
    { harness: "claude" },
  ])("does not cross credential identity or route: %j", (subject) => {
    const old = snapshot();
    const current = primary({ subject: { ...old.subject, ...subject } });
    expect(withoutSupersededQuotaConstraints(old, current, now)).toBe(old);
  });

  it.each([
    window("codex:primary", { used_ratio: 1 }),
    window("throughput", { cooldown_until: reset }),
    window("model", { used_ratio: 1, applies_to_models: ["model-one"] }),
  ])("keeps the new known limit after retiring the older generic refusal: %j", (limit) => {
    const current = primary({ constraints: [limit] });
    expect(withoutSupersededQuotaConstraints(snapshot(), current, now).constraints).toEqual([]);
    expect(current.constraints).toEqual([limit]);
    expect(
      quotaSnapshotAvailability(current, { now, model: limit.applies_to_models?.[0] }).state,
    ).not.toBe("available");
    if (limit.applies_to_models)
      expect(quotaSnapshotAvailability(current, { now, model: "other" }).state).toBe("available");
  });

  it("retires only the exact measured native window and preserves independent constraints", () => {
    const spent = window("primary", { used_ratio: 1 });
    const independent = window("throughput", { cooldown_until: reset });
    const scoped = window("cooldown:model-window", {
      applies_to_models: ["model-one"],
      cooldown_until: reset,
    });
    const old = snapshot({ constraints: [cooldown, spent, independent, scoped] });
    expect(withoutSupersededQuotaConstraints(old, primary(), now).constraints).toEqual([
      independent,
      scoped,
    ]);
  });

  it.each(["codex:primary", "default:primary", "primary"])(
    "recognizes the known native window spelling %s",
    (id) => {
      const old = snapshot({ constraints: [window("primary", { used_ratio: 1 })] });
      expect(
        withoutSupersededQuotaConstraints(old, primary({ constraints: [window(id)] }), now)
          .constraints,
      ).toEqual([]);
    },
  );

  it("does not conflate a review bucket with the native default or missing windows with recovery", () => {
    const old = snapshot({ constraints: [window("primary", { used_ratio: 1 })] });
    for (const constraints of [
      [],
      [window("review:primary")],
      [window("codex:primary", { used_ratio: null })],
    ]) {
      expect(withoutSupersededQuotaConstraints(old, primary({ constraints }), now)).toBe(old);
    }
  });

  it("requires the same model scope for a known cooldown, preserving every other scope", () => {
    const old = snapshot({
      constraints: [
        window("cooldown:known", { applies_to_models: ["a", "b"], cooldown_until: reset }),
      ],
    });
    const unrelated = primary({ constraints: [window("known", { applies_to_models: ["a"] })] });
    expect(withoutSupersededQuotaConstraints(old, unrelated, now)).toBe(old);
    const matching = primary({ constraints: [window("known", { applies_to_models: ["b", "a"] })] });
    expect(withoutSupersededQuotaConstraints(old, matching, now).constraints).toEqual([]);
  });

  describe("a usage refusal with no reopening time (#558) outlives every read (#318)", () => {
    // The engine's own bounded recheck: five minutes after the refusal.
    const recheck = "2026-10-04T12:04:00Z";
    const refusal = window(REOPENING_UNKNOWN_COOLDOWN_ID, {
      used_ratio: null,
      window_seconds: null,
      resets_at: null,
      cooldown_until: recheck,
      applies_to_request_kinds: ["text"],
    });
    const refused = (extra: Partial<QuotaSnapshot> = {}) =>
      snapshot({ constraints: [refusal], ...extra });
    const justBefore = new Date(Date.parse(recheck) - 1);

    it.each([
      { constraints: [window("codex:primary")] },
      { constraints: [window("codex:primary", { used_ratio: null })] },
      { constraints: [window("review:primary", { used_ratio: 0.1 })] },
      { constraints: [] },
    ])("a newer recognized read neither retires nor moves it: %j", ({ constraints }) => {
      const old = refused();
      expect(withoutSupersededQuotaConstraints(old, primary({ constraints }), now)).toBe(old);
      expect(old.constraints).toEqual([refusal]);
      expect(quotaSnapshotAvailability(old, { now: justBefore }).state).not.toBe("available");
      // Its own recheck alone ends the block; the row may then try again.
      expect(quotaSnapshotAvailability(old, { now: new Date(recheck) }).state).toBe("available");
    });

    it("keeps a newer spent window's own date beside it", () => {
      const spent = window("codex:primary", { used_ratio: 1 });
      const current = primary({ constraints: [spent] });
      expect(withoutSupersededQuotaConstraints(refused(), current, now).constraints).toEqual([
        refusal,
      ]);
      expect(quotaSnapshotAvailability(current, { now })).toMatchObject({
        state: "exhausted",
        resets_at: reset,
      });
    });

    it("only a generic refusal beside it yields to the same read", () => {
      const old = snapshot({ constraints: [cooldown, refusal] });
      expect(
        withoutSupersededQuotaConstraints(old, primary({ constraints: [] }), now).constraints,
      ).toEqual([refusal]);
    });

    it("a model-scoped refusal is kept even by a measured read of its own scope", () => {
      const scoped = { ...refusal, applies_to_models: ["model-one"] };
      const old = refused({ constraints: [scoped] });
      const measured = primary({
        constraints: [window("reopening_unknown", { applies_to_models: ["model-one"] })],
      });
      expect(withoutSupersededQuotaConstraints(old, measured, now)).toBe(old);
    });
  });

  it("does not let a successful read erase a refusal observed after the request began", () => {
    const old = snapshot({ observed_at: "2026-10-04T11:59:50Z" });
    const inFlight = primary({ observed_at: "2026-10-04T11:59:40Z" });
    expect(withoutSupersededQuotaConstraints(old, inFlight, now)).toBe(old);
  });
});
