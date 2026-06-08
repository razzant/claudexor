import type { RiskLevel } from "@claudexor/schema";
import { matchAny } from "@claudexor/context";

/**
 * Risk is classified from typed diff/path metadata (and optional LLM judgment
 * layered on top by callers) — never from keyword regex over human text.
 */
export interface DiffMeta {
  changedPaths: string[];
  additions?: number;
  deletions?: number;
  protectedPaths?: string[];
}

export interface RiskAssessment {
  level: RiskLevel;
  reasons: string[];
}

const CRITICAL_PATTERNS = [
  "**/secrets/**",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/credentials*",
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
  const churn = (meta.additions ?? 0) + (meta.deletions ?? 0);

  const protectedHit = paths.filter((p) => matchAny(p, meta.protectedPaths ?? []));
  if (protectedHit.length > 0) reasons.push(`touches protected paths: ${protectedHit.slice(0, 3).join(", ")}`);

  const criticalHit = paths.filter((p) => matchAny(p, CRITICAL_PATTERNS));
  if (criticalHit.length > 0 || protectedHit.length > 0) {
    reasons.unshift(
      criticalHit.length > 0
        ? `critical paths: ${criticalHit.slice(0, 3).join(", ")}`
        : "protected-path change",
    );
    return { level: "critical", reasons };
  }

  const highHit = paths.filter((p) => matchAny(p, HIGH_PATTERNS));
  if (highHit.length > 0) {
    reasons.unshift(`high-risk paths: ${highHit.slice(0, 3).join(", ")}`);
    return { level: "high", reasons };
  }

  const depHit = paths.filter((p) => matchAny(p, DEP_PATTERNS));
  const large = paths.length >= LARGE_DIFF_FILES || churn >= LARGE_DIFF_LINES;
  if (depHit.length > 0) reasons.push(`dependency/manifest change: ${depHit.slice(0, 2).join(", ")}`);
  if (large) reasons.push(`large diff (${paths.length} files, ${churn} lines)`);
  if (depHit.length > 0 && large) return { level: "high", reasons };
  if (depHit.length > 0 || large) return { level: "medium", reasons };

  if (paths.length === 0) return { level: "low", reasons: ["no file changes"] };
  if (paths.length <= 2 && churn <= 50) {
    reasons.push(`small change (${paths.length} files, ${churn} lines)`);
    return { level: "low", reasons };
  }
  reasons.push(`normal change (${paths.length} files, ${churn} lines)`);
  return { level: "medium", reasons };
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
