import { UNKNOWN_COST } from "./cost-evidence.js";
export { routeCostEvidence, attemptCostEvidence } from "./cost-evidence.js";
export type { CashCertainty, CashSettledCallback } from "./shared-financial-state.js";
import type {
  BudgetLease,
  BudgetObservation,
  CostEvidence,
  CostKnowledge,
  CredentialRoute,
  Intent,
  PaidBudget,
  QuotaSnapshot,
} from "@claudexor/schema";
import {
  BudgetLease as BudgetLeaseSchema,
  CostEvidence as CostEvidenceSchema,
  quotaConstraintAppliesToRequestKind,
  quotaSnapshotIdentity,
} from "@claudexor/schema";
import { newId, nowIso, sha256 } from "@claudexor/util";
import { reportedCashKnowledge } from "./usage-evidence.js";
import {
  newSharedFinancialState,
  recordSharedSettlement,
  settlementIsEstimated,
  taskFinancialTotals,
  settlementValuationKnowledge,
  type CashCertainty,
  type CashSettledCallback,
  type SharedFinancialState,
} from "./shared-financial-state.js";

export type CircuitTier = "ok" | "soft" | "downgrade" | "hard";
/** Budget terminal REASON (D8 axes vocabulary): a subset of RunReason. A
 * budget stop always maps the run lifecycle to `failed` with one of these
 * reasons — the old status words exhausted/exhausted_overshoot are gone. */
export type BudgetTerminal = "budget_exhausted" | "budget_overshoot" | "cost_unverifiable" | null;

export { quotaConstraintAppliesToModel } from "./quota-model-scope.js";
import { quotaConstraintAppliesToModel } from "./quota-model-scope.js";

export interface CircuitThresholds {
  soft: number;
  downgrade: number;
  hard: number;
}

export interface ReserveInput {
  taskId: string;
  attemptId?: string;
  intent: Intent;
  harnessId: string;
  modelHint?: string | null;
  reason?: string[];
  cost?: CostEvidence;
}

export interface BudgetSettlement {
  knowledge: CostKnowledge;
  /** Cash certainty is independent from subscription valuation certainty. */
  cashKnowledge?: CostKnowledge;
  /** Valuation certainty is independent from billed cash certainty. */
  valuationKnowledge?: CostKnowledge;
  /** Included work whose route reported no actual debit: the reported total is
   * unknown while `cashKnowledge` (controllable cash) still governs the cap. */
  allowanceDebitUnobserved?: boolean;
  source: string;
  provenance: string[];
  cashUsd?: number;
  valuationUsd?: number;
}

export interface ReserveResult {
  granted: boolean;
  tier: CircuitTier;
  lease?: BudgetLease;
  reason?: string;
  denied?: "hard_cap" | "estimate_headroom" | "finite_zero" | "unknown_paid_in_flight";
}

/** Stable fingerprint of a prompt for loop detection. */
export function promptFingerprint(prompt: string): string {
  return sha256(prompt.trim().replace(/\s+/g, " ").toLowerCase());
}

/** Root and task-scoped views share family finances, leases, holds and caps.
 * Task views expose their own totals; routing, quota and prompt-loop evidence
 * stay view-local. */
export class BudgetLedger {
  markPhysicalDispatchStarted(leaseId: string): void {
    const lease = this.financial.leases.get(leaseId);
    if (
      lease &&
      lease.cost?.billing !== "proven_zero" &&
      lease.cost?.billing !== "subscription_entitlement"
    )
      this.financial.physicalDispatchStarted.add(leaseId);
  }
  private readonly observations: BudgetObservation[] = [];
  private readonly quotaSnapshots = new Map<string, QuotaSnapshot>();
  private readonly promptCounts = new Map<string, number>();
  private readonly financial: SharedFinancialState;
  private readonly taskScope: string | null;
  private readonly localOnCashSettled?: CashSettledCallback;
  private released = false;

