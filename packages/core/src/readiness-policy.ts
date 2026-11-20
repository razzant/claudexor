import type { PaidBudget } from "@claudexor/schema";
import type { DiagnosticGeneration } from "./adapter.js";

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

/** The ONE rule for diagnostic generation: only a finite $0 effective paid
 * budget forbids it. Every other budget (unlimited, finite > 0, unresolved)
 * keeps today's probes; spend itself stays with the budget ledger. */
export function diagnosticGenerationFor(budget: PaidBudget | undefined): DiagnosticGeneration {
  return budget?.kind === "finite" && budget.maxUsd === 0 ? "forbidden" : "allowed";
}

/** The ONE Ask-only gate of that mode: only an ordinary read-only Ask (the run's own mode,
 * not its Deep Scan strategy) ever withholds paid diagnostics; static admission and the
 * orchestrator's readiness probe both ask here. */
export function isOrdinaryAsk(request: { mode?: string; deepScan?: boolean }): boolean {
  return request.mode === "ask" && request.deepScan !== true;
}

/** Shared not-run detail for a proof withheld by `diagnosticGeneration: "forbidden"`. */
export const DIAGNOSTIC_GENERATION_WITHHELD =
  "verification not run: paid diagnostic generation is disabled because no paid budget remains for this Ask";
