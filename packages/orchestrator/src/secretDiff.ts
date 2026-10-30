import { join } from "node:path";
import type { ArtifactStore } from "@claudexor/artifact-store";
import type { WorkspaceEnvelope } from "@claudexor/schema";
import {
  incompleteWorkspaceCapture,
  type WorkspaceManager,
  type CapturedWorkspaceDiff,
} from "@claudexor/workspace";
import { sha256 } from "@claudexor/util";
import type { ProducedOmission } from "./candidateOutputs.js";
import { preserveCaptureSource, type CaptureRefusal } from "./captureRefusal.js";
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
): Promise<CapturedWorkspaceDiff> {
  try {
    return await wsm.captureDiff(envelope);
  } catch (error) {
    return incompleteWorkspaceCapture(error);
  }
}

/** An incomplete observation is unknown, never an empty exact patch. */
export function capturedDiff(capture: CapturedWorkspaceDiff | undefined): string | undefined {
  return capture?.captureIncomplete ? undefined : (capture?.diff ?? "");
}

export interface CandidateCapture {
  /** The EXACT candidate patch: apply, review, synthesis, digests, gates and
   * every saved copy read it. */
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

/** Disclosure fields of one attempt record (`attempt.yaml`). */
export function attemptDisclosure(capture: CandidateCapture): Record<string, unknown> {
  return {
    ...(capture.captureRefusal ? { capture_refusal: capture.captureRefusal } : {}),
    ...(capture.exactBytesRetainedAt
      ? { exact_bytes_retained_at: capture.exactBytesRetainedAt }
      : {}),
    ...nestedRepositoryDisclosure(capture),
  };
}

/**
 * Capture a candidate's changes. Credential-shaped content is ordinary work:
 * the tree, the diff, every saved copy and the reviewer all see the real bytes.
 */
export async function captureCandidateWorkspace(input: {
  wsm: WorkspaceManager;
  envelope: WorkspaceEnvelope;
  inPlace: boolean;
  holder: { runId: string; runDir: string };
  /** Reuse a post-try refusal instead of repeating the same oversized capture. */
  incompleteCapture?: CapturedWorkspaceDiff;
}): Promise<CandidateCapture> {
  const { wsm, envelope, inPlace } = input;
  const captured = input.incompleteCapture ?? (await captureCandidateDiff(wsm, envelope));
  if (captured.captureIncomplete) {
    return {
      diff: "",
      captureRefusal: preserveCaptureSource({ ...input, error: captured.captureFailure }),
      ...(!inPlace ? { exactBytesRetainedAt: envelope.worktree_path } : {}),
    };
  }
  return {
    diff: captured.diff,
    ...(captured.excludedNestedRepositories?.length
      ? { excludedNestedRepositories: captured.excludedNestedRepositories }
      : {}),
  };
}

/**
 * Write a run's final patch: the exact bytes to `final/patch.diff`, plus the
 * disclosure fields for `work_product.yaml` meta (excluded nested
 * repositories, produced images that were not saved). `patchSha256` is the
 * digest of the saved bytes.
 */
export function persistFinalPatch(
  store: ArtifactStore,
  finalDir: string,
  run: Pick<CandidateCapture, "diff" | "excludedNestedRepositories"> & {
    producedOmitted?: ProducedOmission[];
  },
): { patchSha256: string; meta: Record<string, unknown> } {
  store.writePatch(join(finalDir, "patch.diff"), run.diff);
  return {
    patchSha256: sha256(run.diff),
    meta: {
      ...nestedRepositoryDisclosure(run),
      ...(run.producedOmitted?.length ? { produced_omitted: run.producedOmitted } : {}),
    },
  };
}
