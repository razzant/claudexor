import { describe, expect, it } from "vitest";
import { parseAutonomy } from "./orchestrate-options.js";

describe("parseAutonomy", () => {
  it("accepts each typed OrchestrateAutonomy level", () => {
    expect(parseAutonomy("suggest")).toBe("suggest");
    expect(parseAutonomy("auto_safe")).toBe("auto_safe");
    expect(parseAutonomy("auto_full")).toBe("auto_full");
  });

  it("returns undefined when the flag is absent (daemon/orchestrator default to suggest)", () => {
    expect(parseAutonomy(undefined)).toBeUndefined();
  });

  it("fails loudly on an invalid value (never silently falls back to suggest)", () => {
    expect(() => parseAutonomy("full")).toThrow(/invalid --autonomy 'full'/);
    expect(() => parseAutonomy("")).toThrow(/invalid --autonomy/);
    expect(() => parseAutonomy("AUTO_SAFE")).toThrow(/invalid --autonomy/);
  });
});
