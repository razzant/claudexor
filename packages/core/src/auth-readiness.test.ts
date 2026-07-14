import { describe, expect, it } from "vitest";
import { selectStrictAuthRoute, selectedAuthAvailable, selectedAuthReady, shouldVerifyApiKey } from "./auth-readiness.js";

describe("strict doctor auth preference", () => {
  it("never lets an unselected ready route satisfy an explicit preference", () => {
    expect(selectedAuthReady({ preference: "api_key", nativeReady: true, apiKeyReady: false })).toBe(false);
    expect(selectedAuthReady({ preference: "subscription", nativeReady: false, apiKeyReady: true })).toBe(false);
    expect(selectedAuthAvailable({ preference: "api_key", nativeAvailable: true, apiKeyAvailable: false })).toBe(false);
    expect(selectedAuthAvailable({ preference: "subscription", nativeAvailable: false, apiKeyAvailable: true })).toBe(false);
  });

  it("keeps auto subscription-first and verifies a key only when needed", () => {
    expect(shouldVerifyApiKey({ preference: "auto", apiKeyAvailable: true, nativeReady: true })).toBe(false);
    expect(shouldVerifyApiKey({ preference: "auto", apiKeyAvailable: true, nativeReady: false })).toBe(true);
    expect(shouldVerifyApiKey({ preference: "api_key", apiKeyAvailable: true, nativeReady: true })).toBe(true);
    expect(shouldVerifyApiKey({ preference: "subscription", apiKeyAvailable: true, nativeReady: false })).toBe(false);
  });

  it("never invokes a fallback callback for an explicit runtime route", () => {
    const attempts: string[] = [];
    const subscription = () => { attempts.push("subscription"); return false; };
    const apiKey = () => { attempts.push("api_key"); return true; };
    expect(selectStrictAuthRoute("subscription", subscription, apiKey)).toBeNull();
    expect(attempts).toEqual(["subscription"]);
    attempts.length = 0;
    expect(selectStrictAuthRoute("api_key", () => { attempts.push("subscription"); return true; }, () => { attempts.push("api_key"); return false; })).toBeNull();
    expect(attempts).toEqual(["api_key"]);
  });
});
