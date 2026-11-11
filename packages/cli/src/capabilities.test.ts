import { describe, expect, it } from "vitest";
import {
  AgentCapabilityCatalog,
  CatalogHarness,
  ControlRunStartRequest,
  MODE_MUTABILITY,
  RUN_START_CLIENT_REJECTED_KEYS,
} from "@claudexor/schema";
import { CLI_COMMANDS } from "./command-registry.js";
import { catalogAccessControl, mcpToolNames } from "./capabilities.js";

describe("AgentCapabilityCatalog surfaces", () => {
  it("the catalog DTO is strict about its closed vocabularies", () => {
    const minimal = {
      ok: true,
      version: "0.0.0",
      generatedAt: new Date().toISOString(),
      git: {
        status: "developer_tools_stub",
        version: null,
        detail: "xcode-select: no developer tools",
        remediation: "Install Apple Command Line Tools with xcode-select --install.",
      },
      harnesses: [],
      availableHarnesses: [],
      modes: ["ask", "plan", "agent"],
      runControlKeys: ["prompt"],
      runDecisionActions: ["taken"],
      outputSchemaDialects: [
        {
          dialect: "draft-07",
          uri: "http://json-schema.org/draft-07/schema#",
          defaultWhenOmitted: true,
        },
        {
          dialect: "draft-2020-12",
          uri: "https://json-schema.org/draft/2020-12/schema",
          defaultWhenOmitted: false,
        },
      ],
      mutability: {
        readOnlyModes: ["ask", "plan"],
        writeModes: ["agent"],
        isolationKinds: ["envelope", "live"],
        workspaceModes: ["in_place", "isolated"],
        accessProfiles: ["readonly", "workspace_write", "full", "inherit_native"],
        applyModes: ["apply", "commit", "branch", "pr"],
      },
      cliCommands: [{ id: "ask", mutability: "read", stability: "stable", recovery: false }],
      mcpTools: ["claudexor_ask"],
      runApplyStates: ["not_applied", "applied", "applied_review_blocked", "reverted"],
    };
    expect(AgentCapabilityCatalog.parse(minimal).ok).toBe(true);
    expect(AgentCapabilityCatalog.parse(minimal).outputSchemaDialects).toHaveLength(2);
    expect(AgentCapabilityCatalog.parse(minimal).git.status).toBe("developer_tools_stub");
    // An invented isolation kind must be refused, not passed through.
    expect(() =>
      AgentCapabilityCatalog.parse({
        ...minimal,
        mutability: { ...minimal.mutability, isolationKinds: ["container"] },
      }),
    ).toThrow();
  });

  it("run-control keys exclude EVERY key POST /runs rejects from direct clients", () => {
    const keys = Object.keys(ControlRunStartRequest.shape);
    // The schema carries the internal keys (thread-turn pipeline)...
    for (const internal of RUN_START_CLIENT_REJECTED_KEYS) expect(keys).toContain(internal);
    // ...and the shared exclusion list covers exactly the daemon's 400-guards
    // (threadId, turnId, planRunId, planRef) so the catalog never advertises a
    // key that 400s. threadId joined the list under D10: a thread turn is
    // created through POST /threads/:id/turns, never POST /runs.
    expect([...RUN_START_CLIENT_REJECTED_KEYS].sort()).toEqual([
      "continueModelInherited",
      "delegatedFromRunId",
      "parentRunId",
      "planRef",
      "planRunId",
      "retryOf",
      "threadId",
      "turnId",
    ]);
  });

  it("MODE_MUTABILITY covers every canonical mode with a closed verdict", () => {
    expect(Object.keys(MODE_MUTABILITY).sort()).toEqual(["agent", "ask", "plan"]);
    for (const v of Object.values(MODE_MUTABILITY)) expect(["read", "write"]).toContain(v);
  });

  it("every CLI registry command projects into the catalog vocabulary", () => {
    for (const c of CLI_COMMANDS) {
      expect(["read", "write", "delivery", "ops"]).toContain(c.mutability);
      expect(["stable", "experimental"]).toContain(c.stability);
    }
  });

  it("a harness row carries its live-input channel: legacy omission reads none, the enum is closed", () => {
    const row = {
      id: "codex",
      enabled: true,
      displayName: "Codex",
      status: "ok",
      providerFamily: "openai",
      enabledIntents: [],
      disabledIntents: [],
      reasons: [],
      configuredModel: null,
      configuredModelValid: null,
      models: { source: "none", count: 0, verifiedAgainst: null },
      webPolicy: "none",
      attachmentInputs: [],
      effortLevels: [],
      accessProfilesSupported: [],
      readonlyMechanism: "none",
      writeMechanism: "none",
      delegation: {
        available: false,
        reason: "manifest_unsupported",
        remediation: "Choose a harness that supports Claudexor MCP injection.",
        requiresFullAccess: false,
      },
    };
    // An engine older than 3.16.0 omits the field: the consumer reads `none`.
    expect(CatalogHarness.parse(row).liveInput).toBe("none");
    for (const liveInput of ["mid_turn", "next_tool_boundary", "none"] as const) {
      expect(CatalogHarness.parse({ ...row, liveInput }).liveInput).toBe(liveInput);
    }
    // An invented channel is refused, never passed through as a capability.
    expect(() => CatalogHarness.parse({ ...row, liveInput: "interrupt" })).toThrow();
  });

  it("negotiates auxiliary writable roots from capability facts; omission reads unsupported", async () => {
    const { createCodexAdapter } = await import("@claudexor/harness-codex");
    const { createClaudeAdapter } = await import("@claudexor/harness-claude");
    expect(catalogAccessControl(createCodexAdapter().capabilityProfile)).toEqual({
      auxiliaryWritableRoots: true,
    });
    expect(catalogAccessControl(createClaudeAdapter().capabilityProfile)).toEqual({
      auxiliaryWritableRoots: false,
    });
    expect(catalogAccessControl(undefined)).toEqual({ auxiliaryWritableRoots: false });
    const { accessControl: _omitted, ...legacy } = CatalogHarness.parse({
      id: "older-engine",
      enabled: true,
      displayName: "Older",
      status: "ok",
      providerFamily: "openai",
      enabledIntents: [],
      disabledIntents: [],
      reasons: [],
      configuredModel: null,
      configuredModelValid: null,
      models: { source: "none", count: 0, verifiedAgainst: null },
      webPolicy: "none",
      attachmentInputs: [],
      effortLevels: [],
      accessProfilesSupported: [],
      readonlyMechanism: "none",
      delegation: {
        available: false,
        reason: "manifest_unsupported",
        remediation: "n/a",
        requiresFullAccess: false,
      },
    });
    expect(CatalogHarness.parse(legacy).accessControl).toEqual({ auxiliaryWritableRoots: false });
  });

  it("the MCP tool list includes the capabilities tool itself (self-describing surface)", () => {
    const names = mcpToolNames();
    expect(names).toContain("claudexor_capabilities");
    expect(names).toContain("claudexor_status");
    expect(names.length).toBeGreaterThanOrEqual(9);
  });
});
