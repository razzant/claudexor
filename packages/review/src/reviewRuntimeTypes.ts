import type {
  HarnessAdapter,
  ModelCatalogObservation,
  PreparedHarnessProcessing,
} from "@claudexor/core";
import {
  FallbackReason,
  type AuthPreference,
  type CredentialProfile,
  type CredentialRoute,
  type CostKnowledge,
  type EffortHint,
  type HarnessEvent,
  type HarnessRunSpec,
  type ProcessingPreference,
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

export interface ReviewerSpec {
  adapter: HarnessAdapter;
  providerFamily: ProviderFamily;
  requestedModel?: string | null;
  requestedEffort?: EffortHint | null;
  processingPreference?: ProcessingPreference;
  processing?: PreparedHarnessProcessing;
  processingAllowPaid?: boolean;
  promptCacheTtl?: HarnessRunSpec["prompt_cache_ttl"];
  authPreference?: AuthPreference | null;
  /** Exact resolved profile (null = pool/default); `profilePinned: false` = the pool chose it. */
  credentialProfile?: CredentialProfile | null;
  profilePinned?: boolean;
  /** The typed catalog read that admitted `requestedModel` for this credential
   * (the explicit panel's): the review request sends the key that read checked
   * (#393 x #147). Absent when no typed read admitted it. */
  catalog?: ModelCatalogObservation;
}

export interface ReviewerOutput {
  text: string;
  sealedProjectionError?: string;
  observedModel?: string;
  observedCredentialProfileId?: string;
  observedSource: RouteProof["observed"]["evidence_source"];
  costUsd: number;
  costEstimated: boolean;
  cashUsd: number;
  valuationUsd: number;
  unknownUsd: number;
  cashKnowledge: CostKnowledge;
  valuationKnowledge: CostKnowledge;
  /** Included reviewer route reported no actual debit (reported cash unknown). */
  allowanceDebitUnobserved?: boolean;
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

/** A candidate file the reviewer copy could not inspect (#535): it is never
 * copied (its content was not checked) and never silently dropped either —
 * the reviewer's prompt names it and the review returns it. */
export interface UninspectableReviewerFile {
  /** Relative to the candidate root, slash-separated. */
  path: string;
  /** The read failure's code (`EACCES`, `EIO`, ...), or `excluded_from_review_copy`. */
  reason: string;
}

/**
 * What a reviewer copy holds and what shows the change. `explicit_manifest` is a
 * directory result (its FILES.json); `explicit_paths` is a Git result with no
 * rendered patch (its CHANGED_PATHS.json). In both, the listed files are all a
 * review sees; no patch shows the change.
 */
export type ReviewerInventoryMode =
  "git_visible" | "diff_only" | "explicit_manifest" | "explicit_paths";

export interface ReviewerWorkspace {
  root: string;
  evidenceDir: string;
  uninspectable: UninspectableReviewerFile[];
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
  credential_profile_id?: string | null;
  observed_model?: string | null;
  observed_credential_profile_id?: string | null;
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
    credential_profile_id?: string | null;
  }[];
  crossFamilyHealthy: boolean;
  healthyProviders: ProviderFamily[];
  crossFamilyVerified: boolean;
  distinctProviders: ProviderFamily[];
  reviewSpendUsd: number;
  reviewSpendEstimated: boolean;
  reviewCashUsd: number;
  reviewCashKnowledge: CostKnowledge;
  reviewValuationUsd: number;
  reviewValuationKnowledge: CostKnowledge;
  reviewUnknownUsd: number;
  reviewAllowanceDebitUnobserved?: boolean;
  /** Candidate files some reviewer workspace could not inspect (absent when none). */
  uninspectableFiles?: UninspectableReviewerFile[];
}

export function summarizeReviewerSpend(
  spend: readonly number[],
  cash: readonly number[],
  valuation: readonly number[],
  unknown: readonly number[],
  estimated: readonly boolean[],
  cashKnowledge: readonly CostKnowledge[],
  valuationKnowledge: readonly CostKnowledge[],
  allowanceDebitUnobserved: readonly boolean[] = [],
): {
  reviewSpendUsd: number;
  reviewSpendEstimated: boolean;
  reviewCashUsd: number;
  reviewCashKnowledge: CostKnowledge;
  reviewValuationUsd: number;
  reviewValuationKnowledge: CostKnowledge;
  reviewUnknownUsd: number;
  reviewAllowanceDebitUnobserved: boolean;
} {
  const relevantValuationKnowledge = valuationKnowledge.filter(
    (_, index) => (valuation[index] ?? 0) > 0 || (unknown[index] ?? 0) > 0,
  );
  return {
    reviewSpendUsd: spend.reduce((sum, value) => sum + value, 0),
    reviewSpendEstimated: estimated.some(Boolean),
    reviewCashUsd: cash.reduce((sum, value) => sum + value, 0),
    reviewCashKnowledge: mergeKnowledge(cashKnowledge),
    reviewValuationUsd: valuation.reduce((sum, value) => sum + value, 0),
    reviewValuationKnowledge: mergeKnowledge(relevantValuationKnowledge),
    reviewUnknownUsd: unknown.reduce((sum, value) => sum + value, 0),
    reviewAllowanceDebitUnobserved: allowanceDebitUnobserved.some(Boolean),
  };
}

function mergeKnowledge(values: readonly CostKnowledge[]): CostKnowledge {
  if (values.length === 0 || values.includes("unknown")) return "unknown";
  return values.includes("estimated") ? "estimated" : "exact";
}
