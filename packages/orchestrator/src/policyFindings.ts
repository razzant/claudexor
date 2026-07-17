import { matchAny } from "@claudexor/context";
import {
  classifyRisk,
  DEFAULT_REQUIRE_HUMAN_PATHS,
  requireHuman,
  reviewDepthForRisk,
} from "@claudexor/policy";
import { summarizeDiffPaths as diffStats } from "@claudexor/core";
import type { ProtectedPathApproval, ReviewFinding } from "@claudexor/schema";
import { ReviewFinding as ReviewFindingSchema } from "@claudexor/schema";
import { newId } from "@claudexor/util";

/**
 * Deterministic policy findings from the typed diff (no LLM, no regex over
 * prose): protected-path changes and critical-risk diffs escalate NEEDS_HUMAN;
 * a high-risk diff without a cross-family panel escalates as well. Each
 * finding cites the matched files as evidence (BIBLE: evidence beats summaries).
 */
export function policyFindings(
  run: { diff: string },
  reviewVerified: boolean,
  protectedPaths: string[] = [],
  autoProtectedPaths: string[] = [],
  protectedPathApprovals: ProtectedPathApproval[] = [],
  denyPaths: string[] = [],
): {
  findings: ReviewFinding[];
  risk: { level: string; reasons: string[]; changedFiles: number };
} {
  const stats = diffStats(run.diff);
  // Path policy gates match stats.touchedPaths — the one owner of "what the
  // diff touches" (core diff.ts, G1 class); a gate matching a narrower
  // projection is an EXPLICIT decision, never an accident. deny_paths: ANY
  // touch of a denied glob is a violation — create, modify, delete, or
  // either end of a rename. Contract protected_paths: creating a NEW file
  // under a protected glob (or renaming into it) is tamper exactly like
  // editing an existing one. Same matcher as every other path policy
  // (INV-122).
  const denyViolation = requireHuman(stats.touchedPaths, denyPaths);
  const approvalPatterns = protectedPathApprovals.map((approval) => approval.path);
  // AUTO-protected (gate/test files) deliberately matches existingPaths
  // only: creating a new test/package file is the normal create/test-
  // authoring flow, not tamper (pinned by test) — only touching an EXISTING
  // gate input escalates.
  const unapprovedAutoProtectedPaths = stats.existingPaths.filter(
    (path) => !matchAny(path, approvalPatterns),
  );
  const specProtectedOnly = requireHuman(stats.touchedPaths, protectedPaths);
  const autoProtectedOnly = requireHuman(unapprovedAutoProtectedPaths, autoProtectedPaths);
  const protectedOnly = {
    required: specProtectedOnly.required || autoProtectedOnly.required,
    reasons: [...new Set([...specProtectedOnly.reasons, ...autoProtectedOnly.reasons])],
    matchedPaths: [
      ...new Set([...specProtectedOnly.matchedPaths, ...autoProtectedOnly.matchedPaths]),
    ],
  };
  // classifyRisk's built-in pattern sets (sensitive resources, critical/high
  // paths) are themselves a human-approval gate, so they match the TOUCHED
  // set like every other path policy — `git mv .env config/settings.txt`
  // must stay critical, and no other gate would recover it (G1 class,
  // security commit 4e9e2270). Its file COUNT is a separate fact: renames
  // touch two paths but change one file.
  const risk = classifyRisk({
    changedPaths: stats.touchedPaths,
    fileCount: stats.paths.length,
    additions: stats.additions,
    deletions: stats.deletions,
    protectedPaths: protectedOnly.matchedPaths,
  });
  const findings: ReviewFinding[] = [];
  const reviewer = {
    harness_id: "policy",
    requested_model: null,
    requested_effort: null,
    observed_model: null,
    route_proof_status: "verified" as const,
  };
  const evidenceFor = (reasons: string[]) => ({
    files: stats.touchedPaths
      .filter((p) => reasons.some((r) => r.includes(p)))
      .map((path) => ({ path, lines: null })),
  });
  // Structured matched-path evidence (never reconstructed from prose).
  const evidenceFromPaths = (paths: string[]) => ({
    files: paths.map((path) => ({ path, lines: null })),
  });
  const denyReasons = denyViolation.matchedPaths.map(
    (path) => `candidate touched denied path ${path}`,
  );
  const reportedRisk =
    protectedOnly.required || denyViolation.required
      ? {
          level: "critical" as const,
          reasons: [
            ...new Set([
              ...risk.reasons,
              ...protectedOnly.reasons,
              ...(denyViolation.required ? denyReasons : []),
            ]),
          ],
          matchedPaths: [
            ...new Set([
              ...risk.matchedPaths,
              ...protectedOnly.matchedPaths,
              ...denyViolation.matchedPaths,
            ]),
          ],
        }
      : risk;
  if (denyViolation.required) {
    // Authoritative post-diff deny gate: a BLOCK finding keeps the patch
    // undelivered (blocked); only an operator accept_risk decision may still
    // deliver it (INV-111 — the human is the final authority).
    findings.push(
      ReviewFindingSchema.parse({
        id: newId("find"),
        severity: "BLOCK",
        category: "security",
        claim: `candidate touched denied path(s) (deny_paths): ${denyViolation.matchedPaths.join(", ")}`,
        evidence: evidenceFromPaths(denyViolation.matchedPaths),
        reviewer,
        status: "accepted",
      }),
    );
  }
  if (protectedOnly.required) {
    findings.push(
      ReviewFindingSchema.parse({
        id: newId("find"),
        severity: "BLOCK",
        category: "test_gap",
        claim: `candidate changed protected path(s): ${protectedOnly.matchedPaths.join(", ")}`,
        evidence: evidenceFromPaths(protectedOnly.matchedPaths),
        reviewer,
        status: "accepted",
      }),
    );
  }
  const builtInHuman = requireHuman(stats.touchedPaths, DEFAULT_REQUIRE_HUMAN_PATHS);
  const human = {
    required: builtInHuman.required || protectedOnly.required,
    reasons: [...new Set([...builtInHuman.reasons, ...protectedOnly.reasons])],
    matchedPaths: [...new Set([...builtInHuman.matchedPaths, ...protectedOnly.matchedPaths])],
  };
  if (human.required) {
    findings.push(
      ReviewFindingSchema.parse({
        id: newId("find"),
        severity: "NEEDS_HUMAN",
        category: "security",
        claim: `protected-path change requires human approval: ${human.reasons.join("; ")}`,
        evidence: evidenceFromPaths(human.matchedPaths),
        reviewer,
        status: "accepted",
      }),
    );
  }
  const depth = reviewDepthForRisk(reportedRisk.level as never);
  if (depth.humanApproval) {
    findings.push(
      ReviewFindingSchema.parse({
        id: newId("find"),
        severity: "NEEDS_HUMAN",
        category: "security",
        claim: `critical-risk diff requires human approval: ${reportedRisk.reasons.join("; ")}`,
        evidence:
          reportedRisk.matchedPaths.length > 0
            ? evidenceFromPaths(reportedRisk.matchedPaths)
            : evidenceFor(reportedRisk.reasons),
        reviewer,
        status: "accepted",
      }),
    );
  } else if (depth.crossFamily && !reviewVerified) {
    findings.push(
      ReviewFindingSchema.parse({
        id: newId("find"),
        severity: "NEEDS_HUMAN",
        category: "architecture",
        claim: `high-risk diff requires a cross-family review panel (>=2 provider families), which is not available: ${reportedRisk.reasons.join("; ")}`,
        evidence:
          reportedRisk.matchedPaths.length > 0
            ? evidenceFromPaths(reportedRisk.matchedPaths)
            : evidenceFor(reportedRisk.reasons),
        reviewer,
        status: "accepted",
      }),
    );
  }
  return {
    findings,
    risk: {
      level: reportedRisk.level,
      reasons: reportedRisk.reasons,
      changedFiles: stats.paths.length,
    },
  };
}
