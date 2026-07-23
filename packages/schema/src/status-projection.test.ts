import { describe, expect, it } from "vitest";
import {
  makeOutcomeFacts,
  needsDecision,
  needsOperatorAttention,
  needsOperatorInput,
  outcomeBanner,
  outcomeExitCode,
  processExitCode,
  requiredActionsFor,
  runOutcomeLabel,
  workStateVetoes,
} from "./status-projection.js";
import type { RunOutcomeFacts } from "./decision.js";
import type { WorkState } from "./work-report.js";

const needsInputState: WorkState = {
  state: "needs_input",
  source: "constrained",
  required_inputs: [{ kind: "file", locator: "config.yaml", description: "the config" }],
};
const incompleteState: WorkState = { state: "incomplete", source: "constrained" };

const patch = { applyState: "not_applied" as const, hasApplyableChange: true };
const answer = { applyState: "not_applied" as const, hasApplyableChange: false };

describe("outcomeBanner (D18 server-owned headline)", () => {
  it("is null while the run is not terminal", () => {
    expect(outcomeBanner(null, patch)).toBeNull();
  });

  it("a clean succeeded patch that is not applied discloses NOT APPLIED", () => {
    const facts = makeOutcomeFacts("succeeded", { checks: "passed", review: "approved" });
    expect(outcomeBanner(facts, patch)).toBe("Candidate ready — NOT APPLIED");
  });

  it("a verified patch applied in place reads Applied", () => {
    const facts = makeOutcomeFacts("succeeded", { checks: "passed", review: "approved" });
    expect(outcomeBanner(facts, { applyState: "applied", hasApplyableChange: true })).toBe(
      "Applied",
    );
  });

  it("an applied-but-review-blocked patch is disclosed honestly", () => {
    const facts = makeOutcomeFacts("succeeded", { review: "blocked" });
    expect(
      outcomeBanner(facts, { applyState: "applied_review_blocked", hasApplyableChange: true }),
    ).toBe("Applied · review blocked");
  });

  it("a reverted patch reads Reverted", () => {
    const facts = makeOutcomeFacts("succeeded", { checks: "passed", review: "approved" });
    expect(outcomeBanner(facts, { applyState: "reverted", hasApplyableChange: true })).toBe(
      "Reverted — changes rolled back",
    );
  });

  it("a blocked-review patch not yet applied needs review AND is not applied", () => {
    const facts = makeOutcomeFacts("succeeded", { checks: "passed", review: "blocked" });
    expect(outcomeBanner(facts, patch)).toBe("Needs review — NOT APPLIED");
  });

  it("failed checks on an unapplied patch surface as needs review, not applied", () => {
    const facts = makeOutcomeFacts("succeeded", { checks: "failed", review: "approved" });
    expect(outcomeBanner(facts, patch)).toBe("Needs review — NOT APPLIED");
  });

  it("an unverified patch (no checks configured, review not run) discloses not verified", () => {
    const facts = makeOutcomeFacts("succeeded", { checks: "not_configured", review: "not_run" });
    expect(outcomeBanner(facts, patch)).toBe("Candidate ready · not verified — NOT APPLIED");
  });

  it("answer/plan/report runs carry NO apply suffix — nothing to apply", () => {
    const clean = makeOutcomeFacts("succeeded", { checks: "passed", review: "approved" });
    expect(outcomeBanner(clean, answer)).toBe("Done");
    const unverified = makeOutcomeFacts("succeeded", {
      checks: "not_configured",
      review: "not_run",
    });
    expect(outcomeBanner(unverified, answer)).toBe("Done · not verified");
    const blocked = makeOutcomeFacts("succeeded", { review: "blocked" });
    expect(outcomeBanner(blocked, answer)).toBe("Needs review");
  });

  it("non-succeeded lifecycles fall through to the terminal outcome label", () => {
    const failed: RunOutcomeFacts = makeOutcomeFacts("failed", { reason: "harness_failed" });
    expect(outcomeBanner(failed, patch)).toBe(runOutcomeLabel(failed));
    expect(outcomeBanner(failed, patch)).toBe("Failed (harness failed)");
    const cancelled = makeOutcomeFacts("cancelled");
    expect(outcomeBanner(cancelled, patch)).toBe("Cancelled");
  });
});

