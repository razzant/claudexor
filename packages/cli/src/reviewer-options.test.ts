import { describe, expect, it } from "vitest";
import { parseReviewerEffortMap, parseReviewerModelMap } from "./reviewer-options.js";

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

  it("parses per-provider reviewer model overrides", () => {
    expect(parseReviewerModelMap("openai=gpt-4o-mini,anthropic=claude-haiku")).toEqual({
      openai: "gpt-4o-mini",
      anthropic: "claude-haiku",
    });
  });

  it("fails loudly on a malformed reviewer-model pair instead of silently dropping it", () => {
    expect(() => parseReviewerModelMap("openai=")).toThrow(/invalid --reviewer-model entry/);
    expect(() => parseReviewerModelMap("gpt-4o-mini")).toThrow(/invalid --reviewer-model entry/);
    expect(() => parseReviewerModelMap("banana=some-model")).toThrow(/invalid reviewer provider 'banana'/);
  });

  it("returns undefined for an unset flag", () => {
    expect(parseReviewerModelMap(undefined)).toBeUndefined();
  });

  it("preserves a model id that itself contains '='", () => {
    expect(parseReviewerModelMap("openai=org/model=v2")).toEqual({ openai: "org/model=v2" });
  });
});
