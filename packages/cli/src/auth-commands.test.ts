import { describe, expect, it } from "vitest";
import { harnessHasDefaultCredentialStore, harnessSupportsBootstrapLogin } from "@claudexor/schema";
import { authSourceAvailability } from "./cli-io.js";
import { authLoginHarnessList, isKnownAuthLoginHarness } from "./ops-commands.js";

describe("auth readiness output", () => {
  it("shows availability and verification independently without manifest inference", () => {
    expect(
      authSourceAvailability({
        authSources: [
          { source: "native_session", availability: "available", verification: "passed" },
          { source: "provider_auth_file", availability: "available", verification: "not_run" },
        ],
      }),
    ).toBe(
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
    // `auth login` signs in the DEFAULT account. A harness that has none —
    // every agy identity is a named profile — must not be offered here, or the
    // command would only ever reach a server-side refusal.
    expect(isKnownAuthLoginHarness("agy")).toBe(false);
    expect(authLoginHarnessList()).not.toContain("agy");
    expect(authLoginHarnessList().split("|")).toEqual(["codex", "claude", "cursor"]);
  });

  it("requires a named Grok profile instead of offering bootstrap login or a default store", () => {
    expect(harnessHasDefaultCredentialStore("grok")).toBe(false);
    expect(harnessSupportsBootstrapLogin("grok")).toBe(false);
    expect(isKnownAuthLoginHarness("grok")).toBe(false);
    expect(authLoginHarnessList().split("|")).not.toContain("grok");
  });
});
