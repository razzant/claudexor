import { describe, expect, it } from "vitest";
import {
  legacyV320QuotaSource,
  QUOTA_SOURCE_TRAITS,
  REACTIVE_COOLDOWN_SOURCE,
  vendorResetDayCooldownEnd,
} from "./index.js";

describe("vendorResetDayCooldownEnd (day-granular vendor reset, A4)", () => {
  it("covers the WHOLE vendor-named day: next-midnight UTC", () => {
    expect(vendorResetDayCooldownEnd({ vendor_reset_day: "2026-09-12" })).toBe(
      "2026-09-13T00:00:00.000Z",
    );
    // Month/year rollovers stay calendar-honest.
    expect(vendorResetDayCooldownEnd({ vendor_reset_day: "2026-12-31" })).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });

  it("rejects absent, malformed, non-string, and non-object payloads", () => {
    expect(vendorResetDayCooldownEnd(undefined)).toBeNull();
    expect(vendorResetDayCooldownEnd(null)).toBeNull();
    expect(vendorResetDayCooldownEnd([])).toBeNull();
    expect(vendorResetDayCooldownEnd({})).toBeNull();
    expect(vendorResetDayCooldownEnd({ vendor_reset_day: 20260912 })).toBeNull();
    expect(vendorResetDayCooldownEnd({ vendor_reset_day: "9/12/2026" })).toBeNull();
    expect(vendorResetDayCooldownEnd({ vendor_reset_day: "2026-9-12" })).toBeNull();
  });

  it("rejects a value that names no real calendar day (Date.parse rollover)", () => {
    expect(vendorResetDayCooldownEnd({ vendor_reset_day: "2026-02-31" })).toBeNull();
    expect(vendorResetDayCooldownEnd({ vendor_reset_day: "2026-13-01" })).toBeNull();
  });
});

describe("reactive cooldown source vocabulary (schema-owned, A4)", () => {
  it("every mapped source is a reactive spool: no refresher produces or refreshes it", () => {
    for (const source of Object.values(REACTIVE_COOLDOWN_SOURCE)) {
      if (source === undefined) throw new Error("map values are always concrete sources");
      expect(QUOTA_SOURCE_TRAITS[source]).toMatchObject({
        refreshDemandHarness: null,
        producedByRefresher: false,
      });
    }
  });

  it("agy stays deliberately absent until its adapter emits rate_limit (INV-022/023)", () => {
    expect(REACTIVE_COOLDOWN_SOURCE).toEqual({
      codex: "codex_rollout",
      claude: "claude_api_retry",
      cursor: "cursor_rate_limit",
      grok: "grok_rate_limit",
    });
  });

  it("maps post-v3.2.0 reactive evidence for rollback base records", () => {
    expect(legacyV320QuotaSource("grok_rate_limit")).toBe("claude_api_retry");
    expect(legacyV320QuotaSource("cursor_rate_limit")).toBe("claude_api_retry");
    expect(legacyV320QuotaSource("claude_oauth_usage")).toBe("claude_oauth_usage");
    expect(legacyV320QuotaSource("codex_rollout")).toBe("codex_rollout");
    expect(legacyV320QuotaSource("agy_command_usage")).toBe("agy_command_usage");
  });
});
