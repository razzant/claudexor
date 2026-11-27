import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FinalVerifyRecord,
  type GitResultRefusal,
  type WorkspaceCaptureFailure,
  type WorkspaceFilesManifest,
} from "@claudexor/schema";
import { gatesPassed, runGates, type GateSpec } from "@claudexor/review";
import {
  applyWorkspaceFiles,
  captureFailureEvidence,
  FileSpaceError,
  fileSpaceFailure,
  materializeWorkspaceBaseline,
  verifyWorkspaceFiles,
} from "@claudexor/workspace";
import { redactSecrets, sha256 } from "@claudexor/util";
import { finalVerifyBlocks, type VerifyEventLog } from "./final-verifier.js";

/** What a directory delivery adds to the shared receipt: the paths it actually
 * wrote and, for a delivery that stopped for want of room (in its verification
 * copy or at the target), the receipt's typed `refusal` (`space_insufficient`,
 * the paths it concerns). The full typed cause rides beside the receipt in
 * memory (`filesDeliverySpaceFailure`); the receipt itself stays the public one. */
export interface FilesDeliveryFacts {
  appliedPaths: string[];
  refusal?: GitResultRefusal;
}

const deliverySpaceCauses = new WeakMap<object, WorkspaceCaptureFailure>();
export function filesDeliverySpaceFailure(
  receipt: object | null | undefined,
): WorkspaceCaptureFailure | undefined {
  return receipt ? deliverySpaceCauses.get(receipt) : undefined;
}

/** The selected changes a directory delivery found the target already holding
 * (compared against this manifest by that delivery). Beside the receipt in memory,
 * as its space cause is: the receipt's own `appliedPaths` stay its writes alone. */
const deliveryHeldPaths = new WeakMap<object, readonly string[]>();
export function filesDeliveryHeldPaths(receipt: object | null | undefined): readonly string[] {
  return (receipt && deliveryHeldPaths.get(receipt)) ?? [];
}
export function withHeldPaths<T extends object>(receipt: T, held: readonly string[] = []): T {
  if (held.length > 0) deliveryHeldPaths.set(receipt, held);
  return receipt;
}

/** The receipt's typed refusal of a delivery that lacked room, its cause kept beside it. */
export function withSpaceRefusal<T extends object>(
  receipt: T,
  cause: WorkspaceCaptureFailure | undefined,
  paths: readonly string[] = [],
): T & { refusal?: GitResultRefusal } {
  if (!cause) return receipt;
  const result = {
    ...receipt,
    refusal: {
      code: "space_insufficient" as const,
      message: cause.message,
      paths: paths.slice(0, 200),
      pathCount: paths.length,
    },
  };
  deliverySpaceCauses.set(result, cause);
  return result;
}

export interface VerifiableWorkspaceFiles {
  manifest: WorkspaceFilesManifest;
  manifestSha256: string;
  artifactRoot: string;
}

/** The typed cause of a verification that stopped for want of room. The record is
 * the persisted `FinalVerifyRecord` (its prose stays `reason`); this rides beside
 * it in memory so the terminal that reads the record can still name the cause. */
const spaceCauses = new WeakMap<object, WorkspaceCaptureFailure>();
export function finalVerifySpaceFailure(
  record: FinalVerifyRecord | null | undefined,
): WorkspaceCaptureFailure | undefined {
  return record ? spaceCauses.get(record) : undefined;
}

/**
 * The one rule a files delivery and its check (`apply/check`) refuse by: only a
 * verification copy that was materialized may be authorized (`authorize`, an
 * accepted risk included). An unproven one (its copy ran out of room, the
 * verifier failed) or a conflict refuses with its own reason, override or not.
 */
export function filesVerifyRefusal(
  record: FinalVerifyRecord,
  authorize?: (record: FinalVerifyRecord) => string | null,
): string | null {
  if (record.applied_cleanly !== true) return record.reason ?? "file verification failed";
  return authorize ? authorize(record) : finalVerifyBlocks(record) ? "final verify failed" : null;
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
  let root: string | undefined;
  try {
    // Inside the try: a temporary directory that cannot be made is the same
    // typed verification failure as a copy that cannot fit in it.
    root = await mkdtemp(join(tmpdir(), "claudexor-verify-files-"));
    if (sha256(JSON.stringify(candidate.manifest) + "\n") !== candidate.manifestSha256)
      throw new Error("Files manifest does not match its canonical digest");
    // The blobs are read once here; the disposable copy is never flushed.
    await verifyWorkspaceFiles(candidate.manifest, candidate.artifactRoot);
    await materializeWorkspaceBaseline(root, candidate.manifest, candidate.artifactRoot, false);
    const applied = await applyWorkspaceFiles(
      root,
      candidate.manifest,
      candidate.artifactRoot,
      paths,
      { durable: false, artifactsVerified: true },
    );
    if (!applied.applied) {
      // A copy that ran out of room proved nothing either way (null, as for the
      // baseline); only an established failure to apply is a conflict (false).
      const record = done({
        applied_cleanly: applied.captureFailure ? null : false,
        reason: applied.detail,
      });
      if (applied.captureFailure) spaceCauses.set(record, applied.captureFailure);
      return record;
    }
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
  } catch (caught) {
    const error = fileSpaceFailure(caught, "final verification");
    const record = done({
      applied_cleanly: null,
      reason: redactSecrets(error instanceof Error ? error.message : String(error)),
    });
    if (error instanceof FileSpaceError) spaceCauses.set(record, captureFailureEvidence(error));
    return record;
  } finally {
    if (root) await rm(root, { recursive: true, force: true });
  }
}
