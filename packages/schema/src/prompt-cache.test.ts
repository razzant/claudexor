import { describe, expect, it } from "vitest";
import {
  AttemptTelemetryRecord,
  CatalogHarness,
  HarnessCapabilityProfile,
  HarnessEvent,
  HarnessRunSpec,
  PromptCacheTtl,
  PromptCacheTtlReceipt,
  TaskContract,
  observedPromptCacheTtl,
} from "./index.js";

const receipt = {
  requested: "1h",
  submitted: "1h",
  reason: null,
  observed: "1h",
  write_5m_tokens: 0,
  write_1h_tokens: 12,
} as const;

describe("prompt-cache lifetime contract", () => {
  it("accepts exactly 5m and 1h", () => {
    expect(PromptCacheTtl.options).toEqual(["5m", "1h"]);
    for (const value of ["2h", "1H", "5M", "", "default", 3600]) {
      expect(PromptCacheTtl.safeParse(value).success).toBe(false);
    }
  });

  it("the receipt is strict and keeps unknown counts null", () => {
    expect(PromptCacheTtlReceipt.parse(receipt)).toEqual(receipt);
    expect(
      PromptCacheTtlReceipt.parse({
        ...receipt,
        requested: null,
        submitted: null,
        observed: "unknown",
        write_5m_tokens: null,
        write_1h_tokens: null,
      }).observed,
    ).toBe("unknown");
    expect(PromptCacheTtlReceipt.safeParse({ ...receipt, applied: true }).success).toBe(false);
    expect(PromptCacheTtlReceipt.safeParse({ ...receipt, write_1h_tokens: -1 }).success).toBe(
      false,
    );
    expect(PromptCacheTtlReceipt.safeParse({ ...receipt, reason: "" }).success).toBe(false);
    expect(PromptCacheTtlReceipt.safeParse({ ...receipt, observed: "disabled" }).success).toBe(
      false,
    );
  });

  it("one rule maps reported writes to the observed lifetime", () => {
    expect(observedPromptCacheTtl(null, 3)).toBe("unknown");
    expect(observedPromptCacheTtl(3, null)).toBe("unknown");
    expect(observedPromptCacheTtl(0, 0)).toBe("none");
    expect(observedPromptCacheTtl(4, 0)).toBe("5m");
    expect(observedPromptCacheTtl(0, 4)).toBe("1h");
    expect(observedPromptCacheTtl(1, 4)).toBe("mixed");
  });

  it("rides the contract, spec, event, telemetry and capability shapes", () => {
    const contract = TaskContract.parse({
      schema_version: 2,
      task_id: "t",
      created_at: "2026-10-21T00:00:00.000Z",
      repo: { root: "/repo", base_ref: "HEAD" },
      mode: { kind: "agent" },
      user_intent: { raw: "work" },
      prompt_cache_ttl: "1h",
    });
    expect(contract.prompt_cache_ttl).toBe("1h");
    expect(
      HarnessRunSpec.parse({
        session_id: "s",
        intent: "implement",
        prompt: "p",
        cwd: "/repo",
        prompt_cache_ttl: "5m",
      }).prompt_cache_ttl,
    ).toBe("5m");
    expect(
      HarnessEvent.parse({ type: "usage", session_id: "s", ts: "t", prompt_cache_ttl: receipt })
        .prompt_cache_ttl,
    ).toEqual(receipt);
    expect(
      AttemptTelemetryRecord.parse({
        attempt_id: "a01",
        harness_id: "claude",
        web: {},
        prompt_cache_ttl: receipt,
      }).prompt_cache_ttl,
    ).toEqual(receipt);
    expect(HarnessCapabilityProfile.parse({}).prompt_cache_ttls).toBeUndefined();
    expect(HarnessCapabilityProfile.parse({ prompt_cache_ttls: ["1h"] }).prompt_cache_ttls).toEqual(
      ["1h"],
    );
    expect(HarnessCapabilityProfile.safeParse({ prompt_cache_ttls: ["2h"] }).success).toBe(false);
    expect(CatalogHarness.shape.promptCacheTtls.safeParse(["5m", "1h"]).success).toBe(true);
    expect(CatalogHarness.shape.promptCacheTtls.safeParse(["30m"]).success).toBe(false);
  });
});
