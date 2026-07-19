import type {
  BillingKnowledge,
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
} from "@claudexor/schema";
import { newId, nowIso, sha256 } from "@claudexor/util";

export type CircuitTier = "ok" | "soft" | "downgrade" | "hard";
/** Budget terminal REASON (D8 axes vocabulary): a subset of RunReason. A
 * budget stop always maps the run lifecycle to `failed` with one of these
 * reasons — the old status words exhausted/exhausted_overshoot are gone. */
export type BudgetTerminal = "budget_exhausted" | "budget_overshoot" | "cost_unverifiable" | null;

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

const UNKNOWN_COST: CostEvidence = {
  knowledge: "unknown",
  billing: "unknown",
  source: "route_preflight",
  provenance: ["route:billing-unknown"],
  estimatedUsd: null,
};

/** Stable fingerprint of a prompt for loop detection. */
export function promptFingerprint(prompt: string): string {
  return sha256(prompt.trim().replace(/\s+/g, " ").toLowerCase());
}

/** One root incremental-cash ledger. Nested work receives this same instance. */
export class BudgetLedger {
  private readonly leases = new Map<string, BudgetLease>();
  private readonly holds = new Map<string, number>();
  private readonly unknownPaidInFlight = new Set<string>();
  private readonly observations: BudgetObservation[] = [];
  private readonly quotaSnapshots = new Map<string, QuotaSnapshot>();
  private readonly promptCounts = new Map<string, number>();
  private spendUsd = 0;
  private valuationUsd = 0;
  private overshot = false;
  private unverifiable = false;

  constructor(
    private readonly budget: PaidBudget = { kind: "unlimited" },
    private readonly thresholds: CircuitThresholds = { soft: 0.75, downgrade: 0.9, hard: 1 },
    private readonly deps: {
      /**
       * Fires after every settle with the CUMULATIVE ledger truth. The ledger
       * is the one owner of "how much real money this run has spent" —
       * subscription-entitled work settles to cash 0 here (W4.3 sol #15), so
       * consumers (run events → UI) render cash without inferring from route
       * labels. Valuation rides along for telemetry, never for the cash fact.
       */
      onCashSettled?: (cashSpendUsd: number, valuationUsd: number) => void;
    } = {},
  ) {}

  private outstandingHolds(): number {
    let sum = 0;
    for (const value of this.holds.values()) sum += value;
    return sum;
  }

  private cap(): number | null {
    return this.budget.kind === "finite" ? this.budget.maxUsd : null;
  }

  tier(): CircuitTier {
    const cap = this.cap();
    if (cap === null) return "ok";
    if (this.overshot) return "hard";
    if (cap === 0) return this.spendUsd > 0 || this.outstandingHolds() > 0 ? "hard" : "ok";
    const ratio = (this.spendUsd + this.outstandingHolds()) / cap;
    if (ratio >= this.thresholds.hard) return "hard";
    if (ratio >= this.thresholds.downgrade) return "downgrade";
    if (ratio >= this.thresholds.soft) return "soft";
    return "ok";
  }

  remainingUsd(): number | null {
    const cap = this.cap();
    return cap === null ? null : Math.max(0, cap - this.spendUsd - this.outstandingHolds());
  }

  reserve(input: ReserveInput): ReserveResult {
    const cost = CostEvidenceSchema.parse(input.cost ?? UNKNOWN_COST);
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
    if (cap !== null && cap > 0 && unknownPaid && this.unknownPaidInFlight.size > 0) {
      return {
        granted: false,
        tier: this.tier(),
        denied: "unknown_paid_in_flight",
        reason: "one unknown-cost paid unit is already in flight",
      };
    }
    const estimate = zeroCash ? 0 : (cost.estimatedUsd ?? 0);
    const headroom = this.remainingUsd();
    if (estimate > 0 && headroom !== null && estimate >= headroom) {
      return {
        granted: false,
        tier: this.tier(),
        denied: "estimate_headroom",
        reason: `insufficient headroom for estimated cost (${estimate.toFixed(2)} USD >= ${headroom.toFixed(2)} USD remaining)`,
      };
    }
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
    this.leases.set(lease.lease_id, lease);
    if (estimate > 0) this.holds.set(lease.lease_id, estimate);
    if (unknownPaid && cap !== null) this.unknownPaidInFlight.add(lease.lease_id);
    return { granted: true, tier: this.tier(), lease };
  }

