import type { CredentialRoute, ProviderFamily, ReviewFinding, RouteProof } from "@claudexor/schema";

export type ReviewerAuthMode = "local_session" | "api_key" | null;

export function reviewerAuthMode(route?: CredentialRoute): ReviewerAuthMode {
  return route === "vendor_native"
    ? "local_session"
    : route === "managed_api_key"
      ? "api_key"
      : null;
}

export interface ReviewerOutput {
  text: string;
  observedModel?: string;
  observedSource: RouteProof["observed"]["evidence_source"];
  costUsd: number;
  costEstimated: boolean;
  authMode: ReviewerAuthMode;
}

export interface ReviewerArtifactContext {
  dir: string;
  progressPath: string;
  metadataPath: string;
  eventsPath: string;
  transcriptPath: string;
  promptPath: string;
  parsedPath: string;
  parseErrorPath: string;
  metadata: Record<string, unknown>;
}

export interface ReviewerWorkspace {
  root: string;
  evidenceDir: string;
}

export interface ReviewCandidateResult {
  findings: ReviewFinding[];
  routeProofs: RouteProof[];
  reviewerRequests: {
    harness_id: string;
    provider_family: ProviderFamily;
    requested_model: string | null;
    requested_effort: string | null;
  }[];
  crossFamilyHealthy: boolean;
  healthyProviders: ProviderFamily[];
  crossFamilyVerified: boolean;
  distinctProviders: ProviderFamily[];
  reviewSpendUsd: number;
  reviewSpendEstimated: boolean;
  reviewCashUsd: number;
  reviewValuationUsd: number;
}

export function summarizeReviewerSpend(
  spend: readonly number[],
  modes: readonly ReviewerAuthMode[],
  estimated: readonly boolean[],
): {
  reviewSpendUsd: number;
  reviewSpendEstimated: boolean;
  reviewCashUsd: number;
  reviewValuationUsd: number;
} {
  return {
    reviewSpendUsd: spend.reduce((sum, value) => sum + value, 0),
    reviewSpendEstimated: estimated.some(Boolean),
    reviewCashUsd: spend.reduce(
      (sum, value, index) => sum + (modes[index] === "local_session" ? 0 : value),
      0,
    ),
    reviewValuationUsd: spend.reduce(
      (sum, value, index) => sum + (modes[index] === "local_session" ? value : 0),
      0,
    ),
  };
}
