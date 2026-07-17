import type { RiskLevel } from "@claudexor/schema";
import { matchAny } from "@claudexor/context";
import { sensitiveResourcePolicy } from "@claudexor/util";

/**
 * Risk is classified from typed diff/path metadata (and optional LLM judgment
 * layered on top by callers) — never from keyword regex over human text.
 */
export interface DiffMeta {
  /**
   * Every path the diff TOUCHES — including BOTH ends of a rename (G1 class,
   * security commit 4e9e2270). Pattern matching runs over this set: renaming a
   * sensitive/critical file OUT of its location is tamper exactly like editing
   * it, and matching a narrower new-side-only projection silently drops it.
   */
  changedPaths: string[];
  /**
   * How many FILES the diff changes (one per file; a rename is one). Optional:
   * defaults to `changedPaths.length` for callers with no rename ambiguity.
   * The size heuristic and its reason string are a file COUNT, so they must not
   * consume the touched set — a rename-heavy diff would report ~2x the files it
   * changed and escalate early. One owner per fact: the matcher gets the
   * touched set, the counter gets the count.
   */
  fileCount?: number;
  additions?: number;
  deletions?: number;
  protectedPaths?: string[];
}

export interface RiskAssessment {
  level: RiskLevel;
  reasons: string[];
  /** The actual changed paths that triggered this risk level (structured
   * evidence for the human gate — never reconstructed by string-matching prose). */
  matchedPaths: string[];
}

const CRITICAL_PATTERNS = [
  "**/deploy/**/prod*",
  "**/terraform/**",
  "**/.github/workflows/release*",
];
const HIGH_PATTERNS = [
  "**/auth/**",
  "**/payment*/**",
  "**/billing/**",
  "**/security/**",
  "**/migrations/**",
  "**/*migration*",
  "**/crypto/**",
  "**/.github/workflows/**",
  "**/Dockerfile",
  "**/k8s/**",
  "**/charts/**",
];
const DEP_PATTERNS = [
  "**/package.json",
  "package.json",
  "**/pnpm-lock.yaml",
  "pnpm-lock.yaml",
  "**/requirements*.txt",
  "**/Cargo.toml",
  "**/go.mod",
];

const LARGE_DIFF_FILES = 20;
const LARGE_DIFF_LINES = 500;

export function classifyRisk(meta: DiffMeta): RiskAssessment {
  const reasons: string[] = [];
  const paths = meta.changedPaths;
  const fileCount = meta.fileCount ?? paths.length;
  const churn = (meta.additions ?? 0) + (meta.deletions ?? 0);

  const protectedHit = paths.filter((p) => matchAny(p, meta.protectedPaths ?? []));
  if (protectedHit.length > 0)
    reasons.push(`touches protected paths: ${protectedHit.slice(0, 3).join(", ")}`);

  const sensitiveHit = paths.filter((p) => sensitiveResourcePolicy.classifyPath(p).sensitive);
  const domainCriticalHit = paths.filter((p) => matchAny(p, CRITICAL_PATTERNS));
  const criticalHit = [...new Set([...sensitiveHit, ...domainCriticalHit])];
  if (criticalHit.length > 0 || protectedHit.length > 0) {
    reasons.unshift(
      sensitiveHit.length > 0
        ? `sensitive resource paths: ${sensitiveHit.slice(0, 3).join(", ")}`
        : criticalHit.length > 0
          ? `critical paths: ${criticalHit.slice(0, 3).join(", ")}`
          : "protected-path change",
    );
    return {
      level: "critical",
      reasons,
      matchedPaths: [...new Set([...criticalHit, ...protectedHit])],
    };
  }

  const highHit = paths.filter((p) => matchAny(p, HIGH_PATTERNS));
  if (highHit.length > 0) {
    reasons.unshift(`high-risk paths: ${highHit.slice(0, 3).join(", ")}`);
    return { level: "high", reasons, matchedPaths: highHit };
  }

  const depHit = paths.filter((p) => matchAny(p, DEP_PATTERNS));
  const large = fileCount >= LARGE_DIFF_FILES || churn >= LARGE_DIFF_LINES;
  if (depHit.length > 0)
    reasons.push(`dependency/manifest change: ${depHit.slice(0, 2).join(", ")}`);
  if (large) reasons.push(`large diff (${fileCount} files, ${churn} lines)`);
  if (depHit.length > 0 && large) return { level: "high", reasons, matchedPaths: depHit };
  if (depHit.length > 0 || large) return { level: "medium", reasons, matchedPaths: depHit };

  if (fileCount === 0) return { level: "low", reasons: ["no file changes"], matchedPaths: [] };
  if (fileCount <= 2 && churn <= 50) {
    reasons.push(`small change (${fileCount} files, ${churn} lines)`);
    return { level: "low", reasons, matchedPaths: [] };
  }
  reasons.push(`normal change (${fileCount} files, ${churn} lines)`);
  return { level: "medium", reasons, matchedPaths: [] };
}

/** Review depth implied by risk (callers may still override). */
export function reviewDepthForRisk(level: RiskLevel): {
  reviewers: number;
  crossFamily: boolean;
  humanApproval: boolean;
} {
  switch (level) {
    case "low":
      return { reviewers: 1, crossFamily: false, humanApproval: false };
    case "medium":
      return { reviewers: 1, crossFamily: false, humanApproval: false };
    case "high":
      return { reviewers: 2, crossFamily: true, humanApproval: false };
    case "critical":
      return { reviewers: 2, crossFamily: true, humanApproval: true };
  }
}
