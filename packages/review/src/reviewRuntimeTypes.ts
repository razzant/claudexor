import {
  FallbackReason,
  type CredentialRoute,
  type EffortHint,
  type HarnessEvent,
  type ProviderFamily,
  type ReviewFinding,
  type RouteProof,
} from "@claudexor/schema";

export type ReviewerAuthMode = "local_session" | "api_key" | null;

export function reviewerAuthMode(route?: CredentialRoute): ReviewerAuthMode {
  return route === "vendor_native"
    ? "local_session"
    : route === "managed_api_key"
      ? "api_key"
      : null;
}

export function reviewerAuthSwitchFromEvent(ev: HarnessEvent): {
  from_auth_mode: string;
  to_auth_mode: string;
  reason: ReturnType<typeof FallbackReason.parse>;
} {
  const reason = FallbackReason.safeParse(ev.payload?.["reason"]);
  return {
    from_auth_mode:
      typeof ev.payload?.["from_auth_mode"] === "string" ? ev.payload["from_auth_mode"] : "unknown",
    to_auth_mode:
      typeof ev.payload?.["to_auth_mode"] === "string" ? ev.payload["to_auth_mode"] : "unknown",
    reason: reason.success ? reason.data : "auth_unavailable",
  };
}

export interface ReviewerOutput {
  text: string;
  observedModel?: string;
  observedSource: RouteProof["observed"]["evidence_source"];
  costUsd: number;
  costEstimated: boolean;
  cashUsd: number;
  valuationUsd: number;
  unknownUsd: number;
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

export interface ReviewerProgressEvent {
  type:
    | "reviewer.started"
    | "reviewer.first_event"
    | "reviewer.auth_switched"
    | "reviewer.completed"
    | "reviewer.timed_out"
    | "reviewer.failed";
  harness_id: string;
  provider_family: ProviderFamily;
  requested_model: string | null;
  requested_effort: EffortHint | null;
  observed_model?: string | null;
  observed_source?: RouteProof["observed"]["evidence_source"];
  route_proof_status?: RouteProof["status"];
  from_auth_mode?: string;
  to_auth_mode?: string;
  reason?: ReturnType<typeof FallbackReason.parse>;
  artifact_dir: string;
  at: string;
  duration_ms?: number;
  message?: string;
  review_wave_id?: string;
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
  reviewUnknownUsd: number;
}

export function summarizeReviewerSpend(
  spend: readonly number[],
  cash: readonly number[],
  valuation: readonly number[],
  unknown: readonly number[],
  estimated: readonly boolean[],
): {
  reviewSpendUsd: number;
  reviewSpendEstimated: boolean;
  reviewCashUsd: number;
  reviewValuationUsd: number;
  reviewUnknownUsd: number;
} {
  return {
    reviewSpendUsd: spend.reduce((sum, value) => sum + value, 0),
    reviewSpendEstimated: estimated.some(Boolean),
    reviewCashUsd: cash.reduce((sum, value) => sum + value, 0),
    reviewValuationUsd: valuation.reduce((sum, value) => sum + value, 0),
    reviewUnknownUsd: unknown.reduce((sum, value) => sum + value, 0),
  };
}
