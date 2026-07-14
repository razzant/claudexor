/**
 * Scoped DIFF review: review a caller-supplied diff (e.g. a staged
 * commit) with the resolved reviewer panel — the same reviewCandidate
 * machinery race candidates use, no run/envelope. The engine owns reviewer
 * resolution, evidence packaging, revalidation, and typed results; the CLI
 * verb stays a thin surface.
 */
import { join } from "node:path";
import type { AuthPreference, ProviderFamily, ReviewFinding } from "@claudexor/schema";
import { HarnessUnavailableError } from "@claudexor/core";
import { revalidateFindings, type ReviewerSpec, type reviewCandidate } from "@claudexor/review";
import { writeEvidencePacket } from "@claudexor/context";
import { containsSecretLikeToken, redactSecrets } from "@claudexor/util";

export interface DiffReviewInput {
  repoRoot: string;
  diff: string;
  userIntent?: string;
  tests?: string;
  decidedTradeoffs?: string;
  authPreference?: AuthPreference;
  signal?: AbortSignal;
  onReviewerEvent?: (event: { type: string; [k: string]: unknown }) => void;
}

export interface DiffReviewResult {
  findings: ReviewFinding[];
  crossFamilyHealthy: boolean;
  crossFamilyVerified: boolean;
  distinctProviders: ProviderFamily[];
  routeProofs: unknown[];
  reviewSpendUsd: number;
  artifactsDir: string;
}

export interface DiffReviewDeps {
  resolveReviewers: (repoRoot: string, authPreference?: AuthPreference) => Promise<ReviewerSpec[]>;
  reviewScoped: (
    input: Omit<Parameters<typeof reviewCandidate>[0], "env">,
  ) => ReturnType<typeof reviewCandidate>;
  execRootOf: (repoRoot: string) => string;
  envInheritance: (repoRoot: string) => "mirror_native" | "clean";
}

export async function runDiffReview(
  input: DiffReviewInput,
  deps: DiffReviewDeps,
): Promise<DiffReviewResult> {
  if (!input.diff.trim()) {
    throw new Error("reviewDiff: the diff is empty — nothing to review");
  }
  // INV-062: raw secrets must never become review artifacts. The fence lives
  // HERE so every caller (CLI verb, commit gate, future surfaces) is covered
  // before any evidence write or reviewer call — and it covers EVERY
  // artifact-bound string, not just the diff.
  for (const [label, text] of [
    ["diff", input.diff],
    ["userIntent", input.userIntent],
    ["tests", input.tests],
    ["decidedTradeoffs", input.decidedTradeoffs],
  ] as const) {
    if (typeof text === "string" && containsSecretLikeToken(text)) {
      throw new Error(
        `reviewDiff: ${label} contains a secret-like token; refusing review (remove the secret first)`,
      );
    }
  }
  const reviewers = await deps.resolveReviewers(input.repoRoot, input.authPreference);
  if (reviewers.length === 0) {
    throw new HarnessUnavailableError(
      "no eligible reviewers (doctor-OK, review-capable) are available",
    );
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseDir = join(deps.execRootOf(input.repoRoot), ".claudexor", "reviews", `diff-${stamp}`);
  const evidenceDir = join(baseDir, "evidence");
  writeEvidencePacket(evidenceDir, {
    userIntent: redactSecrets(
      input.userIntent ?? "Review this staged diff for defects before commit.",
    ),
    diff: input.diff,
    tests: input.tests ?? "(no test evidence supplied)",
    decidedTradeoffs: input.decidedTradeoffs,
  });
  const result = await deps.reviewScoped({
    candidateLabel: "Staged diff",
    diff: input.diff,
    evidenceDir,
    artifactsDir: join(baseDir, "reviewers"),
    cwd: input.repoRoot,
    reviewers,
    envInheritance: deps.envInheritance(input.repoRoot),
    signal: input.signal,
    onReviewerEvent: input.onReviewerEvent
      ? (event) => input.onReviewerEvent?.({ ...event })
      : undefined,
  });
  const findings = await revalidateFindings(result.findings, {
    candidateRoot: input.repoRoot,
    evidenceDir,
  });
  return {
    findings,
    crossFamilyHealthy: result.crossFamilyHealthy,
    crossFamilyVerified: result.crossFamilyVerified,
    distinctProviders: result.distinctProviders,
    routeProofs: result.routeProofs,
    reviewSpendUsd: result.reviewSpendUsd,
    artifactsDir: join(baseDir, "reviewers"),
  };
}
