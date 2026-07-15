import { realpathSync } from "node:fs";
import type {
  ApplyEligibility,
  DecisionRecord,
  FinalVerifyRecord,
  WorkProduct,
} from "@claudexor/schema";
import { parseUnifiedDiff } from "@claudexor/core";
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
  /**
   * A persisted, auditable operator decision (arbitration/operator_decision.yaml)
   * that explicitly accepts the blocking risk for THIS patch. The override is
   * valid only when its recorded patch hash matches the artifact — a typed,
   * server-owned unblock, never client-faked state.
   */
  operatorDecision?: { action: string; patch_sha256?: string } | null;
  /** Fresh verifier result for this delivery attempt. When omitted, the
   * persisted decision result is used for read-only eligibility projection. */
  finalVerify?: FinalVerifyRecord | null;
}

/**
 * Honest, state-specific guidance for why a run is not applyable and what
 * actually unblocks it. The operator risk override (accept_risk /
 * override_needs_human) unblocks ONLY a `blocked` run (CLAUDEXOR_BIBLE §11) — so
 * never point an operator at a decision the daemon will refuse for this state
 * (a fixed contradiction: apply used to suggest accept_risk for ungated runs).
 */
function applyHint(state: string): string {
  switch (state) {
    case "blocked":
      return "an operator accept_risk/override_needs_human decision (POST /runs/:id/decision) can unblock apply for this patch";
    case "ungated":
    case "review_not_run":
      return "not verified-applyable — add a --test gate or obtain a clean cross-family review, then re-run (risk overrides apply only to blocked runs)";
    case "no_op":
      return "the run made no changes; nothing to apply";
    default:
      return "re-run to reach a successful, verified outcome";
  }
}

export function validateApplyGate(input: ApplyGateInput): string | null {
  // An operator risk override is meaningful ONLY on a BLOCKED run (INV-111,
  // Bible §11): the decision endpoint records decisions exclusively for
  // blocked runs, so a succeeded-state override is an unreachable combination
  // this gate must not honor either. Blocked evidence: the caller-known run
  // state, or — on the artifact-only CLI path where live state is unknown —
  // the persisted decision verdict (the orchestrator overrides decision.yaml
  // to `blocked` whenever the run terminal is blocked).
  const blockedEvidence =
    input.state === "blocked" || (input.state == null && input.decision?.status === "blocked");
  const override =
    blockedEvidence &&
    input.operatorDecision &&
    (input.operatorDecision.action === "accept_risk" ||
      input.operatorDecision.action === "override_needs_human") &&
    typeof input.operatorDecision.patch_sha256 === "string" &&
    input.operatorDecision.patch_sha256 === sha256(input.patch);
  if (input.state && input.state !== "succeeded" && !override) {
    return `run is not applyable while state is ${input.state}; ${applyHint(input.state)}`;
  }
  if (!input.decision) return "decision record is required before apply";
  if (input.decision.status !== "success" && !override) {
    return `decision status is ${input.decision.status}; refusing apply (${applyHint(input.decision.status)})`;
  }
  // FinalVerifier consumer (INV-115): a patch that FAILED to apply onto a
  // fresh tree at its own base is factually undeliverable — no operator
  // override can change that. Failed verify GATES may be overridden through
  // the same accept_risk path as any blocked run.
  const fv = input.finalVerify !== undefined ? input.finalVerify : input.decision.final_verify;
  if (!fv?.attempted) return "fresh final verify is required before apply";
  if (fv.attempted) {
    if (fv.applied_cleanly === false) {
      return `final verify: the patch did not apply onto a fresh tree at its base (${fv.reason ?? "conflict"}); re-run the task`;
    }
    // FAIL CLOSED (INV-115): null means the verifier ERRORED — the patch was
    // never proven against a clean base. Unlike a proven conflict this is an
    // infra failure, so accept_risk may override it.
    if (fv.applied_cleanly === null && !override) {
      return `final verify: the verifier errored before proving the patch against a clean base (${fv.reason ?? "verify infrastructure error"}); refusing apply (an operator accept_risk decision can override)`;
    }
    if (fv.gates_passed === false && !override) {
      return "final verify: deterministic gates failed on the fresh verify tree; refusing apply (an operator accept_risk decision can override)";
    }
  }
  if (!input.workProduct) return "work product is required before apply";
  if (input.workProduct.kind !== "patch")
    return `work product kind ${input.workProduct.kind} is not applyable as a patch`;
  const recorded = input.workProduct.meta?.["patch_sha256"];
  if (typeof recorded !== "string" || recorded.length === 0)
    return "work product patch hash is required before apply";
  if (recorded !== sha256(input.patch))
    return "patch artifact hash does not match the reviewed work product";
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

/**
 * Derived ApplyEligibility (the ONE producer): runs the same gate the apply
 * endpoints enforce and projects a typed verdict for surfaces (GET /runs/:id,
 * MCP structured results, CLI --json) — {eligible, state, reason,
 * requiredAction} instead of every consumer re-implying eligibility.
 */
export function deriveApplyEligibility(input: ApplyGateInput): ApplyEligibility {
  const reason = validateApplyGate(input);
  const state = input.state ?? input.decision?.status ?? null;
  if (reason === null) {
    return { eligible: true, state, reason: null, requiredAction: null };
  }
  return {
    eligible: false,
    state,
    reason,
    requiredAction: applyHint(state ?? ""),
  };
}

/** Paths touched by a unified git diff (both old and new sides, excluding /dev/null). */
function patchPaths(patch: string): string[] {
  // Shared structural parser: header lines are honored only in
  // header position, so removed CONTENT starting with `-- ` (SQL comments)
  // can never masquerade as a path and false-refuse the apply; quoted
  // non-ASCII paths are C-unquoted to their real on-disk form.
  const paths = new Set<string>();
  for (const f of parseUnifiedDiff(patch).files) {
    if (f.oldPath) paths.add(f.oldPath);
    if (f.newPath) paths.add(f.newPath);
  }
  return [...paths];
}
