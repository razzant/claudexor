/**
 * Scoped DIFF review: review a caller-supplied diff (e.g. a staged
 * commit) with the resolved reviewer panel — the same reviewCandidate
 * machinery race candidates use, no run/envelope. The engine owns reviewer
 * resolution, evidence packaging, revalidation, and typed results; the CLI
 * verb stays a thin surface.
 */
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AuthPreference, ProviderFamily, ReviewFinding } from "@claudexor/schema";
import { HarnessUnavailableError, runCapture, runCaptureRaw } from "@claudexor/core";
import { revalidateFindings, type ReviewerSpec, type reviewCandidate } from "@claudexor/review";
import { verifySealedEvidencePacket, writeEvidencePacket } from "@claudexor/context";
import { containsSecretLikeToken, redactSecrets } from "@claudexor/util";

export interface FrozenDiffReviewInput {
  evidenceDir: string;
  artifactsDir: string;
  candidateSha: string;
  candidateTree: string;
  packetManifestSha256: string;
}

export interface DiffReviewInput {
  repoRoot: string;
  diff?: string;
  userIntent?: string;
  tests?: string;
  decidedTradeoffs?: string;
  frozen?: FrozenDiffReviewInput;
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
  if (input.frozen && input.diff !== undefined) {
    throw new Error("reviewDiff: frozen review consumes DIFF.patch from the sealed packet");
  }
  if (!input.frozen && !input.diff?.trim()) {
    throw new Error("reviewDiff: the diff is empty — nothing to review");
  }
  const frozen = input.frozen
    ? await verifyFrozenReviewPacket(input.repoRoot, input.frozen, true)
    : undefined;
  const diff = frozen?.diff ?? input.diff ?? "";
  // INV-062: raw secrets must never become review artifacts. The fence lives
  // HERE so every caller (CLI verb, commit gate, future surfaces) is covered
  // before any evidence write or reviewer call — and it covers EVERY
  // artifact-bound string, not just the diff.
  for (const [label, text] of [
    ["diff", diff],
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
  const baseDir = input.frozen
    ? undefined
    : join(deps.execRootOf(input.repoRoot), ".claudexor", "reviews", `diff-${stamp}`);
  const evidenceDir = frozen?.evidenceDir ?? join(baseDir!, "evidence");
  const artifactsDir = input.frozen?.artifactsDir ?? join(baseDir!, "reviewers");
  if (!input.frozen) {
    writeEvidencePacket(evidenceDir, {
      userIntent: redactSecrets(
        input.userIntent ?? "Review this staged diff for defects before commit.",
      ),
      diff,
      tests: input.tests ?? "(no test evidence supplied)",
      decidedTradeoffs: input.decidedTradeoffs,
    });
  }
  const result = await deps.reviewScoped({
    candidateLabel: input.frozen ? "Frozen candidate" : "Staged diff",
    diff,
    evidenceDir,
    artifactsDir,
    evidenceReadOnly: input.frozen !== undefined,
    ...(frozen
      ? {
          frozenIdentity: {
            candidateSha: input.frozen!.candidateSha,
            candidateTree: input.frozen!.candidateTree,
            packetManifestSha256: frozen.manifestSha256,
          },
        }
      : {}),
    cwd: input.repoRoot,
    reviewers,
    envInheritance: deps.envInheritance(input.repoRoot),
    signal: input.signal,
    onReviewerEvent: input.onReviewerEvent
      ? (event) => input.onReviewerEvent?.({ ...event })
      : undefined,
  });
  if (input.frozen) {
    await verifyFrozenReviewPacket(input.repoRoot, input.frozen, false);
  }
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
    artifactsDir,
  };
}

interface VerifiedFrozenPacket {
  evidenceDir: string;
  diff: string;
  manifestSha256: string;
}

async function verifyFrozenReviewPacket(
  repoRootInput: string,
  frozen: FrozenDiffReviewInput,
  artifactsMustNotExist: boolean,
): Promise<VerifiedFrozenPacket> {
  const repoRoot = realpathSync(repoRootInput);
  const evidenceDir = realpathSync(frozen.evidenceDir);
  const artifactsDir = resolve(frozen.artifactsDir);
  if (artifactsMustNotExist && existsSync(artifactsDir)) {
    throw new Error("reviewDiff: reviewer artifacts directory already exists");
  }
  if (isWithin(repoRoot, evidenceDir)) {
    throw new Error("reviewDiff: frozen evidence directory must be outside the candidate tree");
  }
  if (isWithin(repoRoot, artifactsDir)) {
    throw new Error("reviewDiff: reviewer artifacts directory must be outside the candidate tree");
  }
  if (isWithin(evidenceDir, artifactsDir) || isWithin(artifactsDir, evidenceDir)) {
    throw new Error(
      "reviewDiff: sealed evidence and reviewer artifacts directories must not overlap",
    );
  }

  const [actualSha, actualTree, status] = await Promise.all([
    git(repoRoot, ["rev-parse", "HEAD"]),
    git(repoRoot, ["rev-parse", "HEAD^{tree}"]),
    git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  if (actualSha !== frozen.candidateSha) {
    throw new Error(
      `reviewDiff: candidate SHA mismatch (expected ${frozen.candidateSha}, got ${actualSha})`,
    );
  }
  if (actualTree !== frozen.candidateTree) {
    throw new Error(
      `reviewDiff: candidate tree mismatch (expected ${frozen.candidateTree}, got ${actualTree})`,
    );
  }
  if (status !== "") {
    throw new Error("reviewDiff: frozen candidate worktree is dirty or stale");
  }
  const packet = verifySealedEvidencePacket({
    evidenceDir,
    candidateSha: frozen.candidateSha,
    candidateTree: frozen.candidateTree,
    expectedManifestSha256: frozen.packetManifestSha256,
  });
  const actualDiff = await gitRaw(repoRoot, [
    "diff",
    "--binary",
    `${packet.baseSha}..${frozen.candidateSha}`,
  ]);
  if (packet.diff !== actualDiff) {
    throw new Error("reviewDiff: sealed DIFF.patch does not match base..candidate");
  }
  return {
    evidenceDir: packet.evidenceDir,
    diff: packet.diff,
    manifestSha256: packet.manifestSha256,
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runCapture("git", args, { cwd });
  if (result.code !== 0) {
    throw new Error(
      `reviewDiff: git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout.trim();
}

async function gitRaw(cwd: string, args: string[]): Promise<string> {
  const result = await runCaptureRaw("git", args, { cwd });
  if (result.code !== 0) {
    throw new Error(
      `reviewDiff: git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
