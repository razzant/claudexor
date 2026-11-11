import { describe, expect, it } from "vitest";
import { BudgetLedger } from "../../budget/src/ledger.js";
import type { QuotaConstraint, QuotaSnapshot, QuotaRequestKind } from "@claudexor/schema";
import { profileQuotaBlock } from "../../orchestrator/src/credential-cooldown.js";
import { quotaControlServices } from "./quota-services.js";
const reset = "2099-10-22T12:00:00Z";
function fixture(scope: Partial<QuotaConstraint>) {
  const snapshot: QuotaSnapshot = {
    subject: {
      harness: "agy",
      credential_route: "vendor_native",
      subject_id: "fixture",
      plan_label: null,
    },
    source: "agy_command_usage",
    observed_at: new Date().toISOString(),
    freshness: "fresh",
    constraints: [
      {
        id: "window",
        label: "Scoped",
        used_ratio: 1,
        resets_at: reset,
        window_seconds: 604800,
        cooldown_until: null,
        ...scope,
      },
    ],
  };
  const raw = { snapshots: [snapshot], absences: [], refreshed_at: null };
  const services = quotaControlServices(
    () =>
      ({
        read: () => raw,
        readResources: () => [],
        readConstraintFreshness: () => ({
          ...raw,
          snapshots: [
            {
              ...snapshot,
              constraints: snapshot.constraints.map((c) => ({ ...c, freshness: "fresh" })),
            },
          ],
        }),
      }) as never,
  );
  return { services, snapshot };
}
describe("negotiated quota-block basis preserves the actual blocking owner", () => {
  it.each([
    ["exact", { applies_to_models: ["model-a"] }, "model-a"],
    ["unrelated", { applies_to_models: ["model-a"] }, "different"],
    ["suffix", { applies_to_models: ["model-a"] }, "model-a-future"],
    ["bracket", { applies_to_models: ["model-a"] }, "model-a[1m]"],
    ["substring", { applies_to_models: ["prefix-model-a"] }, "model-a"],
    ["case", { applies_to_models: ["Model-A"] }, "model-a"],
    ["prefix-only", { applies_to_model_prefixes: ["model-"] }, "model-future"],
    ["unscoped", {}, null],
    ["empty", { applies_to_models: [] }, "model-a"],
    ["unspecified-not-declared", { applies_to_model_prefixes: ["model-"] }, null],
    [
      "unspecified-declared",
      { applies_to_models: ["model-a"], applies_to_unspecified_model: true },
      null,
    ],
    [
      "image-only",
      { applies_to_models: ["model-a"], applies_to_request_kinds: ["image"] },
      "model-a",
    ],
  ] as const)(
    "agrees with profileQuotaBlock for model/kind/profile/route (%s)",
    async (_label, scope, model) => {
      const { services, snapshot } = fixture(scope as Partial<QuotaConstraint>);
      for (const requestKind of ["text", "image"] as QuotaRequestKind[]) {
        const result = await services.quota({
          view: "resources_freshness",
          requestKind,
          ...(model === null ? {} : { model }),
        });
        const expected = profileQuotaBlock(
          [snapshot],
          "agy",
          "fixture",
          "local_session",
          model,
          new Date(),
          requestKind,
        );
        expect(result.snapshots[0]!.availability?.state !== "available").toBe(expected !== null);
        expect(result).toHaveProperty("availability_scope", {
          basis: "quota_block",
          model,
          requestKind,
        });
        expect(
          profileQuotaBlock(
            [snapshot],
            "agy",
            "another",
            "local_session",
            model,
            new Date(),
            requestKind,
          ),
        ).toBeNull();
        expect(
          profileQuotaBlock(
            [snapshot],
            "agy",
            "fixture",
            "api_key",
            model,
            new Date(),
            requestKind,
          ),
        ).toBeNull();
      }
    },
  );
  it("keeps all old views and the distinct BudgetLedger model/threshold semantics", async () => {
    const { services, snapshot } = fixture({ applies_to_models: ["model-a"] });
    const budget = new BudgetLedger();
    budget.observeQuotaSnapshot(snapshot);
    // The existing A4 block projection is intentionally looser than the budget
    // predicate. Inspection must not rename one as authority over all admission.
    expect(
      budget.cooldownActive("agy", "vendor_native", "fixture", Date.now(), "model-a-suffix"),
    ).toBe(false);
    expect(
      profileQuotaBlock([snapshot], "agy", "fixture", "local_session", "model-a-suffix"),
    ).not.toBeNull();
    for (const view of [
      undefined,
      "resources",
      "constraint_freshness",
      "resources_freshness",
    ] as const)
      expect(
        (await services.quota({ view, model: "model-a-suffix" })).snapshots[0]!.availability?.state,
      ).toBe("exhausted");
  });
});