  constructor(
    budget: PaidBudget = { kind: "unlimited" },
    thresholds: CircuitThresholds = { soft: 0.75, downgrade: 0.9, hard: 1 },
    deps: {
      /**
       * Fires after every settle with the CUMULATIVE ledger truth. The ledger
       * is the one owner of "how much real money this run has spent" —
       * subscription-entitled work settles to cash 0 here (W4.3 sol #15), so
       * consumers (run events → UI) render cash without inferring from route
       * labels. Valuation rides along for telemetry, never for the cash fact.
       */
      onCashSettled?: CashSettledCallback;
    } = {},
    shared?: { financial: SharedFinancialState; taskScope: string },
  ) {
    this.financial =
      shared?.financial ?? newSharedFinancialState(budget, thresholds, deps.onCashSettled);
    this.taskScope = shared?.taskScope ?? null;
    this.localOnCashSettled = shared ? deps.onCashSettled : undefined;
  }

  scopedToTask(taskId: string, onCashSettled?: CashSettledCallback): BudgetLedger {
    if (!taskId.trim()) throw new Error("budget task scope must not be empty");
    return new BudgetLedger(
      this.financial.budget,
      this.financial.thresholds,
      { onCashSettled },
      {
        financial: this.financial,
        taskScope: taskId,
      },
    );
  }

  private outstandingHolds(): number {
    let sum = 0;
    for (const value of this.financial.holds.values())
      sum += Math.max(value.reservedUsd, value.observedUsd);
    return sum;
  }

  private cap(): number | null {
    return this.financial.budget.kind === "finite" ? this.financial.budget.maxUsd : null;
  }

  tier(): CircuitTier {
    const cap = this.cap();
    if (cap === null) return "ok";
    if (this.financial.overshot) return "hard";
    if (cap === 0) return this.financial.cashUsd > 0 || this.outstandingHolds() > 0 ? "hard" : "ok";
    const ratio = (this.financial.cashUsd + this.outstandingHolds()) / cap;
    if (ratio >= this.financial.thresholds.hard) return "hard";
    if (ratio >= this.financial.thresholds.downgrade) return "downgrade";
    if (ratio >= this.financial.thresholds.soft) return "soft";
    return "ok";
  }

  remainingUsd(): number | null {
    const cap = this.cap();
    return cap === null
      ? null
      : Math.max(0, cap - this.financial.cashUsd - this.outstandingHolds());
  }

  reserve(input: ReserveInput): ReserveResult {
    this.assertTaskScope(input.taskId);
    const cost = CostEvidenceSchema.parse(input.cost ?? UNKNOWN_COST);
    const denied = this.reservationDenial(cost);
    if (denied) return denied;
    const zeroCash = cost.billing === "proven_zero" || cost.billing === "subscription_entitlement";
    const estimate = zeroCash ? 0 : (cost.estimatedUsd ?? 0);
    const unknownPaid = !zeroCash && cost.knowledge === "unknown";
    const lease = BudgetLeaseSchema.parse({
      lease_id: newId("lease"),
      task_id: input.taskId,
      attempt_id: input.attemptId,
      intent: input.intent,
      harness_id: input.harnessId,
      model_hint: input.modelHint ?? null,
      cost,
      reason: input.reason ?? [],
      created_at: nowIso(),
      state: "reserved",
    });
    this.financial.leases.set(lease.lease_id, lease);
    if (estimate > 0)
      this.financial.holds.set(lease.lease_id, { reservedUsd: estimate, observedUsd: 0 });
    if (unknownPaid && this.cap() !== null) this.financial.unknownPaidInFlight.add(lease.lease_id);
    return { granted: true, tier: this.tier(), lease };
  }

