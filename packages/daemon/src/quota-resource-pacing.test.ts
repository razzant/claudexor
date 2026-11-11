import { describe, expect, it } from "vitest";
import { observedResourceFacet, type AccountResourceObservation } from "@claudexor/schema";
import { buildRefresherLanes, noteRefreshPacing } from "./quota-poll-lanes.js";
import { refreshCoverage, validatedRefreshBatches } from "./quota-refresh-batches.js";

const target = { harness: "cursor", profile_id: "fixture" };
const subject = {
  harness: "cursor",
  subject_id: "fixture",
  credential_route: "vendor_native" as const,
  plan_label: null,
};
const at = Date.parse("2026-10-15T12:00:00Z");
const success = (): AccountResourceObservation => ({
  target,
  balances: observedResourceFacet([], "cursor_dashboard", new Date(at + 1)),
  spending: observedResourceFacet([], "cursor_dashboard", new Date(at + 1)),
});
function lane() {
  return buildRefresherLanes([{ vendor: "cursor", refresh: async () => ({ snapshots: [] }) }])
    .lanes[0]!;
}
describe("validated resource-only refresh lifecycle", () => {
  it("counts an attempted target even when its resource read failed, not unrelated targets", () => {
    const failure = {
      target,
      balances: { ...success().balances!, value: null, last_error: "read_failed" },
    };
    const batches = validatedRefreshBatches([
      { status: "fulfilled", value: { snapshots: [], resources: [failure] } },
    ]);
    expect(refreshCoverage(batches, [])).toEqual([JSON.stringify(["cursor", "fixture"])]);
    expect(
      refreshCoverage(
        validatedRefreshBatches(
          [{ status: "fulfilled", value: { snapshots: [], resources: [failure] } }],
          { harness: "cursor", profile_id: "other" },
        ),
        [],
      ),
    ).toEqual([]);
  });
  it("resets the successful subject's ladder but retains its active Retry-After floor and sibling ladder", () => {
    const current = lane();
    const sibling = { ...subject, subject_id: "sibling" };
    current.pacer.noteRateLimited(at, 600_000, subject);
    current.pacer.noteRateLimited(at, null, sibling);
    noteRefreshPacing([current], [], [], [], at + 1, [success()]);
    expect(current.pacer.rateLimitCooldownUntil(at + 2, subject)).toBe(at + 600_000);
    current.pacer.noteRateLimited(at + 600_001, null, subject);
    current.pacer.noteRateLimited(at + 600_001, null, sibling);
    expect(current.pacer.rateLimitCooldownUntil(at + 600_001, subject)).toBe(at + 660_001);
    expect(current.pacer.rateLimitCooldownUntil(at + 600_001, sibling)).toBe(at + 720_001);
  });
  it.each(["missing", "failed", "stale", "diagnostic", "foreign_source", "foreign_target"])(
    "%s resource evidence does not reset a ladder",
    (kind) => {
      const current = lane();
      current.pacer.noteRateLimited(at, null, subject);
      const update = success();
      if (kind === "missing") delete update.spending;
      if (kind === "failed")
        update.balances = { ...update.balances!, value: null, last_error: "read_failed" };
      if (kind === "stale") update.balances!.freshness = "stale";
      if (kind === "diagnostic") {
        delete update.balances;
        delete update.spending;
        update.diagnostics = observedResourceFacet([], "cursor_dashboard", new Date(at + 1));
      }
      if (kind === "foreign_source") update.balances!.source = "fixture";
      if (kind === "foreign_target") update.target = { ...target, profile_id: "other" };
      noteRefreshPacing([current], [], [], [], at + 1, [update]);
      current.pacer.noteRateLimited(at + 61_000, null, subject);
      expect(current.pacer.rateLimitCooldownUntil(at + 61_000, subject)).toBe(at + 181_000);
    },
  );
});
