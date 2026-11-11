import { describe, expect, it } from "vitest";
import type { ReviewCandidateInput } from "./reviewEngine.js";
import { buildReviewPrompt } from "./reviewPrompt.js";

const patch = {
  diffPath: "/evidence/DIFF.patch",
  summaryPath: "/evidence/DIFF_SUMMARY.md",
  diffSha256: "sha256:test",
  summary: "(code review)",
};

const CODE_GROUNDING = "grounded in the current patch or in artifacts under Candidate root";

type ReviewSubjectWasRemoved = "reviewSubject" extends keyof ReviewCandidateInput ? false : true;
type PlanSubjectArgumentWasRemoved = 6 extends Parameters<typeof buildReviewPrompt>["length"]
  ? false
  : true;
const reviewSubjectWasRemoved: ReviewSubjectWasRemoved = true;
const planSubjectArgumentWasRemoved: PlanSubjectArgumentWasRemoved = true;

describe("retired standalone Plan-review API", () => {
  it("keeps both the candidate input and prompt builder code-only", () => {
    expect(reviewSubjectWasRemoved).toBe(true);
    expect(planSubjectArgumentWasRemoved).toBe(true);
  });
});

describe("finding-discipline rules (pinned clause by clause)", () => {
  for (const [name, built] of [
    ["code", buildReviewPrompt("Cand", "/candidate", "/evidence", patch)],
    ["sealed code", buildReviewPrompt("Cand", "/candidate", "/evidence", patch, true)],
  ] as const) {
    it(`tells the ${name} reviewer the machine decides from typed fields, not prose`, () => {
      // "the ONLY field the consumer reads" would be false: isBlocking also
      // weighs attached evidence, and the same prompt tells the reviewer that
      // BLOCK without evidence is not allowed.
      expect(built).toContain("The machine consumer decides from typed fields, never from prose");
      expect(built).toContain("attached evidence is what lets BLOCK or FIX_FIRST stand");
      expect(built).toContain(
        "A hedge, caveat, or withdrawal written inside claim or proposed_fix",
      );
      // The non-blocking set is named outright, and every blocking severity is
      // listed — an earlier wording said "below BLOCK/FIX_FIRST", which reads
      // NEEDS_HUMAN and INSUFFICIENT_EVIDENCE as safe landing spots.
      expect(built).toContain("non-blocking severity — WARN, NIT, or OUT_OF_SCOPE");
      expect(built).toContain("BLOCK, FIX_FIRST, NEEDS_HUMAN, and INSUFFICIENT_EVIDENCE all block");
    });

    it(`tells the ${name} reviewer not to re-raise one root cause as two findings`, () => {
      expect(built).toContain("One root cause is one finding");
      expect(built).toContain("under different wording");
    });

    it(`grounds the ${name} reviewer's findings in the reviewed code`, () => {
      expect(built).toContain(CODE_GROUNDING);
      expect(built).toContain("Do not manufacture a finding from");
      expect(built).toContain("that contradiction is itself the finding");
    });

    it(`tells the ${name} reviewer to state checkable reasoning for the human reader`, () => {
      expect(built).toContain("The prose is for the human, not for the machine");
      expect(built).toContain(
        "State the reasoning that makes the claim true, not only the conclusion",
      );
      // The two rules divide labor rather than contradict: the machine acts on
      // the typed fields, the human reads the reasoning.
      expect(built).toContain(
        "the consumer never weighs that reasoning, it acts on the typed fields above",
      );
      expect(built).toContain("neither substitutes for the other");
      expect(built).toContain(
        "proposed_fix whose own justification does not survive checking is worse than no finding",
      );
    });
  }
});

describe("candidate inventory disclosure", () => {
  it("tells a non-Git reviewer that unchanged sibling context is unavailable", () => {
    const built = buildReviewPrompt("Cand", "/candidate", "/evidence", patch, {
      candidateInventoryMode: "diff_only",
    });
    expect(built).toContain("disclosed diff-only projection");
    expect(built).toContain("not unchanged sibling context");
    expect(built).toContain("return INSUFFICIENT_EVIDENCE instead of guessing");
  });
});

describe("sealed review subject (#257 retired the delta scope)", () => {
  it("names the complete patch as the only review subject", () => {
    const built = buildReviewPrompt("Cand", "/candidate", "/evidence", patch, { sealed: true });
    expect(built).toContain("Review Cand's change from the file-backed patch artifact");
    expect(built).toContain("Full patch: /evidence/DIFF.patch");
    expect(built).not.toContain("DELTA SCOPE");
  });
});
