import type { HarnessAdapter } from "@claudexor/core";
import type { EffortHint, ProviderFamily, ReviewFinding, RouteProof } from "@claudexor/schema";
import { HarnessRunSpec, ReviewFinding as ReviewFindingSchema } from "@claudexor/schema";
import { newId } from "@claudexor/util";
import { dedupeFindings, extractJsonBlocks, parseFindingsDetailed, type ReviewerInfo } from "./findings.js";
import { buildRouteProof, classifyDiversity } from "./route.js";

export interface ReviewerSpec {
  adapter: HarnessAdapter;
  providerFamily: ProviderFamily;
  requestedModel?: string | null;
  requestedEffort?: EffortHint | null;
}

export interface ReviewCandidateInput {
  /** Anonymized label (e.g. "Candidate A") — never reveal which model produced it. */
  candidateLabel: string;
  diff: string;
  evidenceDir: string;
  cwd: string;
  reviewers: ReviewerSpec[];
}

export interface ReviewCandidateResult {
  findings: ReviewFinding[];
  routeProofs: RouteProof[];
  reviewerRequests: { harness_id: string; provider_family: ProviderFamily; requested_model: string | null; requested_effort: string | null }[];
  /** True only when >=2 distinct provider families returned parseable JSON. Not a route-proof claim. */
  crossFamilyHealthy: boolean;
  healthyProviders: ProviderFamily[];
  /** True only when >=2 distinct provider families have verified route proofs. */
  crossFamilyVerified: boolean;
  distinctProviders: ProviderFamily[];
}

function reviewPrompt(label: string, evidenceDir: string, diff: string): string {
  return [
    "You are an adversarial code reviewer.",
    `First read the evidence packet in ${evidenceDir} (USER_INTENT.md, FORBIDDEN_FINDINGS.md, PLAN_ACCEPTED.md, DECIDED_TRADEOFFS.md, TESTS.txt). If a mandatory file is missing, return INSUFFICIENT_EVIDENCE.`,
    `Review ${label}'s change shown below. Output ONLY a JSON array of findings.`,
    `Each finding: {"severity":"BLOCK|FIX_FIRST|WARN|NIT|OUT_OF_SCOPE|INSUFFICIENT_EVIDENCE|NEEDS_HUMAN","category":"correctness|regression|security|performance|maintainability|test_gap|spec_gap|deploy|architecture|ux","claim":"...","evidence":{"files":[{"path":"...","lines":"..."}]},"proposed_fix":"..."}.`,
    "Rules: no evidence => do NOT use BLOCK. Do not relitigate FORBIDDEN_FINDINGS or DECIDED_TRADEOFFS.",
    "",
    "DIFF:",
    diff,
  ].join("\n");
}

/**
 * Cross-family review of one anonymized candidate. Each reviewer runs its review
 * intent and emits JSON findings; we attach route proofs and verify the
 * reviewers span >= 2 distinct provider families.
 */
