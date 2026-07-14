import { describe, expect, it } from "vitest";
import {
  ControlAuthReadinessRefreshRequest,
  ControlAuthReadinessRefreshResponse,
  ControlSetupJobCreateRequest,
} from "./index.js";

describe("exact auth readiness contracts", () => {
  it("accepts only a typed exact auth request and source", () => {
    expect(
      ControlAuthReadinessRefreshRequest.parse({
        authRequest: "subscription",
        source: "native_session",
      }),
    ).toEqual({ authRequest: "subscription", source: "native_session" });
    expect(() =>
      ControlAuthReadinessRefreshRequest.parse({
        authRequest: "subscription",
        source: "native_session",
        fresh: true,
      }),
    ).toThrow();
  });

  it("requires the returned readiness evidence to match the requested source", () => {
    const base = {
      harnessId: "claude",
      authRequest: "subscription" as const,
      requestedSource: "native_session" as const,
      observedAt: "2026-07-14T00:00:00.000Z",
    };
    expect(
      ControlAuthReadinessRefreshResponse.parse({
        ...base,
        readiness: {
          source: "native_session",
          availability: "available",
          verification: "passed",
        },
      }).readiness.verification,
    ).toBe("passed");
    expect(() =>
      ControlAuthReadinessRefreshResponse.parse({
        ...base,
        readiness: {
          source: "api_key_env",
          availability: "available",
          verification: "passed",
        },
      }),
    ).toThrow(/must match the exact requested source/);
  });
});

describe("native-login setup boundary", () => {
  it("admits only exact-subscription login for managed native harnesses", () => {
    for (const harness of ["codex", "claude", "cursor"] as const) {
      expect(
        ControlSetupJobCreateRequest.parse({
          harness,
          action: "login",
          authRequest: "subscription",
        }),
      ).toEqual({ harness, action: "login", authRequest: "subscription" });
    }

    for (const request of [
      { harness: "opencode", action: "login", authRequest: "subscription" },
      { harness: "raw-api", action: "login", authRequest: "subscription" },
      { harness: "codex", action: "doctor", authRequest: "subscription" },
      { harness: "codex", action: "install", authRequest: "subscription" },
      { harness: "codex", action: "store_key", authRequest: "subscription" },
      { harness: "codex", action: "login" },
    ]) {
      expect(() => ControlSetupJobCreateRequest.parse(request)).toThrow();
    }
  });
});
