import { describe, it, expect } from "vitest";
import type { WorkReport } from "@claudexor/schema";
import {
  finalizeAttempt,
  readOnlyNoSuccessTerminal,
  resolveWorkReportEnvelope,
  unwrapWorkReportEnvelope,
  type WorkReportEnvelopeMode,
} from "./attemptFinalize.js";

const completed: WorkReport = { state: "completed", required_inputs: [] };
const needsInput: WorkReport = {
  state: "needs_input",
  required_inputs: [{ kind: "decision", locator: "db-backend", description: "which db?" }],
};

const ACTIVE: WorkReportEnvelopeMode = { active: true, source: "constrained", hasCallerSchema: false };
const ACTIVE_SCHEMA: WorkReportEnvelopeMode = {
  active: true,
  source: "constrained",
  hasCallerSchema: true,
};
const INACTIVE: WorkReportEnvelopeMode = { active: false, source: "absent", hasCallerSchema: false };

describe("resolveWorkReportEnvelope (D-16 spec-build decision)", () => {
  it("wraps a caller schema on a constrained final_message route", () => {
    const { outputSchema, mode } = resolveWorkReportEnvelope({
      transport: "constrained",
      channel: "final_message",
      supportsJsonSchemaOutput: true,
      interactive: false,
      callerSchema: { type: "object", properties: { x: { type: "string" } } },
    });
    expect(mode).toEqual({ active: true, source: "constrained", hasCallerSchema: true });
    expect(outputSchema).toMatchObject({
      type: "object",
      required: ["work_report", "output"],
      additionalProperties: false,
    });
    // The output half is the strictified caller schema, nested (still the
    // conformance authority for the caller lives on the contract, not here).
    expect((outputSchema?.["properties"] as Record<string, unknown>)["output"]).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
  });

  it("wraps the markdown as output:string on a no-caller final_message route", () => {
    const { outputSchema, mode } = resolveWorkReportEnvelope({
      transport: "constrained",
      channel: "final_message",
      supportsJsonSchemaOutput: true,
      interactive: false,
      callerSchema: null,
    });
    expect(mode.active).toBe(true);
    const props = outputSchema?.["properties"] as Record<string, unknown>;
    expect(props["output"]).toEqual({ type: "string" });
    expect(outputSchema?.["required"]).toEqual(["work_report", "output"]);
  });

  it("leaves claude's no-caller side_tool case INACTIVE (D-16c seam)", () => {
    const { outputSchema, mode } = resolveWorkReportEnvelope({
      transport: "constrained",
      channel: "side_tool",
      supportsJsonSchemaOutput: true,
      interactive: false,
      callerSchema: null,
    });
    expect(mode.active).toBe(false);
    expect(outputSchema).toBeUndefined();
  });

  it("activates side_tool WITH a caller schema (claude enveloped answer)", () => {
    const { mode } = resolveWorkReportEnvelope({
      transport: "constrained",
      channel: "side_tool",
      supportsJsonSchemaOutput: true,
      interactive: false,
      callerSchema: { type: "object", properties: {} },
    });
    expect(mode.active).toBe(true);
  });

  it("discloses unsupported for a claude interactive stream-json lane", () => {
    const { mode } = resolveWorkReportEnvelope({
      transport: "constrained",
      channel: "side_tool",
      supportsJsonSchemaOutput: true,
      interactive: true,
      callerSchema: { type: "object", properties: {} },
    });
    expect(mode.active).toBe(false);
  });

  it("leaves validated routes (cursor) INACTIVE in D-16b (adapter instruction is D-16c)", () => {
    const { outputSchema, mode } = resolveWorkReportEnvelope({
      transport: "validated",
      channel: "final_message",
      supportsJsonSchemaOutput: false,
      interactive: false,
      callerSchema: null,
    });
    expect(mode.active).toBe(false);
    expect(outputSchema).toBeUndefined();
  });

  it("preserves the legacy caller-schema transport on an unsupported route", () => {
    const { outputSchema, mode } = resolveWorkReportEnvelope({
      transport: "unsupported",
      channel: "final_message",
      supportsJsonSchemaOutput: true,
      interactive: false,
      callerSchema: { type: "object", properties: { x: { type: "string" } } },
    });
    expect(mode.active).toBe(false);
    // The caller schema still rides (strictified), no work_report wrapper.
    expect(outputSchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(outputSchema?.["properties"]).toHaveProperty("x");
    expect(outputSchema?.["properties"]).not.toHaveProperty("work_report");
  });
});

describe("unwrapWorkReportEnvelope", () => {
  it("passes the answer through untouched when inactive", () => {
    const r = unwrapWorkReportEnvelope("plain markdown", INACTIVE);
    expect(r).toEqual({
      deliverable: "plain markdown",
      workReport: null,
      source: "absent",
      contractViolation: null,
    });
  });

  it("un-nests output:string and a completed report", () => {
    const text = JSON.stringify({ work_report: completed, output: "the answer" });
    const r = unwrapWorkReportEnvelope(text, ACTIVE);
    expect(r.deliverable).toBe("the answer");
    expect(r.workReport).toEqual(completed);
    expect(r.contractViolation).toBeNull();
  });

  it("re-serializes a caller-schema output object for downstream validation", () => {
    const text = JSON.stringify({ work_report: completed, output: { x: "v" } });
    const r = unwrapWorkReportEnvelope(text, ACTIVE_SCHEMA);
    expect(JSON.parse(r.deliverable)).toEqual({ x: "v" });
    expect(r.workReport).toEqual(completed);
  });

  it("flags non-JSON on an active route as a contract violation", () => {
    const r = unwrapWorkReportEnvelope("not json at all", ACTIVE);
    expect(r.contractViolation).toMatch(/not the JSON work_report envelope/);
    expect(r.workReport).toBeNull();
  });

  it("flags a missing/malformed work_report as a contract violation", () => {
    const text = JSON.stringify({ output: "x", work_report: { state: "bogus" } });
    const r = unwrapWorkReportEnvelope(text, ACTIVE);
    expect(r.contractViolation).toMatch(/work_report missing or malformed/);
  });

  it("enforces completed ⇒ no required_inputs (finalizer, not Zod)", () => {
    const bad = {
      work_report: { state: "completed", required_inputs: [needsInput.required_inputs[0]] },
      output: "x",
    };
    const r = unwrapWorkReportEnvelope(JSON.stringify(bad), ACTIVE);
    expect(r.contractViolation).toMatch(/completed work_report must not list required_inputs/);
  });

  it("enforces needs_input ⇒ ≥1 required_input", () => {
    const bad = { work_report: { state: "needs_input", required_inputs: [] }, output: "x" };
    const r = unwrapWorkReportEnvelope(JSON.stringify(bad), ACTIVE);
    expect(r.contractViolation).toMatch(/needs_input work_report must list at least one/);
  });

  it("does not let a prototype-pollution output key escape the envelope", () => {
    const text = '{"work_report":{"state":"completed","required_inputs":[]},"__proto__":{"polluted":1},"output":"ok"}';
    const r = unwrapWorkReportEnvelope(text, ACTIVE);
    expect(r.deliverable).toBe("ok");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

describe("finalizeAttempt (the unified finalizer matrix)", () => {
  const base = {
    deliverableEvidence: true,
    harnessErrored: false,
    workReport: null as WorkReport | null,
    workReportSource: "absent" as const,
    workReportViolation: null as string | null,
    contextTerminalExhausted: false,
  };

  it("clean completed report ⇒ completed work_state, no reason", () => {
    const r = finalizeAttempt({ ...base, workReport: completed, workReportSource: "constrained" });
    expect(r.outcomeClass).toBe("clean");
    expect(r.workState).toEqual({ state: "completed", source: "constrained" });
    expect(r.reason).toBeNull();
    expect(r.harnessErrored).toBe(false);
  });

  it("no report ⇒ unverified, absent, clean", () => {
    const r = finalizeAttempt(base);
    expect(r.workState).toEqual({ state: "unverified", source: "absent" });
    expect(r.outcomeClass).toBe("clean");
  });

  it("needs_input ⇒ veto: work_state carries required_inputs, typed reason, NOT errored", () => {
    const r = finalizeAttempt({
      ...base,
      workReport: needsInput,
      workReportSource: "constrained",
    });
    expect(r.outcomeClass).toBe("veto");
    expect(r.reason).toBe("input_required");
    expect(r.harnessErrored).toBe(false); // lifecycle stays succeeded-class (INV-116)
    expect(r.workState.state).toBe("needs_input");
    expect(r.workState.required_inputs).toHaveLength(1);
  });

  it("incomplete ⇒ veto with work_incomplete reason", () => {
    const r = finalizeAttempt({
      ...base,
      workReport: { state: "incomplete", required_inputs: [] },
      workReportSource: "constrained",
    });
    expect(r.outcomeClass).toBe("veto");
    expect(r.reason).toBe("work_incomplete");
  });

  it("a broken contract on a constrained route ⇒ hard failure (never prose success)", () => {
    const r = finalizeAttempt({
      ...base,
      workReportViolation: "final answer is not the JSON work_report envelope",
      workReportSource: "constrained",
    });
    expect(r.outcomeClass).toBe("contract_failure");
    expect(r.reason).toBe("work_report_contract");
    expect(r.harnessErrored).toBe(true);
    expect(r.deliverablePresent).toBe(false);
  });

  it("terminal context exhaustion with no completed report ⇒ interrupted", () => {
    const r = finalizeAttempt({ ...base, contextTerminalExhausted: true });
    expect(r.outcomeClass).toBe("interrupted");
    expect(r.reason).toBe("context_capacity_exhausted");
  });

  it("a COMPLETED report survives a concurrent context signal (completed wins the exhaustion race)", () => {
    const r = finalizeAttempt({
      ...base,
      workReport: completed,
      workReportSource: "constrained",
      contextTerminalExhausted: true,
    });
    expect(r.outcomeClass).toBe("clean");
    expect(r.workState.state).toBe("completed");
  });

  it("a completed claim NEVER invents deliverable evidence", () => {
    const r = finalizeAttempt({
      ...base,
      deliverableEvidence: false,
      workReport: completed,
      workReportSource: "constrained",
    });
    expect(r.deliverablePresent).toBe(false);
  });
});

describe("readOnlyNoSuccessTerminal (QA-036)", () => {
  it("a blocked Ask WITH a partial deliverable is a review-blocked success", () => {
    expect(
      readOnlyNoSuccessTerminal({
        webBlocked: true,
        hasDeliverable: true,
        budgetStopped: false,
        attemptsCount: 1,
      }),
    ).toEqual({ lifecycle: "succeeded", review: "blocked", reason: "review_blocked" });
  });

  it("REGRESSION QA-036: a blocked Ask with NO deliverable is a FAILURE, never succeeded", () => {
    const facts = readOnlyNoSuccessTerminal({
      webBlocked: true,
      hasDeliverable: false,
      budgetStopped: false,
      attemptsCount: 1,
    });
    expect(facts.lifecycle).toBe("failed");
    expect(facts.review).toBeUndefined();
  });

  it("an empty budget stop is budget_exhausted", () => {
    expect(
      readOnlyNoSuccessTerminal({
        webBlocked: false,
        hasDeliverable: false,
        budgetStopped: true,
        attemptsCount: 0,
      }),
    ).toEqual({ lifecycle: "failed", reason: "budget_exhausted" });
  });
});
