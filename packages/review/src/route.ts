import type { ProviderFamily, RouteProof } from "@claudexor/schema";
import { RouteProof as RouteProofSchema } from "@claudexor/schema";

export interface RouteRequested {
  harness_id: string;
  provider_family: ProviderFamily;
  model_hint?: string | null;
}

export interface RouteObserved {
  provider?: string | null;
  model_id?: string | null;
  evidence_source?: RouteProof["observed"]["evidence_source"];
}

/** Build a RouteProof from observed model evidence or an accepted native CLI model argument. */
export function buildRouteProof(
  requested: RouteRequested,
  observed: RouteObserved,
  diversityAgainst: string[] = [],
): RouteProof {
  const evidenceSource = observed.evidence_source ?? "unavailable";
  const hasObserved = Boolean(observed.model_id) && evidenceSource !== "unavailable";
  const status = !hasObserved ? "unverified" : evidenceSource === "metadata" ? "accepted_model_arg" : "verified";
  return RouteProofSchema.parse({
    requested: {
      harness_id: requested.harness_id,
      provider_family: requested.provider_family,
      model_hint: requested.model_hint ?? null,
    },
    observed: {
      provider: observed.provider ?? null,
      model_id: observed.model_id ?? null,
      evidence_source: evidenceSource,
    },
    diversity_against: diversityAgainst,
    status,
  });
}

/** Mark same-model-fallback when two supposedly-distinct routes share an observed model. */
export function classifyDiversity(proofs: RouteProof[]): RouteProof[] {
  const counts = new Map<string, number>();
  for (const p of proofs) {
    if (p.observed.model_id) counts.set(p.observed.model_id, (counts.get(p.observed.model_id) ?? 0) + 1);
  }
  return proofs.map((p) =>
    p.observed.model_id && (counts.get(p.observed.model_id) ?? 0) > 1
      ? { ...p, status: "same_model_fallback" as const }
      : p,
  );
}

/** Distinct provider families => cross-family review is possible. */
export function verifyCrossFamily(families: ProviderFamily[]): { verified: boolean; distinct: ProviderFamily[] } {
  const distinct = [...new Set(families.filter((f) => f !== "unknown"))];
  return { verified: distinct.length >= 2, distinct };
}
