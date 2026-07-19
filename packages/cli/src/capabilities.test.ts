import { describe, expect, it } from "vitest";
import {
  AgentCapabilityCatalog,
  ControlRunStartRequest,
  MODE_MUTABILITY,
  RUN_START_CLIENT_REJECTED_KEYS,
} from "@claudexor/schema";
import { CLI_COMMANDS } from "./command-registry.js";
import { mcpToolNames } from "./capabilities.js";

describe("AgentCapabilityCatalog surfaces", () => {
  it("the catalog DTO is strict about its closed vocabularies", () => {
    const minimal = {
      ok: true,
      version: "0.0.0",
      generatedAt: new Date().toISOString(),
      harnesses: [],
      availableHarnesses: [],
      modes: ["ask", "plan", "agent", "orchestrate"],
      runControlKeys: ["prompt"],
      mutability: {
        readOnlyModes: ["ask", "plan"],
        writeModes: ["agent", "orchestrate"],
        isolationKinds: ["envelope", "live"],
        workspaceModes: ["in_place", "isolated"],
        accessProfiles: [
          "readonly",
          "workspace_write",
          "full",
          "external_sandbox_full",
          "inherit_native",
        ],
        applyModes: ["apply", "commit", "branch", "pr"],
      },
      cliCommands: [{ id: "ask", mutability: "read", stability: "stable", recovery: false }],
      mcpTools: ["claudexor_ask"],
      runApplyStates: ["not_applied", "applied", "applied_review_blocked", "reverted"],
    };
    expect(AgentCapabilityCatalog.parse(minimal).ok).toBe(true);
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
    // (turnId, planRunId) so the catalog never advertises a key that 400s.
    expect([...RUN_START_CLIENT_REJECTED_KEYS].sort()).toEqual(["planRunId", "turnId"]);
  });

  it("MODE_MUTABILITY covers every canonical mode with a closed verdict", () => {
    expect(Object.keys(MODE_MUTABILITY).sort()).toEqual(["agent", "ask", "orchestrate", "plan"]);
    for (const v of Object.values(MODE_MUTABILITY)) expect(["read", "write"]).toContain(v);
  });

  it("every CLI registry command projects into the catalog vocabulary", () => {
    for (const c of CLI_COMMANDS) {
      expect(["read", "write", "delivery", "ops"]).toContain(c.mutability);
      expect(["stable", "experimental"]).toContain(c.stability);
    }
  });

  it("the MCP tool list includes the capabilities tool itself (self-describing surface)", () => {
    const names = mcpToolNames();
    expect(names).toContain("claudexor_capabilities");
    expect(names).toContain("claudexor_status");
    expect(names.length).toBeGreaterThanOrEqual(9);
  });
});