describe("D-16 work_state veto projections (INV-116)", () => {
  it("labels a needs_input succeeded run above review/checks, with locators", () => {
    const facts = makeOutcomeFacts("succeeded", { work_state: needsInputState });
    expect(runOutcomeLabel(facts)).toBe("Needs input: config.yaml");
    expect(outcomeBanner(facts, answer)).toBe("Needs input: config.yaml");
    expect(outcomeBanner(facts, patch)).toBe("Needs input: config.yaml — NOT APPLIED");
  });

  it("labels an incomplete succeeded run as Incomplete", () => {
    const facts = makeOutcomeFacts("succeeded", { work_state: incompleteState });
    expect(runOutcomeLabel(facts)).toBe("Incomplete");
    expect(outcomeBanner(facts, answer)).toBe("Incomplete");
  });

  it("a completed/unverified work_state never vetoes the banner", () => {
    const done = makeOutcomeFacts("succeeded", {
      checks: "passed",
      review: "approved",
      work_state: { state: "completed", source: "constrained" },
    });
    expect(runOutcomeLabel(done)).toBe("Done");
    expect(workStateVetoes(done)).toBe(false);
  });

  it("outcomeExitCode: a needs_input succeeded run exits non-zero WITHOUT flipping lifecycle", () => {
    const veto = makeOutcomeFacts("succeeded", { work_state: needsInputState });
    expect(veto.lifecycle).toBe("succeeded");
    expect(processExitCode(veto.lifecycle)).toBe(0); // the bare-lifecycle contract is unchanged
    expect(outcomeExitCode(veto)).toBe(1); // the outcome-aware projection vetoes
  });

  it("outcomeExitCode: a clean succeeded run still exits 0", () => {
    expect(outcomeExitCode(makeOutcomeFacts("succeeded"))).toBe(0);
    expect(outcomeExitCode(makeOutcomeFacts("failed", { reason: "harness_failed" }))).toBe(1);
    expect(outcomeExitCode(null)).toBe(1);
  });

  it("needsDecision (the risk-override predicate) does NOT fire for a work_state veto", () => {
    // D-16 wave-1 fix: a work_state veto is non-overridable, so it must stay OUT
    // of the risk-override needsDecision predicate — else the decision endpoint
    // ACKs a false "Apply is available" that the gate then refuses.
    const veto = makeOutcomeFacts("succeeded", { work_state: needsInputState });
    expect(needsDecision(veto, false)).toBe(false);
    // Review/checks vetoes DO remain risk-override needs-decision conditions.
    const reviewBlocked = makeOutcomeFacts("succeeded", { review: "blocked" });
    expect(needsDecision(reviewBlocked, false)).toBe(true);
    expect(needsDecision(reviewBlocked, true)).toBe(false); // an operator decision clears it
  });

  it("needsOperatorInput / needsOperatorAttention fire for a work_state veto (a needs-me terminal)", () => {
    const veto = makeOutcomeFacts("succeeded", { work_state: needsInputState });
    expect(needsOperatorInput(veto)).toBe(true);
    // The inbox/attention signal folds it in (regardless of any operator decision,
    // which cannot resolve a needs-input veto).
    expect(needsOperatorAttention(veto, false)).toBe(true);
    expect(needsOperatorAttention(veto, true)).toBe(true);
    const incompleteVeto = makeOutcomeFacts("succeeded", { work_state: incompleteState });
    expect(needsOperatorInput(incompleteVeto)).toBe(true);
    // A clean succeeded run needs neither.
    const clean = makeOutcomeFacts("succeeded");
    expect(needsOperatorInput(clean)).toBe(false);
    expect(needsOperatorAttention(clean, false)).toBe(false);
  });
});

// GH #29: a succeeded-but-BLOCKED run must carry minimal typed required-actions
// with STABLE machine ids for (i) review-blocked, (ii) needs-decision,
// (iii) failed-gate, and (iv) work_state needs_input — so automation can act
// without re-deriving the block class. Clean/decided/failed runs carry none.
describe("requiredActionsFor (GH #29 minimal typed required actions)", () => {
  const ids = (facts: RunOutcomeFacts, decided = false): string[] =>
    requiredActionsFor(facts, decided).map((a) => a.id);

  it("(i)+(ii) review blocked, no decision → resolve_review_block + record_operator_decision", () => {
    const facts = makeOutcomeFacts("succeeded", { checks: "passed", review: "blocked" });
    expect(ids(facts)).toEqual(["resolve_review_block", "record_operator_decision"]);
  });

  it("(iii) a failed gate yields fix_failed_checks + the operator-decision affordance", () => {
    const facts = makeOutcomeFacts("succeeded", { checks: "failed", review: "approved" });
    expect(ids(facts)).toEqual(["fix_failed_checks", "record_operator_decision"]);
  });

  it("a recorded valid operator decision clears the risk-overridable actions", () => {
    const facts = makeOutcomeFacts("succeeded", { checks: "passed", review: "blocked" });
    expect(ids(facts, true)).toEqual([]);
  });

  it("(iv) a work_state needs_input veto is NON-overridable: provide_required_input only", () => {
    const facts = makeOutcomeFacts("succeeded", {
      checks: "passed",
      review: "blocked",
      work_state: needsInputState,
    });
    // The needs-input veto wins over review; no operator-decision affordance.
    expect(ids(facts)).toEqual(["provide_required_input"]);
    expect(requiredActionsFor(facts, false)[0]?.detail).toContain("config.yaml");
  });

  it("an incomplete work_state yields complete_incomplete_work", () => {
    const facts = makeOutcomeFacts("succeeded", { work_state: incompleteState });
    expect(ids(facts)).toEqual(["complete_incomplete_work"]);
  });

  it("a clean succeeded run and a failed run both carry no required actions", () => {
    expect(
      requiredActionsFor(
        makeOutcomeFacts("succeeded", { checks: "passed", review: "approved" }),
        false,
      ),
    ).toEqual([]);
    expect(
      requiredActionsFor(makeOutcomeFacts("failed", { reason: "harness_failed" }), false),
    ).toEqual([]);
    expect(requiredActionsFor(null, false)).toEqual([]);
  });
});
