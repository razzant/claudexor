import { isAbsolute, relative, resolve } from "node:path";
import { matchAny } from "@claudex/context";

/** Default commands that always require a human (never auto-run). */
export const DEFAULT_DENY_COMMANDS = ["git push --force", "git push -f", "rm -rf /", "rm -rf ~", ":(){:|:&};:"];

/** Default path globs whose changes require human approval. */
export const DEFAULT_REQUIRE_HUMAN_PATHS = [
  "**/auth/**",
  "**/payment*/**",
  "**/billing/**",
  "**/migrations/**",
  "**/secrets/**",
  "**/.github/workflows/**",
];

/** Actions that require human approval regardless of paths. */
export const HUMAN_APPROVAL_ACTIONS = ["package_publish", "production_deploy", "force_push", "data_deletion"];

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
}

export function requireHuman(
  changedPaths: string[],
  actions: string[] = [],
  patterns: string[] = DEFAULT_REQUIRE_HUMAN_PATHS,
): RequireHumanResult {
  const reasons: string[] = [];
  for (const p of changedPaths) {
    if (matchAny(p, patterns)) reasons.push(`change to ${p} requires human approval`);
  }
  for (const a of actions) {
    if (HUMAN_APPROVAL_ACTIONS.includes(a)) reasons.push(`action '${a}' requires human approval`);
  }
  return { required: reasons.length > 0, reasons };
}

export function isDeniedCommand(command: string, denyList: string[] = DEFAULT_DENY_COMMANDS): boolean {
  const norm = command.trim().replace(/\s+/g, " ");
  return denyList.some((d) => norm === d || norm.startsWith(d + " ") || norm.includes(d));
}
