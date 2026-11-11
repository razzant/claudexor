import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { ControlAccountResourcesFreshnessResponse } from "@claudexor/schema";
import type { QuotaRegistry } from "@claudexor/daemon";
import { parseCursorResources } from "./cursor-quota-parse.js";
import { quotaControlServices } from "./quota-services.js";
import { mergeResources } from "../../daemon/src/quota-resources.js";

const raw = JSON.parse(
  readFileSync(new URL("./test-support/cursor-usage-team.json", import.meta.url), "utf8"),
).data;
describe("Cursor producer-fed Swift presentation fixture", () => {
  it("derives the complete consumer fixture from the synthetic-amount dashboard, merge and passive control read", async () => {
    const resources = ["chosen", "healthy-sibling"].map((id) =>
      mergeResources(undefined, parseCursorResources(raw, id, new Date("2026-10-15T13:04:58Z"))),
    );
    const registry = {
      readConstraintFreshness: () => ({ snapshots: [], absences: [], refreshed_at: null }),
      readResources: () => resources,
    } as unknown as QuotaRegistry;
    const result = ControlAccountResourcesFreshnessResponse.parse(
      await quotaControlServices(() => registry).quota({
        view: "resources_freshness",
        model: "auto",
        requestKind: "text",
      }),
    );
    const fixture = new URL(
      "../../../apps/macos/ClaudexorApp/Tests/ClaudexorAppTests/Fixtures/cursor-resources-freshness.json",
      import.meta.url,
    );
    // Explicit producer regeneration, never a hand-edited consumer DTO:
    // UPDATE_CURSOR_RESOURCE_FIXTURE=1 pnpm exec vitest run packages/cli/src/cursor-quota-golden.test.ts
    if (process.env.UPDATE_CURSOR_RESOURCE_FIXTURE === "1")
      writeFileSync(fixture, JSON.stringify(result, null, 2) + "\n");
    const golden = JSON.parse(readFileSync(fixture, "utf8"));
    expect(result).toEqual(golden);
    const row = result.resources[0]!;
    expect(row.balances.value!.find((value) => value.scope === "team")).toMatchObject({
      amount: "65433",
      unit: "minor",
      currency: "USD",
      decimal_places: 2,
    });
    expect(row.spending.value!.find((value) => value.usage_kind === "included")).toMatchObject({
      used: "2500",
      unit: "minor",
      currency: "USD",
      decimal_places: 2,
    });
    expect(result.snapshots).toEqual([]);
  });
});
