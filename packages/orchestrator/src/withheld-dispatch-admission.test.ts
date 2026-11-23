import { describe, expect, it } from "vitest";
import type { HarnessRunSpec } from "@claudexor/schema";
import { admitCurrentProfileDispatch } from "./modelGovernance.js";
import { bindProcessingAdmission } from "./processing-dispatch.js";

const included = { nativeMode: null, kind: "included", source: "fixture" } as const;
const specOf = (profile: unknown = null, auth_preference?: "subscription" | "api_key") =>
  ({
    credential_profile: profile,
    auth_preference,
    processing_cost_basis: included,
    extra: {} as Record<string, unknown>,
  }) as unknown as HarnessRunSpec;
const route = (diagnosticGeneration: "allowed" | "forbidden", pinned = false) => ({
  diagnosticGeneration,
  quotaAdmission: { profile: null, ...(pinned ? { pinnedNative: true as const } : {}) },
});

describe("a withheld $0 Ask prices each send by that send's own proof", () => {
  it("never lets a receipt's included class stand for an unverified base login", async () => {
    const spec = specOf();
    await admitCurrentProfileDispatch(route("forbidden"), spec);
    expect(spec.extra["routeBillingKnowledge"]).toBe("unknown");
    expect(spec.processing_cost_basis?.kind).toBe("unknown");
  });

  it("keeps the vendor-verified native pin included on a send strictly on that login", async () => {
    const spec = specOf(null, "subscription");
    await admitCurrentProfileDispatch(route("forbidden", true), spec);
    expect(spec.extra["routeBillingKnowledge"]).toBe("subscription_entitlement");
    expect(spec.processing_cost_basis?.kind).toBe("included");
  });

  it("leaves an allowed Ask and a named account's own verification untouched", async () => {
    const allowed = specOf();
    await admitCurrentProfileDispatch(route("allowed"), allowed);
    expect(allowed.extra["routeBillingKnowledge"]).toBeUndefined();
    expect(allowed.processing_cost_basis?.kind).toBe("included");
    const named = specOf({ profile_id: "p", credential_kind: "config_dir_login" });
    await admitCurrentProfileDispatch(
      { ...route("forbidden"), billingVerificationForProfile: async () => "passed" as const },
      named,
    );
    expect(named.extra["routeBillingKnowledge"]).toBe("subscription_entitlement");
    expect(named.processing_cost_basis?.kind).toBe("included");
  });

  it("prices a send that left the pinned login, or a row with only a local login, as unknown", async () => {
    const left = [specOf(null, "api_key"), specOf(null)];
    for (const spec of left) await admitCurrentProfileDispatch(route("forbidden", true), spec);
    const local = specOf({ profile_id: "p", credential_kind: "config_dir_login" }, "subscription");
    await admitCurrentProfileDispatch(
      {
        ...route("forbidden", true),
        billingVerificationForProfile: async () => "not_run" as const,
      },
      local,
    );
    for (const spec of [...left, local]) {
      expect(spec.extra["routeBillingKnowledge"]).toBe("unknown");
      expect(spec.processing_cost_basis?.kind).toBe("unknown");
    }
  });

  it("reprices even a send with no receipt by its own verdict, never by the earlier lease", async () => {
    const priced: string[] = [];
    const ledger = {
      repriceReservedLease: (lease: string, cost: { billing: string }) => {
        priced.push(`${lease}:${cost.billing}`);
        return { granted: true };
      },
      markPhysicalDispatchStarted: () => {},
    };
    for (const auth of ["subscription", "api_key"] as const) {
      const spec = { ...specOf(null, auth), processing_cost_basis: undefined };
      const reserved = { lease_id: "lease", cost: { estimatedUsd: null } };
      bindProcessingAdmission(spec, ledger as never, reserved as never, "claude", "a01");
      await admitCurrentProfileDispatch(route("forbidden", true), spec);
    }
    // The strict pin reprices as included; the send that left it as unknown, which $0 refuses.
    expect(priced).toEqual(["lease:subscription_entitlement", "lease:unknown"]);
  });
});
