import { z } from "zod";
import { Id, ProviderFamily } from "./primitives.js";

export const RouteProofStatus = z.enum(["verified", "unverified", "same_model_fallback"]);
export type RouteProofStatus = z.infer<typeof RouteProofStatus>;

export const RouteEvidenceSource = z.enum([
  "stream_event",
  "metadata",
  "model_catalog",
  "transcript",
  "unavailable",
]);
export type RouteEvidenceSource = z.infer<typeof RouteEvidenceSource>;

/**
 * Records what was requested vs what was actually observed, so multi-model
 * claims cannot silently collapse onto one model.
 */
export const RouteProof = z.object({
  requested: z.object({
    harness_id: Id,
    provider_family: ProviderFamily,
    model_hint: z.string().nullable().default(null),
  }),
  observed: z.object({
    provider: z.string().nullable().default(null),
    model_id: z.string().nullable().default(null),
    evidence_source: RouteEvidenceSource.default("unavailable"),
  }),
  diversity_against: z.array(Id).default([]),
  status: RouteProofStatus,
});
export type RouteProof = z.infer<typeof RouteProof>;
