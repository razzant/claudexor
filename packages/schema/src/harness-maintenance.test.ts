import { describe, expect, it } from "vitest";
import {
  ControlHarnessMaintenanceCreateRequest,
  HarnessMaintenanceParams,
  HarnessNewestObservation,
} from "./harness-maintenance.js";

describe("vendor maintenance wire contract", () => {
  it("accepts current and explicit exact versions and rejects retired or ranged targets with the new spelling", () => {
    for (const target of [{ kind: "latest" }, { kind: "version", version: "1.2.3-beta.1" }])
      expect(
        ControlHarnessMaintenanceCreateRequest.safeParse({ harness: "codex", target }).success,
      ).toBe(true);
    for (const target of [{ kind: "previous" }, { kind: "baseline" }])
      expect(() =>
        ControlHarnessMaintenanceCreateRequest.parse({ harness: "codex", target }),
      ).toThrow("kind:");
    expect(
      ControlHarnessMaintenanceCreateRequest.safeParse({
        harness: "codex",
        target: { kind: "version", version: "^1.2.0" },
      }).success,
    ).toBe(false);
    expect(
      HarnessMaintenanceParams.safeParse({
        kind: "harness_maintenance",
        harness: "codex",
        requester: { source: "api", requestId: "k" },
        target: { kind: "latest", version: "1.0.0" },
      }).success,
    ).toBe(false);
  });
  it("distinguishes an absent read from a failed one and a timestamped answer", () => {
    expect(HarnessNewestObservation.parse({ status: "not_read", source: null }).status).toBe(
      "not_read",
    );
    expect(
      HarnessNewestObservation.safeParse({
        status: "available",
        source: "https://example.invalid",
        version: "1.2.3",
      }).success,
    ).toBe(false);
    expect(
      HarnessNewestObservation.safeParse({
        status: "unavailable",
        source: null,
        observedAt: new Date().toISOString(),
        problem: { code: "newest_unavailable", message: "offline", retryable: true },
      }).success,
    ).toBe(true);
  });
});
