import { describe, expect, it, vi } from "vitest";
import {
  ControlQuotaFreshnessResponse,
  emptyResourceFacet,
  observedResourceFacet,
  type AccountResourceSnapshot,
  type ControlQuotaResponse,
  type QuotaFreshness,
} from "@claudexor/schema";
import { quotaControlServices } from "./quota-services.js";

const raw: ControlQuotaResponse = {
  snapshots: [
    {
      subject: {
        harness: "claude",
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: "work",
      },
      constraints: [
        {
          id: "fable_only",
          label: "7 day (Fable)",
          applies_to_models: ["fable"],
          used_ratio: 1,
          window_seconds: 604_800,
          resets_at: "2099-08-09T00:00:00.000Z",
          cooldown_until: null,
        },
      ],
      source: "claude_oauth_usage",
      observed_at: "2026-08-09T00:00:00.000Z",
      freshness: "fresh",
    },
  ],
  absences: [],
  refreshed_at: null,
};

describe("quotaControlServices", () => {
  it.each([undefined, "resources", "constraint_freshness", "resources_freshness"] as const)(
    "keeps image quota visible and scoped across the %s read view",
    async (view) => {
      const mixed = structuredClone(raw);
      mixed.snapshots[0]!.constraints = [
        {
          ...raw.snapshots[0]!.constraints[0]!,
          id: "text",
          applies_to_models: null,
          applies_to_request_kinds: ["text"],
          used_ratio: 0.2,
        },
        {
          ...raw.snapshots[0]!.constraints[0]!,
          id: "image",
          applies_to_models: ["gpt-image-2"],
          applies_to_request_kinds: ["image"],
        },
      ];
      const projected = {
        ...mixed,
        snapshots: mixed.snapshots.map((snapshot) => ({
          ...snapshot,
          constraints: snapshot.constraints.map((constraint) => ({
            ...constraint,
            freshness: "fresh" as const,
          })),
        })),
      };
      const registry = {
        read: () => mixed,
        readResources: () => [],
        readConstraintFreshness: () => projected,
        refresh: vi.fn(async () => mixed),
        refreshResources: vi.fn(async () => ({ ...mixed, resources: [] })),
      };
      const services = quotaControlServices(() => registry as never);
      const text = await services.quota({ view });
      const image = await services.quota({ view, requestKind: "image", model: "gpt-image-2" });
      expect(text.snapshots[0]!.availability?.state).toBe("available");
      expect(image.snapshots[0]!.availability).toMatchObject({
        state: "exhausted",
        blocking_constraints: ["image"],
      });
      expect(image.snapshots[0]!.constraints).toHaveLength(2);
      expect(image.snapshots[0]!.constraints[1]!.applies_to_request_kinds).toEqual(["image"]);
      if (view === "constraint_freshness")
        expect(
          ControlQuotaFreshnessResponse.parse(image).snapshots[0]!.constraints[1]!.freshness,
        ).toBe("fresh");
      if (view === "resources") expect(image).toHaveProperty("resources", []);
      const other = await services.quota({ view, requestKind: "image", model: "different-model" });
      expect(other.snapshots[0]!.availability?.state).toBe("available");
      const refreshed = await services.refreshQuota({
        ...(view === "resources" ? { view } : {}),
        requestKind: "image",
        model: "gpt-image-2",
      });
      expect(refreshed.snapshots[0]!.availability?.state).toBe("exhausted");
      expect(mixed.snapshots[0]).not.toHaveProperty("availability");
      expect(mixed.snapshots[0]!.constraints[0]).not.toHaveProperty("freshness");
    },
  );

  it("decorates cheap and refreshed responses without changing registry-owned raw quota", async () => {
    const read = vi.fn(() => raw);
    const refresh = vi.fn(async () => raw);
    const services = quotaControlServices(() => ({ read, refresh }) as never);

    const cheap = await services.quota();
    const full = await services.refreshQuota({ model: "fable" });
    expect(cheap.snapshots[0]?.availability).toMatchObject({
      state: "available",
      blocking_constraints: [],
      model_scoped_exhaustions: [expect.objectContaining({ constraint_id: "fable_only" })],
    });
    expect(full.snapshots[0]?.availability).toMatchObject({
      state: "exhausted",
      blocking_constraints: ["fable_only"],
    });
    expect(raw.snapshots[0]).not.toHaveProperty("availability");
    expect(read).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("uses the passive raw-evidence projection only for an explicit read selector", async () => {
    const projected = {
      ...raw,
      snapshots: raw.snapshots.map((snapshot) => ({
        ...snapshot,
        constraints: snapshot.constraints.map((constraint) => ({
          ...constraint,
          freshness: "fresh" as const,
        })),
      })),
    };
    const read = vi.fn(() => raw);
    const readConstraintFreshness = vi.fn(() => projected);
    const refresh = vi.fn(async () => raw);
    const services = quotaControlServices(
      () => ({ read, readConstraintFreshness, refresh }) as never,
    );
    const response = await services.quota({ view: "constraint_freshness" });
    expect(response.snapshots[0]!.constraints[0]).toMatchObject({ freshness: "fresh" });
    expect(response.snapshots[0]!.availability).toBeDefined();
    expect(readConstraintFreshness).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    const legacy = await services.quota();
    expect(legacy.snapshots[0]!.constraints[0]).not.toHaveProperty("freshness");
    expect(read).toHaveBeenCalledOnce();
    await expect(services.quota({ view: "future" } as never)).rejects.toThrow();
    expect(refresh).not.toHaveBeenCalled();
    expect(raw.snapshots[0]!.constraints[0]).not.toHaveProperty("freshness");
  });

  it.each([
    ["fresh", "fresh", "fresh"],
    ["fresh", "stale", "stale"],
    ["stale", "fresh", "fresh"],
    ["unknown", "fresh", "unknown"],
  ] as const)(
    "dates the compatibility reset-credit label by its resets facet: snapshot %s, facet %s",
    async (aggregate, facet, expected) => {
      const at = new Date("2026-10-10T12:00:00.000Z");
      const window = (freshness: QuotaFreshness) => ({
        id: "weekly",
        label: "Weekly",
        used_ratio: 0.4,
        window_seconds: 604_800,
        resets_at: "2099-10-17T12:00:00.000Z",
        cooldown_until: null,
        freshness,
      });
      const codex = {
        subject: {
          harness: "codex",
          credential_route: "vendor_native" as const,
          plan_label: null,
          subject_id: "work",
        },
        source: "codex_app_server" as const,
        observed_at: at.toISOString(),
        freshness: aggregate,
        constraints: [window(aggregate), { ...window(aggregate), id: "reset_credits" }],
      };
      const projected: ControlQuotaFreshnessResponse = {
        snapshots: [codex],
        absences: [],
        refreshed_at: null,
      };
      const resets = observedResourceFacet(
        [
          {
            id: "codex_granted",
            kind: "granted_reset" as const,
            label: "Granted reset",
            description: null,
            available_count: 2,
            eligible: null,
            usable_now: null,
            reason: null,
            resets_at: null,
            weekly_limit_applies: false,
            grants: null,
          },
        ],
        "codex_app_server",
        at,
      );
      const resources: AccountResourceSnapshot[] = [
        {
          target: { harness: "codex", profile_id: "work" },
          balances: emptyResourceFacet(),
          spending: emptyResourceFacet(),
          resets: { ...resets, freshness: facet },
          diagnostics: emptyResourceFacet(),
        },
      ];
      const stripped: ControlQuotaResponse = {
        ...projected,
        snapshots: [
          {
            ...codex,
            constraints: codex.constraints.map(({ freshness: _freshness, ...rest }) => rest),
          },
        ],
      };
      const registry = {
        read: () => stripped,
        readConstraintFreshness: () => structuredClone(projected),
        readResources: () => resources,
      };
      const services = quotaControlServices(() => registry as never);
      const opted = ControlQuotaFreshnessResponse.parse(
        await services.quota({ view: "constraint_freshness" }),
      );
      const combined = await services.quota({ view: "resources_freshness" });
      expect(combined.snapshots).toEqual(opted.snapshots);
      expect(combined).toMatchObject({
        resources,
        availability_scope: { basis: "quota_block", model: null, requestKind: "text" },
      });
      expect(
        combined.snapshots[0]!.constraints.filter(
          (constraint) => constraint.id === "reset_credits",
        ),
      ).toHaveLength(1);
      const legacy = await services.quota();
      expect(opted.snapshots[0]!.constraints).toEqual([
        window(aggregate),
        {
          id: "reset_credits",
          label: "2 reset credits available",
          used_ratio: null,
          window_seconds: null,
          resets_at: null,
          cooldown_until: null,
          freshness: expected,
        },
      ]);
      // Removing only constraint freshness yields the exact legacy response.
      expect({
        ...opted,
        snapshots: opted.snapshots.map((snapshot) => ({
          ...snapshot,
          constraints: snapshot.constraints.map(({ freshness: _freshness, ...rest }) => rest),
        })),
      }).toEqual(legacy);
    },
  );
});
