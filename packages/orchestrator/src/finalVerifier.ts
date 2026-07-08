/**
 * FinalVerifier (INV-115): before a race winner becomes adoptable/
 * applyable, its patch is applied onto a FRESH worktree at the winner's own
 * base sha and the deterministic gates re-run there. This catches the class
 * of "reviewed green in the candidate tree, broken against the real base"
 * failures (stale envelope, gate side effects) with zero model spend.
 * Deterministic-first: no model involvement; gates cost no USD, so the
 * candidate ledger is trivially respected.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FinalVerifyRecord } from "@claudexor/schema";
import { type GateSpec, gatesPassed, runGates } from "@claudexor/review";
import { applyPatchProtected, branchDelete, worktreeAdd, worktreeRemove } from "@claudexor/workspace";
import { newId, redactSecrets } from "@claudexor/util";

interface VerifiableWinner {
  baseSha?: string;
  diff: string;
}

interface VerifyEventLog {
  emit(type: "gate.completed", payload: Record<string, unknown>): unknown;
}

/** FAIL-CLOSED verdict (INV-115): an attempted verify that did not PROVE
 * applied_cleanly (false OR null/errored) or whose gates failed blocks the
 * run. One owner — race and convergence consume the same rule. */
export function finalVerifyBlocks(finalVerify: FinalVerifyRecord | null): boolean {
  return (
    finalVerify !== null &&
    finalVerify.attempted &&
    (finalVerify.applied_cleanly !== true || finalVerify.gates_passed === false)
  );
}

/** The persisted decision must AGREE with a blocked terminal: status/outcome
 * blocked, human_review recommendation, and an evidence fact naming the cause.
 * One owner for the race and convergence decision writes. */
export function blockedDecisionOverride(
  evidenceFacts: string[],
  finalVerify: FinalVerifyRecord | null,
): {
  status: "blocked";
  outcome: "blocked";
  apply_recommendation: "human_review";
  evidence_facts: string[];
} {
  const fact = finalVerifyBlocks(finalVerify)
    ? finalVerify?.applied_cleanly !== true
      ? `final verify failed: ${finalVerify?.reason ?? "patch did not survive a fresh tree at its base"}`
      : "final verify failed: deterministic gates failed on the fresh verify tree"
    : "reviewer escalated blocking NEEDS_HUMAN findings; a typed operator decision is required";
  return {
    status: "blocked",
    outcome: "blocked",
    apply_recommendation: "human_review",
    evidence_facts: [...evidenceFacts, fact],
  };
}

export async function finalVerifyPatch(
  execRoot: string,
  winner: VerifiableWinner,
  specs: GateSpec[],
  log: VerifyEventLog,
): Promise<FinalVerifyRecord> {
  const started = Date.now();
  const done = (fields: Record<string, unknown>): FinalVerifyRecord =>
    FinalVerifyRecord.parse({
      attempted: true,
      base_sha: winner.baseSha ?? null,
      duration_ms: Date.now() - started,
      ...fields,
    });
  if (!winner.baseSha) {
    // FAIL CLOSED: the in-place exemption is a CALLER-level decision (the
    // orchestrator skips in-place turns before calling). An ENVELOPE patch
    // reaching this point without a recorded base sha cannot be proven
    // against a clean base — that blocks like any other verifier error,
    // never silently bypasses INV-115.
    return FinalVerifyRecord.parse({
      attempted: true,
      applied_cleanly: null,
      reason: "no base sha recorded for the winner envelope; cannot verify against a clean base",
      duration_ms: Date.now() - started,
    });
  }
  const verifyBase = mkdtempSync(join(tmpdir(), "claudexor-verify-"));
  const verifyTree = join(verifyBase, "tree");
  const branch = `claudexor/verify-${newId("fv").slice(3)}`;
  try {
    await worktreeAdd(execRoot, verifyTree, branch, winner.baseSha);
    const applied = await applyPatchProtected(verifyTree, winner.diff);
    if (!applied.ok) {
      return done({ applied_cleanly: false, reason: applied.detail ?? "apply failed on the verify tree" });
    }
    if (specs.length === 0) {
      return done({ applied_cleanly: true, gates_passed: null, reason: "no deterministic gates configured" });
    }
    const gates = await runGates(specs, { cwd: verifyTree });
    log.emit("gate.completed", {
      attempt_id: "final-verify",
      gates: gates.map((g) => ({ id: g.id, status: g.status, exit_code: g.exit_code, duration_ms: g.duration_ms })),
      passed: gatesPassed(gates),
    });
    return done({
      applied_cleanly: true,
      gates_passed: gatesPassed(gates),
      gates: gates.map((g) => ({ id: g.id, status: g.status })),
    });
  } catch (err) {
    return done({ applied_cleanly: null, reason: redactSecrets(err instanceof Error ? err.message : String(err)) });
  } finally {
    try {
      await worktreeRemove(execRoot, verifyTree);
    } catch {
      /* best-effort */
    }
    try {
      await branchDelete(execRoot, branch);
    } catch {
      /* best-effort */
    }
    try {
      rmSync(verifyBase, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}
