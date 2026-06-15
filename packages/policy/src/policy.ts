import { isAbsolute, relative, resolve } from "node:path";
import { matchAny } from "@claudexor/context";

/** Default path globs whose changes require human approval. */
export const DEFAULT_REQUIRE_HUMAN_PATHS = [
  "**/auth/**",
  "**/payment*/**",
  "**/billing/**",
  "**/migrations/**",
  "**/secrets/**",
  "**/.github/workflows/**",
];

export interface PathGuardResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Confine writes to the workspace root (defense-in-depth on top of the native
 * harness sandbox). Ported in spirit from Ouroboros' make_path_guard.
 */
export function pathGuard(workspaceRoot: string, targetPath: string): PathGuardResult {
  const root = resolve(workspaceRoot);
  const target = isAbsolute(targetPath) ? resolve(targetPath) : resolve(root, targetPath);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return { allowed: false, reason: `write to '${targetPath}' resolves outside workspace '${workspaceRoot}'` };
  }
  return { allowed: true };
}

export interface RequireHumanResult {
  required: boolean;
  reasons: string[];
  /** The changed paths that matched a human-approval pattern (structured evidence,
   * never reconstructed by substring-matching the reason prose). */
  matchedPaths: string[];
}

export function requireHuman(
  changedPaths: string[],
  patterns: string[] = DEFAULT_REQUIRE_HUMAN_PATHS,
): RequireHumanResult {
  const reasons: string[] = [];
  const matchedPaths: string[] = [];
  for (const p of changedPaths) {
    if (matchAny(p, patterns)) {
      reasons.push(`change to ${p} requires human approval`);
      matchedPaths.push(p);
    }
  }
  return { required: reasons.length > 0, reasons, matchedPaths };
}
