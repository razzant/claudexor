/** Maximum age of a positive physical doctor/login probe. Reuse never renews it. */
export const DOCTOR_TTL_MS = Number(process.env.CLAUDEXOR_DOCTOR_TTL_MS ?? 90_000);

type Positive<T> = { key: string; at: number; value: T };

/** Dated admission facts under an exact identity (INV-135). Only physical
 * observations publish. Their start order is independent of the clock used for expiry. */
export class DatedPositives<T> {
  private readonly scopes = new Map<string, { latest: number; fact?: Positive<T> }>();
  private sequence = 0;

  get(scope: string, key: string | null, reuse = true): T | undefined {
    const entry = this.scopes.get(scope);
    const fact = entry?.fact;
    if (fact && fact.key === key) {
      const age = Date.now() - fact.at;
      if (age >= 0 && age < DOCTOR_TTL_MS) return reuse ? structuredClone(fact.value) : undefined;
    }
    if (entry) delete entry.fact;
    return undefined;
  }

  /** Start a physical observation. Finish with its dated fact, or empty on refusal. */
  observe(scope: string): (fact?: Positive<T>) => void {
    const entry = this.scopes.get(scope) ?? { latest: 0 };
    this.scopes.set(scope, entry);
    const order = ++this.sequence;
    return (fact) => {
      if (order < entry.latest) return;
      entry.latest = order;
      entry.fact = fact && structuredClone(fact);
    };
  }

  /** Detaching the entry also fences observations still holding it. */
  drop(matches: (scope: string) => boolean = () => true, keep?: (value: T) => boolean): void {
    for (const [scope, entry] of this.scopes) {
      if (!matches(scope)) continue;
      if (entry.fact && keep?.(entry.fact.value)) entry.latest = ++this.sequence;
      else this.scopes.delete(scope);
    }
  }
}
