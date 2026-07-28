import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "./primitives.js";
import {
  RunFacts,
  RunFactsInvalidError,
  RunFactsInvariantError,
  validateRunFactsInvariants,
  validateRunFactsReceipt,
} from "./run-facts.js";
import { makeOutcomeFacts, requiredActionsFor } from "./status-projection.js";

const timestamp = "2026-07-26T12:00:00.000Z";

function validPlan(): RunFacts {
  return RunFacts.parse({
    schema_version: SCHEMA_VERSION,
    run_id: "run-test",
    task_id: "task-test",
    mode: "plan",
    outcome: makeOutcomeFacts("succeeded"),
    deliverable: {
      present: true,
      kind: "plan",
      path: "final/plan.md",
      producer_attempt_id: "p01",
    },
    participants: {
      planners: 1,
      attempts: [
        {
          attempt_id: "p01",
          harness_id: "codex",
          role: "planner",
          deliverable_present: true,
          status: "success",
        },
      ],
    },
    gates: {
      configured: false,
      required: 0,
      total: 0,
      executed: false,
      state: "not_configured",
      receipt_attempt_id: null,
    },
    review: { state: "not_run", blocker_ids: [], blockers: 0 },
    apply: { eligibility: null, operator_decision_present: false },
    required_actions: [],
    generated_at: timestamp,
  });
}

