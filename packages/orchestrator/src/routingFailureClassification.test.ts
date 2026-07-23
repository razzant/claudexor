import { describe, expect, it } from "vitest";
import { RoutingPreflightError } from "@claudexor/budget";
import { harnessFailureNextActions } from "./harnessFailure.js";
import { routingFailureClassification } from "./orchestrator.js";

/**
 * A-1/D-9/#22: a routing preflight refusal (quality routing with no comparable
 * user-declared tier for the intent) is a CONFIGURATION error, not a
 * harness-availability problem. Every strategy's routing catch runs the throw
 * through this one classifier, so it must map RoutingPreflightError → config_error
 * (with config remediation) and every other routing throw → harness_unavailable.
 */
describe("routingFailureClassification", () => {
  it("classifies a RoutingPreflightError as config_error with config remediation", () => {
    const err = new RoutingPreflightError(
      "quality routing requires a comparable user-declared tier for intent 'implement'",
    );
    expect(err.code).toBe("routing_preflight_refused");
    const result = routingFailureClassification(err);
    expect(result.category).toBe("config_error");
    // Config remediation, never auth/harness-availability guidance.
    expect(result.nextActions).toEqual(harnessFailureNextActions("config_error"));
    expect(result.nextActions?.join(" ")).not.toMatch(/re-?authenticate/i);
  });

  it("detects the refusal by typed code (robust across duplicate package copies)", () => {
    // A structurally-equal error from another @claudexor/budget copy carries the
    // same typed `code` but fails instanceof; the classifier must still catch it.
    const cloned = Object.assign(new Error("preflight refused"), {
      code: "routing_preflight_refused",
    });
    expect(routingFailureClassification(cloned).category).toBe("config_error");
  });

  it("classifies any other routing throw as harness_unavailable with no config remediation", () => {
    const result = routingFailureClassification(
      new Error("no harness remains eligible for 'implement' after budget and quota routing"),
    );
    expect(result.category).toBe("harness_unavailable");
    expect(result.nextActions).toBeUndefined();
  });

  it("is null-safe for a non-object throw", () => {
    expect(routingFailureClassification("boom").category).toBe("harness_unavailable");
    expect(routingFailureClassification(undefined).category).toBe("harness_unavailable");
  });
});
