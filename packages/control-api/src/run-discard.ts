/**
 * The `discard` decision (POST /v2/runs/:id/decision): explicitly give up a
 * terminal run's result that is still held for the operator — a pending
 * copied-files result (INV-111) or a stopped run's isolated envelope retained
 * for `continueFrom` (A9). Direct effects already in place are never undone.
 */
import {
  ControlRunDecisionResponse,
  RunResumable,
  WorkProduct,
  type RunTakenReason,
} from "@claudexor/schema";
import { releaseRetainedEnvelope, retainedSourcesOfRun } from "@claudexor/workspace";
import { readFilesWorkProduct } from "./files-work-product.js";
import { appendRunAuditEvent } from "./run-audit.js";
import {
  controlRunResult,
  markRunApplyState,
  markRunTaken,
  readDeliveryState,
} from "./run-delivery-state.js";
import { safeReadStructuredArtifact } from "./run-artifact-read.js";
import type { DaemonRunRecord } from "./run-record.js";
import { TERMINAL_STATES } from "./sse-shared.js";

export async function discardRunResult(rec: DaemonRunRecord): Promise<ControlRunDecisionResponse> {
  // Strict read: an unreadable or invalid source address or custody record is
  // this decision's own failure (reported to the caller before anything is
  // released), never "nothing held" and never a partial discard of the
  // readable sources only.
  const terminal = TERMINAL_STATES.has(rec.state);
  const sources =
    terminal && rec.runDir && rec.runId ? retainedSourcesOfRun(rec.runDir, rec.runId) : [];
  // One run can hold both: a best-of directory run keeps a refused candidate's
  // copy beside its winner's pending files. The decision gives up everything held.
  const files = readFilesWorkProduct(rec);
  const state = controlRunResult(rec).applyState;
  const pendingFiles =
    terminal &&
    files?.manifest.isolation === "envelope" &&
    (state === "not_applied" || state === "discarded")
      ? files
      : null;
  if (!sources.length && !pendingFiles)
    throw Object.assign(
      new Error(
        "Only an unapplied copied files result or a kept stopped run can be discarded; direct effects remain in place",
      ),
      { status: 409 },
    );
  // The single-write files flip first; a source release that then fails leaves
  // the rest held and reported, and repeating the decision finishes it.
  if (pendingFiles) markRunApplyState(rec, "discarded", undefined, true);
  const released: string[] = [];
  try {
    for (const source of sources) {
      await releaseRetainedEnvelope(source);
      released.push(source.envelope.worktree_path);
    }
  } finally {
    appendRunAuditEvent(rec, "control.applied", {
      decision: "discard",
      ...(released.length ? { retained_envelopes: released } : {}),
      ...(pendingFiles ? { manifest_sha256: pendingFiles.manifestSha256 } : {}),
    });
  }
  // Only a continuable source has a continuation to speak of; a capture-refused
  // copy was kept for inspection only. Release ends custody first and its file
  // removal is best-effort, so nothing here claims the files are gone.
  const kept = sources.some((source) => source.continuation_eligible !== false)
    ? "Stopped work discarded: custody of its kept source envelopes was released (file cleanup is best-effort). A continuation starts from the project base."
    : "Custody of the kept source copies for inspection was released (file cleanup is best-effort); nothing was applied or reverted.";
  const pending = "Pending file application discarded; retained result follows normal retention.";
  return ControlRunDecisionResponse.parse({
    accepted: true,
    status: "discarded",
    message: !pendingFiles ? kept : sources.length ? `${kept} ${pending}` : pending,
  });
}

function refuseTaken(
  code: "run_taken_non_terminal" | "run_taken_continuable" | "run_taken_not_patch",
  reason: "non_terminal" | "continuable" | "not_patch",
  message: string,
): never {
  throw Object.assign(new Error(message), {
    status: 409,
    code,
    retryable: false,
    context: { reason },
  });
}

/** A caller-owned capture acknowledges a terminal patch without deleting the
 * engine artifact. The mutable delivery overlay makes this idempotent and lets
 * ordinary age/keep-last retention retire it later. */
export async function takeRunResult(
  rec: DaemonRunRecord,
  reason: RunTakenReason = "captured_result",
): Promise<ControlRunDecisionResponse> {
  if (!TERMINAL_STATES.has(rec.state))
    refuseTaken(
      "run_taken_non_terminal",
      "non_terminal",
      "Only a terminal run's patch result can be acknowledged as taken",
    );

  const alreadyTaken = readDeliveryState(rec);
  if (alreadyTaken?.takenAt) {
    return ControlRunDecisionResponse.parse({
      accepted: true,
      status: "taken",
      message:
        "Run result acknowledged as taken; the engine copy remains available until ordinary retention removes it.",
    });
  }

  const sources = rec.runDir && rec.runId ? retainedSourcesOfRun(rec.runDir, rec.runId) : [];
  const resumable = safeReadStructuredArtifact(rec, "final/resumable.yaml", RunResumable);
  if (resumable || sources.some((source) => source.continuation_eligible !== false))
    refuseTaken(
      "run_taken_continuable",
      "continuable",
      "A continuable run must be continued or discarded before its result can be acknowledged as taken",
    );

  const workProduct = safeReadStructuredArtifact(rec, "final/work_product.yaml", WorkProduct);
  const resultKind = workProduct?.meta["result_kind"];
  if (
    !workProduct ||
    workProduct.kind !== "patch" ||
    (resultKind !== undefined && resultKind !== "patch")
  )
    refuseTaken(
      "run_taken_not_patch",
      "not_patch",
      "Only a terminal patch result can be acknowledged as taken",
    );

  markRunTaken(rec, reason);
  appendRunAuditEvent(rec, "control.applied", {
    decision: "taken",
    reason,
  });
  return ControlRunDecisionResponse.parse({
    accepted: true,
    status: "taken",
    message:
      "Run result acknowledged as taken; the engine copy remains available until ordinary retention removes it.",
  });
}