  /** Admit the exact next physical send under its existing logical lease.
   * Previous streamed amounts and unknown-paid debt survive until settlement. */
  repriceReservedLease(leaseId: string, evidence: CostEvidence): ReserveResult {
    const lease = this.leaseForMutation(leaseId, true);
    if (lease.state !== "reserved") throw new Error("cannot reprice a closed budget lease");
    const cost = CostEvidenceSchema.parse(evidence);
    const zeroCash = cost.billing === "proven_zero" || cost.billing === "subscription_entitlement";
    const previous = this.financial.holds.get(leaseId) ?? { reservedUsd: 0, observedUsd: 0 };
    const requiredHold = Math.max(
      previous.reservedUsd,
      previous.observedUsd + (zeroCash ? 0 : (cost.estimatedUsd ?? 0)),
    );
    const denied = this.reservationDenial(cost, leaseId, requiredHold);
    if (denied) return denied;
    lease.cost = cost;
    if (requiredHold > 0)
      this.financial.holds.set(leaseId, { ...previous, reservedUsd: requiredHold });
    if (!zeroCash && cost.knowledge === "unknown" && this.cap() !== null)
      this.financial.unknownPaidInFlight.add(leaseId);
    else if (zeroCash && !this.financial.physicalDispatchStarted.has(leaseId))
      this.financial.unknownPaidInFlight.delete(leaseId);
    return { granted: true, tier: this.tier(), lease };
  }

  private reservationDenial(
    cost: CostEvidence,
    ownLeaseId?: string,
    requiredHold?: number,
  ): ReserveResult | null {
    const zeroCash = cost.billing === "proven_zero" || cost.billing === "subscription_entitlement";
    const cap = this.cap();
    if (cap === 0 && !zeroCash) {
      return {
        granted: false,
        tier: "hard",
        denied: "finite_zero",
        reason: "finite(0) admits only proven-zero or subscription-entitlement work",
      };
    }
    if (this.tier() === "hard" && !zeroCash) {
      return { granted: false, tier: "hard", denied: "hard_cap", reason: "budget exhausted" };
    }
    const unknownPaid = !zeroCash && cost.knowledge === "unknown";
    if (
      cap !== null &&
      cap > 0 &&
      unknownPaid &&
      [...this.financial.unknownPaidInFlight].some((id) => id !== ownLeaseId)
    ) {
      return {
        granted: false,
        tier: this.tier(),
        denied: "unknown_paid_in_flight",
        reason: "one unknown-cost paid unit is already in flight",
      };
    }
    const estimate = requiredHold ?? (zeroCash ? 0 : (cost.estimatedUsd ?? 0));
    const ownHold = ownLeaseId ? this.financial.holds.get(ownLeaseId) : undefined;
    const headroom =
      cap === null
        ? null
        : this.remainingUsd()! + (ownHold ? Math.max(ownHold.reservedUsd, ownHold.observedUsd) : 0);
    if (!zeroCash && estimate > 0 && headroom !== null && estimate >= headroom) {
      return {
        granted: false,
        tier: this.tier(),
        denied: "estimate_headroom",
        reason: `insufficient headroom for estimated cost (${estimate.toFixed(2)} USD >= ${headroom.toFixed(2)} USD remaining)`,
      };
    }
    return null;
  }

  /** Raise the hold from actual streamed cash/unknown usage. Subscription
   * valuation never calls this; an in-attempt API fallback does. */
  updateHold(leaseId: string, streamedCashUsd: number): void {
    const lease = this.leaseForMutation(leaseId, false);
    if (!lease || lease.state !== "reserved") return;
    const current = this.financial.holds.get(leaseId) ?? { reservedUsd: 0, observedUsd: 0 };
    if (streamedCashUsd > current.observedUsd)
      this.financial.holds.set(leaseId, { ...current, observedUsd: streamedCashUsd });
  }

