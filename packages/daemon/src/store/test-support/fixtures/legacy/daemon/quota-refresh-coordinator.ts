type RefreshCycle<T> = {
  credentialGeneration: number;
  result: Promise<T>;
};

/** One official-source refresh at a time, fenced by credential generation. */
export class QuotaRefreshCoordinator<T> {
  private credentialGeneration = 0;
  private inFlight: RefreshCycle<T> | null = null;

  retireCredentialGeneration(): void {
    this.credentialGeneration += 1;
  }

  isCurrent(credentialGeneration: number): boolean {
    return credentialGeneration === this.credentialGeneration;
  }

  /** The generation a caller should capture BEFORE a cycle to later ask
   * whether a credential change intervened (per-lane pacing reads it). */
  currentGeneration(): number {
    return this.credentialGeneration;
  }

  async run(
    start: (credentialGeneration: number) => Promise<T>,
    followCredentialChanges = true,
  ): Promise<T> {
    const requestedGeneration = this.credentialGeneration;
    for (;;) {
      const credentialGeneration = this.credentialGeneration;
      let cycle = this.inFlight;
      if (cycle === null) {
        let pending: RefreshCycle<T>;
        const result = start(credentialGeneration).finally(() => {
          if (this.inFlight === pending) this.inFlight = null;
        });
        pending = { credentialGeneration, result };
        this.inFlight = pending;
        cycle = pending;
      }
      try {
        const result = await cycle.result;
        if (this.isCurrent(cycle.credentialGeneration)) return result;
        if (!followCredentialChanges && cycle.credentialGeneration === requestedGeneration) {
          return result;
        }
      } catch (error) {
        if (this.isCurrent(cycle.credentialGeneration)) throw error;
        if (!followCredentialChanges && cycle.credentialGeneration === requestedGeneration) {
          throw error;
        }
      }
      // Post-change callers wait for obsolete work, then all join one new
      // generation. A superseded poll reports no refresh to its pacing owner.
    }
  }
}
