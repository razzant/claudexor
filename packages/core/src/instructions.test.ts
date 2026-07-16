import { describe, expect, it } from "vitest";
import { promptWithInstructions } from "./instructions.js";

describe("promptWithInstructions (cursor/opencode/raw-api delivery)", () => {
  it("returns the bare prompt when there are no instructions", () => {
    expect(promptWithInstructions({ prompt: "do the thing" })).toBe("do the thing");
    expect(promptWithInstructions({ prompt: "do the thing", instructions: "   " })).toBe(
      "do the thing",
    );
  });

  it("prefixes a delimited system block above the prompt", () => {
    const out = promptWithInstructions({ prompt: "do the thing", instructions: "be terse" });
    expect(out).toContain("[SYSTEM INSTRUCTIONS]");
    expect(out).toContain("[END SYSTEM INSTRUCTIONS]");
    expect(out).toContain("be terse");
    // The user's request stays last so the model reads instructions as framing.
    expect(out.endsWith("do the thing")).toBe(true);
    // The instruction block is above the prompt.
    expect(out.indexOf("be terse")).toBeLessThan(out.indexOf("do the thing"));
  });
});
