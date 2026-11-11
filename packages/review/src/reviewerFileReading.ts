/**
 * INV-042 and the owner's choice: change review belongs to a harness that reads the
 * candidate evidence files itself (`read_files`), whatever it declares about `review`.
 * This is the one owner of that test. The engine's panels judge the manifest they
 * already hold, and every list of reviewers that reaches a candidate any other way
 * (`reviewCandidate`, an injected `OrchestratorDeps.reviewers`) passes through
 * `requireReadingReviewers`. It reads a declaration: nothing here proves that a native
 * harness actually opened a file.
 */
import { HarnessUnavailableError, type HarnessAdapter } from "@claudexor/core";
import type { HarnessManifest } from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import type { ReviewerSpec } from "./reviewRuntimeTypes.js";

export const CANNOT_READ_EVIDENCE =
  "cannot read the candidate evidence files itself; review changes with a harness that reads files";

/** Adapters whose manifest declared it. A real discovery spawns vendor probes that can
 * fail or stall, so a reviewer already admitted is not probed again at each dispatch. */
const declaredReaders = new WeakSet<HarnessAdapter>();

/** Whether this manifest declares it; a yes is remembered for that dispatch. */
export function admitFileReader(
  adapter: HarnessAdapter,
  manifest: Pick<HarnessManifest, "capabilities">,
): boolean {
  if (!manifest.capabilities.read_files) return false;
  declaredReaders.add(adapter);
  return true;
}

/**
 * The list unchanged, or a refusal of all of it before anything runs: one reviewer
 * that cannot read is never dropped to leave a clean partial panel. A failed discovery
 * proves nothing, so it refuses too.
 */
export async function requireReadingReviewers<R extends Pick<ReviewerSpec, "adapter">>(
  reviewers: R[],
): Promise<R[]> {
  for (const { adapter } of reviewers) {
    if (declaredReaders.has(adapter)) continue;
    let reads: boolean;
    try {
      reads = admitFileReader(adapter, await adapter.discover());
    } catch (error) {
      const reason = redactSecrets(error instanceof Error ? error.message : String(error));
      throw new HarnessUnavailableError(
        `reviewer harness '${adapter.id}' is unavailable: ${reason}`,
      );
    }
    if (!reads) {
      throw new HarnessUnavailableError(`reviewer harness '${adapter.id}' ${CANNOT_READ_EVIDENCE}`);
    }
  }
  return reviewers;
}
