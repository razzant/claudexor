import { ArtifactStore } from "@claudexor/artifact-store";
import { retryProcessingIntent } from "@claudexor/orchestrator";
import type { ControlRunStartRequest } from "@claudexor/schema";

interface SourceRecords {
  getByRunId(runId: string): { runDir?: string } | undefined;
}

/** Exact Retry (`retryOf`) keeps the speed its source run inherited. A caller
 * preference, a new thread turn or any other command chooses its own. */
export function exactRetryProcessingIntent(
  p: Pick<ControlRunStartRequest, "retryOf" | "processingPreference">,
  commands: SourceRecords,
  repoRoot: string,
): ReturnType<typeof retryProcessingIntent> {
  if (!p.retryOf || p.processingPreference !== undefined) return undefined;
  const runDir = commands.getByRunId(p.retryOf)?.runDir;
  return runDir ? retryProcessingIntent(new ArtifactStore(repoRoot), runDir) : undefined;
}
