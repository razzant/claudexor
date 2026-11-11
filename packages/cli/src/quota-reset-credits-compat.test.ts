import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCodexAccountResources, parseCodexRateLimitsResponse } from "@claudexor/harness-codex";
import {
  emptyResourceFacet,
  AccountResourceSnapshot,
  ControlAccountResourcesFreshnessResponse,
} from "@claudexor/schema";
import { quotaControlServices } from "./quota-services.js";

const at = new Date("2026-10-15T13:00:00Z");
function producer(count: number | null) {
  const observation = parseCodexAccountResources(
    { rateLimitResetCredits: { availableCount: count, credits: null } },
    "fixture",
    at,
  );
  const resources = [
    AccountResourceSnapshot.parse({
      balances: emptyResourceFacet(),
      spending: emptyResourceFacet(),
      resets: emptyResourceFacet(),
      diagnostics: emptyResourceFacet(),
      ...observation,
    }),
  ];
  const raw = {
    snapshots: parseCodexRateLimitsResponse(
      {
        rateLimits: {
          primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1792072800 },
        },
      },
      at,
      "fixture",
    ),
    absences: [],
    refreshed_at: null,
  };
  const projected = {
    ...raw,
    snapshots: raw.snapshots.map((snapshot) => ({
      ...snapshot,
      constraints: snapshot.constraints.map((constraint) => ({
        ...constraint,
        freshness: "fresh",
      })),
    })),
  };
  const registry = {
    read: () => raw,
    readConstraintFreshness: () => projected,
    readResources: () => resources,
  };
  return { registry, raw, resources };
}
describe("reset-credit combined-view compatibility", () => {
  it("keeps the old label and typed offer as one count from the same passive producer", async () => {
    const { registry, raw, resources } = producer(2);
    const initial = JSON.stringify(registry.readConstraintFreshness());
    const services = quotaControlServices(() => registry as never);
    const result = ControlAccountResourcesFreshnessResponse.parse(
      await services.quota({ view: "resources_freshness" }),
    );
    expect(result.snapshots[0]!.constraints.filter((c) => c.id === "reset_credits")).toEqual([
      {
        id: "reset_credits",
        label: "2 reset credits available",
        used_ratio: null,
        window_seconds: null,
        resets_at: null,
        cooldown_until: null,
        freshness: "fresh",
      },
    ]);
    expect(result.resources[0]!.resets.value).toMatchObject([
      { id: "codex_granted", available_count: 2 },
    ]);
    expect(result.resources).toEqual(resources);
    expect(result.snapshots).toEqual(
      (await services.quota({ view: "constraint_freshness" })).snapshots,
    );
    expect(JSON.stringify(registry.readConstraintFreshness())).toBe(initial);
    // Preserve the older resources-only view: it never carried compatibility text.
    expect((await services.quota({ view: "resources" })).snapshots).toEqual(
      expect.arrayContaining(
        raw.snapshots.map((s) => expect.objectContaining({ constraints: s.constraints })),
      ),
    );
    const fixture = new URL("./test-support/codex-reset-credits-compat.json", import.meta.url);
    if (process.env.UPDATE_RESET_CREDITS_FIXTURE === "1")
      writeFileSync(fixture, JSON.stringify(result, null, 2) + "\n");
    expect(result).toEqual(JSON.parse(readFileSync(fixture, "utf8")));
  });
  it.each([0, null])("does not fabricate a compatibility count for %s", async (count) => {
    const { registry } = producer(count);
    const result = await quotaControlServices(() => registry as never).quota({
      view: "resources_freshness",
    });
    expect(result.snapshots[0]!.constraints.some((c) => c.id === "reset_credits")).toBe(false);
    // Zero remains a typed reported fact, and missing stays missing.
    expect(result).toMatchObject({
      resources: [{ resets: { value: [{ available_count: count }] } }],
    });
  });
});
