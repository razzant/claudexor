import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FinalVerifyRecord, type WorkspaceFilesManifest } from "@claudexor/schema";
import { gatesPassed, runGates, type GateSpec } from "@claudexor/review";
import {
  applyWorkspaceFiles,
  materializeWorkspaceBaseline,
  verifyWorkspaceFiles,
} from "@claudexor/workspace";
import { redactSecrets, sha256 } from "@claudexor/util";
import type { VerifyEventLog } from "./final-verifier.js";

export interface VerifiableWorkspaceFiles {
  manifest: WorkspaceFilesManifest;
  manifestSha256: string;
  artifactRoot: string;
}

/** What a verification the run's stop interrupted records: not verified, never passed. */
export const VERIFY_STOPPED = "the run was stopped during final verification";

export async function finalVerifyFiles(
  candidate: VerifiableWorkspaceFiles,
  paths: readonly string[] | undefined,
  specs: GateSpec[],
  log: VerifyEventLog,
  /** The run's stop: once it fired no gate is launched (run-deadline/1 included). */
  signal?: AbortSignal,
): Promise<FinalVerifyRecord & { base_manifest_sha256: string }> {
  const started = Date.now();
  const done = (fields: Record<string, unknown>) => ({
    ...FinalVerifyRecord.parse({ attempted: true, duration_ms: Date.now() - started, ...fields }),
    base_manifest_sha256: candidate.manifestSha256,
  });
  const root = await mkdtemp(join(tmpdir(), "claudexor-verify-files-"));
  try {
    if (sha256(JSON.stringify(candidate.manifest) + "\n") !== candidate.manifestSha256)
      throw new Error("Files manifest does not match its canonical digest");
    await verifyWorkspaceFiles(candidate.manifest, candidate.artifactRoot);
    await materializeWorkspaceBaseline(root, candidate.manifest, candidate.artifactRoot);
    const applied = await applyWorkspaceFiles(
      root,
      candidate.manifest,
      candidate.artifactRoot,
      paths,
    );
    if (!applied.applied) return done({ applied_cleanly: false, reason: applied.detail });
    if (specs.length === 0)
      return done({
        applied_cleanly: true,
        gates_passed: null,
        reason: "no deterministic gates configured",
      });
    if (signal?.aborted) return done({ applied_cleanly: null, reason: VERIFY_STOPPED });
    const gates = await runGates(specs, { cwd: root, ...(signal ? { signal } : {}) });
    if (signal?.aborted) return done({ applied_cleanly: null, reason: VERIFY_STOPPED });
    log.emit("gate.completed", { attempt_id: "final-verify", gates, passed: gatesPassed(gates) });
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
    await rm(root, { recursive: true, force: true });
  }
}
