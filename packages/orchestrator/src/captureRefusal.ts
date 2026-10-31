import {
  captureInventoryLines,
  makeOutcomeFacts,
  type ActiveTaskContract,
  type RunOutcomeFacts,
  type RunReason,
  type WorkspaceEnvelope,
  type WorkspaceCaptureFailure,
} from "@claudexor/schema";
import {
  captureFailureEvidence,
  envelopeBaseOf,
  readEnvelopeCustody,
  retainForInspection,
  retainForContinuation,
  type WorkspaceManager,
} from "@claudexor/workspace";
import { redactSecrets } from "@claudexor/util";

/** Incomplete capture preserves the original source; it never implies a clean tree. */
export interface CaptureRefusal {
  disposition: "discarded" | "manual_cleanup" | "retained";
  detail: string;
  phase?: "workspace" | "artifact_security";
  failure?: WorkspaceCaptureFailure;
  sourceRoot?: string;
  retentionFailure?: WorkspaceCaptureFailure;
}

/** What a capture refusal skips: the configured checks and a requested review. */
export interface SkippedVerification {
  checks: number;
  review: boolean;
}

/** The contract's checks and review intent (absent intent keeps review required). */
export function skippedVerification(
  contract: Pick<ActiveTaskContract, "tests" | "review_requested">,
): SkippedVerification {
  return { checks: contract.tests.commands.length, review: contract.review_requested !== false };
}

/** THE reason of a terminal that a capture refusal leads. */
export const CAPTURE_REFUSED_REASON: RunReason = "capture_refused";

/**
 * THE outcome owner of a terminal that a capture refusal leads: the process
 * failed with its own reason (never `workspace_unavailable`: the workspace was
 * used), and what the changes amounted to stays unknown. Every lane takes its
 * facts from here, so a different headline is one change.
 */
export function captureRefusedFacts(): RunOutcomeFacts {
  return makeOutcomeFacts("failed", { reason: CAPTURE_REFUSED_REASON, noChanges: null });
}

/** Run-summary lines for a refused capture's non-exact inventory ("" without one). */
export function captureInventorySummary(failure: WorkspaceCaptureFailure | undefined): string {
  return failure?.inventory ? `\n${captureInventoryLines(failure.inventory).join("\n")}\n` : "";
}

/** Where the kept source and a failed scratch cleanup can be inspected; a
 * terminal with its own remedy (budget, cancel) appends these instead of a retry. */
export function captureInspectionActions(refusal: CaptureRefusal | undefined): string[] {
  if (!refusal) return [];
  return [
    ...(refusal.sourceRoot
      ? [`Inspect the changed files at ${refusal.sourceRoot}`]
      : refusal.disposition === "manual_cleanup"
        ? ["Inspect the changed files in the project folder directly"]
        : []),
    ...(refusal.failure?.cleanup
      ? ["Inspect Claudexor temporary state: private scratch cleanup failed"]
      : []),
  ];
}

/** Capture happens after the executor's work, so replaying that work is never
 * the remedy: inspect what is kept and decide on it directly. */
export function captureRefusalNextActions(refusal: CaptureRefusal): string[] {
  return [
    ...captureInspectionActions(refusal),
    ...(refusal.disposition === "discarded"
      ? []
      : ["Decide on those changes yourself: Claudexor kept no exact result to apply or revert"]),
  ];
}

function captureCause(failure: WorkspaceCaptureFailure): string {
  switch (failure.code) {
    case "capture_output_exceeded":
      return `a Git output exceeded the ${failure.bufferBudgetBytes ?? "configured"}-byte capture buffer`;
    case "capture_output_incomplete":
      return "the capture output was not completely drained";
    case "capture_preview_truncated":
      return "only a clipped preview of the changes could be read";
    case "capture_space_insufficient":
      return failure.requiredBytes !== undefined && failure.availableBytes !== undefined
        ? `there was not enough free disk space to keep the exact result (${failure.requiredBytes} bytes needed, ${failure.availableBytes} free)`
        : "there was not enough free disk space to keep the exact result";
    case "capture_git_stalled":
      return `Git stopped making progress while recording the result${failure.stallMs !== undefined ? ` (no progress for ${failure.stallMs} ms)` : ""}`;
    case "capture_git_signal":
      return `Git was terminated${failure.signal ? ` by ${failure.signal}` : ""} while recording the result`;
    case "capture_read_failed":
      return "a changed file could not be read while recording the result";
    case "capture_object_missing":
      return "a Git object the result needs was missing";
    case "capture_failed":
      // The class names only a code-shaped cause; the diagnostic follows it.
      return failure.causeCode !== failure.code && /^[\w.-]{1,64}$/.test(failure.causeCode ?? "")
        ? `the capture failed (${failure.causeCode})`
        : "the capture failed";
  }
}

