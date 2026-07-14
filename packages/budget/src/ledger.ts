import type { BudgetLease, BudgetObservation, Intent } from "@claudexor/schema";
import { BudgetLease as BudgetLeaseSchema } from "@claudexor/schema";
import { newId, nowIso, sha256 } from "@claudexor/util";

export type CircuitTier = "ok" | "soft" | "downgrade" | "hard";

export interface BudgetLimits {
  maxUsd?: number | null;
}

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
  maxUsd?: number | null;
  reason?: string[];
  /**
   * Estimated USD the unit may spend, held against the cap until settled. Holds
   * make concurrent in-flight units visible to `tier()` so a parallel race wave
   * cannot blow past `max_usd` between settlements.
   */
  estimateUsd?: number;
}

export interface ReserveResult {
  granted: boolean;
  tier: CircuitTier;
  lease?: BudgetLease;
  reason?: string;
  /** Typed denial cause (no string matching on `reason`): `hard_cap` = the
   * breaker already tripped; `estimate_headroom` = the DD-27 wave guard —
   * this slot's estimate does not fit, but already-granted work continues. */
  denied?: "hard_cap" | "estimate_headroom";
}

/** Stable fingerprint of a prompt for loop detection. */
export function promptFingerprint(prompt: string): string {
  return sha256(prompt.trim().replace(/\s+/g, " ").toLowerCase());
}

/**
 * Dollar-based budget ledger with pre-call reservation, prompt-fingerprint loop
 * detection, and a 3-tier circuit breaker (soft-warn -> downgrade -> hard-kill).
 * Sub-ledgers (children) roll their spend up to the parent.
 */
export class BudgetLedger {
  private readonly leases = new Map<string, BudgetLease>();
  /** Outstanding USD holds for reserved-but-unsettled leases (amount-bearing). */
  private readonly holds = new Map<string, number>();
  private readonly observations: BudgetObservation[] = [];
  private readonly promptCounts = new Map<string, number>();
  private spendUsd = 0;

  constructor(
    private readonly limits: BudgetLimits = {},
    private readonly thresholds: CircuitThresholds = { soft: 0.75, downgrade: 0.9, hard: 1.0 },
    private readonly parent?: BudgetLedger,
  ) {}

  /** Create a child sub-ledger whose spend rolls up to this one. */
  child(limits: BudgetLimits = {}): BudgetLedger {
    return new BudgetLedger(limits, this.thresholds, this);
  }

  private outstandingHolds(): number {
    let sum = 0;
    for (const v of this.holds.values()) sum += v;
    return sum;
  }

  tier(): CircuitTier {
    const cap = this.limits.maxUsd ?? null;
    const localTier = ((): CircuitTier => {
      if (cap === null || cap <= 0) return "ok";
      // Settled spend + outstanding in-flight holds: a parallel wave of
      // streaming candidates counts against the cap BEFORE settlement.
      const ratio = (this.spendUsd + this.outstandingHolds()) / cap;
      if (ratio >= this.thresholds.hard) return "hard";
      if (ratio >= this.thresholds.downgrade) return "downgrade";
      if (ratio >= this.thresholds.soft) return "soft";
      return "ok";
    })();
    const parentTier = this.parent?.tier() ?? "ok";
    return mostSevere(localTier, parentTier);
  }

  /** USD still available under the nearest cap in the ledger chain (null = uncapped). */
  private remainingHeadroomUsd(): number | null {
    const cap = this.limits.maxUsd ?? null;
    const local =
      cap === null || cap <= 0
        ? null
        : cap * this.thresholds.hard - (this.spendUsd + this.outstandingHolds());
    const parent = this.parent?.remainingHeadroomUsd() ?? null;
    if (local === null) return parent;
    if (parent === null) return local;
    return Math.min(local, parent);
  }

  reserve(input: ReserveInput): ReserveResult {
    const tier = this.tier();
    if (tier === "hard") {
      return {
        granted: false,
        tier,
        reason: "budget exhausted (hard cap reached)",
        denied: "hard_cap",
      };
    }
    // DD-27 wave guard: an estimate-bearing reservation must FIT UNDER the
    // remaining headroom, or it is DENIED without recording the hold — a
    // denied slot must never poison the tier for candidates that were already
    // granted. `>=` on purpose: an estimate that exactly consumes headroom
    // would trip the hard tier the instant its hold lands, cancelling every
    // in-flight candidate with $0 real spend (the equality case is common —
    // caps and the floor are both round nickels).
    if (typeof input.estimateUsd === "number" && input.estimateUsd > 0) {
      const headroom = this.remainingHeadroomUsd();
      if (headroom !== null && input.estimateUsd >= headroom) {
        return {
          granted: false,
          tier,
          reason: `insufficient headroom for estimated cost (${input.estimateUsd.toFixed(2)} USD >= ${Math.max(headroom, 0).toFixed(2)} USD remaining)`,
          denied: "estimate_headroom",
        };
      }
    }
    const lease = BudgetLeaseSchema.parse({
      lease_id: newId("lease"),
      task_id: input.taskId,
      attempt_id: input.attemptId,
      intent: input.intent,
      harness_id: input.harnessId,
      model_hint: input.modelHint ?? null,
      max_usd: input.maxUsd ?? null,
      reason: input.reason ?? [],
      created_at: nowIso(),
      state: "reserved",
    });
    this.leases.set(lease.lease_id, lease);
    if (typeof input.estimateUsd === "number" && input.estimateUsd > 0) {
      this.setHold(lease.lease_id, input.estimateUsd);
    }
    return { granted: true, tier, lease };
  }

