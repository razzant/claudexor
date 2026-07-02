import { describe, expect, it } from "vitest";
import { validateModel } from "./model.js";

describe("validateModel (strict D3)", () => {
  const known = ["sonnet", "opus", "claude-opus-4-8"];

  it("is ok when no model is requested (the harness default is used)", () => {
    expect(validateModel(null, known).status).toBe("ok");
    expect(validateModel(undefined, known).status).toBe("ok");
    expect(validateModel("", known).status).toBe("ok");
  });

  it("is ok for a known alias/id", () => {
    expect(validateModel("opus", known).status).toBe("ok");
    expect(validateModel("claude-opus-4-8", known).status).toBe("ok");
    expect(validateModel("  opus  ", known).status).toBe("ok"); // trimmed
  });

  it("REJECTS an explicit model when the harness has no truth list (never forwarded to die natively)", () => {
    const manifest = validateModel("anything", [], "manifest");
    expect(manifest.status).toBe("rejected");
    expect(manifest.message).toContain("cannot verify models");
    expect(manifest.message).toContain("manifest known_models");
    const api = validateModel("anything", [], "api");
    expect(api.status).toBe("rejected");
    expect(api.message).toContain("live model inventory");
  });

  it("REJECTS a miss naming the truth source and the list (the fable regression, now typed)", () => {
    const r = validateModel("fable-x", known, "manifest");
    expect(r.status).toBe("rejected");
    expect(r.message).toContain('model "fable-x"');
    expect(r.message).toContain("manifest known-model list");
    expect(r.message).toContain("sonnet");
  });

  it("REJECTS an api-inventory miss", () => {
    const r = validateModel("ghost", ["gpt-4o", "gpt-4o-mini"], "api");
    expect(r.status).toBe("rejected");
    expect(r.message).toContain("live model inventory");
  });

  it("truncates giant truth lists in the refusal message", () => {
    const big = Array.from({ length: 120 }, (_, i) => `m-${i}`);
    const r = validateModel("nope", big, "api");
    expect(r.status).toBe("rejected");
    expect(r.message).toContain("(120 total)");
  });
});
