import { describe, expect, it } from "vitest";
import { knownModelIdsForRoute, type KnownModelEntry } from "./harness.js";
import { deriveAuthRouteReason, estimateEffectiveAuthRoute } from "./auth.js";

describe("knownModelIdsForRoute (W11, INV-104 x INV-061)", () => {
  const entries: KnownModelEntry[] = [
    "everywhere",
    { id: "sub-only", routes: ["local_session"] },
    { id: "api-only", routes: ["api_key"] },
    { id: "both", routes: ["local_session", "api_key"] },
  ];

  it("filters every route/model pair", () => {
    expect(knownModelIdsForRoute(entries, "local_session")).toEqual([
      "everywhere",
      "sub-only",
      "both",
    ]);
    expect(knownModelIdsForRoute(entries, "api_key")).toEqual(["everywhere", "api-only", "both"]);
  });

  it("fail-closed on an undecidable route: route-scoped models are EXCLUDED", () => {
    expect(knownModelIdsForRoute(entries, null)).toEqual(["everywhere"]);
  });

  it("bare-string lists (the backward shape) are route-independent", () => {
    expect(knownModelIdsForRoute(["a", "b"], null)).toEqual(["a", "b"]);
    expect(knownModelIdsForRoute(["a", "b"], "api_key")).toEqual(["a", "b"]);
  });
});

describe("estimateEffectiveAuthRoute (W11, INV-061 projection)", () => {
  const src = (
    source: string,
    availability: "available" | "unavailable" | "unknown" = "available",
    verification: "passed" | "failed" | "not_run" = "passed",
  ) =>
    ({
      source,
      availability,
      verification,
    }) as never;

  it("auto prefers the native session (native-first doctrine)", () => {
    expect(
      estimateEffectiveAuthRoute("auto", [src("native_session"), src("api_key_env")]),
    ).toBe("local_session");
  });

  it("auto falls back to api_key when no native source is usable", () => {
    expect(estimateEffectiveAuthRoute("auto", [src("api_key_env")])).toBe("api_key");
    expect(
      estimateEffectiveAuthRoute("auto", [
        src("native_session", "unavailable"),
        src("api_key_env"),
      ]),
    ).toBe("api_key");
  });

  it("explicit preferences never estimate the other route (null instead)", () => {
    expect(estimateEffectiveAuthRoute("subscription", [src("api_key_env")])).toBe(null);
    expect(estimateEffectiveAuthRoute("api_key", [src("native_session")])).toBe(null);
  });

  it("a failed verification disqualifies a source; no usable source = null", () => {
    expect(
      estimateEffectiveAuthRoute("auto", [src("native_session", "available", "failed")]),
    ).toBe(null);
    expect(estimateEffectiveAuthRoute("auto", [])).toBe(null);
  });
});

describe("deriveAuthRouteReason (W10)", () => {
  it("maps every requested x effective pair deterministically", () => {
    expect(deriveAuthRouteReason("auto", "local_session")).toBe("native_first");
    expect(deriveAuthRouteReason("auto", "api_key")).toBe("no_native_session_fallback");
    expect(deriveAuthRouteReason("subscription", "local_session")).toBe("as_requested");
    expect(deriveAuthRouteReason("api_key", "api_key")).toBe("as_requested");
    expect(deriveAuthRouteReason("subscription", "api_key")).toBe("requested_route_unavailable");
    expect(deriveAuthRouteReason("api_key", "local_session")).toBe("requested_route_unavailable");
    expect(deriveAuthRouteReason("auto", null)).toBe("undisclosed");
    expect(deriveAuthRouteReason("auto", "unknown")).toBe("undisclosed");
  });
});
