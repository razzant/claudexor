/**
 * The `discard` decision (POST /v2/runs/:id/decision): explicitly give up a
 * terminal run's result that is still held for the operator — a pending
 * copied-files result (INV-111) or a stopped run's isolated envelope retained
 * for `continueFrom` (A9). Direct effects already in place are never undone.
 */
import { ControlRunDecisionResponse } from "@claudexor/schema";
import { releaseRetainedEnvelope, retainedSourcesOfRun } from "@claudexor/workspace";
import { readFilesWorkProduct } from "./files-work-product.js";
import { appendRunAuditEvent } from "./run-audit.js";
import { controlRunResult, markRunApplyState } from "./run-delivery-state.js";
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