  settle(leaseId: string, settlement: BudgetSettlement): void {
    const lease = this.leaseForMutation(leaseId, true);
    if (lease.state !== "reserved") return;
    lease.state = "settled";
    this.financial.holds.delete(leaseId);
    const previousPaidUnresolved = this.financial.unknownPaidInFlight.has(leaseId);
    this.financial.unknownPaidInFlight.delete(leaseId);
    this.financial.physicalDispatchStarted.delete(leaseId);
    const reservedZeroCash =
      !previousPaidUnresolved &&
      (lease.cost.billing === "proven_zero" || lease.cost.billing === "subscription_entitlement");
    // A route can change inside one attempt. Component-specific settlement
    // evidence from the actual usage stream outranks the preflight reservation:
    // an API retry must remain cash even when the lease began on subscription.
    const settledCashComponent =
      settlement.cashKnowledge !== undefined && settlement.cashUsd !== undefined;
    const zeroCash = reservedZeroCash && !settledCashComponent;
    const cashUsd = zeroCash ? 0 : Math.max(0, settlement.cashUsd ?? 0);
    const valuationUsd = Math.max(
      0,
      settlement.valuationUsd ?? (zeroCash ? (settlement.cashUsd ?? 0) : 0),
    );
    const taskTotals = taskFinancialTotals(this.financial, lease.task_id);
    const cashKnowledge = zeroCash ? "exact" : (settlement.cashKnowledge ?? settlement.knowledge);
    const reported = reportedCashKnowledge(cashKnowledge, settlement.allowanceDebitUnobserved);
    const valuationReported =
      settlement.valuationUsd !== undefined ||
      settlement.valuationKnowledge !== undefined ||
      (zeroCash && settlement.cashUsd !== undefined);
    recordSharedSettlement(
      this.financial,
      taskTotals,
      cashUsd,
      valuationUsd,
      reported,
      valuationReported ? (settlement.valuationKnowledge ?? settlement.knowledge) : null,
      cashKnowledge,
    );
    // The finite cap governs controllable cash; an unobserved allowance debit
    // is reported unknown but is not a cap the engine can verify or enforce.
    if (this.financial.budget.kind === "finite") {
      if (cashKnowledge === "unknown") this.financial.unverifiable = true;
      if (this.financial.cashUsd > this.financial.budget.maxUsd) this.financial.overshot = true;
    }
    this.localOnCashSettled?.(
      taskTotals.cashUsd,
      taskTotals.valuationUsd,
      taskTotals.cashEstimated,
      taskTotals.valuationKnowledge ?? "unknown",
      taskTotals.cashKnowledge ?? "unknown",
      taskTotals.controllableCashKnowledge ?? "unknown",
    );
  }
  cancel(leaseId: string): void {
    const lease = this.leaseForMutation(leaseId, false);
    if (lease?.state === "reserved") lease.state = "cancelled";
    this.financial.holds.delete(leaseId);
    this.financial.unknownPaidInFlight.delete(leaseId);
    this.financial.physicalDispatchStarted.delete(leaseId);
  }
  spend(): number {
    return this.taskScope === null
      ? this.financial.cashUsd
      : (this.financial.totalsByTask.get(this.taskScope)?.cashUsd ?? 0);
  }

  cashKnowledge(): CostKnowledge {
    return (
      (this.taskScope === null
        ? this.financial.cashKnowledge
        : this.financial.totalsByTask.get(this.taskScope)?.cashKnowledge) ?? "unknown"
    );
  }

  /** Reported and cap-governed certainty of `spend()`; they differ only when
   * included work reports no actual debit. */
  cashCertainty(): CashCertainty {
    const totals =
      this.taskScope === null ? this.financial : this.financial.totalsByTask.get(this.taskScope);
    return {
      reported: totals?.cashKnowledge ?? null,
      controllable: totals?.controllableCashKnowledge ?? null,
    };
  }

  valuation(): number {
    return this.taskScope === null
      ? this.financial.valuationUsd
      : (this.financial.totalsByTask.get(this.taskScope)?.valuationUsd ?? 0);
  }

  estimated(): boolean {
    return settlementIsEstimated(this.financial, this.taskScope);
  }

  valuationKnowledge(): CostKnowledge {
    return settlementValuationKnowledge(this.financial, this.taskScope);
  }

  terminal(): BudgetTerminal {
    if (this.financial.overshot) return "budget_overshoot";
    if (this.financial.unverifiable) return "cost_unverifiable";
    return this.tier() === "hard" ? "budget_exhausted" : null;
  }

