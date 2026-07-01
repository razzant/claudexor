import { describe, expect, it } from "vitest";
import {
  parseProtectedPathApprovalFlags,
  parseReviewerEffortFlags,
  parseReviewerModelFlags,
  parseReviewerPanelFlags,
  parseTestCommandFlags,
} from "./run-options.js";

describe("run option parsing", () => {
  it("aggregates repeated protected-path approval flags", () => {
    expect(
      parseProtectedPathApprovalFlags(["packages/**/*.test.ts", "apps/macos/**,docs/**"]),
    ).toEqual([
      { path: "packages/**/*.test.ts", reason: "explicit CLI --allow-protected-path" },
      { path: "apps/macos/**", reason: "explicit CLI --allow-protected-path" },
      { path: "docs/**", reason: "explicit CLI --allow-protected-path" },
    ]);
  });

  it("fails loudly when protected-path approval is provided without a value", () => {
    expect(() => parseProtectedPathApprovalFlags([true])).toThrow(
      /invalid --allow-protected-path value/,
    );
  });

  it("fails loudly on empty comma-separated protected-path approval entries", () => {
    expect(() => parseProtectedPathApprovalFlags(["packages/**,"])).toThrow(
      /empty comma-separated entry/,
    );
    expect(() => parseProtectedPathApprovalFlags(["packages/**,,docs/**"])).toThrow(
      /empty comma-separated entry/,
    );
  });

  it("parses repeated and ;;-separated deterministic test commands", () => {
    expect(parseTestCommandFlags(["pnpm build;; pnpm test", "pnpm docs:check"])).toEqual([
      "pnpm build",
      "pnpm test",
      "pnpm docs:check",
    ]);
  });

  it("fails loudly on empty ;;-separated deterministic test command entries", () => {
    expect(() => parseTestCommandFlags([";;pnpm test"])).toThrow(/empty ;;-separated entry/);
    expect(() => parseTestCommandFlags(["pnpm test;;"])).toThrow(/empty ;;-separated entry/);
    expect(() => parseTestCommandFlags(["pnpm test;;;;pnpm build"])).toThrow(
      /empty ;;-separated entry/,
    );
  });

  it("aggregates repeated reviewer-panel flags in order", () => {
    expect(
      parseReviewerPanelFlags([
        "claude=claude-opus-4-8:max",
        "cursor=gemini-3.1-pro,cursor=gpt-5.5-extra-high",
      ]),
    ).toEqual([
      { harness: "claude", model: "claude-opus-4-8", effort: "max" },
      { harness: "cursor", model: "gemini-3.1-pro" },
      { harness: "cursor", model: "gpt-5.5-extra-high" },
    ]);
  });

  it("fails loudly when reviewer-panel is provided without a value", () => {
    expect(() => parseReviewerPanelFlags([true])).toThrow(/invalid --reviewer-panel value/);
  });

  it("aggregates repeated reviewer model and effort flags", () => {
    expect(parseReviewerModelFlags(["openai=gpt-4o", "anthropic=claude-haiku"])).toEqual({
      openai: "gpt-4o",
      anthropic: "claude-haiku",
    });
    expect(parseReviewerEffortFlags(["openai=xhigh", "anthropic=max"])).toEqual({
      openai: "xhigh",
      anthropic: "max",
    });
  });

  it("fails loudly when reviewer model or effort is provided without a value", () => {
    expect(() => parseReviewerModelFlags([true])).toThrow(/invalid --reviewer-model value/);
    expect(() => parseReviewerEffortFlags([true])).toThrow(/invalid --reviewer-effort value/);
  });
});
