import { describe, it, expect } from "vitest";
import type { WorkReport } from "@claudexor/schema";
import {
  finalizeAttempt,
  readOnlyNoSuccessTerminal,
  unrecoveredToolErrorFailure,
  webEvidenceFailure,
} from "./attemptFinalize.js";
import {
  resolveWorkReportEnvelope,
  unwrapWorkReportEnvelope,
  type WorkReportEnvelopeMode,
} from "./workReportEnvelope.js";
import type { ToolErrorRecord } from "./attemptTelemetry.js";

const completed: WorkReport = { state: "completed", required_inputs: [] };
const needsInput: WorkReport = {
  state: "needs_input",
  required_inputs: [{ kind: "decision", locator: "db-backend", description: "which db?" }],
};
const incomplete: WorkReport = { state: "incomplete", required_inputs: [] };

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
    expect(mode.instruction).toContain("complete final answer as normal Markdown");
    expect(mode.instruction).not.toContain('"output"');
    // The footer is requested, not "mandatory": its absence leaves the work
    // state unverified (owner decision 2026-10-05), and the instruction says so.
    expect(mode.instruction).not.toContain("mandatory");
    expect(mode.instruction).toContain("Always end with this block");
    expect(mode.instruction).toContain("unverified");
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

  // A constrained no-caller-schema route promises `output` is the deliverable
  // STRING. Cursor's instructed fence uses it only as a compatibility fallback
  // for historical fence-only replies.
  const fenceEnvelope = (envelope: unknown): string =>
    ["```json", JSON.stringify(envelope), "```"].join("\n");
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
    it(`instructed_fence: fence-only legacy ${label} output is disclosed unverified, never a violation`, () => {
      const text = fenceEnvelope({ work_report: completed, output: badOutput });
      const r = unwrapWorkReportEnvelope(text, FENCE);
      expect(r.contractViolation).toBeNull();
      expect(r.workReport).toBeNull();
      expect(r.unverified).toEqual({
        reason: "legacy_output_invalid",
        detail: expect.stringMatching(/output must be a string/),
      });
      // The whole reply is kept: never "[object Object]", never an empty answer.
      expect(r.deliverable).toBe(text);
    });
    it(`instructed_fence: a valid veto outranks a fence-only legacy ${label} output`, () => {
      for (const report of [needsInput, incomplete]) {
        const text = fenceEnvelope({ work_report: report, output: badOutput });
        const r = unwrapWorkReportEnvelope(text, FENCE);
        expect(r.workReport).toEqual(report);
        expect(r.unverified).toBeUndefined();
        expect(r.contractViolation).toBeNull();
        expect(r.deliverable).toBe(text);
      }
    });
  }

  it("constrained_json: a missing output slot is a work_report contract violation", () => {
    const r = unwrapWorkReportEnvelope(JSON.stringify({ work_report: completed }), ACTIVE);
    expect(r.contractViolation).toMatch(/output must be a string/);
    expect(r.workReport).toBeNull();
  });

  it("instructed_fence: a footer-only report is valid with an empty deliverable", () => {
    const r = unwrapWorkReportEnvelope(fenceEnvelope({ work_report: completed }), FENCE);
    expect(r.deliverable).toBe("");
    expect(r.workReport).toEqual(completed);
    expect(r.contractViolation).toBeNull();
  });

  it("flags non-JSON on an active route as a contract violation", () => {
    const r = unwrapWorkReportEnvelope("not json at all", ACTIVE);
    expect(r.contractViolation).toMatch(/not the JSON work_report envelope/);
    expect(r.workReport).toBeNull();
  });

  it("keeps required_inputs locator+description exactly as the model wrote them (INV-146)", () => {
    // Assembled at runtime so this test file never carries a contiguous
    // token-shaped literal at rest.
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
    // The validated work_report feeds telemetry, decision facts, the CLI
    // needs-input label and the next turn: the model's own words, unchanged.
    expect(r.workReport?.required_inputs[0]).toEqual({
      kind: "credential",
      locator: `env:API_KEY=${fakeToken}`,
      description: `paste ${fakeToken} to proceed`,
    });
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
    expect(r.workReport).toBeNull();
    expect(r.reportProblem).toEqual({
      kind: "completed_with_required_inputs",
      reported: bad.work_report,
    });
  });

  it("enforces needs_input ⇒ ≥1 required_input", () => {
    const bad = { work_report: { state: "needs_input", required_inputs: [] }, output: "x" };
    const r = unwrapWorkReportEnvelope(JSON.stringify(bad), ACTIVE);
    expect(r.contractViolation).toMatch(/needs_input work_report must list at least one/);
    expect(r.reportProblem).toBeUndefined();
  });

  it("never attaches the salvage marker to malformed reports or invalid output slots", () => {
    const contradictory = { ...completed, required_inputs: needsInput.required_inputs };
    for (const raw of [
      "not JSON",
      "[]",
      JSON.stringify({ work_report: contradictory }),
      JSON.stringify({ work_report: contradictory, output: {} }),
      JSON.stringify({ work_report: { state: "unknown" }, output: "useful text" }),
    ]) {
      const result = unwrapWorkReportEnvelope(raw, ACTIVE);
      expect(result.contractViolation).not.toBeNull();
      expect(result.reportProblem).toBeUndefined();
    }
  });

  it("retains the contradictory claim exactly for the evidence writers (INV-146)", () => {
    const secret = "sk-" + "aB3dEf9h".repeat(6);
    const result = unwrapWorkReportEnvelope(
      JSON.stringify({
        output: "useful plan",
        work_report: {
          state: "completed",
          required_inputs: [{ kind: "context", locator: secret, description: `See ${secret}` }],
        },
      }),
      ACTIVE,
    );
    expect(result.workReport).toBeNull();
    expect(result.reportProblem?.kind).toBe("completed_with_required_inputs");
    expect(result.reportProblem?.reported.required_inputs[0]).toEqual({
      kind: "context",
      locator: secret,
      description: `See ${secret}`,
    });
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

  // D-16c instructed_fence (cursor): the LAST fenced JSON block is metadata;
  // the complete Markdown before it is the canonical deliverable.
  it("instructed_fence: preserves rich Markdown and treats the last fence as metadata", () => {
    const answer = [
      "# Plan",
      "",
      "## Steps",
      "1. Inspect the current owner.",
      "2. Make the smallest shared change.",
      "",
      "```ts",
      "const preserved = true;",
      "```",
      "",
      "## Risks",
      "- Keep legacy fence-only replies readable.",
      "",
      "## Open Questions",
      "- [single] Which rollout? :: staged :: immediate",
      "```json",
      JSON.stringify({ work_report: completed }),
      "```",
    ].join("\n");
    const r = unwrapWorkReportEnvelope(answer, FENCE);
    expect(r.deliverable).toBe(answer.slice(0, answer.lastIndexOf("```json")).trimEnd());
    expect(r.workReport).toEqual(completed);
    expect(r.source).toBe("validated");
    expect(r.contractViolation).toBeNull();
  });

  it("instructed_fence: a rich prefix wins over a redundant legacy output", () => {
    const answer = [
      "# Complete answer",
      "Full detail that must not be replaced by a short summary.",
      "```json",
      JSON.stringify({ work_report: completed, output: "short summary" }),
      "```",
    ].join("\n");
    const r = unwrapWorkReportEnvelope(answer, FENCE);
    expect(r.deliverable).toBe(
      "# Complete answer\nFull detail that must not be replaced by a short summary.",
    );
    expect(r.workReport).toEqual(completed);
    expect(r.contractViolation).toBeNull();
  });

  it("instructed_fence: a historical fence-only envelope falls back to output", () => {
    const r = unwrapWorkReportEnvelope(
      fenceEnvelope({ work_report: completed, output: "legacy answer" }),
      FENCE,
    );
    expect(r.deliverable).toBe("legacy answer");
    expect(r.workReport).toEqual(completed);
    expect(r.contractViolation).toBeNull();
  });

  // Owner decision 2026-10-05 («1. A»): an INSTRUCTED footer is a request, not
  // a native constraint, so every footer problem is a disclosed unverified
  // work_state with the COMPLETE answer as the deliverable — never a contract
  // failure, and never a trailing consumer JSON block cut out of the answer.
  it("instructed_fence: no fenced block ⇒ unverified footer_missing, whole answer kept", () => {
    const r = unwrapWorkReportEnvelope("just prose, no fence", FENCE);
    expect(r).toEqual({
      deliverable: "just prose, no fence",
      workReport: null,
      source: "validated",
      contractViolation: null,
      unverified: { reason: "footer_missing", detail: expect.stringMatching(/no fenced/) },
    });
  });

  it("instructed_fence: a trailing consumer JSON array is part of the answer, not a footer", () => {
    const answer = [
      "Review result:",
      "```json",
      JSON.stringify([{ id: "f1", class: "need_evidence" }]),
      "```",
    ].join("\n");
    const r = unwrapWorkReportEnvelope(answer, FENCE);
    expect(r.deliverable).toBe(answer);
    expect(r.contractViolation).toBeNull();
    expect(r.unverified?.reason).toBe("footer_not_object");
  });

  it("instructed_fence: a lone consumer JSON object fence keeps the whole text (never an empty deliverable)", () => {
    const answer = fenceEnvelope({ verdict: "PASS", findings: [] });
    const r = unwrapWorkReportEnvelope(answer, FENCE);
    expect(r.deliverable).toBe(answer);
    expect(r.unverified?.reason).toBe("report_missing");
    expect(r.workReport).toBeNull();
    expect(r.contractViolation).toBeNull();
  });

  it("instructed_fence: a trailing code fence that is not JSON is part of the answer", () => {
    const answer = "# Fix\n\n```ts\nconst preserved = true;\n```";
    const r = unwrapWorkReportEnvelope(answer, FENCE);
    expect(r.deliverable).toBe(answer);
    expect(r.unverified?.reason).toBe("footer_not_json");
    expect(r.contractViolation).toBeNull();
  });

  it("instructed_fence: a broken footer attempt is disclosed and nothing is cut from the answer", () => {
    for (const answer of [
      ["# Answer", "Full detail.", fenceEnvelope({ work_report: { state: "bogus" } })].join("\n"),
      fenceEnvelope({ work_report: { state: "bogus" } }),
    ]) {
      const r = unwrapWorkReportEnvelope(answer, FENCE);
      expect(r.deliverable).toBe(answer);
      expect(r.workReport).toBeNull();
      expect(r.contractViolation).toBeNull();
      expect(r.unverified).toEqual({
        reason: "report_malformed",
        detail: expect.stringMatching(/work_report missing or malformed/),
      });
    }
  });

  it("instructed_fence: a malformed needs_input claim stays readable in the answer (never a veto, never hidden)", () => {
    // The required_inputs kind is outside the enum, so the report is not valid:
    // it cannot veto, but the reader must still see what the model asked for.
    const footer = fenceEnvelope({
      work_report: {
        state: "needs_input",
        required_inputs: [{ kind: "api_key", locator: null, description: "Need the staging key" }],
      },
    });
    const answer = ["# Partial answer", footer].join("\n");
    const r = unwrapWorkReportEnvelope(answer, FENCE);
    expect(r.workReport).toBeNull();
    expect(r.unverified?.reason).toBe("report_malformed");
    expect(r.deliverable).toBe(answer);
    expect(r.deliverable).toContain("Need the staging key");
  });

  it("instructed_fence: a contradictory footer is unverified AND retains the claim as evidence", () => {
    const contradictory = { ...completed, required_inputs: needsInput.required_inputs };
    const answer = ["# Plan", fenceEnvelope({ work_report: contradictory })].join("\n");
    const r = unwrapWorkReportEnvelope(answer, FENCE);
    expect(r.deliverable).toBe(answer);
    expect(r.workReport).toBeNull();
    expect(r.contractViolation).toBeNull();
    expect(r.unverified).toEqual({
      reason: "report_contradictory",
      detail: "a completed work_report must not list required_inputs",
    });
    expect(r.reportProblem).toEqual({
      kind: "completed_with_required_inputs",
      reported: contradictory,
    });
    const emptyNeedsInput = unwrapWorkReportEnvelope(
      fenceEnvelope({ work_report: { state: "needs_input", required_inputs: [] } }),
      FENCE,
    );
    expect(emptyNeedsInput.unverified?.reason).toBe("report_contradictory");
    expect(emptyNeedsInput.reportProblem).toBeUndefined();
  });

  it("instructed_fence: a VALID footer keeps the full contract (no unverified marker)", () => {
    const r = unwrapWorkReportEnvelope(
      ["# Done", fenceEnvelope({ work_report: completed })].join("\n"),
      FENCE,
    );
    expect(r.unverified).toBeUndefined();
    expect(r.workReport).toEqual(completed);
    expect(r.deliverable).toBe("# Done");
  });

  it("the native channels stay strict: no unverified marker, a violation instead", () => {
    for (const r of [
      unwrapWorkReportEnvelope("just prose", ACTIVE),
      unwrapWorkReportEnvelope("[]", ACTIVE),
      unwrapWorkReportEnvelope(JSON.stringify({ output: "x" }), ACTIVE),
      unwrapWorkReportEnvelope("# answer", SIDE_TOOL, {}),
      unwrapWorkReportEnvelope("# answer", SIDE_TOOL, { sideToolReport: { state: "bogus" } }),
    ]) {
      expect(r.contractViolation).not.toBeNull();
      expect(r.unverified).toBeUndefined();
    }
  });

  it("instructed_fence: a needs_input envelope carries required_inputs", () => {
    const answer = "```json\n" + JSON.stringify({ work_report: needsInput }) + "\n```";
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

  it("an instructed footer problem ⇒ clean, unverified work_state with the route's source and reason", () => {
    const r = finalizeAttempt({
      ...base,
      workReportSource: "validated",
      workReportUnverified: { reason: "footer_missing", detail: "no fenced work_report block" },
    });
    expect(r.outcomeClass).toBe("clean");
    expect(r.reason).toBeNull();
    expect(r.harnessErrored).toBe(false);
    expect(r.deliverablePresent).toBe(true);
    expect(r.workState).toEqual({
      state: "unverified",
      source: "validated",
      unverified_reason: "footer_missing",
    });
  });

  it("a valid report outranks a stale unverified marker; a native violation still fails", () => {
    const completedRun = finalizeAttempt({
      ...base,
      workReport: completed,
      workReportSource: "validated",
      workReportUnverified: { reason: "footer_missing", detail: "stale" },
    });
    expect(completedRun.workState).toEqual({ state: "completed", source: "validated" });
    const strict = finalizeAttempt({
      ...base,
      workReportSource: "constrained",
      workReportViolation: "final answer is not the JSON work_report envelope",
      workReportUnverified: null,
    });
    expect(strict.outcomeClass).toBe("contract_failure");
    expect(strict.workState).toEqual({ state: "unverified", source: "constrained" });
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

describe("unrecoveredToolErrorFailure (INV-043/INV-044 deliverable exception)", () => {
  const toolError = (tool: string, summary: string): ToolErrorRecord => ({
    tool,
    kind: "command",
    target: null,
    summary,
    toolUseId: null,
    recovered: false,
  });

  it("a delivered deliverable keeps unrecovered tool errors as warning evidence", () => {
    expect(unrecoveredToolErrorFailure([toolError("command", "exit 1")], true)).toBeNull();
  });

  it("a deliverable-less attempt escalates the FIRST unrecovered error", () => {
    expect(
      unrecoveredToolErrorFailure(
        [toolError("command", "exit 1"), toolError("read", "no such file")],
        false,
      ),
    ).toBe("command failed without recovery: exit 1");
  });

  it("optional web errors never become the deliverable-less harness failure", () => {
    expect(
      unrecoveredToolErrorFailure(
        [{ ...toolError("WebSearch", "User Rejected"), kind: "web" }],
        false,
      ),
    ).toBeNull();
  });

  it("skips optional web errors and still escalates the first non-web error", () => {
    expect(
      unrecoveredToolErrorFailure(
        [
          { ...toolError("WebSearch", "User Rejected"), kind: "web" },
          toolError("command", "exit 1"),
        ],
        false,
      ),
    ).toBe("command failed without recovery: exit 1");
  });

  it("no unrecovered errors is never a failure, delivered or not", () => {
    expect(unrecoveredToolErrorFailure([], false)).toBeNull();
    expect(unrecoveredToolErrorFailure([], true)).toBeNull();
  });
});

describe("webEvidenceFailure (one owner for the web axis message)", () => {
  it("a recorded error summary is the reason verbatim", () => {
    expect(webEvidenceFailure({ attempted: true, errorSummary: "429 from search" })).toBe(
      "web evidence unsatisfied: 429 from search",
    );
    // The summary wins even when web was never attempted (nullish fallback only).
    expect(webEvidenceFailure({ attempted: false, errorSummary: "blocked by policy" })).toBe(
      "web evidence unsatisfied: blocked by policy",
    );
  });

  it("an attempted-but-unsummarized failure reads as an unrecovered web tool", () => {
    expect(webEvidenceFailure({ attempted: true, errorSummary: null })).toBe(
      "web evidence unsatisfied: web tool failed without verified recovery",
    );
  });

  it("never-attempted required web reads as never attempted", () => {
    expect(webEvidenceFailure({ attempted: false, errorSummary: null })).toBe(
      "web evidence unsatisfied: web evidence required but never attempted",
    );
  });
});
