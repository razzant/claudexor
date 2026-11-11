import { describe, expect, it } from "vitest";
import { ControlQuotaResponse, QuotaSnapshot } from "./quota.js";
import { ControlQuotaFreshnessResponse, ControlQuotaReadRequest } from "./quota-read.js";
import { ControlAccountResourcesResponse, ControlQuotaQueryResponse } from "./account-resources.js";

const legacy = ControlQuotaResponse.parse({
  snapshots: [
    {
      subject: { harness: "claude", credential_route: "vendor_native" },
      source: "claude_oauth_usage",
      observed_at: "2026-10-10T12:00:00.000Z",
      freshness: "stale",
      constraints: [
        {
          id: "weekly",
          label: "Weekly",
          used_ratio: null,
          resets_at: null,
          window_seconds: 604800,
        },
      ],
    },
  ],
  refreshed_at: null,
});

describe("strict quota read negotiation", () => {
  it("keeps legacy, raw, resources, and opt-in schemas separate", () => {
    const projected = {
      ...legacy,
      snapshots: legacy.snapshots.map((snapshot) => ({
        ...snapshot,
        constraints: snapshot.constraints.map((constraint) => ({
          ...constraint,
          freshness: "fresh",
        })),
      })),
    };
    expect(ControlQuotaResponse.parse(legacy)).toEqual(legacy);
    expect(ControlQuotaFreshnessResponse.parse(projected)).toEqual(projected);
    expect(ControlQuotaQueryResponse.parse(legacy)).toEqual(legacy);
    expect(ControlQuotaQueryResponse.parse(projected)).toEqual(projected);
    expect(() => ControlQuotaResponse.parse(projected)).toThrow();
    expect(() => QuotaSnapshot.parse(projected.snapshots[0])).toThrow();
    expect(() => ControlQuotaFreshnessResponse.parse(legacy)).toThrow();
    for (const freshness of [null, "expired", 0]) {
      const invalid = structuredClone(projected);
      Object.assign(invalid.snapshots[0]!.constraints[0]!, { freshness });
      expect(() => ControlQuotaQueryResponse.parse(invalid)).toThrow();
    }
    const unknownField = structuredClone(projected);
    Object.assign(unknownField.snapshots[0]!.constraints[0]!, { refill: true });
    expect(() => ControlQuotaQueryResponse.parse(unknownField)).toThrow();
    // The two opt-in views are distinct whole shapes, never combined.
    const resources = { ...legacy, resources: [] };
    expect(ControlQuotaQueryResponse.parse(resources)).toEqual(resources);
    expect(() => ControlQuotaFreshnessResponse.parse(resources)).toThrow();
    expect(() => ControlAccountResourcesResponse.parse(projected)).toThrow();
    expect(() => ControlQuotaQueryResponse.parse({ ...projected, resources: [] })).toThrow();
  });

  it("accepts only the explicit supported selectors", () => {
    expect(ControlQuotaReadRequest.parse({})).toEqual({});
    for (const view of ["constraint_freshness", "resources", "resources_freshness"] as const) {
      expect(ControlQuotaReadRequest.parse({ view })).toEqual({ view });
      const image = { view, requestKind: "image", model: "gpt-image-2" };
      expect(ControlQuotaReadRequest.parse(image)).toEqual(image);
    }
    for (const input of [
      { requestKind: "future" },
      { model: "" },
      { target: { harness: "codex", profile_id: "work" } },
    ])
      expect(() => ControlQuotaReadRequest.parse(input)).toThrow();
    for (const input of [{ view: "" }, { view: "future" }, { view: null }, { extra: true }]) {
      expect(() => ControlQuotaReadRequest.parse(input)).toThrow();
    }
  });

  it("rejects partial explicit metadata across constraints or snapshots instead of downgrading", () => {
    const snapshot = legacy.snapshots[0]!;
    const explicit = {
      ...snapshot,
      constraints: [
        { ...snapshot.constraints[0]!, freshness: "fresh" },
        { ...snapshot.constraints[0]!, id: "five_hour", freshness: "stale" },
      ],
    };
    const complete = { ...legacy, snapshots: [explicit, explicit] };
    expect(ControlQuotaQueryResponse.parse(complete)).toEqual(complete);
    const missingSibling = structuredClone(complete);
    Reflect.deleteProperty(missingSibling.snapshots[0]!.constraints[1]!, "freshness");
    const missingSnapshot = { ...legacy, snapshots: [explicit, snapshot] };
    for (const partial of [missingSibling, missingSnapshot]) {
      expect(ControlQuotaQueryResponse.safeParse(partial).success).toBe(false);
      expect(ControlQuotaResponse.safeParse(partial).success).toBe(false);
      expect(ControlQuotaFreshnessResponse.safeParse(partial).success).toBe(false);
    }
    // A completely legacy response is accepted as-is; missing nested metadata
    // cannot upgrade stale aggregate evidence or fabricate fresh windows.
    expect(ControlQuotaQueryResponse.parse(legacy)).toEqual(legacy);
    expect(ControlQuotaQueryResponse.parse(legacy).snapshots[0]!.freshness).toBe("stale");
    expect(ControlQuotaQueryResponse.parse(legacy).snapshots[0]!.constraints[0]).not.toHaveProperty(
      "freshness",
    );
  });
});
