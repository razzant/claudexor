import { describe, expect, it, vi } from "vitest";
import {
  ControlAccountResourcesFreshnessResponse,
  ControlQuotaQueryResponse,
  ControlQuotaResponse,
  ControlQuotaFreshnessResponse,
  emptyResourceFacet,
} from "@claudexor/schema";
import { quotaControlServices } from "./quota-services.js";

const at = "2099-10-15T12:00:00Z";
function registry() {
  const snapshot = {
    subject: {
      harness: "agy",
      credential_route: "vendor_native",
      subject_id: "one",
      plan_label: null,
    },
    source: "agy_command_usage",
    observed_at: at,
    freshness: "stale",
    constraints: [
      {
        id: "3p",
        label: "Weekly third party",
        applies_to_models: ["old-model"],
        applies_to_model_prefixes: ["claude-opus-"],
        applies_to_request_kinds: ["text"],
        used_ratio: 1,
        window_seconds: 604800,
        resets_at: "2099-10-22T12:00:00Z",
        cooldown_until: null,
        freshness: "fresh",
      },
      {
        id: "gemini",
        label: "Gemini",
        applies_to_model_prefixes: ["gemini-"],
        used_ratio: null,
        window_seconds: null,
        resets_at: null,
        cooldown_until: null,
        freshness: "unknown",
      },
    ],
  };
  const projected = { snapshots: [snapshot], absences: [], refreshed_at: null };
  const resources = [
    {
      target: { harness: "agy", profile_id: "one" },
      balances: emptyResourceFacet(),
      spending: emptyResourceFacet(),
      resets: {
        ...emptyResourceFacet(),
        value: [],
        source: "fixture",
        observed_at: at,
        freshness: "stale",
      },
      diagnostics: emptyResourceFacet(),
    },
  ];
  return {
    readConstraintFreshness: vi.fn(() => structuredClone(projected)),
    readResources: vi.fn(() => structuredClone(resources)),
    refresh: vi.fn(),
    read: vi.fn(),
  };
}
describe("complete passive resources/freshness negotiation", () => {
  it("echoes exact scope, keeps all independent dates, and never refreshes or reads the legacy projection", async () => {
    const r = registry(),
      svc = quotaControlServices(() => r as never);
    const response = ControlAccountResourcesFreshnessResponse.parse(
      await svc.quota({
        view: "resources_freshness",
        model: "claude-opus-future",
        requestKind: "text",
      }),
    );
    expect(response.availability_scope).toEqual({
      basis: "quota_block",
      model: "claude-opus-future",
      requestKind: "text",
    });
    expect(response.snapshots[0]!.availability?.state).toBe("exhausted");
    expect(response.snapshots[0]!.constraints.map((c) => c.freshness)).toEqual([
      "fresh",
      "unknown",
    ]);
    expect(response.snapshots[0]!.freshness).toBe("stale");
    expect(response.resources[0]!.resets.freshness).toBe("stale");
    expect(response.resources[0]!.balances.value).toBeNull();
    expect(r.refresh).not.toHaveBeenCalled();
    expect(r.read).not.toHaveBeenCalled();
    expect(ControlQuotaQueryResponse.parse(response)).toEqual(response);
    expect(ControlQuotaResponse.safeParse(response).success).toBe(false);
    expect(ControlQuotaFreshnessResponse.safeParse(response).success).toBe(false);
    const { availability_scope: _, ...noEcho } = response;
    expect(ControlQuotaQueryResponse.safeParse(noEcho).success).toBe(false);
    const noWindow = structuredClone(response);
    delete (noWindow.snapshots[0]!.constraints[0] as any).freshness;
    expect(ControlQuotaQueryResponse.safeParse(noWindow).success).toBe(false);
  });
  it("defaults the echo without claiming a requested model and separates request kinds", async () => {
    const svc = quotaControlServices(() => registry() as never);
    const read = async (scope = {}) =>
      ControlAccountResourcesFreshnessResponse.parse(
        await svc.quota({ view: "resources_freshness", ...scope }),
      );
    expect((await read()).availability_scope).toEqual({
      basis: "quota_block",
      model: null,
      requestKind: "text",
    });
    expect((await read({ model: "gemini-future" })).snapshots[0]!.availability?.state).toBe(
      "available",
    );
    expect(
      (await read({ model: "claude-opus-future", requestKind: "image" })).snapshots[0]!.availability
        ?.state,
    ).toBe("available");
  });
});
