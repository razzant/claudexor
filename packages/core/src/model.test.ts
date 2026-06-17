import { describe, expect, it } from "vitest";
import { validateModel } from "./model.js";

describe("validateModel", () => {
  const known = ["sonnet", "opus", "claude-opus-4-8"];

  it("is ok when no model is requested (the harness default is used)", () => {
    expect(validateModel(null, known, false).status).toBe("ok");
    expect(validateModel(undefined, known, false).status).toBe("ok");
    expect(validateModel("", known, false).status).toBe("ok");
  });

  it("is ok for a known alias/id", () => {
    expect(validateModel("opus", known, false).status).toBe("ok");
    expect(validateModel("claude-opus-4-8", known, false).status).toBe("ok");
    expect(validateModel("  opus  ", known, false).status).toBe("ok"); // trimmed
  });

  it("never blocks when the harness declares no list (CLI is the authority)", () => {
    expect(validateModel("anything", [], false).status).toBe("ok");
    expect(validateModel("anything", [], true).status).toBe("ok");
  });

  it("WARNS (unknown) for a non-authoritative miss — e.g. the fable regression", () => {
    const r = validateModel("fable", known, false);
    expect(r.status).toBe("unknown");
    expect(r.message).toContain("fable");
  });

  it("REJECTS an authoritative miss (exhaustive list, e.g. an API model catalog)", () => {
    expect(validateModel("ghost", ["gpt-4o", "gpt-4o-mini"], true).status).toBe("rejected");
  });
});
