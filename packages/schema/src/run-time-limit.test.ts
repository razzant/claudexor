import { describe, expect, it } from "vitest";
import { GlobalConfig, ControlSettingsSnapshot, ControlRunStartRequest } from "./index.js";
import { RunTimeLimitRequest } from "./run-time-limit.js";

describe("explicit run time policy", () => {
  it("allows a disabled inactivity watchdog in config and settings without changing defaults", () => {
    expect(
      GlobalConfig.parse({ runtime: { harness_inactivity_timeout_ms: null } }).runtime
        .harness_inactivity_timeout_ms,
    ).toBeNull();
    expect(
      ControlSettingsSnapshot.parse({ runtime: { harnessInactivityTimeoutMs: null } }).runtime
        .harnessInactivityTimeoutMs,
    ).toBeNull();
    expect(GlobalConfig.parse({}).runtime.harness_inactivity_timeout_ms).toBe(3_600_000);
    expect(() => GlobalConfig.parse({ runtime: { harness_inactivity_timeout_ms: 0 } })).toThrow();
  });
  it("does not create an implicit run deadline and preserves explicit soft mode", () => {
    expect(ControlRunStartRequest.parse({ prompt: "work" }).maxSeconds).toBeUndefined();
    expect(
      ControlRunStartRequest.parse({ prompt: "work", maxSeconds: 60, timeLimitMode: "soft" }),
    ).toMatchObject({ maxSeconds: 60, timeLimitMode: "soft" });
  });
  it("leaves an omitted set mode to the live timer and requires a revision for mutations", () => {
    const parsed = RunTimeLimitRequest.parse({ action: "set", seconds: 60, expectedRevision: 0 });
    expect(parsed).toEqual({ action: "set", seconds: 60, expectedRevision: 0 });
    expect("mode" in parsed).toBe(false);
    expect(
      RunTimeLimitRequest.parse({ action: "set", seconds: 60, mode: "hard", expectedRevision: 0 }),
    ).toMatchObject({ mode: "hard" });
    expect(() => RunTimeLimitRequest.parse({ action: "extend", seconds: 60 })).toThrow();
    expect(() =>
      RunTimeLimitRequest.parse({ action: "disable", expectedRevision: 0, extraAuthority: true }),
    ).toThrow();
  });
});
