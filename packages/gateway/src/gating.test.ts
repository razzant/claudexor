import { describe, expect, it } from "vitest";
import type { ConformanceReport, HarnessManifest } from "@claudex/schema";
import { allowedIntents } from "./gating.js";

function manifest(): HarnessManifest {
  return {
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
      compare: true,
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
      quota_signal: "observed",
      usage_signal: "exact",
    },
    auth_modes: ["local_session"],
    access_profiles_supported: ["readonly", "workspace_write", "full"],
    models: { discovery: "available" },
  };
}

function report(status: ConformanceReport["status"], extra: Partial<ConformanceReport> = {}): ConformanceReport {
  return {
    harness_id: "x",
    status,
    checks: [],
    enabled_intents: [],
    disabled_intents: [],
    reasons: [],
    ...extra,
  };
}

describe("allowedIntents", () => {
  it("ok grants capability intents including review/arbitrate", () => {
    const intents = allowedIntents(manifest(), report("ok"));
    expect(intents).toContain("review");
    expect(intents).toContain("arbitrate");
    expect(intents).toContain("implement");
  });

  it("unavailable grants nothing", () => {
    expect(allowedIntents(manifest(), report("unavailable"))).toEqual([]);
    expect(allowedIntents(manifest(), null)).toEqual([]);
  });

  it("degraded drops critical intents unless explicitly enabled", () => {
    const intents = allowedIntents(manifest(), report("degraded", { enabled_intents: ["implement"] }));
    expect(intents).toContain("implement");
    expect(intents).not.toContain("review");
    expect(intents).not.toContain("arbitrate");
  });

  it("degraded keeps a critical intent that is explicitly re-enabled", () => {
    const intents = allowedIntents(manifest(), report("degraded", { enabled_intents: ["review"] }));
    expect(intents).toContain("review");
  });
});
