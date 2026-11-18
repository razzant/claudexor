/** Maximum age of a positive physical doctor/login probe. Reuse never renews it. */
export const DOCTOR_TTL_MS = Number(process.env.CLAUDEXOR_DOCTOR_TTL_MS ?? 90_000);

/** Dated positive admission facts (INV-135): per scope, the last positive physical
 * observation, answering only the exact identity key it was observed under and only
 * within DOCTOR_TTL_MS of its physical date. A hit never renews that date; an
 * unknown (null) key never answers; a mismatched or expired fact is dropped. */
export class DatedPositives<T> {
  private readonly facts = new Map<string, { key: string; at: number; value: T }>();

  get(scope: string, key: string | null): T | undefined {
    const fact = this.facts.get(scope);
    const age = fact ? Date.now() - fact.at : -1;
    if (key !== null && fact?.key === key && age >= 0 && age < DOCTOR_TTL_MS)
      return structuredClone(fact.value);
    this.facts.delete(scope);
    return undefined;
  }

  /** `at` is the physical observation's own start or date, never a later hit. */
  set(scope: string, key: string, at: number, value: T): void {
    this.facts.set(scope, { key, at, value: structuredClone(value) });
  }

  drop(matches: (scope: string) => boolean = () => true): void {
    for (const scope of this.facts.keys()) if (matches(scope)) this.facts.delete(scope);
  }
}
