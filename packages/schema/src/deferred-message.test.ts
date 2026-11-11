import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "./primitives.js";
import { RunFacts } from "./run-facts.js";
import { makeOutcomeFacts, requiredActionsFor } from "./status-projection.js";
import { DeferredMessageMutation, deferredMessageHold } from "./deferred-message.js";

function receipt(mode: "agent" | "ask" = "agent"): RunFacts {
  return RunFacts.parse({
    schema_version: SCHEMA_VERSION,
    run_id: "run-test",
    task_id: "task-test",
    mode,
    outcome: {
      ...makeOutcomeFacts("succeeded"),
      review_requested: false,
      work_state: { state: "completed", source: "constrained", required_inputs: [] },
    },
    deliverable: {
      present: true,
      kind: mode === "ask" ? "answer" : "patch",
      path: mode === "ask" ? "final/answer.md" : "final/patch.diff",
      producer_attempt_id: "a01",
    },
    presentation: {
      state: "ready",
      primary: {
        kind: mode === "ask" ? "answer" : "patch",
        path: mode === "ask" ? "final/answer.md" : "final/patch.diff",
      },
    },
    participants: {
      planners: 0,
      attempts: [
        {
          attempt_id: "a01",
          harness_id: "codex",
          role: "candidate",
          deliverable_present: true,
          status: "success",
        },
      ],
    },
    gates: { configured: false, required: 0, total: 0, executed: false, state: "not_configured" },
    review: { state: "not_run", blocker_ids: [], blockers: 0 },
    apply: { eligibility: null, operator_decision_present: false },
    required_actions: [],
    generated_at: "2026-10-26T12:00:00.000Z",
  });
}

function hold(facts: RunFacts, lifecycle = facts.outcome.lifecycle) {
  facts.required_actions = requiredActionsFor(facts.outcome, facts.apply.operator_decision_present);
  return deferredMessageHold(lifecycle, facts, { runId: "run-test", taskId: "task-test" });
}

describe("deferred one-shot typed success", () => {
  it.each(["agent", "ask"] as const)("admits ordinary %s opt-out with no checks", (mode) => {
    expect(hold(receipt(mode))).toBeNull();
  });
  it("permits an honestly unverified verification follow-up without upgrading its facts", () => {
    const facts = receipt();
    facts.outcome.work_state = {
      state: "unverified",
      source: "validated",
      required_inputs: [],
      unverified_reason: "footer_missing",
    };
    expect(hold(facts)).toBeNull();
    expect(facts.outcome.work_state.state).toBe("unverified");
  });
  it.each(["failed", "cancelled", "interrupted"] as const)(
    "holds %s even with useful output",
    (state) => {
      const facts = receipt();
      facts.outcome.lifecycle = state;
      expect(hold(facts)?.code).toBe(`predecessor_${state}`);
    },
  );
  it.each(["needs_input", "incomplete"] as const)("holds succeeded plus %s", (state) => {
    const facts = receipt();
    facts.outcome.work_state = {
      state,
      source: "constrained",
      required_inputs: [
        { kind: "decision", locator: null, description: "Choose the required target" },
      ],
    };
    facts.outcome.reason = state === "needs_input" ? "input_required" : "work_incomplete";
    expect(hold(facts)?.code).toBe(`predecessor_${state}`);
  });
  it("holds failed configured checks", () => {
    const facts = receipt();
    facts.outcome.checks = "failed";
    facts.gates = {
      configured: true,
      required: 1,
      total: 1,
      executed: true,
      state: "failed",
      receipt_attempt_id: "a01",
    };
    expect(hold(facts)?.code).toBe("predecessor_checks_failed");
  });
  it("holds blocked or unsatisfied required review", () => {
    const facts = receipt();
    facts.outcome.review_requested = true;
    expect(hold(facts)?.code).toBe("predecessor_review_blocked");
    facts.outcome.review = "blocked";
    facts.review = { state: "blocked", blockers: 1, blocker_ids: ["b1"] };
    expect(hold(facts)?.code).toBe("predecessor_review_blocked");
  });
  it("holds missing, contradictory, foreign and lifecycle-mismatched facts", () => {
    expect(deferredMessageHold("succeeded", null)?.code).toBe("predecessor_facts_unavailable");
    expect(hold({ ...receipt(), run_id: "foreign" })?.code).toBe("predecessor_facts_unavailable");
    expect(hold(receipt(), "failed")?.code).toBe("predecessor_failed");
    const facts = receipt();
    facts.gates.configured = true;
    expect(hold(facts)?.code).toBe("predecessor_facts_unavailable");
  });
  it("requires canonical useful ready output", () => {
    const facts = receipt();
    facts.deliverable = { present: false, kind: null, path: null, producer_attempt_id: null };
    facts.presentation = { state: "diagnostic", primary: null };
    expect(hold(facts)?.code).toBe("predecessor_output_unavailable");
  });
  it("replacement and clear carry no executable controls or alternate target", () => {
    const edit = {
      action: "replace",
      draftId: "draft-1",
      expectedRevision: 1,
      prompt: "Verify the result",
      attachments: [],
    };
    expect(DeferredMessageMutation.safeParse(edit).success).toBe(true);
    for (const extra of [
      { access: "full_access" },
      { predecessorId: "other" },
      { controls: { credentialProfileId: "other" } },
      { force: true },
    ]) {
      expect(DeferredMessageMutation.safeParse({ ...edit, ...extra }).success).toBe(false);
    }
    expect(
      DeferredMessageMutation.safeParse({
        action: "clear",
        predecessorId: "run-test",
        expectedRevision: 1,
      }).success,
    ).toBe(false);
  });
});
