import { describe, expect, it } from "vitest";
import type { AttemptTelemetry } from "./attemptTelemetry.js";
import {
  capturedNoGitChange,
  convergenceOutcomeFacts,
  isWorkingCandidate,
  needsPostTurnFence,
  partitionCandidates,
} from "./candidateEvidence.js";
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

  it("an uncaptured candidate never joins the working set beside a clean sibling", () => {
    const clean = candidate({ attemptId: "a2", diff: "diff --git a/y b/y\n+2\n" });
    const { working } = partitionCandidates([
      candidate({
        diff: "",
        errored: true,
        captureRefusal: {
          disposition: "discarded",
          detail: "uncaptured isolated candidate output was discarded with the candidate envelope",
        },
      }),
      clean,
    ]);
    expect(working).toEqual([clean]);
  });

  it("a candidate whose patch holds credential-shaped strings is an ordinary working candidate", () => {
    const flagged = candidate({
      diff: "diff --git a/LEAK.txt b/LEAK.txt\n+exact bytes\n",
    });
    expect(isWorkingCandidate(flagged)).toBe(true);
    expect(partitionCandidates([flagged]).working).toEqual([flagged]);
  });
});

describe("capturedNoGitChange (#502: the post-turn fence's only skip)", () => {
  const result = (base: string, candidate: string) =>
    ({ base_tree: base, candidate_tree: candidate }) as CandidateRun["result"];
  const refusal = { disposition: "discarded", detail: "fixture" } as CandidateRun["captureRefusal"];

  it("is true only for a complete Git capture whose trees agree", () => {
    expect(capturedNoGitChange(candidate({ result: result("t1", "t1") }))).toBe(true);
    expect(capturedNoGitChange(candidate({ result: result("t1", "t2") }))).toBe(false);
  });

  it("an unknown capture is never unchanged: no result, a refusal, a refused continuation, files", () => {
    // The per-slot failure shape: an empty patch text and no capture at all.
    expect(capturedNoGitChange(candidate({ diff: "", errored: true }))).toBe(false);
    expect(
      capturedNoGitChange(candidate({ result: result("t1", "t1"), captureRefusal: refusal })),
    ).toBe(false);
    expect(
      capturedNoGitChange(
        candidate({
          result: result("t1", "t1"),
          continuationRefusal: { attemptId: "a2", refusal: refusal! },
        }),
      ),
    ).toBe(false);
    expect(
      capturedNoGitChange(
        candidate({
          result: result("t1", "t1"),
          files: { noChanges: true } as CandidateRun["files"],
        }),
      ),
    ).toBe(false);
  });
});

describe("needsPostTurnFence (#502)", () => {
  const result = (base: string, candidate: string) =>
    ({ base_tree: base, candidate_tree: candidate }) as CandidateRun["result"];
  const refusal = { disposition: "discarded", detail: "fixture" } as CandidateRun["captureRefusal"];

  it("fences a changed or never-captured turn, and an empty roster as before", () => {
    expect(needsPostTurnFence([candidate({ result: result("t1", "t2") })])).toBe(true);
    expect(needsPostTurnFence([candidate({ diff: "", errored: true })])).toBe(true);
    expect(needsPostTurnFence([])).toBe(true);
  });

  it("takes no fence for a refused capture or a complete unchanged one", () => {
    expect(needsPostTurnFence([candidate({ captureRefusal: refusal })])).toBe(false);
    expect(needsPostTurnFence([candidate({ result: result("t1", "t1") })])).toBe(false);
  });
});

describe("convergenceOutcomeFacts precedence", () => {
  const cancel = () => makeOutcomeFacts("cancelled");
  it("interrupted outranks stuck/cancel/budget and is never converged", () => {
    const facts = convergenceOutcomeFacts(
      {
        converged: false,
        interrupted: "context_capacity_exhausted",
        stuckNoProgress: true,
        aborted: true,
        exhausted: true,
      },
      cancel,
    );
    expect(facts.lifecycle).toBe("interrupted");
    expect(facts.reason).toBe("context_capacity_exhausted");
    const capped = { converged: false, stuckNoProgress: false, aborted: false, exhausted: false };
    expect(
      convergenceOutcomeFacts({ ...capped, interrupted: "turn_limit_reached" }, cancel),
    ).toMatchObject({ lifecycle: "interrupted", reason: "turn_limit_reached" });
  });
  it("keeps the pre-r8 ladder for non-interrupted states", () => {
    const base = { converged: false, interrupted: null, aborted: false, exhausted: false };
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
