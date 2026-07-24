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

const ACTIVE: WorkReportEnvelopeMode = {
  active: true,
  source: "constrained",
  hasCallerSchema: false,
  channel: "constrained_json",
  instruction: null,
};
const ACTIVE_SCHEMA: WorkReportEnvelopeMode = {
  active: true,
  source: "constrained",
  hasCallerSchema: true,
  channel: "constrained_json",
  instruction: null,
};
const INACTIVE: WorkReportEnvelopeMode = {
  active: false,
  source: "absent",
  hasCallerSchema: false,
  channel: "constrained_json",
  instruction: null,
};
const SIDE_TOOL: WorkReportEnvelopeMode = {
  active: true,
  source: "constrained",
  hasCallerSchema: false,
  channel: "side_tool",
  instruction: null,
};
const FENCE: WorkReportEnvelopeMode = {
  active: true,
  source: "validated",
  hasCallerSchema: false,
  channel: "instructed_fence",
  instruction: "…",
};

describe("resolveWorkReportEnvelope (D-16 spec-build decision)", () => {
  it("wraps a caller schema on a constrained final_message route", () => {
    const { outputSchema, mode } = resolveWorkReportEnvelope({
      transport: "constrained",
      channel: "final_message",
      supportsJsonSchemaOutput: true,
      interactive: false,
      callerSchema: { type: "object", properties: { x: { type: "string" } } },
    });
    expect(mode).toEqual({
      active: true,
      source: "constrained",
      hasCallerSchema: true,
      channel: "constrained_json",
      instruction: null,
    });
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

  it("activates claude's no-caller side_tool case with a {work_report}-only schema (D-16c)", () => {
    const { outputSchema, mode } = resolveWorkReportEnvelope({
      transport: "constrained",
      channel: "side_tool",
      supportsJsonSchemaOutput: true,
      interactive: false,
      callerSchema: null,
    });
    expect(mode.active).toBe(true);
    expect(mode.channel).toBe("side_tool");
    expect(mode.source).toBe("constrained");
    // A {work_report}-ONLY envelope: no `output` half, so the markdown final
    // message stays the deliverable.
    expect(outputSchema?.["required"]).toEqual(["work_report"]);
    expect(outputSchema?.["properties"]).not.toHaveProperty("output");
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

  it("activates validated routes (cursor) with an instructed fenced envelope (D-16c)", () => {
    const { outputSchema, mode } = resolveWorkReportEnvelope({
      transport: "validated",
      channel: "final_message",
      supportsJsonSchemaOutput: false,
      interactive: false,
      callerSchema: null,
    });
    expect(mode.active).toBe(true);
    expect(mode.channel).toBe("instructed_fence");
    expect(mode.source).toBe("validated");
    // No native schema constrains cursor — the envelope rides an instruction.
    expect(mode.instruction).toBeTruthy();
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

  // A no-caller-schema route promises `output` is the deliverable STRING. A
  // non-string (or missing) output is a broken envelope, NOT something to coerce
  // to "[object Object]" and finalize clean (constrained_json + instructed_fence).
  const fenceEnvelope = (envelope: unknown): string =>
    ["prefatory prose", "```json", JSON.stringify(envelope), "```"].join("\n");
  const nonStringOutputs: Array<[string, unknown]> = [
    ["object", {}],
    ["array", []],
    ["null", null],
  ];
  for (const [label, badOutput] of nonStringOutputs) {
    it(`constrained_json: ${label} output is a work_report contract violation (never "[object Object]")`, () => {
      const text = JSON.stringify({ work_report: completed, output: badOutput });
      const r = unwrapWorkReportEnvelope(text, ACTIVE);
      expect(r.contractViolation).toMatch(/output must be a string/);
      expect(r.workReport).toBeNull();
      expect(r.deliverable).not.toContain("[object Object]");
    });
    it(`instructed_fence: ${label} output is a work_report contract violation`, () => {
      const r = unwrapWorkReportEnvelope(
        fenceEnvelope({ work_report: completed, output: badOutput }),
        FENCE,
      );
      expect(r.contractViolation).toMatch(/output must be a string/);
      expect(r.workReport).toBeNull();
      expect(r.deliverable).not.toContain("[object Object]");
    });
  }

  it("constrained_json: a missing output slot is a work_report contract violation", () => {
    const r = unwrapWorkReportEnvelope(JSON.stringify({ work_report: completed }), ACTIVE);
    expect(r.contractViolation).toMatch(/output must be a string/);
    expect(r.workReport).toBeNull();
  });

  it("instructed_fence: a missing output slot is a work_report contract violation", () => {
    const r = unwrapWorkReportEnvelope(fenceEnvelope({ work_report: completed }), FENCE);
    expect(r.contractViolation).toMatch(/output must be a string/);
    expect(r.workReport).toBeNull();
  });

  it("flags non-JSON on an active route as a contract violation", () => {
    const r = unwrapWorkReportEnvelope("not json at all", ACTIVE);
    expect(r.contractViolation).toMatch(/not the JSON work_report envelope/);
    expect(r.workReport).toBeNull();
  });

  it("redacts secret-like tokens in required_inputs locator+description (one owner)", () => {
    // Assemble the fake token at runtime so this test file never carries a
    // contiguous secret-like token at rest (runSupport.test.ts pattern).
    const fakeToken = ["sk-ant", "1234567890abcdefghij"].join("-");
    const text = JSON.stringify({
      work_report: {
        state: "needs_input",
        required_inputs: [
          {
            kind: "credential",
            locator: `env:API_KEY=${fakeToken}`,
            description: `paste ${fakeToken} to proceed`,
          },
        ],
      },
      output: "partial",
    });
    const r = unwrapWorkReportEnvelope(text, ACTIVE);
    expect(r.contractViolation).toBeNull();
    const ri = r.workReport?.required_inputs[0];
    // The raw token never survives into the validated work_report (which flows
    // to telemetry yaml, decision facts, and the CLI needsInputLabel).
    expect(ri?.locator).not.toContain(fakeToken);
    expect(ri?.description).not.toContain(fakeToken);
    expect(ri?.locator).toContain("[redacted]");
    expect(ri?.description).toContain("[redacted]");
    // Non-secret text is preserved.
    expect(ri?.description).toContain("to proceed");
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
    const text =
      '{"work_report":{"state":"completed","required_inputs":[]},"__proto__":{"polluted":1},"output":"ok"}';
    const r = unwrapWorkReportEnvelope(text, ACTIVE);
    expect(r.deliverable).toBe("ok");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  // D-16c side_tool (claude): the markdown answer IS the deliverable; the report
  // rides the tool payload the caller extracted from telemetry.
  it("side_tool: markdown stays the deliverable, tool payload is the report", () => {
    const r = unwrapWorkReportEnvelope("# The markdown answer", SIDE_TOOL, {
      sideToolReport: completed,
    });
    expect(r.deliverable).toBe("# The markdown answer");
    expect(r.workReport).toEqual(completed);
    expect(r.source).toBe("constrained");
    expect(r.contractViolation).toBeNull();
  });

  it("side_tool: a missing tool report is a typed contract violation", () => {
    const r = unwrapWorkReportEnvelope("# answer", SIDE_TOOL, {});
    expect(r.contractViolation).toMatch(/StructuredOutput tool did not carry a work_report/);
    // The markdown deliverable is still preserved for inspection.
    expect(r.deliverable).toBe("# answer");
  });

  it("side_tool: a malformed tool report is a typed contract violation", () => {
    const r = unwrapWorkReportEnvelope("# answer", SIDE_TOOL, {
      sideToolReport: { state: "bogus" },
    });
    expect(r.contractViolation).toMatch(/work_report missing or malformed/);
  });

  // D-16c instructed_fence (cursor): the envelope is the LAST fenced JSON block.
  it("instructed_fence: parses the last fenced JSON block, prose before it discarded", () => {
    const answer = [
      "Here is my summary of what I did.",
      "```json",
      JSON.stringify({ work_report: completed, output: "final deliverable text" }),
      "```",
    ].join("\n");
    const r = unwrapWorkReportEnvelope(answer, FENCE);
    expect(r.deliverable).toBe("final deliverable text");
    expect(r.workReport).toEqual(completed);
    expect(r.source).toBe("validated");
    expect(r.contractViolation).toBeNull();
  });

  it("instructed_fence: no fenced block is a typed contract violation (validated route)", () => {
    const r = unwrapWorkReportEnvelope("just prose, no fence", FENCE);
    expect(r.contractViolation).toMatch(/no fenced work_report envelope/);
  });

  it("instructed_fence: a needs_input envelope carries required_inputs", () => {
    const answer = "```json\n" + JSON.stringify({ work_report: needsInput, output: "" }) + "\n```";
    const r = unwrapWorkReportEnvelope(answer, FENCE);
    expect(r.workReport?.state).toBe("needs_input");
    expect(r.workReport?.required_inputs).toHaveLength(1);
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
