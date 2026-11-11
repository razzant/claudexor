import { describe, expect, it } from "vitest";
import { type ConformanceReport, HarnessManifest } from "@claudexor/schema";
import { allowedIntents, capabilityIntents } from "./gating.js";

// Built through the Zod SSOT so schema defaults apply and the fixture cannot
// silently drift from the manifest contract.
function manifest(): HarnessManifest {
  return HarnessManifest.parse({
    id: "x",
    display_name: "X",
    kind: "local_cli",
    provider_family: "openai",
    capabilities: {
      plan: true,
      spec: true,
      implement: true,
      create_from_scratch: true,
      repair: true,
      review: true,
      verify: true,
      synthesize: true,
      shell: true,
      read_files: true,
      edit_files: true,
      apply_patch: true,
      structured_events: true,
      structured_output: true,
      json_schema_output: true,
      resume: true,
      cancel: true,
      mcp: true,
      plugins: true,
      worktree_native: false,
    },
    auth_modes: ["local_session"],
    access_profiles_supported: ["readonly", "workspace_write", "full"],
  });
}

function report(
  status: ConformanceReport["status"],
  extra: Partial<ConformanceReport> = {},
): ConformanceReport {
  return {
    harness_id: "x",
    status,
    checks: [],
    enabled_intents: [],
    disabled_intents: [],
    reasons: [],
    auth_sources: [],
    ...extra,
  };
}

describe("allowedIntents", () => {
  it("ok grants capability intents including review", () => {
    const intents = allowedIntents(manifest(), report("ok"));
    expect(intents).toContain("review");
    expect(intents).toContain("implement");
  });

  it("unavailable grants nothing", () => {
    expect(allowedIntents(manifest(), report("unavailable"))).toEqual([]);
    expect(allowedIntents(manifest(), null)).toEqual([]);
  });

  it("degraded grants only explicitly enabled intents", () => {
    const intents = allowedIntents(
      manifest(),
      report("degraded", { enabled_intents: ["implement"] }),
    );
    expect(intents).toContain("implement");
    expect(intents).not.toContain("explain");
    expect(intents).not.toContain("review");
  });

  it("degraded keeps a critical intent that is explicitly re-enabled", () => {
    const intents = allowedIntents(manifest(), report("degraded", { enabled_intents: ["review"] }));
    expect(intents).toContain("review");
  });

  it("degraded with no enabled intents grants nothing", () => {
    expect(allowedIntents(manifest(), report("degraded"))).toEqual([]);
  });

  it("answering needs no file access: a route without read_files keeps a doctor-enabled explain, not audit (#133)", () => {
    const remote = HarnessManifest.parse({
      id: "remote",
      display_name: "Remote",
      kind: "remote_api",
      provider_family: "unknown",
      capabilities: { plan: true, review: true, read_files: false },
      access_profiles_supported: ["readonly"],
    });
    expect(capabilityIntents(remote.capabilities)).toEqual(["plan", "spec", "review", "explain"]);
    const intents = allowedIntents(
      remote,
      report("degraded", {
        enabled_intents: ["plan", "review", "explain", "audit"],
        disabled_intents: [],
      }),
    );
    expect(intents).toContain("explain");
    expect(intents).not.toContain("audit");
    // A doctor that does not enable explain still withholds it.
    expect(allowedIntents(remote, report("degraded", { enabled_intents: ["plan"] }))).not.toContain(
      "explain",
    );
    // A file-reading harness keeps both, in the established order.
    expect(capabilityIntents(manifest().capabilities).slice(-2)).toEqual(["explain", "audit"]);
  });
});