  updateHold(leaseId: string, streamedUsd: number): void {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.state !== "reserved") return;
    if (lease.cost.billing === "proven_zero" || lease.cost.billing === "subscription_entitlement")
      return;
    const current = this.holds.get(leaseId) ?? 0;
    if (streamedUsd > current) this.holds.set(leaseId, streamedUsd);
  }

  settle(leaseId: string, settlement: BudgetSettlement): void {
    const lease = this.leases.get(leaseId);
    if (!lease) throw new Error(`cannot settle unknown lease: ${leaseId}`);
    if (lease.state !== "reserved") return;
    lease.state = "settled";
    this.holds.delete(leaseId);
    this.unknownPaidInFlight.delete(leaseId);
    const zeroCash =
      lease.cost.billing === "proven_zero" || lease.cost.billing === "subscription_entitlement";
    const cashUsd = zeroCash ? 0 : Math.max(0, settlement.cashUsd ?? 0);
    this.spendUsd += cashUsd;
    this.valuationUsd += Math.max(
      0,
      settlement.valuationUsd ?? (zeroCash ? (settlement.cashUsd ?? 0) : 0),
    );
    if (this.budget.kind === "finite") {
      if (!zeroCash && settlement.knowledge === "unknown") this.unverifiable = true;
      if (this.spendUsd > this.budget.maxUsd) this.overshot = true;
    }
    this.deps.onCashSettled?.(this.spendUsd, this.valuationUsd);
  }

  cancel(leaseId: string): void {
    const lease = this.leases.get(leaseId);
    if (lease?.state === "reserved") lease.state = "cancelled";
    this.holds.delete(leaseId);
    this.unknownPaidInFlight.delete(leaseId);
  }

  spend(): number {
    return this.spendUsd;
  }

  valuation(): number {
    return this.valuationUsd;
  }

  terminal(): BudgetTerminal {
    if (this.overshot) return "budget_overshoot";
    if (this.unverifiable) return "cost_unverifiable";
    return this.tier() === "hard" ? "budget_exhausted" : null;
  }

  observe(observation: BudgetObservation): void {
    this.observations.push(observation);
  }

  /** Seed durable quota projection without collapsing credential identities. */
  observeQuotaSnapshot(snapshot: QuotaSnapshot): void {
    const subject = snapshot.subject;
    const key = [
      subject.harness,
      subject.credential_route,
      subject.subject_id ?? "",
      snapshot.source,
    ].join("\0");
    this.quotaSnapshots.set(key, snapshot);
  }

  observationsFor(harnessId: string): BudgetObservation[] {
    return this.observations.filter((observation) => observation.harness_id === harnessId);
  }

  cooldownActive(
    harnessId: string,
    credentialRoute?: CredentialRoute,
    credentialSubjectId?: string | null,
    now: number = Date.now(),
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

      if (!observation.cooldown_until) return false;
      const time = Date.parse(observation.cooldown_until);
      return Number.isFinite(time) && time > now;
    });
    if (liveObservation) return true;
    if (!credentialRoute) return false;
    return this.snapshotsFor(harnessId, credentialRoute, credentialSubjectId).some((snapshot) =>
      snapshot.constraints.some((constraint) => {
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

export function routeCostEvidence(input: {
  billing?: BillingKnowledge;
  knowledge?: CostKnowledge;
  source: string;
  provenance: string[];
  estimatedUsd?: number | null;
}): CostEvidence {
  return CostEvidenceSchema.parse({
    billing: input.billing ?? "unknown",
    knowledge: input.knowledge ?? "unknown",
    source: input.source,
    provenance: input.provenance,
    estimatedUsd: input.estimatedUsd ?? null,
  });
}

export function attemptCostEvidence(
  harnessId: string,
  attemptId: string,
  estimatedUsd?: number,
  billing: BillingKnowledge = "unknown",
): CostEvidence {
  return routeCostEvidence({
    source: "route-preflight",
    provenance: [`harness:${harnessId}`, `attempt:${attemptId}`, `billing:${billing}`],
    billing,
    knowledge: estimatedUsd === undefined ? "unknown" : "estimated",
    estimatedUsd: estimatedUsd ?? null,
  });
}

export function usageCostSettlement(
  cashUsd: number,
  estimated: boolean,
  source: string,
  provenance: string[],
): BudgetSettlement {
  return cashUsd > 0
    ? { knowledge: estimated ? "estimated" : "exact", source, provenance, cashUsd }
    : { knowledge: "unknown", source: `${source}-missing`, provenance };
}

export function reviewUsageCostSettlement(
  cashUsd: number,
  valuationUsd: number,
  estimated: boolean,
  provenance: string[],
  unknownUsd = 0,
): BudgetSettlement {
  const observed = cashUsd > 0 || valuationUsd > 0 || unknownUsd > 0;
  return {
    knowledge: observed && unknownUsd === 0 ? (estimated ? "estimated" : "exact") : "unknown",
    source: observed ? "review-usage" : "review-usage-missing",
    provenance,
    cashUsd: Math.max(0, cashUsd),
    valuationUsd: Math.max(0, valuationUsd),
  };
}

export function attemptUsageCostSettlement(
  totalUsd: number,
  estimated: boolean,
  attemptId: string,
  harnessId: string,
  authMode?: "local_session" | "api_key" | null,
  split?: { cashUsd: number; valuationUsd: number; unknownUsd: number },
): BudgetSettlement {
  if (split) {
    const observed = split.cashUsd + split.valuationUsd + split.unknownUsd;
    if (observed > 0) {
      return {
        knowledge: split.unknownUsd > 0 ? "unknown" : estimated ? "estimated" : "exact",
        source: "harness-usage-by-route",
        provenance: [`attempt:${attemptId}`, `harness:${harnessId}`, "route:per-usage-event"],
        cashUsd: split.cashUsd,
        valuationUsd: split.valuationUsd,
      };
    }
  }
  if (isSubscriptionValuation(authMode)) {
    return {
      knowledge: estimated ? "estimated" : "exact",
      source: "harness-token-valuation",
      provenance: [`attempt:${attemptId}`, `harness:${harnessId}`, "route:vendor_native"],
      valuationUsd: totalUsd,
    };
  }
  return usageCostSettlement(totalUsd, estimated, "harness-usage", [
    `attempt:${attemptId}`,
    `harness:${harnessId}`,
    ...(authMode ? [`route:${authMode}`] : []),
  ]);
}

/** One owner for the W4.3 fact used at settlement AND mid-flight cap checks. */
export function isSubscriptionValuation(authMode?: "local_session" | "api_key" | null): boolean {
  // Vendor-reported cost on a native subscription route is VALUATION,
  // regardless of whether the vendor labels it estimated or exact. It never
  // becomes incremental cash (live-found: Claude reported estimated=false
  // and the UI incorrectly showed ~$0.37 cash for subscription work).
  return authMode === "local_session";
}

export function unknownCostSettlement(source: string, cashUsd?: number): BudgetSettlement {
  return {
    knowledge: "unknown",
    source,
    provenance: [`orchestrator:${source}`],
    ...(cashUsd === undefined ? {} : { cashUsd }),
  };
}

export function isBudgetTerminal(reason: string | null): reason is Exclude<BudgetTerminal, null> {
  return (
    reason === "budget_exhausted" || reason === "budget_overshoot" || reason === "cost_unverifiable"
  );
}
