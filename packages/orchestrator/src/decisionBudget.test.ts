import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { arbitrate, type CandidateEvidence } from "@claudexor/arbitration";
import { ArtifactStore } from "@claudexor/artifact-store";
import { BudgetLedger, attemptUsageCostSettlement, type BudgetSettlement } from "@claudexor/budget";
import {
  DecisionRecord,
  makeOutcomeFacts,
  type CostEvidence,
  type PaidBudget,
} from "@claudexor/schema";
import {
  arbitrationBudgetOptions,
  decisionBudgetSummary,
  reconcileDecisionBudget,
  settledBudgetSnapshot,
} from "./decisionBudget.js";
import { announcedRunContext } from "./runTerminalContext.js";

const roots: string[] = [];
afterEach(
  () => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
  0,
); // synchronous removal: no deadline (#376, see vitest.setup.ts)

const evidence = (billing: CostEvidence["billing"]): CostEvidence => ({
  knowledge: billing === "subscription_entitlement" ? "exact" : "unknown",
  billing,
  source: "fixture",
  provenance: ["fixture"],
  estimatedUsd: null,
});

/** Settle real attempt evidence through the ledger the decision producers read. */
function settled(budget: PaidBudget, ...settlements: Array<[CostEvidence, BudgetSettlement]>) {
  const ledger = new BudgetLedger(budget);
  for (const [cost, settlement] of settlements) {
    const lease = ledger.reserve({ taskId: "t", intent: "implement", harnessId: "codex", cost });
    expect(lease.granted, lease.reason).toBe(true);
    ledger.settle(lease.lease!.lease_id, settlement);
  }
  return ledger;
}

// Codex subscription work: cap-governed cash exact 0, actual debit unobserved.
const unobservedAllowance: [CostEvidence, BudgetSettlement] = [
  evidence("subscription_entitlement"),
  attemptUsageCostSettlement(0, false, "a01", "codex", "local_session", {
    cashUsd: 0,
    valuationUsd: 0.4,
    unknownUsd: 0,
    cashKnowledge: "exact",
    valuationKnowledge: "estimated",
    allowanceDebitUnobserved: true,
  }),
];
const exactCash = (usd: number): [CostEvidence, BudgetSettlement] => [
  evidence("metered"),
  { knowledge: "exact", cashKnowledge: "exact", cashUsd: usd, source: "fixture", provenance: [] },
];
const unknownPaid: [CostEvidence, BudgetSettlement] = [
  evidence("metered"),
  { knowledge: "unknown", cashKnowledge: "unknown", cashUsd: 0, source: "fixture", provenance: [] },
];

// A candidate that carries its own cost: an unknown ledger total must not fall back to it.
const candidate: CandidateEvidence = {
  attemptId: "a01",
  label: "a01",
  gates: [],
  acceptanceCovered: [],
  acceptanceTotal: 0,
  findings: [],
  testsPassed: 0,
  testsTotal: 0,
  finalReviewClean: false,
  reviewVerified: false,
  diffSize: 1,
  diffBytes: 1,
  costUsd: 0.7,
};

describe("decision budget never presents an unknown total as its known subtotal", () => {
  it.each([
    {
      name: "unobserved subscription debit under finite(0)",
      budget: { kind: "finite", maxUsd: 0 } as const,
      settlements: [unobservedAllowance],
      expected: { spend_usd: null, cash_usd: null, controllable_cash_usd: 0, estimated: true },
    },
    {
      name: "unobserved debit beside an exact API receipt",
      budget: { kind: "finite", maxUsd: 5 } as const,
      settlements: [unobservedAllowance, exactCash(0.25)],
      expected: { spend_usd: null, cash_usd: null, controllable_cash_usd: 0.25, estimated: true },
    },
    {
      name: "exact cash only",
      budget: { kind: "unlimited" } as const,
      settlements: [exactCash(0.25)],
      expected: { spend_usd: 0.25, cash_usd: 0.25, controllable_cash_usd: 0.25, estimated: false },
    },
    {
      name: "paid route without a receipt",
      budget: { kind: "unlimited" } as const,
      settlements: [exactCash(0.25), unknownPaid],
      expected: {
        spend_usd: null,
        cash_usd: null,
        controllable_cash_usd: null,
        estimated: true,
      },
    },
    {
      name: "nothing settled",
      budget: { kind: "unlimited" } as const,
      settlements: [],
      expected: { spend_usd: 0, cash_usd: 0, controllable_cash_usd: 0, estimated: false },
    },
  ])("$name", ({ budget, settlements, expected }) => {
    const ledger = settled(budget, ...settlements);
    const summary = decisionBudgetSummary(ledger);
    expect(summary).toMatchObject(expected);
    // The arbitration producer carries the same split and never falls back to a
    // candidate's own cost for an unknown total.
    const arbitrated = arbitrate([candidate], {
      ...arbitrationBudgetOptions(ledger),
      reviewRequested: false,
    }).decision;
    expect(DecisionRecord.parse(arbitrated).budget_summary).toMatchObject(expected);
  });

  it("reconciles a Delegate family's decision with the same split", () => {
    const root = mkdtempSync(join(tmpdir(), "decision-budget-"));
    roots.push(root);
    const store = new ArtifactStore(root);
    const paths = store.runPaths("run-1");
    const ledger = settled({ kind: "finite", maxUsd: 0 }, unobservedAllowance);
    store.writeYaml(join(paths.arbitrationDir, "decision.yaml"), {
      winner: "a01",
      facts: makeOutcomeFacts("succeeded"),
      budget_summary: { spend_usd: 0, cash_usd: 0, valuation_usd: 0, estimated: true },
      future_extension: { kept: true },
    });
    const context = announcedRunContext(
      { log: {} as never, store, paths, runId: "run-1", taskId: "t", mode: "agent", phase: "x" },
      ledger,
      () => true,
    );
    reconcileDecisionBudget(context, settledBudgetSnapshot(context));
    const written = store.readYaml<Record<string, unknown>>(
      join(paths.arbitrationDir, "decision.yaml"),
    );
    expect(written).toMatchObject({
      future_extension: { kept: true },
      budget_summary: {
        spend_usd: null,
        cash_usd: null,
        controllable_cash_usd: 0,
        valuation_usd: 0.4,
        estimated: true,
      },
    });
    // The run result keeps the known settled figure; only the decision's total is unknown.
    expect(settledBudgetSnapshot(context).spendUsd).toBe(0);
  });
});