  /**
   * Raise a lease's hold to the cost streamed so far (never lowers it). Call from
   * the usage-event stream so `tier()` reflects in-flight spend mid-attempt.
   */
  updateHold(leaseId: string, streamedUsd: number): void {
    if (!this.leases.has(leaseId)) return;
    const current = this.holds.get(leaseId) ?? 0;
    if (streamedUsd > current) this.setHold(leaseId, streamedUsd);
  }

  private setHold(leaseId: string, usd: number): void {
    const prev = this.holds.get(leaseId) ?? 0;
    this.holds.set(leaseId, usd);
    this.parent?.adjustRollupHold(leaseId, usd - prev);
  }

  private adjustRollupHold(leaseId: string, deltaUsd: number): void {
    const key = `child:${leaseId}`;
    const prev = this.holds.get(key) ?? 0;
    const next = Math.max(0, prev + deltaUsd);
    if (next === 0) this.holds.delete(key);
    else this.holds.set(key, next);
    this.parent?.adjustRollupHold(leaseId, deltaUsd);
  }

  private clearHold(leaseId: string): void {
    const held = this.holds.get(leaseId) ?? 0;
    this.holds.delete(leaseId);
    if (held > 0) this.parent?.adjustRollupHold(leaseId, -held);
  }

  settle(leaseId: string, actualUsd: number): void {
    const lease = this.leases.get(leaseId);
    // Fail loudly: settling a lease this ledger never granted would attribute
    // spend to nothing (a bookkeeping bug, not a runtime race).
    if (!lease) throw new Error(`cannot settle unknown lease: ${leaseId}`);
    // Idempotent for the spend add: a duplicate settle (success path followed
    // by a late error handler) must never double-count real spend. DECIDED
    // TRADEOFF: this no-op can also mask a genuine double-settle bug — spend
    // correctness wins because the duplicate-settle race is a real runtime
    // path (terminal handler + error handler), while a masked bug still
    // surfaces in the rollup totals a test would assert on.
    if (lease.state !== "reserved") return;
    lease.state = "settled";
    this.clearHold(leaseId);
    this.spendUsd += actualUsd;
    this.parent?.addRollupSpend(actualUsd);
  }

  cancel(leaseId: string): void {
    const lease = this.leases.get(leaseId);
    if (lease) lease.state = "cancelled";
    this.clearHold(leaseId);
  }

  private addRollupSpend(usd: number): void {
    this.spendUsd += usd;
    this.parent?.addRollupSpend(usd);
  }

  spend(): number {
    return this.spendUsd;
  }

  observe(o: BudgetObservation): void {
    this.observations.push(o);
  }

  observationsFor(harnessId: string): BudgetObservation[] {
    return this.observations.filter((o) => o.harness_id === harnessId);
  }

  /** True if the harness is in an active cooldown (from an observed rate-limit). */
  cooldownActive(harnessId: string, now: number = Date.now()): boolean {
    return this.observationsFor(harnessId).some((o) => {
      if (!o.cooldown_until) return false;
      const t = Date.parse(o.cooldown_until);
      return Number.isFinite(t) && t > now;
    });
  }

  /** Observed remaining headroom (0..1) for a harness, or 1 if unknown. */
  headroom(harnessId: string): number {
    const used = this.observationsFor(harnessId)
      .map((o) => o.used_percent)
      .filter((v): v is number => typeof v === "number");
    if (used.length === 0) return 1;
    const maxUsed = Math.max(...used);
    return Math.max(0, 1 - maxUsed / 100);
  }

  recordPrompt(fingerprint: string): number {
    const n = (this.promptCounts.get(fingerprint) ?? 0) + 1;
    this.promptCounts.set(fingerprint, n);
    return n;
  }

  isLoop(fingerprint: string, threshold = 3): boolean {
    return (this.promptCounts.get(fingerprint) ?? 0) >= threshold;
  }
}

function severity(t: CircuitTier): number {
  return { ok: 0, soft: 1, downgrade: 2, hard: 3 }[t];
}

function mostSevere(a: CircuitTier, b: CircuitTier): CircuitTier {
  return severity(a) >= severity(b) ? a : b;
}
