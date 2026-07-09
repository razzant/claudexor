import { z } from "zod";
import { Id, ProviderFamily } from "./primitives.js";

export const RouteProofStatus = z
  .enum(["verified", "accepted_model_arg", "unverified", "same_model_fallback"])
  .describe(
    "How strongly the executed route is proven: verified (observed evidence matches the request), accepted_model_arg (the requested model arg was accepted without stream evidence), unverified, or same_model_fallback (a fallback landed on the same model).",
  );
export type RouteProofStatus = z.infer<typeof RouteProofStatus>;

export const RouteEvidenceSource = z
  .enum(["stream_event", "metadata", "model_catalog", "transcript", "unavailable"])
  .describe("Where the observed model/provider evidence came from: a stream event, response metadata, the model catalog, the transcript, or nowhere.");
export type RouteEvidenceSource = z.infer<typeof RouteEvidenceSource>;

/**
 * Records what was requested vs what was actually observed, so multi-model
 * claims cannot silently collapse onto one model.
 */
export const RouteProof = z
  .object({
    requested: z
      .object({
        harness_id: Id.describe("Harness the route was requested on."),
        provider_family: ProviderFamily,
        model_hint: z.string().nullable().default(null).describe("Model requested for the route; null = harness default."),
      })
      .describe("What was requested."),
    observed: z
      .object({
        provider: z.string().nullable().default(null).describe("Provider actually observed; null when no evidence."),
        model_id: z.string().nullable().default(null).describe("Model actually observed; null when no evidence."),
        evidence_source: RouteEvidenceSource.default("unavailable"),
      })
      .describe("What was actually observed."),
    diversity_against: z.array(Id).default([]).describe("Harness ids this route was required to be diverse against."),
    status: RouteProofStatus,
  })
  .describe("Records requested vs observed harness/model routing, so multi-model claims cannot silently collapse onto one model.");
export type RouteProof = z.infer<typeof RouteProof>;
