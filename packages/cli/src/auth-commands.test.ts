import { describe, expect, it } from "vitest";
import { authSourceAvailability } from "./cli-io.js";
import { isKnownAuthLoginHarness } from "./ops-commands.js";

describe("auth readiness output", () => {
  it("shows availability and verification independently without manifest inference", () => {
    expect(authSourceAvailability({
      authSources: [
        { source: "native_session", availability: "available", verification: "passed" },
        { source: "provider_auth_file", availability: "available", verification: "not_run" },
      ],
    })).toBe(
      "native_session[availability=available,verification=passed], provider_auth_file[availability=available,verification=not_run]",
    );
    expect(authSourceAvailability({})).toBe("readiness-not-reported");
  });
});

describe("post-login verification", () => {
  it("fails closed for unknown auth-login harness ids", () => {
    expect(isKnownAuthLoginHarness("codex")).toBe(true);
    expect(isKnownAuthLoginHarness("opencode")).toBe(false);
    expect(isKnownAuthLoginHarness("typo")).toBe(false);
  });
});
