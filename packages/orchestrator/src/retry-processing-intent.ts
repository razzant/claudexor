import { join } from "node:path";
import type { ArtifactStore } from "@claudexor/artifact-store";
import { RunProcessingIntent, type ProcessingReceipt } from "@claudexor/schema";

export const PROCESSING_INTENT_FILE = "processing_intent.yaml";

/**
 * Freeze the speed each routed harness chose without a preference at its first
 * routing (the earliest typed selection, before any attempt). An Exact Retry
 * records the intent it was given, not its own fallback, so a retry chain keeps
 * the original choice and provenance. Later routings in the same run only add
 * harnesses that were not routed before.
 */
export function recordProcessingIntent(
  store: Pick<ArtifactStore, "readYaml" | "writeYaml">,
  contextDir: string,
  intents: Readonly<Record<string, ProcessingReceipt>>,
): void {
  const path = join(contextDir, PROCESSING_INTENT_FILE);
  const recorded = RunProcessingIntent.safeParse(store.readYaml(path)).data?.harnesses ?? {};
  const added = Object.entries(intents).filter(([harnessId]) => !(harnessId in recorded));
  if (added.length === 0) return;
  store.writeYaml(
    path,
    RunProcessingIntent.parse({
      schema_version: 1,
      harnesses: { ...recorded, ...Object.fromEntries(added) },
    }),
  );
}

/**
 * The speed an Exact Retry keeps: its source run's frozen routing-time intent,
 * like the frozen model and effort (QA-035), so a settings or account change
 * between the runs never re-resolves it. A source without that record (an older
 * run, or one routed with a preference) yields nothing.
 */
export function retryProcessingIntent(
  store: Pick<ArtifactStore, "readYaml">,
  sourceRunDir: string,
): Record<string, ProcessingReceipt> | undefined {
  const recorded = RunProcessingIntent.safeParse(
    store.readYaml(join(sourceRunDir, "context", PROCESSING_INTENT_FILE)),
  ).data?.harnesses;
  return recorded && Object.keys(recorded).length > 0 ? recorded : undefined;
}