export async function reviewCandidate(input: ReviewCandidateInput): Promise<ReviewCandidateResult> {
  const all: ReviewFinding[] = [];
  const routeProofs: RouteProof[] = [];
  const reviewerRequests: ReviewCandidateResult["reviewerRequests"] = [];
  const healthyFamilies = new Set<ProviderFamily>();

  for (const reviewer of input.reviewers) {
    reviewerRequests.push({
      harness_id: reviewer.adapter.id,
      provider_family: reviewer.providerFamily,
      requested_model: reviewer.requestedModel ?? null,
      requested_effort: reviewer.requestedEffort ?? null,
    });
    const spec = HarnessRunSpec.parse({
      session_id: newId("rev"),
      intent: "review",
      prompt: reviewPrompt(input.candidateLabel, input.evidenceDir, input.diff),
      cwd: input.cwd,
      access: "readonly",
      model_hint: reviewer.requestedModel ?? null,
      effort_hint: reviewer.requestedEffort ?? null,
    });

    let text = "";
    let observedModel: string | undefined;
    let observedSource: RouteProof["observed"]["evidence_source"] = "unavailable";
    let reviewerError: string | null = null;
    try {
      const iter = (reviewer.adapter.review ?? reviewer.adapter.run).call(reviewer.adapter, spec);
      for await (const ev of iter) {
        if (ev.type === "message" && ev.text) text += ev.text + "\n";
        if (ev.observed_model) {
          observedModel = ev.observed_model;
          const source = ev.payload?.["observed_model_source"];
          observedSource = source === "metadata" || source === "model_catalog" || source === "transcript" ? source : "stream_event";
        }
      }
    } catch (err) {
      reviewerError = err instanceof Error ? err.message : String(err);
    }

    const proof = buildRouteProof(
      {
        harness_id: reviewer.adapter.id,
        provider_family: reviewer.providerFamily,
        model_hint: reviewer.requestedModel ?? null,
      },
      {
        provider: reviewer.providerFamily,
        model_id: observedModel ?? null,
        evidence_source: observedModel ? observedSource : "unavailable",
      },
    );
    routeProofs.push(proof);

    const info: ReviewerInfo = {
      harness_id: reviewer.adapter.id,
      requested_model: reviewer.requestedModel ?? null,
      requested_effort: reviewer.requestedEffort ?? null,
      observed_model: observedModel ?? null,
      route_proof_status: proof.status,
    };
    if (reviewerError) {
      all.push(insufficientEvidenceFinding(info, `Reviewer failed: ${reviewerError}`));
      continue;
    }
    const jsonBlocks = extractJsonBlocks(text);
    if (text.trim() === "" || jsonBlocks.length === 0) {
      all.push(insufficientEvidenceFinding(info, "Reviewer produced no parseable JSON findings."));
      continue;
    }
    const parsed = parseFindingsDetailed(text, info);
    if (parsed.malformed > 0) {
      all.push(insufficientEvidenceFinding(info, `Reviewer produced ${parsed.malformed} malformed finding item(s).`));
      continue;
    }
    if (reviewer.providerFamily !== "unknown") healthyFamilies.add(reviewer.providerFamily);
    all.push(...parsed.findings);
  }

  const classifiedProofs = classifyDiversity(routeProofs);
  const proofStatusByHarness = new Map(classifiedProofs.map((p) => [p.requested.harness_id, p.status]));
  const findings = all.map((f) => {
    const status = proofStatusByHarness.get(f.reviewer.harness_id);
    if (!status || f.reviewer.route_proof_status === status) return f;
    return ReviewFindingSchema.parse({
      ...f,
      reviewer: { ...f.reviewer, route_proof_status: status },
    });
  });
  const healthyProviders = [...healthyFamilies];
  const verifiedFamilies = [
    ...new Set(
      classifiedProofs
        .filter((p) => p.status === "verified" || p.status === "accepted_model_arg")
        .map((p) => p.requested.provider_family)
        .filter((f) => f !== "unknown"),
    ),
  ];
  return {
    findings: dedupeFindings(findings),
    routeProofs: classifiedProofs,
    reviewerRequests,
    crossFamilyHealthy: healthyProviders.length >= 2,
    healthyProviders,
    crossFamilyVerified: verifiedFamilies.length >= 2,
    distinctProviders: verifiedFamilies,
  };
}

function insufficientEvidenceFinding(reviewer: ReviewerInfo, claim: string): ReviewFinding {
  return ReviewFindingSchema.parse({
    id: newId("f"),
    severity: "INSUFFICIENT_EVIDENCE",
    category: "test_gap",
    claim,
    evidence: {},
    proposed_fix: "Treat this review as inconclusive and rerun with a healthy reviewer.",
    reviewer: {
      harness_id: reviewer.harness_id,
      requested_model: reviewer.requested_model ?? null,
      requested_effort: reviewer.requested_effort ?? null,
      observed_model: reviewer.observed_model ?? null,
      route_proof_status: reviewer.route_proof_status ?? "unverified",
    },
    status: "insufficient_evidence",
  });
}

export interface MatrixCandidate {
  attemptId: string;
  label: string;
  diff: string;
  evidenceDir: string;
  cwd: string;
}

export interface CandidateReview {
  attemptId: string;
  label: string;
  result: ReviewCandidateResult;
}

/** Cross-review matrix: review every candidate with the same panel of reviewers. */
export async function reviewMatrix(
  candidates: MatrixCandidate[],
  reviewers: ReviewerSpec[],
): Promise<CandidateReview[]> {
  const out: CandidateReview[] = [];
  for (const c of candidates) {
    const result = await reviewCandidate({
      candidateLabel: c.label,
      diff: c.diff,
      evidenceDir: c.evidenceDir,
      cwd: c.cwd,
      reviewers,
    });
    out.push({ attemptId: c.attemptId, label: c.label, result });
  }
  return out;
}
