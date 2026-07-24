import { describe, expect, it } from "vitest";
import type { AttemptTelemetry } from "./attemptTelemetry.js";
import { convergenceOutcomeFacts, partitionCandidates } from "./candidateEvidence.js";
import type { CandidateRun } from "./candidateEvidence.js";
import { makeOutcomeFacts } from "@claudexor/schema";

function candidate(over: Partial<CandidateRun>): CandidateRun {
  return {
    attemptId: "a1",
    harnessId: "fake",
    diff: "",
    answerText: undefined,
    errored: false,
    errors: [],
    gates: [],
    telemetry: {} as AttemptTelemetry,
    ...over,
  } as CandidateRun;
}

describe("partitionCandidates (D-16 veto owner)", () => {
  it("noChanges is DIFF-AWARE: an interrupted candidate with a real partial diff is NOT no_changes", () => {
    const { working, facts } = partitionCandidates([
      candidate({ outcomeClass: "interrupted", diff: "diff --git a/x b/x\n+1\n" }),
    ]);
    expect(working).toEqual([]);
    expect(facts.lifecycle).toBe("interrupted");
    expect(facts.reason).toBe("context_capacity_exhausted");
    expect(facts.noChanges).toBe(false);
  });

  it("no_changes only when EVERY candidate produced neither diff nor answer", () => {
    const { facts } = partitionCandidates([
      candidate({ outcomeClass: "interrupted", diff: "  \n" }),
    ]);
    expect(facts.noChanges).toBe(true);
  });

  it("an interrupted candidate never joins the working (reviewable) set even beside a clean sibling", () => {
    const clean = candidate({ attemptId: "a2", diff: "diff --git a/y b/y\n+2\n" });
    const { working } = partitionCandidates([
      candidate({ outcomeClass: "interrupted", diff: "diff --git a/x b/x\n+1\n" }),
      clean,
    ]);
    expect(working).toEqual([clean]);
  });
});

describe("convergenceOutcomeFacts precedence", () => {
  const cancel = () => makeOutcomeFacts("cancelled");
  it("interrupted outranks stuck/cancel/budget and is never converged", () => {
    const facts = convergenceOutcomeFacts(
      {
        converged: false,
        interrupted: true,
        stuckNoProgress: true,
        aborted: true,
        exhausted: true,
      },
      cancel,
    );
    expect(facts.lifecycle).toBe("interrupted");
    expect(facts.reason).toBe("context_capacity_exhausted");
  });
  it("keeps the pre-r8 ladder for non-interrupted states", () => {
    const base = { converged: false, interrupted: false, aborted: false, exhausted: false };
    expect(convergenceOutcomeFacts({ ...base, stuckNoProgress: true }, cancel).reason).toBe(
      "stuck_no_progress",
    );
    expect(
      convergenceOutcomeFacts({ ...base, stuckNoProgress: false, aborted: true }, cancel).lifecycle,
    ).toBe("cancelled");
    expect(
      convergenceOutcomeFacts({ ...base, stuckNoProgress: false, exhausted: true }, cancel).reason,
    ).toBe("budget_exhausted");
    expect(convergenceOutcomeFacts({ ...base, stuckNoProgress: false }, cancel).reason).toBe(
      "not_converged",
    );
    expect(
      convergenceOutcomeFacts({ ...base, converged: true, stuckNoProgress: false }, cancel)
        .lifecycle,
    ).toBe("succeeded");
  });
});
