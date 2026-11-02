import {
  effortResolutionEvent,
  prepareHarnessProcessing,
  type HarnessAdapter,
} from "@claudexor/core";
import type { EffortResolution, HarnessRunSpec } from "@claudexor/schema";
import { appendLine } from "@claudexor/util";
import { redactValue, updateReviewerMetadata } from "./reviewerArtifacts.js";
import type { ReviewerArtifactContext } from "./reviewRuntimeTypes.js";

/**
 * ONE prepared result per reviewer dispatch — the same seam the agent run
 * uses in the engine's model gate. The final native model is the processing
 * receipt's `submittedNative` (the adapter's `--model` reads it), the cost
 * basis rides the spec, and a model-id effort carrier (Cursor, Antigravity)
 * returns its level receipt from the same call. Re-run on every native retry,
 * so a rotated account prepares against its own inventory.
 */
export async function prepareReviewerRunSpec(
  adapter: HarnessAdapter,
  spec: HarnessRunSpec,
): Promise<{ spec: HarnessRunSpec; effort: EffortResolution | undefined }> {
  if (!spec.processing_preference && !adapter.prepareProcessing) return { spec, effort: undefined };
  const prepared = await prepareHarnessProcessing(adapter, {
    preference: spec.processing_preference,
    model: spec.model_hint,
    effort: spec.effort_hint,
    cwd: spec.cwd,
    env: spec.env,
    credentialProfile: spec.credential_profile,
    authPreference: spec.auth_preference,
    allowPaid: spec.processing_allow_paid,
  });
  return {
    spec: { ...spec, processing: prepared.receipt, processing_cost_basis: prepared.costBasis },
    effort: prepared.effort,
  };
}

/**
 * Record the prepared effort receipt exactly as a flag adapter's in-stream
 * receipt is recorded: the status event goes into the reviewer's normalized
 * stream, the receipt into `metadata.json`, and an adaptation/model-change disclosure
 * into the reviewer's `ignored_settings`. Nothing is injected into the live
 * adapter stream, so first-event timing keeps meaning "the adapter spoke".
 */
export function recordPreparedEffort(
  artifact: ReviewerArtifactContext,
  sessionId: string,
  receipt: EffortResolution | undefined,
  ignoredSettings: Set<string>,
  spec?: Pick<HarnessRunSpec, "model_hint" | "processing">,
): void {
  if (!receipt) return;
  const event = effortResolutionEvent(sessionId, receipt, spec);
  appendLine(artifact.eventsPath, JSON.stringify(redactValue(event)));
  const disclosures = event.payload?.["ignored_settings"];
  if (Array.isArray(disclosures))
    for (const item of disclosures) if (typeof item === "string") ignoredSettings.add(item);
  updateReviewerMetadata(artifact, {
    effort_resolution: receipt,
    ...(ignoredSettings.size > 0 ? { ignored_settings: [...ignoredSettings] } : {}),
  });
}
