import type { HarnessAdapter } from "@claudex/core";
import type { ProviderFamily, ReviewFinding, RouteProof } from "@claudex/schema";
import { HarnessRunSpec, ReviewFinding as ReviewFindingSchema } from "@claudex/schema";
import { newId } from "@claudex/util";
import { dedupeFindings, extractJsonBlocks, parseFindings, type ReviewerInfo } from "./findings.js";
import { buildRouteProof, classifyDiversity } from "./route.js";

export interface ReviewerSpec {
  adapter: HarnessAdapter;
  providerFamily: ProviderFamily;
  requestedModel?: string | null;
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
  crossFamilyVerified: boolean;
  distinctProviders: ProviderFamily[];
}

function reviewPrompt(label: string, evidenceDir: string, diff: string): string {
  return [
    "You are an adversarial code reviewer.",
    `First read the evidence packet in ${evidenceDir} (USER_INTENT.md, FORBIDDEN_FINDINGS.md, PLAN_ACCEPTED.md, DECIDED_TRADEOFFS.md, TESTS.txt). If a mandatory file is missing, return INSUFFICIENT_EVIDENCE.`,
    `Review ${label}'s change shown below. Output ONLY a JSON array of findings.`,
    `Each finding: {"severity":"BLOCK|FIX_FIRST|WARN|NIT|OUT_OF_SCOPE|INSUFFICIENT_EVIDENCE|NEEDS_HUMAN","category":"correctness|regression|security|performance|maintainability|test_gap|spec_gap|deploy|architecture|ux|benchmark","claim":"...","evidence":{"files":[{"path":"...","lines":"..."}]},"proposed_fix":"..."}.`,
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

  for (const reviewer of input.reviewers) {
    const spec = HarnessRunSpec.parse({
      session_id: newId("rev"),
      intent: "review",
      prompt: reviewPrompt(input.candidateLabel, input.evidenceDir, input.diff),
      cwd: input.cwd,
      access: "readonly",
      model_hint: reviewer.requestedModel ?? null,
    });

    let text = "";
    let observedModel: string | undefined;
    let reviewerError: string | null = null;
    try {
      const iter = (reviewer.adapter.review ?? reviewer.adapter.run).call(reviewer.adapter, spec);
      for await (const ev of iter) {
        if (ev.type === "message" && ev.text) text += ev.text + "\n";
        if (ev.observed_model) observedModel = ev.observed_model;
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
        evidence_source: observedModel ? "stream_event" : "unavailable",
      },
    );
    routeProofs.push(proof);

    const info: ReviewerInfo = {
      harness_id: reviewer.adapter.id,
      requested_model: reviewer.requestedModel ?? null,
      observed_model: observedModel ?? null,
      route_proof_status: proof.status,
    };
    if (reviewerError) {
      all.push(insufficientEvidenceFinding(info, `Reviewer failed: ${reviewerError}`));
      continue;
    }
    if (text.trim() === "" || extractJsonBlocks(text).length === 0) {
      all.push(insufficientEvidenceFinding(info, "Reviewer produced no parseable JSON findings."));
      continue;
    }
    all.push(...parseFindings(text, info));
  }

  const classifiedProofs = classifyDiversity(routeProofs);
  const verifiedFamilies = [
    ...new Set(
      classifiedProofs
        .filter((p) => p.status === "verified" && p.requested.provider_family !== "unknown")
        .map((p) => p.requested.provider_family),
    ),
  ];
  return {
    findings: dedupeFindings(all),
    routeProofs: classifiedProofs,
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
