/**
 * FinalVerifier (D12/INV-115): before a race winner becomes adoptable/
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
    // In-place single-candidate turns mutate the live tree directly; there
    // is no patch-vs-base to verify (and no base recorded).
    return FinalVerifyRecord.parse({ attempted: false, reason: "no base sha recorded for the winner envelope" });
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