  /** Cancel every still-reserved lease owned by this scoped task and detach
   * its callback. Used when a delegated child reaches terminal. */
  releaseTask(): void {
    if (this.taskScope === null || this.released) return;
    for (const [leaseId, lease] of this.financial.leases) {
      if (lease.task_id === this.taskScope && lease.state === "reserved") this.cancel(leaseId);
    }
    this.released = true;
  }

  private assertTaskScope(taskId: string): void {
    if (this.released) {
      throw Object.assign(new Error("budget task scope is released"), {
        code: "delegation_budget_scope_released",
        status: 409,
      });
    }
    if (this.taskScope !== null && taskId !== this.taskScope) {
      throw Object.assign(
        new Error(`budget task scope ${this.taskScope} cannot act for ${taskId}`),
        { code: "delegation_budget_scope_violation", status: 403 },
      );
    }
  }

  private leaseForMutation(leaseId: string, required: true): BudgetLease;
  private leaseForMutation(leaseId: string, required: false): BudgetLease | undefined;
  private leaseForMutation(leaseId: string, required: boolean): BudgetLease | undefined {
    const lease = this.financial.leases.get(leaseId);
    if (!lease) {
      if (required) throw new Error(`cannot settle unknown lease: ${leaseId}`);
      return undefined;
    }
    this.assertTaskScope(lease.task_id);
    return lease;
  }

  observe(observation: BudgetObservation): void {
    this.observations.push(observation);
  }

  /** Seed durable quota projection without collapsing credential identities. */
  observeQuotaSnapshot(snapshot: QuotaSnapshot): void {
    this.quotaSnapshots.set(quotaSnapshotIdentity(snapshot), snapshot);
  }

  observationsFor(harnessId: string): BudgetObservation[] {
    return this.observations.filter((observation) => observation.harness_id === harnessId);
  }

  cooldownActive(
    harnessId: string,
    credentialRoute?: CredentialRoute,
    credentialSubjectId?: string | null,
    now: number = Date.now(),
    model?: string | null,
  ): boolean {
    // Live observations are subject- AND route-scoped like snapshots
    // (rounds 17-18): a profiled or API-key rate-limit must never cool the
    // same harness's other subjects or its healthy other route. `undefined`
    // caller subject/route = conservative any; a LEGACY observation without
    // a route stamp stays conservative (applies to every route).
    const liveObservation = this.observationsFor(harnessId).some((observation) => {
      if (
        credentialSubjectId !== undefined &&
        (observation.subject_id ?? null) !== credentialSubjectId
      )
        return false;
      if (
        credentialRoute !== undefined &&
        observation.credential_route !== undefined &&
        observation.credential_route !== credentialRoute
      )
        return false;
      if (
        !quotaConstraintAppliesToRequestKind(observation) ||
        !quotaConstraintAppliesToModel(observation, model)
      )
        return false;

      if (!observation.cooldown_until) return false;
      const time = Date.parse(observation.cooldown_until);
      return Number.isFinite(time) && time > now;
    });
    if (liveObservation) return true;
    if (!credentialRoute) return false;
    return this.snapshotsFor(harnessId, credentialRoute, credentialSubjectId).some((snapshot) =>
      snapshot.constraints.some((constraint) => {
        if (
          !quotaConstraintAppliesToRequestKind(constraint) ||
          !quotaConstraintAppliesToModel(constraint, model)
        )
          return false;
        const cooldown = constraint.cooldown_until
          ? Date.parse(constraint.cooldown_until)
          : Number.NaN;
        const reset = constraint.resets_at ? Date.parse(constraint.resets_at) : Number.NaN;
        return (
          (Number.isFinite(cooldown) && cooldown > now) ||
          (constraint.used_ratio !== null &&
            constraint.used_ratio >= 1 &&
            Number.isFinite(reset) &&
            reset > now)
        );
      }),
    );
  }

