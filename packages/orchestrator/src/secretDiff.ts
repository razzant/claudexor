import { join } from "node:path";
import type { ArtifactStore } from "@claudexor/artifact-store";
import { summarizeDiffPaths } from "@claudexor/core";
import { hasCandidateChanges } from "./candidateEvidence.js";
import { captureInventoryLines } from "@claudexor/schema";
import type {
  ActiveTaskContract,
  CaptureChangeInventory,
  GitDeliveryPair,
  GitObjectResult,
  PatchViewUnavailable,
  WorkspaceEnvelope,
} from "@claudexor/schema";
import {
  createPairRevertAnchorOrNull,
  createRevertAnchorFromPatchOrNull,
  createRevertAnchorOrNull,
  incompleteWorkspaceCapture,
  type WorkspaceManager,
  type CapturedWorkspaceDiff,
} from "@claudexor/workspace";
import { sha256 } from "@claudexor/util";
import { producedOmissionSummaryLine, type ProducedOmission } from "./candidateOutputs.js";
import {
  preserveCaptureSource,
  skippedVerification,
  type CaptureRefusal,
} from "./captureRefusal.js";
export {
  captureInspectionActions,
  captureRefusalNextActions,
  type CaptureRefusal,
} from "./captureRefusal.js";

/** Shared by post-try attribution and final-only capture. Errors remain workspace
 * evidence, allowing answer assembly and observed cost to finish normally. */
export async function captureCandidateDiff(
  wsm: WorkspaceManager,
  envelope: WorkspaceEnvelope,
  /** The run directory: while it exists, the result's objects stay in the store. */
  owner?: string,
): Promise<CapturedWorkspaceDiff> {
  try {
    return await wsm.captureDiff(envelope, owner);
  } catch (error) {
    return incompleteWorkspaceCapture(error);
  }
}

/** An incomplete observation is unknown, never an empty exact patch. */
export function capturedDiff(capture: CapturedWorkspaceDiff | undefined): string | undefined {
  return capture?.captureIncomplete ? undefined : (capture?.diff ?? "");
}

export { hasCandidateChanges } from "./candidateEvidence.js";

/** A try left the tree as it found it: never true for an unknown (incomplete) capture. */
export function captureUnchanged(capture: CapturedWorkspaceDiff | undefined): boolean {
  if (!capture || capture.captureIncomplete) return false;
  return !hasCandidateChanges(capture);
}

/** What a delivery receives: the object result with its rendered view, or a legacy patch. */
export function deliverableOf(
  run: Pick<CandidateCapture, "diff" | "result" | "patchViewUnavailable">,
): string | { result: GitObjectResult; renderedPatch: string | null } {
  if (!run.result) return run.diff;
  return { result: run.result, renderedPatch: run.patchViewUnavailable ? null : run.diff };
}

/** Identity of a capture for stability and stuck checks: digest v1, or the legacy patch digest. */
export function captureIdentity(capture: Pick<CandidateCapture, "diff" | "result">): string {
  return capture.result?.digest ?? sha256(capture.diff);
}

/** The revert handles of one run: Git reads where it executed; its project keeps them. */
export function revertAnchors(execRoot: string, projectRoot: string) {
  return {
    /** An in-place turn's pair, from its pre/post snapshots. */
    turn: (preTurnSha: string | null, postTurnSha: string | null) =>
      createRevertAnchorOrNull(execRoot, preTurnSha, postTurnSha, projectRoot),
    /** After a protected adoption: the actual delivery pair when one was written,
     * else the legacy exact-patch anchor. */
    after: async (
      run: Pick<CandidateCapture, "diff" | "result">,
      delivered: { deliveryPair?: GitDeliveryPair },
    ): Promise<string | null> =>
      run.result
        ? createPairRevertAnchorOrNull(execRoot, delivered.deliveryPair, projectRoot)
        : createRevertAnchorFromPatchOrNull(execRoot, run.diff),
  };
}

