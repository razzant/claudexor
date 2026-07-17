import { describe, expect, it } from "vitest";
import type { CredentialProfile } from "@claudexor/schema";
import {
  createOpenCodeAdapter,
  opencodeProfileKeyOrRefusal,
  probeOpencodeCredentialProfile,
} from "./index.js";

function profile(over: Partial<CredentialProfile> = {}): CredentialProfile {
  return {
    profile_id: "acc2",
    harness_id: "opencode",
    display_name: "Second",
    credential_kind: "api_key",
    isolation_locator: null,
    secret_ref: "opencode:acc2",
    enabled: true,
    created_at: null,
    ...over,
  } as CredentialProfile;
}

// Release wave round-15 #1/#5: one owner (opencodeProfileKeyOrRefusal) for the
// run route and the doctor probe; refs must be NAMESPACED and bound to an
// opencode provider slot.
describe("opencode strict profile resolution (INV-135)", () => {
  it("a namespaced provider ref selects exactly its provider env var", () => {
    const gate = opencodeProfileKeyOrRefusal(profile(), (ref) =>
      ref === "opencode:acc2" ? "sk-oc" : null,
    );
    expect(gate).toEqual({ envVar: "OPENCODE_API_KEY", value: "sk-oc" });
    const viaOpenai = opencodeProfileKeyOrRefusal(profile({ secret_ref: "openai:acc2" }), (ref) =>
      ref === "openai:acc2" ? "sk-oai" : null,
    );
    expect(viaOpenai).toEqual({ envVar: "OPENAI_API_KEY", value: "sk-oai" });
  });

  it("bare, foreign, and non-api_key refs refuse typed without reading any slot", () => {
    const reads: string[] = [];
    const resolve = (ref: string) => {
      reads.push(ref);
      return "leaked";
    };
    for (const secret_ref of ["opencode", "cursor:acc2"]) {
      const gate = opencodeProfileKeyOrRefusal(profile({ secret_ref }), resolve);
      expect("refusal" in gate && gate.reason).toBe("misconfigured");
    }
    const kind = opencodeProfileKeyOrRefusal(profile({ credential_kind: "oauth_token" }), resolve);
    expect("refusal" in kind && kind.refusal).toContain("api_key transport");
    expect(reads).toEqual([]);
  });
});

describe("opencode credential-profile doctor probe (INV-135)", () => {
  it("a stored namespaced slot is available; missing/mis-bound are unavailable", async () => {
    expect(
      probeOpencodeCredentialProfile(profile(), (ref) => (ref === "opencode:acc2" ? "sk" : null)),
    ).toMatchObject({
      profile_id: "acc2",
      harness_id: "opencode",
      availability: "available",
      verification: "not_run",
    });
    expect(probeOpencodeCredentialProfile(profile(), () => null)).toMatchObject({
      availability: "unavailable",
      verification: "not_run",
    });
    expect(
      probeOpencodeCredentialProfile(profile({ secret_ref: "opencode" }), () => "x"),
    ).toMatchObject({ availability: "unavailable", verification: "failed" });
  });

  it("the adapter registers the probe so the orchestrator's profile override can consult it", () => {
    expect(typeof createOpenCodeAdapter().probeCredentialProfile).toBe("function");
  });
});