  /** Binding pacing slack across applicable windows; null means honestly unknown. */
  bindingPaceSlack(
    harnessId: string,
    credentialRoute?: CredentialRoute,
    credentialSubjectId?: string | null,
    now: number = Date.now(),
    model?: string | null,
  ): number | null {
    const latest = new Map<string, BudgetObservation>();
    for (const observation of this.observationsFor(harnessId)) {
      if (observation.kind !== "quota_constraint" || !observation.constraint_id) continue;
      // Subject- and route-scoped like cooldowns (rounds 17-18); the latest
      // key includes route+subject so two routes' same-named windows never
      // overwrite each other.
      if (
        credentialSubjectId !== undefined &&
        (observation.subject_id ?? null) !== credentialSubjectId
      )
        continue;
      if (
        credentialRoute !== undefined &&
        observation.credential_route !== undefined &&
        observation.credential_route !== credentialRoute
      )
        continue;
      if (
        !quotaConstraintAppliesToRequestKind(observation) ||
        !quotaConstraintAppliesToModel(observation, model)
      )
        continue;
      latest.set(
        `${observation.credential_route ?? ""}\0${observation.subject_id ?? ""}\0${observation.constraint_id}`,
        observation,
      );
    }
    const slacks: number[] = [];
    for (const observation of latest.values()) {
      if (
        typeof observation.used_ratio !== "number" ||
        typeof observation.window_seconds !== "number" ||
        !observation.resets_at
      )
        continue;
      const resetMs = Date.parse(observation.resets_at);
      if (!Number.isFinite(resetMs) || resetMs <= now) continue;
      const remaining = Math.min(
        1,
        Math.max(0, (resetMs - now) / 1000 / observation.window_seconds),
      );
      const elapsedFraction = 1 - remaining;
      slacks.push(elapsedFraction - observation.used_ratio);
    }
    if (credentialRoute) {
      for (const snapshot of this.snapshotsFor(harnessId, credentialRoute, credentialSubjectId)) {
        for (const constraint of snapshot.constraints) {
          if (
            !quotaConstraintAppliesToRequestKind(constraint) ||
            !quotaConstraintAppliesToModel(constraint, model)
          )
            continue;
          if (
            typeof constraint.used_ratio !== "number" ||
            typeof constraint.window_seconds !== "number" ||
            !constraint.resets_at
          )
            continue;
          const resetMs = Date.parse(constraint.resets_at);
          if (!Number.isFinite(resetMs) || resetMs <= now) continue;
          const remaining = Math.min(
            1,
            Math.max(0, (resetMs - now) / 1000 / constraint.window_seconds),
          );
          slacks.push(1 - remaining - constraint.used_ratio);
        }
      }
    }
    return slacks.length > 0 ? Math.min(...slacks) : null;
  }

  /** Fresh snapshots for a harness+route, optionally pinned to ONE credential
   * subject (release wave round-16 #2): when the caller knows the effective
   * subject — a profile id, or null for the engine default — only that
   * subject's windows apply, so profile A's exhaustion never cools profile B
   * or the default. `undefined` = subject unknown, conservative any-subject. */
  private snapshotsFor(
    harnessId: string,
    credentialRoute: CredentialRoute,
    credentialSubjectId?: string | null,
  ): QuotaSnapshot[] {
    return [...this.quotaSnapshots.values()].filter(
      (snapshot) =>
        snapshot.freshness === "fresh" &&
        snapshot.subject.harness === harnessId &&
        snapshot.subject.credential_route === credentialRoute &&
        (credentialSubjectId === undefined ||
          (snapshot.subject.subject_id ?? null) === credentialSubjectId),
    );
  }

  recordPrompt(fingerprint: string): number {
    const count = (this.promptCounts.get(fingerprint) ?? 0) + 1;
    this.promptCounts.set(fingerprint, count);
    return count;
  }

  isLoop(fingerprint: string, threshold = 3): boolean {
    return (this.promptCounts.get(fingerprint) ?? 0) >= threshold;
  }
}

export function isBudgetTerminal(reason: string | null): reason is Exclude<BudgetTerminal, null> {
  return (
    reason === "budget_exhausted" || reason === "budget_overshoot" || reason === "cost_unverifiable"
  );
}
