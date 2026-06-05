export interface ReadinessDebt {
  signature: string;
  count: number;
  lastReason: string;
}

/**
 * Tracks "commit-readiness debts" and round history to detect thrashing. When a
 * failure signature repeats, the loop should change strategy (in
 * until-convergence) or stop and ask (in adversarial-review), rather than
 * re-running the same failing approach.
 */
export class ReadinessLedger {
  private readonly debts = new Map<string, ReadinessDebt>();
  private readonly history: { round: number; signature: string }[] = [];
  private round = 0;

  recordRound(signature: string, reason: string): void {
    this.round += 1;
    this.history.push({ round: this.round, signature });
    const debt = this.debts.get(signature);
    if (debt) {
      debt.count += 1;
      debt.lastReason = reason;
    } else {
      this.debts.set(signature, { signature, count: 1, lastReason: reason });
    }
  }

  /** True when the same failure signature has recurred >= threshold times. */
  isStalled(signature: string, threshold = 2): boolean {
    return (this.debts.get(signature)?.count ?? 0) >= threshold;
  }

  debtFor(signature: string): ReadinessDebt | undefined {
    return this.debts.get(signature);
  }

  rounds(): number {
    return this.round;
  }

  openDebts(): ReadinessDebt[] {
    return [...this.debts.values()];
  }
}

/** Stable signature for a set of failure reasons, for thrash detection. */
export function failureSignature(reasons: string[]): string {
  return reasons.slice().map((r) => r.toLowerCase()).sort().join(" | ");
}