/** Diffstat of a work product: counted from the view, or files only for an unrendered result. */
export function resultDiffStats(
  run: Pick<CandidateCapture, "diff" | "patchViewUnavailable" | "changedPaths">,
): { paths: string[]; additions: number | null; deletions: number | null } {
  if (run.patchViewUnavailable)
    return { paths: run.changedPaths ?? [], additions: null, deletions: null };
  return summarizeDiffPaths(run.diff);
}

/** Object-backed facts of a Git capture (#535), carried from capture to every consumer. */
export interface CandidateObjectFacts {
  /** The exact candidate as Git objects: canonical whenever present. */
  result?: GitObjectResult;
  /** Present when no patch view was rendered; the result stays exact. */
  patchViewUnavailable?: PatchViewUnavailable;
  inventory?: CaptureChangeInventory;
  /** Every changed path of an unrendered result, and those whose old side existed. */
  changedPaths?: string[];
  existingPaths?: string[];
}

/** The object facts of a capture, unchanged. */
export function objectFactsOf(captured: CandidateObjectFacts): CandidateObjectFacts {
  return Object.fromEntries(
    (["result", "patchViewUnavailable", "inventory", "changedPaths", "existingPaths"] as const)
      .filter((key) => captured[key] !== undefined)
      .map((key) => [key, captured[key]]),
  );
}

export interface CandidateCapture extends CandidateObjectFacts {
  /** The EXACT rendered patch view of `result` ("" when unrendered), or a legacy
   * exact patch when no object result exists: review, synthesis and the saved
   * copy read it; apply, digests and gates read `result` when present. */
  diff: string;
  captureRefusal?: CaptureRefusal;
  /** Set when an incomplete isolated capture kept its envelope: this is where
   * the bytes still are. */
  exactBytesRetainedAt?: string;
  /** Untracked nested repositories the capture left out of `diff`; the attempt
   * record and the final work product disclose them. */
  excludedNestedRepositories?: string[];
}

/** `excluded_nested_repositories` as saved: deduplicated and sorted; nothing
 * when the capture left nothing out. */
function nestedRepositoryDisclosure(
  capture: Pick<CandidateCapture, "excludedNestedRepositories">,
): Record<string, unknown> {
  return capture.excludedNestedRepositories?.length
    ? {
        excluded_nested_repositories: [...new Set(capture.excludedNestedRepositories)].sort(),
      }
    : {};
}

/** The attempt artifact writer's view of a capture (the exact patch or its typed absence). */
export function attemptPatchInput(capture: CandidateCapture) {
  return {
    diff: capture.diff,
    ...(capture.patchViewUnavailable
      ? { patchViewUnavailable: capture.patchViewUnavailable, changedPaths: capture.changedPaths }
      : {}),
  };
}

/** Disclosure fields of one attempt record (`attempt.yaml`). */
export function attemptDisclosure(capture: CandidateCapture): Record<string, unknown> {
  return {
    ...(capture.result ? { git_result: capture.result } : {}),
    ...(capture.patchViewUnavailable
      ? { patch_view: { available: false, ...capture.patchViewUnavailable } }
      : {}),
    ...(capture.patchViewUnavailable && capture.inventory
      ? { change_inventory: capture.inventory }
      : {}),
    ...(capture.captureRefusal ? { capture_refusal: capture.captureRefusal } : {}),
    ...(capture.exactBytesRetainedAt
      ? { exact_bytes_retained_at: capture.exactBytesRetainedAt }
      : {}),
    ...nestedRepositoryDisclosure(capture),
  };
}

/**
 * Capture a candidate's changes. Credential-shaped content is ordinary work:
 * the tree, the result's objects, the diff, every saved copy and the reviewer
 * all see the real bytes.
 */
