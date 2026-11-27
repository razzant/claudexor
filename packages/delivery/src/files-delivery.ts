import { realpath } from "node:fs/promises";
import type { FinalVerifyRecord } from "@claudexor/schema";
import type { GateSpec } from "@claudexor/review";
import { sha256 } from "@claudexor/util";
import {
  applyWorkspaceFiles,
  readWorkspaceFile,
  selectedWorkspaceChanges,
  workspaceFilePath,
} from "@claudexor/workspace";
import { finalVerifyBlocks, type VerifyEventLog } from "./final-verifier.js";
import {
  finalVerifyFiles,
  finalVerifySpaceFailure,
  withSpaceRefusal,
  type FilesDeliveryFacts,
  type VerifiableWorkspaceFiles,
} from "./files-verifier.js";
import type { VerifiedDeliverResult } from "./index.js";
import { withRepositoryMutationLease } from "./mutation-lease.js";

/** Directory delivery shares the existing target lease and receipt semantics. */
export async function verifyAndDeliverFiles(
  targetRoot: string,
  candidate: VerifiableWorkspaceFiles,
  options: { paths?: string[]; signal?: AbortSignal } = {},
  gates: GateSpec[] = [],
  authorize?: (record: FinalVerifyRecord) => string | null,
  log: VerifyEventLog = { emit: () => undefined },
): Promise<VerifiedDeliverResult & FilesDeliveryFacts> {
  return withRepositoryMutationLease(targetRoot, async () => {
    const changes = selectedWorkspaceChanges(candidate.manifest, options.paths);
    const preimage = async () => {
      const entries = [];
      for (const entry of changes)
        entries.push({
          path: entry.path,
          state: await readWorkspaceFile(await workspaceFilePath(targetRoot, entry.path, true)),
        });
      return sha256(JSON.stringify(entries));
    };
    const targetPreimageSha = await preimage();
    const { paths, signal } = options;
    const finalVerify = await finalVerifyFiles(candidate, paths, gates, log, signal);
    const verifySpace = finalVerifySpaceFailure(finalVerify);
    const refusal =
      (await realpath(targetRoot)) !== (await realpath(candidate.manifest.sourceRoot))
        ? "target does not match the work product source"
        : finalVerify.applied_cleanly !== true
          ? (finalVerify.reason ?? "file verification failed")
          : authorize
            ? authorize(finalVerify)
            : finalVerifyBlocks(finalVerify)
              ? "final verify failed"
              : null;
    if (refusal || (await preimage()) !== targetPreimageSha) {
      const refused = {
        mode: "apply" as const,
        applied: false,
        treeMutated: false,
        appliedPaths: [],
        refused: true,
        detail: refusal ?? "target changed after final verify; refusing stale delivery",
        finalVerify,
        targetPreimageSha,
      };
      // A verification copy that could not fit refused it: the receipt says so, typed.
      return withSpaceRefusal(refused, refusal === finalVerify.reason ? verifySpace : undefined);
    }
    const { captureFailure, stoppedAt, ...result } = await applyWorkspaceFiles(
      targetRoot,
      candidate.manifest,
      candidate.artifactRoot,
      options.paths,
    );
    // The target ran out of room: `appliedPaths` are those written before it stopped.
    return withSpaceRefusal(
      {
        mode: "apply" as const,
        ...result,
        refused: !result.applied,
        finalVerify,
        targetPreimageSha,
      },
      captureFailure,
      stoppedAt ? [stoppedAt] : [],
    );
  });
}
