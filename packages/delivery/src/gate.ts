import { realpathSync } from "node:fs";
import type {
  ApplyEligibility,
  DecisionRecord,
  FinalVerifyRecord,
  RunApplyState,
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
  /**
   * The run's effective MUTABLE delivery/apply state (delivery_state overlay →
   * work_product snapshot), threaded in by the same owner that projects
   * `summary.result.applyState` (QA-021). When a change is already in the live
   * tree (`applied` / `applied_review_blocked`) or was deliberately reverted,
   * apply is no longer the pending action and the eligibility projection must
   * answer a terminal disposition BEFORE the pre-delivery gate — never "rerun a
   * fresh check" for finished work. Absent/`not_applied` runs the normal gate.
   */
  applyState?: RunApplyState | null;
}

/**
 * Honest, axes-specific guidance for why a run is not applyable and what
 * actually unblocks it (D8). The operator risk override (accept_risk /
 * override_needs_human) unblocks ONLY a needs-decision run — review blocked or
 * checks failed (CLAUDEXOR_BIBLE §11) — so never point an operator at a
 * decision the daemon will refuse (a not-verified run needs a gate/review, not
 * a risk override). Keyed on the decision facts when present.
 */
function applyHint(decision: DecisionRecord | null, lifecycle: string | null): string {
  const facts = decision?.facts ?? null;
  if (facts) {
    if (facts.review === "blocked" || facts.checks === "failed") {
      // A blocked run already completed its (verified) review — pointing back at
      // "run a review first" is a dead loop (QA-032B). The real next step is the
      // typed risk override; the fresh final check then runs at apply time.
      return "Accept the risk to apply it anyway (`claudexor decision <run> --accept-risk`).";
    }
    if (facts.review === "not_run" || facts.checks === "not_configured") {
      return "Add a test check or get a clean cross-family review, then re-run. (Accepting the risk only unblocks a change that was reviewed and blocked.)";
    }
    if (facts.noChanges) return "This run made no changes, so there is nothing to apply.";
  }
  if (lifecycle && lifecycle !== "succeeded") {
    return "Re-run until the change finishes successfully.";
  }
  return "Re-run until the change finishes successfully.";
}

/** A terminal is a needs-decision block (accepted review blockers or failed
 * checks) when its axes say so — the axes replacement for state==="blocked". */
function isNeedsDecision(decision: DecisionRecord | null): boolean {
  const facts = decision?.facts;
  return !!facts && (facts.review === "blocked" || facts.checks === "failed");
}

/**
 * A valid, hash-bound operator risk override (INV-111, Bible §11): meaningful
 * ONLY on a needs-decision run (review blocked / checks failed) and only when
 * the recorded decision hash matches the exact patch artifact — a typed,
 * server-owned unblock, never client-faked state.
 */
function hasValidRiskOverride(input: ApplyGateInput): boolean {
  const d = input.operatorDecision;
  return (
    isNeedsDecision(input.decision) &&
    !!d &&
    (d.action === "accept_risk" || d.action === "override_needs_human") &&
    typeof d.patch_sha256 === "string" &&
    d.patch_sha256 === sha256(input.patch)
  );
}

/**
 * QA-032: a review-blocked run skips FinalVerifier BY CONSTRUCTION, so its
 * persisted `final_verify` is null. When a hash-bound risk override authorizes
 * this exact patch, the fresh final check runs JUST-IN-TIME at apply (the apply
 * route supplies a fresh `finalVerify` to this same gate). For the READ-ONLY
 * projection (GET /runs/:id, /apply/check — no `finalVerify` supplied) the gate
 * must therefore NOT dead-end on the missing persisted verifier; it reports the
 * change as deliverable, gated by the JIT verify, so the only affordance that
 * can produce a green verify is not hidden behind an unsatisfiable verdict.
 */
function isOverrideVerifyPending(input: ApplyGateInput): boolean {
  // At apply time the caller supplies the fresh finalVerify; the real result is
  // then gated normally (a mechanical conflict still fails closed).
  if (input.finalVerify !== undefined) return false;
  const persisted = input.decision?.final_verify ?? null;
  if (persisted?.attempted) return false;
  return hasValidRiskOverride(input);
}