/** The typed failure's own diagnostic (already redacted and bounded by
 * `captureFailureEvidence`) as one sentence: the human receipt names the
 * precise cause the machine record keeps, not only its class. */
function captureDiagnostic(failure: WorkspaceCaptureFailure): string {
  const text = redactSecrets(failure.message.replace(/\s+/g, " ").trim());
  return text ? ` Detail: ${text}${/[.!?]$/.test(text) ? "" : "."}` : "";
}

/**
 * A directory capture that could not prove containment or read its files fails
 * closed with its typed cause, named as the Git lane names it; content is never
 * a cause (INV-146), its paths and error codes are. In place, the live files stay
 * for inspection; an isolated copy is discarded.
 */
export function directoryCaptureRefusal(error: unknown, inPlace: boolean): CaptureRefusal {
  const failure = captureFailureEvidence(error instanceof Error ? error : new Error(String(error)));
  return {
    disposition: inPlace ? "manual_cleanup" : "discarded",
    detail:
      `Directory output capture failed (containment, read or size): ${captureCause(failure)}.` +
      `${captureDiagnostic(failure)} No file payload was published. Direct effects require` +
      " inspection, not a fabricated rollback.",
    phase: "artifact_security",
    failure,
  };
}

/** The refusal receipt: what was not recorded, what is kept, and the release's limit. */
function refusalDetail(input: {
  inPlace: boolean;
  root: string;
  failure: WorkspaceCaptureFailure;
  retentionFailed: boolean;
  skipped: SkippedVerification;
}): string {
  const lost = [
    "the exact result",
    ...(input.inPlace ? ["a revert point"] : []),
    "apply eligibility",
    ...(input.skipped.checks > 0
      ? [`${input.skipped.checks} configured check(s), which did not run`]
      : []),
    ...(input.skipped.review ? ["the requested review, which did not run"] : []),
  ];
  const kept = input.inPlace
    ? `the changed files in ${input.root} (already in place, not reviewed)`
    : input.retentionFailed
      ? `the isolated source at ${input.root}, held by this process only (durable retention could not be recorded)`
      : `the retained isolated source at ${input.root} (not applied)`;
  return (
    `The changes could not be captured exactly: ${captureCause(input.failure)}.` +
    `${captureDiagnostic(input.failure)} ` +
    `Not recorded: ${lost.join("; ")}. ` +
    `Kept: the final answer, any media the run produced, and ${kept}.`
  );
}

/** Existing custody is the durability owner; only an eligible singleton gets
 * the singular continuation pointer. Other candidates are addressed by attempt. */
export function preserveCaptureSource(input: {
  wsm: WorkspaceManager;
  envelope: WorkspaceEnvelope;
  inPlace: boolean;
  holder: { runId: string; runDir: string };
  skipped: SkippedVerification;
  error?: Error;
}): CaptureRefusal {
  const { wsm, envelope, inPlace, holder } = input;
  let retentionFailure: WorkspaceCaptureFailure | undefined;
  // Live media may exceed the run's bounded copies: disposal keeps their directory.
  if (inPlace) wsm.keepArtifactDirectory(envelope);
  else {
    wsm.retainEnvelope(envelope);
    try {
      const current = readEnvelopeCustody(envelopeBaseOf(envelope));
      if (current?.holder_run_id === holder.runId && current.continuation_eligible !== false)
        retainForContinuation(envelope, holder, null);
      else retainForInspection(envelope, holder);
    } catch (error) {
      // Preserve the completed answer/accounting even if persistence itself fails.
      // The process-local hold remains, but durable recovery is explicitly unproven.
      retentionFailure = captureFailureEvidence(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
  const failure = captureFailureEvidence(input.error);
  return {
    disposition: inPlace || retentionFailure ? "manual_cleanup" : "retained",
    phase: "workspace",
    sourceRoot: envelope.worktree_path,
    failure,
    ...(retentionFailure ? { retentionFailure } : {}),
    detail: refusalDetail({
      inPlace,
      root: envelope.worktree_path,
      failure,
      retentionFailed: retentionFailure !== undefined,
      skipped: input.skipped,
    }),
  };
}
