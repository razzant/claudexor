import { describe, expect, it } from "vitest";
import { buildReviewPrompt } from "./reviewPrompt.js";

const patch = {
  diffPath: "/evidence/DIFF.patch",
  summaryPath: "/evidence/DIFF_SUMMARY.md",
  diffSha256: "sha256:test",
  summary: "(plan review — no code diff)",
};

describe("typed review subject", () => {
  it("does not ask plan reviewers to find missing implementation/screenshots", () => {
    const prompt = buildReviewPrompt("Plan", "/candidate", "/evidence", patch, false, "plan");
    expect(prompt).toContain("READ-ONLY PLAN");
    expect(prompt).toContain("absence is NOT a finding");
    expect(prompt).toContain("PLAN_ACCEPTED.md");
    expect(prompt).toContain("do not demand a code diff");
  });
});
