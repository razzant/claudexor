import { describe, expect, it } from "vitest";
import { parseReviewerEffortMap } from "./reviewer-options.js";

describe("reviewer option parsing", () => {
  it("parses per-provider reviewer effort overrides", () => {
    expect(parseReviewerEffortMap("openai=xhigh,anthropic=high")).toEqual({
      openai: "xhigh",
      anthropic: "high",
    });
  });

  it("rejects unknown reviewer effort provider keys", () => {
    expect(() => parseReviewerEffortMap("banana=max")).toThrow(/invalid reviewer provider 'banana'/);
  });
});
