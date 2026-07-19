/** Delivery-owned FinalVerifier (INV-115). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FinalVerifyRecord, makeOutcomeFacts, type RunOutcomeFacts } from "@claudexor/schema";
import { type GateSpec, gatesPassed, runGates } from "@claudexor/review";
import {
  applyPatchProtected,
  branchDelete,
  worktreeAdd,
  worktreeRemove,
} from "@claudexor/workspace";
import { newId, redactSecrets } from "@claudexor/util";

export interface VerifiablePatch {
  baseSha?: string;
  diff: string;
}

export interface VerifyEventLog {
  emit(type: "gate.completed", payload: Record<string, unknown>): unknown;
}

export function finalVerifyBlocks(finalVerify: FinalVerifyRecord | null): boolean {
  return (
    finalVerify !== null &&
    finalVerify.attempted &&
    (finalVerify.applied_cleanly !== true || finalVerify.gates_passed === false)
  );
}

/** The D8 facts override a persisted decision adopts when its terminal is a
 * needs-decision block: a final-verify failure lands on the CHECKS axis
 * (checks=failed, reason checks_failed); a NEEDS_HUMAN review escalation lands
 * on the REVIEW axis (review=blocked, reason review_blocked). Lifecycle stays
 * succeeded — the process finished; a human decision is what is pending. */
export function blockedDecisionOverride(
  evidenceFacts: string[],
  finalVerify: FinalVerifyRecord | null,
): {
  facts: RunOutcomeFacts;
  apply_recommendation: "human_review";
  verification_basis: "none";
  evidence_facts: string[];
} {
  const verifyBlocked = finalVerifyBlocks(finalVerify);
  const fact = verifyBlocked
    ? finalVerify?.applied_cleanly !== true
      ? `final verify failed: ${finalVerify?.reason ?? "patch did not survive a fresh tree at its base"}`
      : "final verify failed: deterministic gates failed on the fresh verify tree"
    : "reviewer escalated blocking NEEDS_HUMAN findings; a typed operator decision is required";
  return {
    facts: verifyBlocked
      ? makeOutcomeFacts("succeeded", { checks: "failed", reason: "checks_failed" })
      : makeOutcomeFacts("succeeded", { review: "blocked", reason: "review_blocked" }),
    apply_recommendation: "human_review",
    verification_basis: "none",
    evidence_facts: [...evidenceFacts, fact],
  };
}

export async function finalVerifyPatch(
  execRoot: string,
  candidate: VerifiablePatch,
  specs: GateSpec[],
  log: VerifyEventLog,
): Promise<FinalVerifyRecord> {
  const started = Date.now();
  const done = (fields: Record<string, unknown>): FinalVerifyRecord =>
    FinalVerifyRecord.parse({
      attempted: true,
      base_sha: candidate.baseSha ?? null,
      duration_ms: Date.now() - started,
      ...fields,
    });
  if (!candidate.baseSha) {
    return FinalVerifyRecord.parse({
      attempted: true,
      applied_cleanly: null,
      reason: "no base sha recorded for the patch; cannot verify against a clean base",
      duration_ms: Date.now() - started,
    });
  }
  const verifyBase = mkdtempSync(join(tmpdir(), "claudexor-verify-"));
  const verifyTree = join(verifyBase, "tree");
  const branch = `claudexor/verify-${newId("fv").slice(3)}`;
  try {
    await worktreeAdd(execRoot, verifyTree, branch, candidate.baseSha);
    const applied = await applyPatchProtected(verifyTree, candidate.diff);
    if (!applied.ok) {
      return done({
        applied_cleanly: false,
        reason: applied.detail ?? "apply failed on the verify tree",
      });
    }
    if (specs.length === 0) {
      return done({
        applied_cleanly: true,
        gates_passed: null,
        reason: "no deterministic gates configured",
      });
    }
    const gates = await runGates(specs, { cwd: verifyTree });
    log.emit("gate.completed", {
      attempt_id: "final-verify",
      gates: gates.map((gate) => ({
        id: gate.id,
        status: gate.status,
        exit_code: gate.exit_code,
        duration_ms: gate.duration_ms,
      })),
      passed: gatesPassed(gates),
    });
    return done({
      applied_cleanly: true,
      gates_passed: gatesPassed(gates),
      gates: gates.map((gate) => ({ id: gate.id, status: gate.status })),
    });
  } catch (error) {
    return done({
      applied_cleanly: null,
      reason: redactSecrets(error instanceof Error ? error.message : String(error)),
    });
  } finally {
    try {
      await worktreeRemove(execRoot, verifyTree);
    } catch {
      // Best-effort cleanup; startup GC owns crash debris.
    }
    try {
      await branchDelete(execRoot, branch);
    } catch {
      // Best-effort cleanup; startup GC owns crash debris.
    }
    rmSync(verifyBase, { recursive: true, force: true });
  }
}
