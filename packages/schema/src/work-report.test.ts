import { describe, expect, it } from "vitest";
import AjvModule from "ajv";
import {
  WorkReport,
  WORK_REPORT_TRANSPORT_SCHEMA,
  buildWorkReportEnvelope,
} from "./index.js";

const Ajv = AjvModule.default ?? (AjvModule as unknown as typeof AjvModule.default);

describe("WorkReport wire type (D-16)", () => {
  it("accepts a completed report with no required_inputs", () => {
    expect(WorkReport.parse({ state: "completed", required_inputs: [] })).toEqual({
      state: "completed",
      required_inputs: [],
    });
  });

  it("does NOT enforce cross-field rules on the wire (the finalizer does)", () => {
    // A completed report WITH required_inputs is permissive on the wire so a
    // broken report is a typed contract failure, not a parse throw that loses
    // the whole answer.
    expect(() =>
      WorkReport.parse({
        state: "completed",
        required_inputs: [{ kind: "file", locator: null, description: "x" }],
      }),
    ).not.toThrow();
  });

  it("caps required_inputs at 16", () => {
    const many = Array.from({ length: 17 }, () => ({
      kind: "context" as const,
      locator: null,
      description: "x",
    }));
    expect(() => WorkReport.parse({ state: "needs_input", required_inputs: many })).toThrow();
  });
});

describe("WORK_REPORT_TRANSPORT_SCHEMA", () => {
  const ajv = new Ajv({ allErrors: true, strict: false });

  it("compiles as a strict draft-07 schema", () => {
    expect(() => ajv.compile(WORK_REPORT_TRANSPORT_SCHEMA)).not.toThrow();
  });

  it("validates a real completed WorkReport and rejects an unknown key", () => {
    const validate = ajv.compile(WORK_REPORT_TRANSPORT_SCHEMA);
    expect(validate({ state: "completed", required_inputs: [] })).toBe(true);
    expect(validate({ state: "completed", required_inputs: [], extra: 1 })).toBe(false);
    expect(validate({ state: "bogus", required_inputs: [] })).toBe(false);
  });

  it("mirrors the Zod key surface (drift guard)", () => {
    const props = WORK_REPORT_TRANSPORT_SCHEMA["properties"] as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(["required_inputs", "state"]);
    expect(WORK_REPORT_TRANSPORT_SCHEMA["required"]).toEqual(["state", "required_inputs"]);
    expect(WORK_REPORT_TRANSPORT_SCHEMA["additionalProperties"]).toBe(false);
  });
});

describe("buildWorkReportEnvelope", () => {
  it("null output ⇒ work_report only (claude side_tool)", () => {
    const env = buildWorkReportEnvelope(null);
    expect(env["required"]).toEqual(["work_report"]);
    expect(env["properties"]).not.toHaveProperty("output");
  });

  it("'string' output ⇒ {work_report, output:string} (final_message no-caller)", () => {
    const env = buildWorkReportEnvelope("string");
    expect(env["required"]).toEqual(["work_report", "output"]);
    expect((env["properties"] as Record<string, unknown>)["output"]).toEqual({ type: "string" });
  });

  it("a caller schema ⇒ {work_report, output:<schema>}", () => {
    const s = { type: "object", properties: { x: { type: "string" } }, additionalProperties: false };
    const env = buildWorkReportEnvelope(s);
    expect((env["properties"] as Record<string, unknown>)["output"]).toBe(s);
    expect(env["additionalProperties"]).toBe(false);
  });
});