function validAgentPatch(): RunFacts {
  const base = validPlan();
  return RunFacts.parse({
    ...base,
    mode: "agent",
    deliverable: {
      present: true,
      kind: "patch",
      path: "final/patch.diff",
      producer_attempt_id: "a01",
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
  });
}

describe("RunFacts invariant validator (GH #29)", () => {
  it("accepts a successful solo plan with a canonical deliverable", () => {
    expect(validateRunFactsInvariants(validPlan())).toEqual(validPlan());
  });

  it("counts only planner lanes in a council, excluding merge and reviewer roles", () => {
    const base = validPlan();
    const council = {
      ...base,
      deliverable: {
        ...base.deliverable,
        producer_attempt_id: "p03",
      },
      participants: {
        planners: 2,
        attempts: [
          {
            attempt_id: "p01",
            harness_id: "codex",
            role: "planner" as const,
            deliverable_present: true,
            status: "success" as const,
          },
          {
            attempt_id: "p02",
            harness_id: "claude",
            role: "planner" as const,
            deliverable_present: true,
            status: "success" as const,
          },
          {
            attempt_id: "p03",
            harness_id: "codex",
            role: "merge" as const,
            deliverable_present: true,
            status: "success" as const,
          },
          {
            attempt_id: null,
            harness_id: "reviewer",
            role: "reviewer" as const,
            deliverable_present: false,
            status: null,
          },
        ],
      },
    };

    expect(validateRunFactsInvariants(council).participants.planners).toBe(2);
  });

  it("rejects a succeeded plan whose canonical deliverable is absent", () => {
    const base = validPlan();
    expect(() =>
      validateRunFactsInvariants({
        ...base,
        deliverable: {
          present: false,
          kind: null,
          path: null,
          producer_attempt_id: null,
        },
      }),
    ).toThrow(RunFactsInvariantError);
  });

  it("requires a present deliverable to link to a successful participant that delivered", () => {
    const base = validPlan();
    expect(() =>
      validateRunFactsInvariants({
        ...base,
        deliverable: { ...base.deliverable, producer_attempt_id: null },
      }),
    ).toThrow(/identify its producer attempt/);
    expect(() =>
      validateRunFactsInvariants({
        ...base,
        deliverable: { ...base.deliverable, producer_attempt_id: "p99" },
      }),
    ).toThrow(/producer must exist/);
    expect(() =>
      validateRunFactsInvariants({
        ...base,
        participants: {
          ...base.participants,
          attempts: base.participants.attempts.map((participant) => ({
            ...participant,
            status: "failed" as const,
          })),
        },
      }),
    ).toThrow(/successful participant status/);
    expect(() =>
      validateRunFactsInvariants({
        ...base,
        participants: {
          ...base.participants,
          attempts: base.participants.attempts.map((participant) => ({
            ...participant,
            deliverable_present: false,
          })),
        },
      }),
    ).toThrow(/deliverable_present=true/);
  });

  it("accepts a produced patch whose participant status records the blocking gate failure", () => {
    const base = validAgentPatch();
    const outcome = makeOutcomeFacts("succeeded", {
      checks: "failed",
      review: "approved",
      reason: "checks_failed",
    });
    const receipt = validateRunFactsInvariants({
      ...base,
      outcome,
      participants: {
        ...base.participants,
        attempts: base.participants.attempts.map((participant) => ({
          ...participant,
          status: "failed" as const,
        })),
      },
      gates: {
        configured: true,
        required: 1,
        total: 1,
        executed: true,
        state: "failed",
        receipt_attempt_id: "a01",
      },
      review: { state: "approved", blocker_ids: [], blockers: 0 },
      required_actions: requiredActionsFor(outcome, false),
    });

    expect(receipt.outcome).toMatchObject({
      lifecycle: "succeeded",
      checks: "failed",
      reason: "checks_failed",
    });
    expect(receipt.participants.attempts[0]?.status).toBe("failed");
  });

  it("allows an unknown producer on a non-plan deliverable while validating any known producer", () => {
    const base = validAgentPatch();
    const receipt = validateRunFactsInvariants({
      ...base,
      deliverable: {
        present: true,
        kind: "answer",
        path: "final/answer.md",
        producer_attempt_id: null,
      },
    });
    expect(receipt.deliverable.producer_attempt_id).toBeNull();
  });

  it("rejects a known failed producer on any succeeded deliverable but permits honest failed partial work", () => {
    const base = validAgentPatch();
    const failedProducer = {
      ...base,
      participants: {
        ...base.participants,
        attempts: base.participants.attempts.map((participant) => ({
          ...participant,
          status: "failed" as const,
          deliverable_present: false,
        })),
      },
    };
    expect(() => validateRunFactsInvariants(failedProducer)).toThrow(
      /successful participant status/,
    );

    const failedOutcome = makeOutcomeFacts("failed", { reason: "harness_failed" });
    expect(
      validateRunFactsInvariants({
        ...failedProducer,
        outcome: failedOutcome,
        required_actions: requiredActionsFor(failedOutcome, false),
      }).outcome.lifecycle,
    ).toBe("failed");

    const blockedOutcome = makeOutcomeFacts("succeeded", {
      review: "blocked",
      reason: "review_blocked",
    });
    expect(
      validateRunFactsInvariants({
        ...base,
        outcome: blockedOutcome,
        participants: {
          ...base.participants,
          attempts: base.participants.attempts.map((participant) => ({
            ...participant,
            status: "blocked" as const,
          })),
        },
        review: { state: "blocked", blocker_ids: [], blockers: 0 },
        required_actions: requiredActionsFor(blockedOutcome, false),
      }).outcome.review,
    ).toBe("blocked");
  });

  it("accepts a blocked plan that produced only diagnostic output", () => {
    const base = validPlan();
    const outcome = makeOutcomeFacts("succeeded", {
      review: "blocked",
      reason: "review_blocked",
    });
    const receipt = validateRunFactsInvariants({
      ...base,
      outcome,
      deliverable: {
        present: false,
        kind: null,
        path: null,
        producer_attempt_id: null,
      },
      review: { state: "blocked", blocker_ids: [], blockers: 0 },
      required_actions: requiredActionsFor(outcome, false),
    });

    expect(receipt.deliverable.present).toBe(false);
    expect(receipt.review.state).toBe("blocked");
  });

  it("rejects a planner count inflated by merge/reviewer attempts", () => {
    const base = validPlan();
    expect(() =>
      validateRunFactsInvariants({
        ...base,
        participants: { ...base.participants, planners: 2 },
      }),
    ).toThrow(/does not match planner roles/);
  });
  it("rejects configured/passed gates that claim checks were not configured", () => {
    const base = validPlan();
    expect(() =>
      validateRunFactsInvariants({
        ...base,
        outcome: makeOutcomeFacts("succeeded", { checks: "not_configured" }),
        gates: {
          configured: true,
          required: 1,
          total: 1,
          executed: true,
          state: "passed",
          receipt_attempt_id: "p01",
        },
      }),
    ).toThrow(/outcome.checks=passed/);
  });

  it("accepts a zero-gate succeeded terminal whose deterministic checks failed closed", () => {
    // FinalVerifier and the protected live apply are deterministic checks that
    // run even when the contract configures no gates: a fresh-verify failure or
    // a refused live delivery rides the CHECKS axis (checks=failed,
    // reason=checks_failed) while gates.* stays honestly not_configured.
    const base = validAgentPatch();
    const outcome = makeOutcomeFacts("succeeded", {
      checks: "failed",
      review: "approved",
      reason: "checks_failed",
    });
    const receipt = validateRunFactsInvariants({
      ...base,
      outcome,
      review: { state: "approved", blocker_ids: [], blockers: 0 },
      required_actions: requiredActionsFor(outcome, false),
    });
    expect(receipt.gates).toMatchObject({ configured: false, total: 0, state: "not_configured" });
    expect(receipt.outcome).toMatchObject({ checks: "failed", reason: "checks_failed" });
  });

  it("retains a fail-closed checks axis when cancellation wins over a zero-gate terminal", () => {
    // A cancel that wins the terminal race keeps independent axis evidence
    // from the already-prepared outcome (terminalOutcomeFacts): checks=failed
    // with an unconfigured gate set must stay representable under a
    // cancellation reason.
    const base = validAgentPatch();
    const outcome = makeOutcomeFacts("cancelled", {
      checks: "failed",
      review: "approved",
      reason: "user_cancelled",
    });
    const receipt = validateRunFactsInvariants({
      ...base,
      outcome,
      review: { state: "approved", blocker_ids: [], blockers: 0 },
      required_actions: requiredActionsFor(outcome, false),
    });
    expect(receipt.outcome).toMatchObject({ checks: "failed", reason: "user_cancelled" });
  });

  it("rejects a green checks axis that no configured gate produced", () => {
    const base = validAgentPatch();
    const outcome = makeOutcomeFacts("succeeded", { checks: "passed", review: "approved" });
    expect(() =>
      validateRunFactsInvariants({
        ...base,
        outcome,
        review: { state: "approved", blocker_ids: [], blockers: 0 },
        required_actions: requiredActionsFor(outcome, false),
      }),
    ).toThrow(/unconfigured gates cannot claim outcome.checks=passed/);
  });

  it("rejects a failure-only reason on a succeeded lifecycle", () => {
    const base = validAgentPatch();
    expect(() =>
      validateRunFactsInvariants({
        ...base,
        outcome: makeOutcomeFacts("succeeded", { reason: "harness_failed" }),
      }),
    ).toThrow(/incompatible with lifecycle=succeeded/);
  });

  it("accepts a requested gate with one executed passing receipt", () => {
    const base = validPlan();
    const receipt = validateRunFactsInvariants({
      ...base,
      outcome: makeOutcomeFacts("succeeded", { checks: "passed" }),
      gates: {
        configured: true,
        required: 1,
        total: 1,
        executed: true,
        state: "passed",
        receipt_attempt_id: "p01",
      },
    });
    expect(receipt.gates).toMatchObject({ configured: true, executed: true, state: "passed" });
  });

  it("rejects a succeeded receipt whose gates belong to a losing attempt", () => {
    const base = validPlan();
    expect(() =>
      validateRunFactsInvariants({
        ...base,
        outcome: makeOutcomeFacts("succeeded", { checks: "passed" }),
        participants: {
          ...base.participants,
          planners: 2,
          attempts: [
            ...base.participants.attempts,
            {
              attempt_id: "p02",
              harness_id: "claude",
              role: "planner",
              deliverable_present: true,
              status: "success",
            },
          ],
        },
        gates: {
          configured: true,
          required: 1,
          total: 1,
          executed: true,
          state: "passed",
          receipt_attempt_id: "p02",
        },
      }),
    ).toThrow(/deliverable producer or final verify/);
  });

  it("treats a skipped required gate as fail-closed and rejects a green checks axis", () => {
    const base = validPlan();
    expect(() =>
      validateRunFactsInvariants({
        ...base,
        outcome: makeOutcomeFacts("succeeded", { checks: "passed" }),
        gates: {
          configured: true,
          required: 1,
          total: 1,
          executed: false,
          state: "skipped",
          receipt_attempt_id: null,
        },
      }),
    ).toThrow(/fail-closed outcome.checks=failed/);
  });

  it("accepts a partial gate receipt while keeping the skipped set fail-closed", () => {
    const base = validPlan();
    const receipt = validateRunFactsInvariants({
      ...base,
      outcome: makeOutcomeFacts("succeeded", {
        checks: "failed",
        reason: "checks_failed",
      }),
      gates: {
        configured: true,
        required: 2,
        total: 2,
        executed: true,
        state: "skipped",
        receipt_attempt_id: "p01",
      },
      required_actions: requiredActionsFor(
        makeOutcomeFacts("succeeded", {
          checks: "failed",
          reason: "checks_failed",
        }),
        false,
      ),
    });
    expect(receipt.gates).toMatchObject({
      executed: true,
      state: "skipped",
      receipt_attempt_id: "p01",
    });
    expect(receipt.outcome.checks).toBe("failed");
  });

  it("rejects needs-review blockers without typed actionable required actions", () => {
    const base = validPlan();
    const outcome = makeOutcomeFacts("succeeded", {
      review: "blocked",
      reason: "review_blocked",
    });
    const blocked = {
      ...base,
      outcome,
      review: { state: "blocked" as const, blocker_ids: ["finding-1"], blockers: 1 },
      apply: {
        eligibility: {
          eligible: false,
          state: "needs_review",
          reason: "Review blocked.",
          requiredAction: "Record a decision.",
        },
        operator_decision_present: false,
      },
      required_actions: [],
    };

    expect(() => validateRunFactsInvariants(blocked)).toThrow(/canonical terminal outcome/);

    const valid = validateRunFactsInvariants({
      ...blocked,
      required_actions: requiredActionsFor(outcome, false),
    });
    expect(valid.required_actions.map((action) => action.id)).toEqual([
      "resolve_review_block",
      "record_operator_decision",
    ]);
  });

  it("accepts a blocked review with no accepted blocker ids", () => {
    const base = validPlan();
    const outcome = makeOutcomeFacts("succeeded", {
      review: "blocked",
      reason: "review_blocked",
    });
    const receipt = validateRunFactsInvariants({
      ...base,
      outcome,
      review: { state: "blocked", blocker_ids: [], blockers: 0 },
      required_actions: requiredActionsFor(outcome, false),
    });
    expect(receipt.review).toEqual({ state: "blocked", blocker_ids: [], blockers: 0 });
    expect(receipt.required_actions.map((action) => action.id)).toEqual([
      "resolve_review_block",
      "record_operator_decision",
    ]);
  });

  it("rejects reason axes that contradict checks or review truth", () => {
    const base = validPlan();
    expect(() =>
      validateRunFactsInvariants({
        ...base,
        outcome: makeOutcomeFacts("succeeded", {
          checks: "passed",
          reason: "checks_failed",
        }),
      }),
    ).toThrow(/reason=checks_failed/);
    expect(() =>
      validateRunFactsInvariants({
        ...base,
        outcome: makeOutcomeFacts("succeeded", {
          review: "approved",
          reason: "review_blocked",
        }),
        review: { state: "approved", blocker_ids: [], blockers: 0 },
      }),
    ).toThrow(/reason=review_blocked/);
  });

  it("requires reason=no_changes to agree with outcome.noChanges", () => {
    const base = validAgentPatch();
    const noChangeReceipt = {
      ...base,
      outcome: makeOutcomeFacts("succeeded", {
        noChanges: true,
        reason: "no_changes",
      }),
      deliverable: {
        present: false,
        kind: null,
        path: null,
        producer_attempt_id: null,
      },
      participants: {
        ...base.participants,
        attempts: base.participants.attempts.map((participant) => ({
          ...participant,
          deliverable_present: false,
        })),
      },
    };

    expect(validateRunFactsInvariants(noChangeReceipt).outcome.noChanges).toBe(true);
    expect(() =>
      validateRunFactsInvariants({
        ...noChangeReceipt,
        outcome: makeOutcomeFacts("succeeded", {
          noChanges: false,
          reason: "no_changes",
        }),
      }),
    ).toThrow(/reason=no_changes requires outcome.noChanges=true/);
  });

  it("binds reason=input_required iff work_state.state=needs_input", () => {
    const base = validPlan();
    const needsInputOutcome = makeOutcomeFacts("succeeded", {
      noChanges: true,
      reason: "input_required",
      work_state: {
        state: "needs_input",
        source: "constrained",
        required_inputs: [{ kind: "file", locator: "config.yaml", description: "configuration" }],
      },
    });
    const needsInputReceipt = {
      ...base,
      outcome: needsInputOutcome,
      required_actions: requiredActionsFor(needsInputOutcome, false),
    };

    expect(validateRunFactsInvariants(needsInputReceipt).outcome.reason).toBe("input_required");
    expect(() =>
      validateRunFactsInvariants({
        ...needsInputReceipt,
        outcome: makeOutcomeFacts("succeeded", {
          noChanges: true,
          reason: "input_required",
        }),
        required_actions: [],
      }),
    ).toThrow(/reason=input_required iff outcome.work_state.state=needs_input/);

    const missingReasonOutcome = makeOutcomeFacts("succeeded", {
      noChanges: true,
      work_state: needsInputOutcome.work_state,
    });
    expect(() =>
      validateRunFactsInvariants({
        ...needsInputReceipt,
        outcome: missingReasonOutcome,
        required_actions: requiredActionsFor(missingReasonOutcome, false),
      }),
    ).toThrow(/reason=input_required iff outcome.work_state.state=needs_input/);
  });

  it("binds reason=work_incomplete iff work_state.state=incomplete", () => {
    const base = validPlan();
    const incompleteOutcome = makeOutcomeFacts("succeeded", {
      noChanges: true,
      reason: "work_incomplete",
      work_state: {
        state: "incomplete",
        source: "constrained",
      },
    });
    const incompleteReceipt = {
      ...base,
      outcome: incompleteOutcome,
      required_actions: requiredActionsFor(incompleteOutcome, false),
    };

    expect(validateRunFactsInvariants(incompleteReceipt).outcome.reason).toBe("work_incomplete");
    expect(() =>
      validateRunFactsInvariants({
        ...incompleteReceipt,
        outcome: makeOutcomeFacts("succeeded", {
          noChanges: true,
          reason: "work_incomplete",
        }),
        required_actions: [],
      }),
    ).toThrow(/reason=work_incomplete iff outcome.work_state.state=incomplete/);

    const missingReasonOutcome = makeOutcomeFacts("succeeded", {
      noChanges: true,
      work_state: incompleteOutcome.work_state,
    });
    expect(() =>
      validateRunFactsInvariants({
        ...incompleteReceipt,
        outcome: missingReasonOutcome,
        required_actions: requiredActionsFor(missingReasonOutcome, false),
      }),
    ).toThrow(/reason=work_incomplete iff outcome.work_state.state=incomplete/);
  });

  it("preserves independent work-state evidence when cancellation owns the terminal reason", () => {
    const base = validPlan();
    const cancelledOutcome = makeOutcomeFacts("cancelled", {
      noChanges: true,
      review: "approved",
      reason: "user_cancelled",
      work_state: {
        state: "incomplete",
        source: "constrained",
      },
    });
    const receipt = {
      ...base,
      outcome: cancelledOutcome,
      review: {
        state: "approved" as const,
        blocker_ids: [],
        blockers: 0,
      },
      required_actions: requiredActionsFor(cancelledOutcome, false),
    };

    expect(validateRunFactsInvariants(receipt).outcome).toMatchObject({
      lifecycle: "cancelled",
      reason: "user_cancelled",
      work_state: {
        state: "incomplete",
        source: "constrained",
      },
    });
  });

  it("rejects apply eligibility that bypasses lifecycle or required actions", () => {
    const base = validPlan();
    expect(() =>
      validateRunFactsInvariants({
        ...base,
        outcome: makeOutcomeFacts("failed", { reason: "harness_failed" }),
        apply: {
          eligibility: {
            eligible: true,
            state: "ok",
            reason: null,
            requiredAction: null,
          },
          operator_decision_present: false,
        },
      }),
    ).toThrow(/non-succeeded lifecycle/);

    const blocked = makeOutcomeFacts("succeeded", {
      review: "blocked",
      reason: "review_blocked",
    });
    expect(() =>
      validateRunFactsInvariants({
        ...base,
        outcome: blocked,
        review: { state: "blocked", blocker_ids: [], blockers: 0 },
        apply: {
          eligibility: {
            eligible: true,
            state: "ok",
            reason: null,
            requiredAction: null,
          },
          operator_decision_present: false,
        },
        required_actions: requiredActionsFor(blocked, false),
      }),
    ).toThrow(/required actions remain/);
  });

  it("allows positive apply eligibility only for an agent patch deliverable", () => {
    const eligibility = {
      eligible: true as const,
      state: "ok" as const,
      reason: null,
      requiredAction: null,
    };
    const plan = validPlan();
    expect(() =>
      validateRunFactsInvariants({
        ...plan,
        apply: { eligibility, operator_decision_present: false },
      }),
    ).toThrow(/only for agent mode/);

    const answer = validAgentPatch();
    expect(() =>
      validateRunFactsInvariants({
        ...answer,
        deliverable: {
          ...answer.deliverable,
          kind: "answer",
          path: "final/answer.md",
        },
        apply: { eligibility, operator_decision_present: false },
      }),
    ).toThrow(/only for a patch deliverable/);
  });

  it("accepts hash-bound risk eligibility only on a needs-decision outcome", () => {
    const base = validAgentPatch();
    const blocked = makeOutcomeFacts("succeeded", {
      review: "blocked",
      reason: "review_blocked",
    });
    const receipt = validateRunFactsInvariants({
      ...base,
      outcome: blocked,
      review: { state: "blocked", blocker_ids: [], blockers: 0 },
      apply: {
        eligibility: {
          eligible: true,
          state: "verify_pending",
          reason: null,
          requiredAction: null,
        },
        operator_decision_present: true,
      },
      required_actions: requiredActionsFor(blocked, true),
    });
    expect(receipt.apply.eligibility?.eligible).toBe(true);

    expect(() =>
      validateRunFactsInvariants({
        ...base,
        apply: {
          eligibility: null,
          operator_decision_present: true,
        },
      }),
    ).toThrow(/needs-decision outcome/);
  });

  it("binds positive apply eligibility to review, work-state, no-change, and state truth", () => {
    const base = validAgentPatch();
    const cleanOutcome = makeOutcomeFacts("succeeded", {
      review: "approved",
      checks: "not_configured",
    });
    const clean = {
      ...base,
      outcome: cleanOutcome,
      review: { state: "approved" as const, blocker_ids: [], blockers: 0 },
      apply: {
        eligibility: {
          eligible: true,
          state: "not_verified",
          reason: null,
          requiredAction: null,
        },
        operator_decision_present: false,
      },
      required_actions: requiredActionsFor(cleanOutcome, false),
    };
    expect(validateRunFactsInvariants(clean).apply.eligibility?.eligible).toBe(true);

    expect(() =>
      validateRunFactsInvariants({
        ...clean,
        outcome: makeOutcomeFacts("succeeded", {
          review: "not_run",
          checks: "not_configured",
        }),
        review: { state: "not_run", blocker_ids: [], blockers: 0 },
      }),
    ).toThrow(/outcome.review=approved/);

    expect(() =>
      validateRunFactsInvariants({
        ...clean,
        outcome: makeOutcomeFacts("succeeded", {
          review: "approved",
          checks: "not_configured",
          noChanges: true,
        }),
      }),
    ).toThrow(/noChanges=true/);

    expect(() =>
      validateRunFactsInvariants({
        ...clean,
        outcome: makeOutcomeFacts("succeeded", {
          review: "approved",
          checks: "not_configured",
          work_state: {
            state: "needs_input",
            source: "constrained",
            required_inputs: [
              { kind: "file", locator: "config.yaml", description: "configuration" },
            ],
          },
        }),
      }),
    ).toThrow(/unfinished work_state/);

    expect(() =>
      validateRunFactsInvariants({
        ...clean,
        apply: {
          ...clean.apply,
          eligibility: { ...clean.apply.eligibility, state: "arbitrary" },
        },
      }),
    ).toThrow(/canonical eligibility state/);
  });

  it("rejects duplicate blocker and action ids", () => {
    const base = validPlan();
    expect(() =>
      validateRunFactsInvariants({
        ...base,
        review: {
          state: "not_run",
          blocker_ids: ["finding-1", "finding-1"],
          blockers: 2,
        },
        required_actions: [
          { id: "record_operator_decision", detail: "one" },
          { id: "record_operator_decision", detail: "two" },
        ],
      }),
    ).toThrow(RunFactsInvariantError);
  });

  it("rejects accepted blocker ids on an approved review", () => {
    const base = validPlan();
    expect(() =>
      validateRunFactsInvariants({
        ...base,
        outcome: makeOutcomeFacts("succeeded", { review: "approved" }),
        review: {
          state: "approved",
          blocker_ids: ["finding-1"],
          blockers: 1,
        },
      }),
    ).toThrow(/require review.state=blocked/);
  });
});

describe("validateRunFactsReceipt (the shared pure read-back owner, S2)", () => {
  it("returns the receipt when shape, invariants, and identity all hold", () => {
    const base = validPlan();
    expect(
      validateRunFactsReceipt(base, {
        runId: "run-test",
        taskId: "task-test",
        lifecycle: "succeeded",
      }),
    ).toEqual(base);
  });

  it("refuses a wrong-shape value with the typed run_facts_invalid refusal", () => {
    expect(() => validateRunFactsReceipt({ run_id: "partial" })).toThrow(RunFactsInvalidError);
    expect(() => validateRunFactsReceipt({ run_id: "partial" })).toThrow(
      /canonical RunFacts receipt is invalid/,
    );
    try {
      validateRunFactsReceipt({ run_id: "partial" });
    } catch (error) {
      expect(error).toMatchObject({
        code: "run_facts_invalid",
        retryable: false,
        evidenceRefs: ["final/run_facts.yaml"],
      });
    }
  });

  it("refuses an identity contradicting the caller's authority, including lifecycle", () => {
    const base = validPlan();
    expect(() => validateRunFactsReceipt(base, { runId: "run-other" })).toThrow(
      RunFactsInvalidError,
    );
    expect(() => validateRunFactsReceipt(base, { taskId: "task-other" })).toThrow(
      RunFactsInvalidError,
    );
    expect(() => validateRunFactsReceipt(base, { lifecycle: "failed" })).toThrow(
      RunFactsInvalidError,
    );
  });
});
