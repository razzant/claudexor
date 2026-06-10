import { realpathSync } from "node:fs";
import type { DecisionRecord, WorkProduct } from "@claudexor/schema";
import { pathGuard } from "@claudexor/policy";
import { sha256 } from "@claudexor/util";

/**
 * Single owner of the apply gate (CLAUDEXOR_BIBLE §11): apply is allowed only
 * for successful runs with a successful decision record and a patch
 * WorkProduct bound (by hash) to the original verified repo root. Both
 * surfaces (CLI `claudexor apply` and the Control API apply endpoints) MUST
 * call this instead of re-implementing the policy.
 */
export interface ApplyGateInput {
  /** Daemon job state when known; the artifact-only CLI path passes null. */
  state?: string | null;
  decision: DecisionRecord | null;
  workProduct: WorkProduct | null;
  patch: string;
  /** Repo root recorded by the run (contract/params); null when unknown. */
  originalRepoRoot: string | null;
  /** Repo the caller wants to apply into. */
  targetRepoRoot: string;
}

export function validateApplyGate(input: ApplyGateInput): string | null {
  if (input.state && input.state !== "succeeded") {
    return `run is not applyable while state is ${input.state}`;
  }
  if (!input.decision) return "decision record is required before apply";
  if (input.decision.status !== "success") return `decision status is ${input.decision.status}; refusing apply`;
  if (!input.workProduct) return "work product is required before apply";
  if (input.workProduct.kind !== "patch") return `work product kind ${input.workProduct.kind} is not applyable as a patch`;
  const recorded = input.workProduct.meta?.["patch_sha256"];
  if (typeof recorded !== "string" || recorded.length === 0) return "work product patch hash is required before apply";
  if (recorded !== sha256(input.patch)) return "patch artifact hash does not match the reviewed work product";
  if (!input.originalRepoRoot) return "run original project is unknown; refusing apply";
  try {
    if (realpathSync(input.originalRepoRoot) !== realpathSync(input.targetRepoRoot)) {
      return "target repo does not match the run's original project; refusing apply";
    }
  } catch {
    return "run original project cannot be verified; refusing apply";
  }
  // Workspace confinement (defense-in-depth on top of `git apply`): every
  // patched path must resolve INSIDE the target repo root.
  for (const path of patchPaths(input.patch)) {
    const guard = pathGuard(input.targetRepoRoot, path);
    if (!guard.allowed) return `patch path escapes the target repo: ${guard.reason}`;
  }
  return null;
}

/** Paths touched by a unified git diff (both old and new sides, excluding /dev/null). */
function patchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      const raw = line.slice(4).trim();
      if (raw === "/dev/null") continue;
      paths.add(raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw);
    }
  }
  return [...paths];
}
