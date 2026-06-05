import type { HarnessAdapter } from "@claudex/core";
import type { ProviderFamily, ReviewFinding, RouteProof } from "@claudex/schema";
import { HarnessRunSpec } from "@claudex/schema";
import { newId } from "@claudex/util";
import { dedupeFindings, parseFindings, type ReviewerInfo } from "./findings.js";
import { buildRouteProof, classifyDiversity, verifyCrossFamily } from "./route.js";

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
  const families: ProviderFamily[] = [];

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
    const iter = (reviewer.adapter.review ?? reviewer.adapter.run).call(reviewer.adapter, spec);
    for await (const ev of iter) {
      if (ev.type === "message" && ev.text) text += ev.text + "\n";
      if (ev.observed_model) observedModel = ev.observed_model;
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
    families.push(reviewer.providerFamily);

    const info: ReviewerInfo = {
      harness_id: reviewer.adapter.id,
      requested_model: reviewer.requestedModel ?? null,
      observed_model: observedModel ?? null,
      route_proof_status: proof.status,
    };
    all.push(...parseFindings(text, info));
  }

  const diversity = verifyCrossFamily(families);
  return {
    findings: dedupeFindings(all),
    routeProofs: classifyDiversity(routeProofs),
    crossFamilyVerified: diversity.verified,
    distinctProviders: diversity.distinct,
  };
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
