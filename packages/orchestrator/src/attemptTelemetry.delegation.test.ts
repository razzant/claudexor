import { describe, expect, it } from "vitest";
import {
  attemptTelemetryRecord,
  createAttemptTelemetry,
  delegationBeltUnavailable,
  observeAttemptTelemetry,
  setAttemptOutcome,
} from "./attemptTelemetry.js";
import type { HarnessEvent } from "@claudexor/schema";

const ts = "2026-07-23T00:00:00.000Z";

// A claude `started` frame carrying the injected MCP server statuses (QA-024).
// This is exactly the shape parse.ts surfaces from the vendor init frame:
// `started.payload.mcp_servers = [{ name, status }]`.
function startedWithBelt(status: string): HarnessEvent {
  return {
    type: "started",
    session_id: "s",
    ts,
    payload: { mcp_servers: [{ name: "claudexor", status }] },
  } as unknown as HarnessEvent;
}

function beltToolCall(): HarnessEvent {
  return {
    type: "tool_call",
    session_id: "s",
    ts,
    tool: { name: "mcp__claudexor__claudexor_ask", kind: "other" },
  } as unknown as HarnessEvent;
}

const outcomeOpts = {
  deliverablePresent: true,
  gatesPassed: null,
  harnessErrored: false,
  webRequiredUnsatisfied: false,
};

describe("delegation belt readiness telemetry (QA-024)", () => {
  it("marks the belt requested when a belt server name is injected", () => {
    const t = createAttemptTelemetry("auto", false, "auto", [], null, "claudexor");
    expect(t.delegationBelt.requested).toBe(true);
    expect(t.delegationBelt.serverName).toBe("claudexor");
    // No belt requested when no server injected.
    const none = createAttemptTelemetry("auto", false);
    expect(none.delegationBelt.requested).toBe(false);
  });

  it("a requested belt reported `failed` with zero tool evidence terminalizes FAILED, never silent success", () => {
    const t = createAttemptTelemetry("auto", false, "auto", [], null, "claudexor");
    observeAttemptTelemetry(t, startedWithBelt("failed"));
    expect(t.delegationBelt.failed).toBe(true);
    expect(t.delegationBelt.toolEvidence).toBe(false);
    expect(delegationBeltUnavailable(t)).toBe(true);

    // Deliverable present + gates fine would normally be clean success; the
    // failed belt must elevate it to a typed failure.
    setAttemptOutcome(t, outcomeOpts);
    expect(t.outcome?.status).toBe("failed");

    const rec = attemptTelemetryRecord("a1", "claude", t);
    expect(rec.outcome.delegation_belt_unavailable).toBe(true);
    expect(rec.delegation_belt).toEqual({
      requested: true,
      server_name: "claudexor",
      ready: false,
      failed: true,
      tool_evidence: false,
    });
  });

  it("a failed belt that STILL produced belt tool evidence is not 'unavailable' (used, even if flaky)", () => {
    const t = createAttemptTelemetry("auto", false, "auto", [], null, "claudexor");
    observeAttemptTelemetry(t, startedWithBelt("failed"));
    observeAttemptTelemetry(t, beltToolCall());
    expect(t.delegationBelt.toolEvidence).toBe(true);
    expect(delegationBeltUnavailable(t)).toBe(false);
    setAttemptOutcome(t, outcomeOpts);
    expect(t.outcome?.status).toBe("success");
  });

  it("a ready-but-unused belt stays a clean success (docs leave the spawn decision to the harness)", () => {
    const t = createAttemptTelemetry("auto", false, "auto", [], null, "claudexor");
    observeAttemptTelemetry(t, startedWithBelt("connected"));
    expect(t.delegationBelt.ready).toBe(true);
    expect(t.delegationBelt.failed).toBe(false);
    expect(delegationBeltUnavailable(t)).toBe(false);
    setAttemptOutcome(t, outcomeOpts);
    expect(t.outcome?.status).toBe("success");
    // The evidence record is still emitted (ready/unused is durable truth).
    const rec = attemptTelemetryRecord("a1", "claude", t);
    expect(rec.delegation_belt?.ready).toBe(true);
  });

  it("a non-delegate attempt records no belt evidence at all", () => {
    const t = createAttemptTelemetry("auto", false);
    // A stray mcp_servers frame for some OTHER server never fabricates belt state.
    observeAttemptTelemetry(t, startedWithBelt("failed"));
    expect(t.delegationBelt.requested).toBe(false);
    expect(t.delegationBelt.failed).toBe(false);
    setAttemptOutcome(t, outcomeOpts);
    expect(t.outcome?.status).toBe("success");
    expect(attemptTelemetryRecord("a1", "claude", t).delegation_belt).toBeUndefined();
  });
});