export function validateApplyGate(input: ApplyGateInput): string | null {
  // An operator risk override is meaningful ONLY on a needs-decision run —
  // review blocked or checks failed (INV-111, Bible §11): the decision
  // endpoint records decisions exclusively for such runs, so any other
  // combination this gate must not honor either. Evidence lives on the
  // persisted decision facts (the orchestrator stamps review=blocked /
  // checks=failed whenever the run terminal is a needs-decision block).
  const facts = input.decision?.facts ?? null;
  const override = hasValidRiskOverride(input);
  if (input.state && input.state !== "succeeded" && !override) {
    // Plain human message (F5); the machine axes stay on the decision facts /
    // ApplyEligibility.state that callers read alongside this string.
    return `This change can't be applied yet — the run is still ${input.state}. ${applyHint(input.decision, input.state)}`;
  }
  if (!input.decision) return "A completed run is required before this change can be applied.";
  // Apply requires a succeeded lifecycle with an APPROVED review and checks
  // not failed (INV-112 verification-basis rules unchanged).
  const applyable =
    facts?.lifecycle === "succeeded" && facts.review === "approved" && facts.checks !== "failed";
  if (!applyable && !override) {
    // Jargon soup rewritten to plain language (F5). The raw axes (lifecycle,
    // review, checks) remain the machine detail on `decision.facts` and the
    // typed `ApplyEligibility` projection — not embedded in this human line.
    return `This change isn't ready to apply yet. ${applyHint(input.decision, input.state ?? null)}`;
  }
  // FinalVerifier consumer (INV-115): a patch that FAILED to apply onto a
  // fresh tree at its own base is factually undeliverable — no operator
  // override can change that. Failed verify GATES may be overridden through
  // the same accept_risk path as any blocked run.
  const fv = input.finalVerify !== undefined ? input.finalVerify : input.decision.final_verify;
  if (!fv?.attempted) {
    // A blocked run authorized by a hash-bound override skips FinalVerifier by
    // construction; the read-only projection reports deliverable and the fresh
    // check runs at apply (QA-032). The apply path supplies `finalVerify` and so
    // never takes this branch — an unattempted fresh verify there still refuses.
    if (isOverrideVerifyPending(input)) return null;
    return "This change needs a fresh final check before it can be applied.";
  }
  if (fv.attempted) {
    if (fv.applied_cleanly === false) {
      return `This change no longer applies onto a fresh copy of the code (${fv.reason ?? "conflict"}). Re-run the task.`;
    }
    // FAIL CLOSED (INV-115): null means the verifier ERRORED — the patch was
    // never proven against a clean base. Unlike a proven conflict this is an
    // infra failure, so accept_risk may override it.
    if (fv.applied_cleanly === null && !override) {
      return `We couldn't confirm this change applies onto a fresh copy (${fv.reason ?? "verification error"}). Accept the risk to apply anyway, or re-run.`;
    }
    if (fv.gates_passed === false && !override) {
      return "The checks failed when re-run on a fresh copy of the code. Accept the risk to apply anyway, or fix and re-run.";
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
  // Terminal delivery disposition (QA-021), checked BEFORE the pre-delivery
  // gate: once a run's change is already in the live tree — or was deliberately
  // reverted — apply is no longer the pending action. Deriving eligibility from
  // the pre-delivery gate here would tell an operator/agent to "run a fresh
  // final check" or "re-run" for finished work (an in-place winner honestly
  // carries final_verify:null). The effective RunApplyState is the authority;
  // the review outcome for `applied_review_blocked` lives on the outcome banner
  // and the separate Revert affordance, not on this apply verdict.
  const applyState = input.applyState ?? null;
  if (applyState === "applied" || applyState === "applied_review_blocked") {
    return {
      eligible: false,
      state: "already_applied",
      reason: "This change is already applied.",
      requiredAction: null,
    };
  }
  if (applyState === "reverted") {
    return {
      eligible: false,
      state: "reverted",
      reason: "This change was reverted.",
      requiredAction: null,
    };
  }
  const reason = validateApplyGate(input);
  // The eligibility `state` is a coarse apply classification (not a run state):
  // ok / needs_review / not_verified / no_changes, projected from the axes.
  const facts = input.decision?.facts ?? null;
  const state = !facts
    ? (input.state ?? null)
    : facts.review === "blocked" || facts.checks === "failed"
      ? "needs_review"
      : facts.review === "not_run" || facts.checks === "not_configured"
        ? "not_verified"
        : facts.noChanges
          ? "no_changes"
          : "ok";
  if (reason === null) {
    // A hash-bound risk override on a blocked run whose FinalVerifier was
    // skipped by construction is eligible; the fresh final check runs at apply
    // time (QA-032). Surface a typed verify-pending state so surfaces can offer
    // Apply with an honest "a fresh check will run before mutation" caveat
    // rather than a dead end that hides the only verifier trigger.
    if (isOverrideVerifyPending(input)) {
      return { eligible: true, state: "verify_pending", reason: null, requiredAction: null };
    }
    return { eligible: true, state, reason: null, requiredAction: null };
  }
  return {
    eligible: false,
    state,
    reason,
    requiredAction: applyHint(input.decision, input.state ?? null),
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
