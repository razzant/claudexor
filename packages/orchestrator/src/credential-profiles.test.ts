import { describe, expect, it } from "vitest";
import type { CredentialProfile } from "@claudexor/schema";
import { resolveCredentialProfile } from "./credential-profiles.js";

const work: CredentialProfile = {
  profile_id: "work",
  harness_id: "claude",
  display_name: "Work",
  credential_kind: "config_dir_login",
  isolation_locator: "/tmp/p/work",
  secret_ref: null,
  enabled: true,
  created_at: null,
};

describe("resolveCredentialProfile (INV-135, the one resolve owner)", () => {
  it("returns the exact registry entry for a matching harness", () => {
    expect(resolveCredentialProfile([work], "work", "claude")).toBe(work);
  });

  it("refuses an unknown id — an explicit profile never defaults", () => {
    expect(() => resolveCredentialProfile([work], "ghost", "claude")).toThrow(/not registered/);
  });

  it("refuses a harness-mismatched id (same name registered for another harness)", () => {
    expect(() => resolveCredentialProfile([work], "work", "codex")).toThrow(/not registered/);
  });

  it("refuses a disabled profile", () => {
    expect(() => resolveCredentialProfile([{ ...work, enabled: false }], "work", "claude")).toThrow(
      /disabled/,
    );
  });
});
