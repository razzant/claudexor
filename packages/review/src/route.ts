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
  const status = !hasObserved
    ? "unverified"
    : evidenceSource === "metadata"
      ? "accepted_model_arg"
      : "verified";
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

/**
 * Mark same-model-fallback when supposedly-distinct routes collapse onto one
 * STREAM-OBSERVED model. Only `verified` proofs count as real observations —
 * an `accepted_model_arg` (argv echo) or `unverified` proof is not evidence the
 * CLI ran that model, so it must not trigger a false same-model-fallback claim.
 *
 * Intentional same-family repeats of the same requested model stay verified,
 * but distinct requested model hints within one family must still be flagged if
 * the native CLI reports the same observed model for all of them.
 */
export function classifyDiversity(proofs: RouteProof[]): RouteProof[] {
  const familiesByObservedModel = new Map<string, Set<ProviderFamily>>();
  const requestedHintsByObservedModel = new Map<string, Set<string>>();
  for (const p of proofs) {
    if (p.status === "verified" && p.observed.model_id) {
      const families =
        familiesByObservedModel.get(p.observed.model_id) ?? new Set<ProviderFamily>();
      families.add(p.requested.provider_family);
      familiesByObservedModel.set(p.observed.model_id, families);
      const requestedHints =
        requestedHintsByObservedModel.get(p.observed.model_id) ?? new Set<string>();
      requestedHints.add(p.requested.model_hint ?? "");
      requestedHintsByObservedModel.set(p.observed.model_id, requestedHints);
    }
  }
  return proofs.map((p) => {
    const observedModel = p.observed.model_id;
    const collapsed =
      p.status === "verified" &&
      observedModel &&
      ((familiesByObservedModel.get(observedModel)?.size ?? 0) > 1 ||
        (requestedHintsByObservedModel.get(observedModel)?.size ?? 0) > 1);
    return collapsed ? { ...p, status: "same_model_fallback" as const } : p;
  });
}
