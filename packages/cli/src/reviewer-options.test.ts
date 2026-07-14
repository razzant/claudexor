import { describe, expect, it } from "vitest";
import {
  parseReviewerEffortMap,
  parseReviewerModelMap,
  parseReviewerPanel,
} from "./reviewer-options.js";

describe("reviewer option parsing", () => {
  it("parses per-provider reviewer effort overrides", () => {
    expect(parseReviewerEffortMap("openai=xhigh,anthropic=high")).toEqual({
      openai: "xhigh",
      anthropic: "high",
    });
  });

  it("rejects unknown reviewer effort provider keys", () => {
    expect(() => parseReviewerEffortMap("banana=max")).toThrow(
      /invalid reviewer provider 'banana'/,
    );
  });

  it("fails loudly on malformed reviewer-effort pairs", () => {
    expect(() => parseReviewerEffortMap("openai=")).toThrow(/invalid --reviewer-effort entry/);
    expect(() => parseReviewerEffortMap("gpt-5.5")).toThrow(/invalid --reviewer-effort entry/);
    expect(() => parseReviewerEffortMap("openai=max=ignored")).toThrow(
      /invalid --reviewer-effort entry/,
    );
  });

  it("fails loudly on empty reviewer-effort comma entries", () => {
    expect(() => parseReviewerEffortMap(",openai=max")).toThrow(/empty comma-separated entry/);
    expect(() => parseReviewerEffortMap("openai=max,,anthropic=high")).toThrow(
      /empty comma-separated entry/,
    );
    expect(() => parseReviewerEffortMap("openai=max,")).toThrow(/empty comma-separated entry/);
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
    expect(() => parseReviewerModelMap("banana=some-model")).toThrow(
      /invalid reviewer provider 'banana'/,
    );
  });

  it("fails loudly on empty reviewer-model comma entries", () => {
    expect(() => parseReviewerModelMap(",openai=gpt-5.5")).toThrow(/empty comma-separated entry/);
    expect(() => parseReviewerModelMap("openai=gpt-5.5,,anthropic=claude")).toThrow(
      /empty comma-separated entry/,
    );
    expect(() => parseReviewerModelMap("openai=gpt-5.5,")).toThrow(/empty comma-separated entry/);
  });

  it("returns undefined for an unset flag", () => {
    expect(parseReviewerModelMap(undefined)).toBeUndefined();
  });

  it("preserves a model id that itself contains '='", () => {
    expect(parseReviewerModelMap("openai=org/model=v2")).toEqual({ openai: "org/model=v2" });
  });

  it("parses an explicit ordered reviewer panel without provider-family dedupe", () => {
    expect(
      parseReviewerPanel(
        "claude=claude-opus-4-8:max,cursor=gemini-3.1-pro,cursor=gemini-3.5-flash,cursor=gpt-5.5-extra-high",
      ),
    ).toEqual([
      { harness: "claude", model: "claude-opus-4-8", effort: "max" },
      { harness: "cursor", model: "gemini-3.1-pro" },
      { harness: "cursor", model: "gemini-3.5-flash" },
      { harness: "cursor", model: "gpt-5.5-extra-high" },
    ]);
  });

  it("allows harness-only reviewer panel entries for default reviewer models", () => {
    expect(parseReviewerPanel("claude,cursor=gpt-5.5")).toEqual([
      { harness: "claude" },
      { harness: "cursor", model: "gpt-5.5" },
    ]);
  });

  it("allows reviewer effort without an explicit model using harness-only spelling", () => {
    expect(parseReviewerPanel("claude:max,cursor:xhigh,cursor=gemini-3.1-pro")).toEqual([
      { harness: "claude", effort: "max" },
      { harness: "cursor", effort: "xhigh" },
      { harness: "cursor", model: "gemini-3.1-pro" },
    ]);
  });

  it("keeps colons inside model ids unless the suffix is a valid effort", () => {
    expect(parseReviewerPanel("cursor=org:model:v2,claude=vendor:opus:max")).toEqual([
      { harness: "cursor", model: "org:model:v2" },
      { harness: "claude", model: "vendor:opus", effort: "max" },
    ]);
  });

  it("fails loudly on malformed explicit reviewer panel entries", () => {
    expect(() => parseReviewerPanel(" , ")).toThrow(/empty entries are not allowed/);
    expect(() => parseReviewerPanel("claude,,cursor=gpt-5.5")).toThrow(
      /empty entries are not allowed/,
    );
    expect(() => parseReviewerPanel("claude,cursor=gpt-5.5,")).toThrow(
      /empty entries are not allowed/,
    );
    expect(() => parseReviewerPanel("=gpt-5.5")).toThrow(/invalid --reviewer-panel entry/);
    expect(() => parseReviewerPanel("cursor=")).toThrow(/missing model after '='/);
    expect(() => parseReviewerPanel("cursor=:max")).toThrow(/missing model after '='/);
    expect(() => parseReviewerPanel("claude:turbo")).toThrow(/expected harness\[:effort\]/);
  });
});
