import { projectionRead } from "./projection-context.js";
import { requiredGateSpecsFromTaskArtifact } from "./task-contract-gates.js";
import {
  type ApplyGateInput,
  deriveApplyEligibility,
  validateApplyGate,
  verifyAndDeliver,
} from "@claudexor/delivery";
import {
  DecisionRecord,
  WorkProduct,
  type ApplyEligibility,
  type ControlApplyCheckRequest,
  type ControlApplyRequest,
  type FinalVerifyRecord,
} from "@claudexor/schema";
import { noProjectRepoRoot } from "@claudexor/util";
import {
  paramsRecord,
  type DaemonRunRecord,
  type ControlOperatorDecisionRecord,
} from "./run-record.js";
import {
  readStructured,
  readRawTextArtifact,
  safeReadStructuredArtifact,
} from "./run-artifact-read.js";
import { effectiveTerminalFacts, expectedRunFacts } from "./run-facts-projection.js";
import { controlRunResult } from "./run-delivery-state.js";
import { runExecutionRoot } from "./run-execution-root.js";
import { readFilesWorkProduct } from "./files-work-product.js";
import * as exactPatch from "./run-exact-patch.js";
/** Decisions bind exact content, including on a bounded history receipt. */
export function validRunOperatorDecision(
  rec: DaemonRunRecord,
  decision: ControlOperatorDecisionRecord | null,
  maxBytes?: number,
) {
  if (!decision) return null;
  return decision.patchSha256 ===
    exactPatch.runPatchDigest(rec, runRepoRoot(rec, maxBytes), maxBytes)
    ? decision
    : null;
}
export function runRepoRoot(rec: DaemonRunRecord, maxBytes?: number): string | null {
  return projectionRead(rec.runDir ?? rec.id, `repo-root:${maxBytes ?? "all"}`, () =>
    runRepoRootUncached(rec, maxBytes),
  );
}

function runRepoRootUncached(rec: DaemonRunRecord, maxBytes?: number): string | null {
  const p = paramsRecord(rec);
  const scope = p["scope"];
  if (scope && typeof scope === "object" && !Array.isArray(scope)) {
    const s = scope as Record<string, unknown>;
    if (s["kind"] === "project" && typeof s["root"] === "string") return s["root"];
    if (s["kind"] === "none") return noProjectRepoRoot();
  }
  let task: unknown = null;
  try {
    task = readStructured(readRawTextArtifact(rec, "context/task.yaml", maxBytes), ".yaml", {
      parse: (value: unknown) => value,
    });
  } catch (error) {
    if (maxBytes !== undefined && (error as { status?: number }).status === 503) throw error;
    task = null;
  }
  if (task && typeof task === "object" && !Array.isArray(task)) {
    const repo = (task as Record<string, unknown>)["repo"];
    if (repo && typeof repo === "object" && !Array.isArray(repo)) {
      const root = (repo as Record<string, unknown>)["root"];
      if (typeof root === "string") return root;
    }
  }
  return null;
}

export function applyGateInputFor(
  rec: DaemonRunRecord,
  patch: string,
  targetRepoRoot: string,
  operatorDecision: ControlOperatorDecisionRecord | null,
  maxBytes?: number,
): ApplyGateInput {
  const files = readFilesWorkProduct(rec, maxBytes);
  const decision = safeReadStructuredArtifact(
    rec,
    "arbitration/decision.yaml",
    DecisionRecord,
    maxBytes,
  );
  const terminal = effectiveTerminalFacts(
    rec.runDir,
    decision?.facts ?? null,
    decision,
    expectedRunFacts(rec),
    maxBytes,
  );
  return {
    state: rec.state,
    decision: terminal.decision,
    workProduct: safeReadStructuredArtifact(rec, "final/work_product.yaml", WorkProduct, maxBytes),
    patch,
    gitResult: exactPatch.runGitResult(rec, maxBytes),
    ...(files ? { filesManifest: files.manifest, manifestSha256: files.manifestSha256 } : {}),
    originalRepoRoot: runExecutionRoot(rec, runRepoRoot(rec, maxBytes)),
    targetRepoRoot,
    operatorDecision: operatorDecision
      ? {
          action: operatorDecision.action,
          ...(files
            ? { manifest_sha256: operatorDecision.patchSha256 }
            : { patch_sha256: operatorDecision.patchSha256 }),
        }
      : null,
    // Effective mutable delivery/apply state from the SAME owner that projects
    // summary.result.applyState (delivery_state overlay → work_product snapshot):
    // an already-applied / reverted run gets a terminal eligibility disposition
    // instead of a stale "rerun a fresh check" (QA-021).
    applyState: controlRunResult(rec, maxBytes).applyState,
    // D-16 work_state veto (INV-116): thread the model-attested work outcome
    // (the canonical terminal facts) so the gate refuses a needs_input/
    // incomplete winner even with a clean legacy review.
    workState: terminal.outcomeFacts?.work_state ?? null,
  };
}

export function applyEligibilityFor(
  rec: DaemonRunRecord,
  operatorDecision: ControlOperatorDecisionRecord | null,
  maxBytes?: number,
): ApplyEligibility | null {
  const root = runExecutionRoot(rec, runRepoRoot(rec, maxBytes));
  const { patch, unavailable } = exactPatch.resolveRunPatch(
    rec,
    runRepoRoot(rec, maxBytes),
    maxBytes,
  );
  const files = readFilesWorkProduct(rec, maxBytes);
  // An object result is applyable by its trees, whether or not a view was rendered.
  const result = files ? null : exactPatch.runGitResult(rec, maxBytes);
  if (
    result
      ? result.base_tree === result.candidate_tree
      : !files && (patch === null || patch.trim() === "")
  )
    return null;
  if (!root) return null;
  return deriveApplyEligibility({
    ...applyGateInputFor(rec, patch ?? "", root, operatorDecision, maxBytes),
    // The exact view of an object result is optional; its objects are the exact bytes.
    exactPatchUnavailable: result ? false : unavailable,
  });
}

export function readPatch(rec: DaemonRunRecord): string | null {
  return exactPatch.readExactRunPatch(rec, runRepoRoot(rec));
}

export function applyTargetRoot(
  target: ControlApplyCheckRequest["target"] | ControlApplyRequest["target"],
  rec: DaemonRunRecord,
): string | null {
  if (target.kind === "project") return target.root;
  return runExecutionRoot(rec, runRepoRoot(rec));
}

/** Project the run record into the delivery package's single-owner apply gate. */
export function applyGateError(
  rec: DaemonRunRecord,
  patch: string,
  targetRepoRoot: string,
  operatorDecision: ControlOperatorDecisionRecord | null,
  finalVerify?: FinalVerifyRecord,
): string | null {
  return validateApplyGate({
    ...applyGateInputFor(rec, patch, targetRepoRoot, operatorDecision),
    ...(finalVerify ? { finalVerify } : {}),
  });
}

export function gateSpecsForRun(
  rec: DaemonRunRecord,
): NonNullable<Parameters<typeof verifyAndDeliver>[3]> {
  let raw: string | null = null;
  try {
    raw = readRawTextArtifact(rec, "context/task.yaml");
  } catch {
    // The shared parser maps unreadable authority to the same typed refusal.
  }
  return requiredGateSpecsFromTaskArtifact(raw);
}