export async function captureCandidateWorkspace(input: {
  wsm: WorkspaceManager;
  envelope: WorkspaceEnvelope;
  inPlace: boolean;
  holder: { runId: string; runDir: string };
  /** Its configured checks and review intent: a refusal's receipt names what it skips. */
  contract: Pick<ActiveTaskContract, "tests" | "review_requested">;
  /** Reuse a post-try refusal instead of repeating the same oversized capture. */
  incompleteCapture?: CapturedWorkspaceDiff;
}): Promise<CandidateCapture> {
  const { wsm, envelope, inPlace } = input;
  const captured =
    input.incompleteCapture ?? (await captureCandidateDiff(wsm, envelope, input.holder.runDir));
  if (captured.captureIncomplete) {
    return {
      diff: "",
      captureRefusal: preserveCaptureSource({
        ...input,
        skipped: skippedVerification(input.contract),
        error: captured.captureFailure,
      }),
      ...(!inPlace ? { exactBytesRetainedAt: envelope.worktree_path } : {}),
    };
  }
  return {
    // An unrendered result has no patch view; the result itself stays exact.
    diff: captured.patchViewUnavailable ? "" : captured.diff,
    ...objectFactsOf(captured),
    ...(captured.excludedNestedRepositories?.length
      ? { excludedNestedRepositories: captured.excludedNestedRepositories }
      : {}),
  };
}

/**
 * Write a run's final patch: the exact bytes to `final/patch.diff`, plus the
 * disclosure fields for `work_product.yaml` meta (excluded nested
 * repositories, produced images that were not saved, the Git result and a
 * typed view absence). `patchSha256` is the digest of the saved bytes; a
 * result without a rendered view writes no patch file and has none.
 */
export function persistFinalPatch(
  store: ArtifactStore,
  finalDir: string,
  run: Pick<
    CandidateCapture,
    "diff" | "excludedNestedRepositories" | "result" | "patchViewUnavailable" | "inventory"
  > & {
    producedOmitted?: ProducedOmission[];
  },
): { patchSha256: string | null; meta: Record<string, unknown> } {
  const meta: Record<string, unknown> = {
    ...nestedRepositoryDisclosure(run),
    ...(run.producedOmitted?.length ? { produced_omitted: run.producedOmitted } : {}),
    ...(run.result ? { git_result: run.result } : {}),
  };
  if (run.result && run.patchViewUnavailable) {
    // F: no `patch.diff` at all — never an empty or descriptor file under that
    // name (clients read empty as "no changes"). patch_sha256 exists only for a
    // rendered patch; decisions bind to the result digest v1.
    return {
      patchSha256: null,
      meta: {
        ...meta,
        patch_view: { available: false, ...run.patchViewUnavailable },
        ...(run.inventory ? { change_inventory: run.inventory } : {}),
      },
    };
  }
  store.writePatch(join(finalDir, "patch.diff"), run.diff);
  return { patchSha256: sha256(run.diff), meta };
}

/**
 * Summary lines of a work product: produced images that were not saved and,
 * for an object result without a rendered view (#535), what was kept and why
 * no patch shows, with its bounded inventory. Null when there is nothing to say.
 */
export function resultSummaryLines(
  run:
    | (Pick<CandidateCapture, "result" | "patchViewUnavailable" | "inventory"> & {
        producedOmitted?: readonly ProducedOmission[];
      })
    | undefined,
): string | null {
  const lines = [producedOmissionSummaryLine(run?.producedOmitted)].filter(
    (line): line is string => !!line,
  );
  if (run?.result && run.patchViewUnavailable) {
    const view = run.patchViewUnavailable;
    lines.push(
      `- Result: kept exactly as Git objects (${run.result.digest}); ` +
        (view.reason === "render_failed"
          ? "its patch view could not be rendered"
          : "too large to show as one patch") +
        ` (estimated ${view.estimatedBytes ?? "unknown"} bytes, view limit ${view.limitBytes}).` +
        " It can still be verified, applied and reverted.",
      ...(run.inventory ? captureInventoryLines(run.inventory).map((line) => `  ${line}`) : []),
    );
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/** `\n`-prefixed result summary for a summary template; "" when there is nothing to say. */
export function resultSummaryDisclosure(run: Parameters<typeof resultSummaryLines>[0]): string {
  const lines = resultSummaryLines(run);
  return lines ? `\n${lines}` : "";
}
