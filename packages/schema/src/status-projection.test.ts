import { describe, expect, it } from "vitest";
import {
  makeOutcomeFacts,
  needsDecision,
  outcomeBanner,
  outcomeExitCode,
  processExitCode,
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

  it("needsDecision fires for a work_state veto (a needs-me terminal)", () => {
    const veto = makeOutcomeFacts("succeeded", { work_state: needsInputState });
    expect(needsDecision(veto, false)).toBe(true);
    expect(needsDecision(veto, true)).toBe(false); // an operator decision clears it
  });
});
