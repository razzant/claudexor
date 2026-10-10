import {
  EffortResolution,
  ProcessingReceipt,
  ProcessingCostBasis,
  type HarnessRunSpec,
} from "../schema/index.js";
import type {
  HarnessAdapter,
  HarnessProcessingSpec,
  PreparedHarnessProcessing,
} from "./adapter.js";

/** Shared fallback for adapters without service controls. Never changes model,
 * effort, credential route, or output policy. Native observations stay unknown.
 * An adapter whose effort rides the model id returns its effort receipt from
 * the same call; it is validated here and travels with the prepared result. */
export async function prepareHarnessProcessing(
  adapter: HarnessAdapter,
  spec: HarnessProcessingSpec,
): Promise<PreparedHarnessProcessing> {
  const prepared: PreparedHarnessProcessing = adapter.prepareProcessing
    ? await adapter.prepareProcessing(spec)
    : {
        model: spec.model,
        receipt: {
          requested: spec.preference ?? null,
          submitted: null,
          submittedNative: null,
          observed: "unknown" as const,
          observedNative: [],
          reason: "processing_control_unavailable",
          source: "adapter-capability",
        },
        costBasis: { nativeMode: null, kind: "unknown" as const, source: "adapter-capability" },
      };
  const receipt = ProcessingReceipt.parse(prepared.receipt);
  return {
    model: prepared.model,
    receipt,
    costBasis: ProcessingCostBasis.parse(prepared.costBasis),
    ...(prepared.effort ? { effort: EffortResolution.parse(prepared.effort) } : {}),
  };
}

/** Runtime-only callback owned by the caller's existing budget lease. It sees
 * the exact prepared spec, after account/model resolution and before spawn. */
export type ProcessingAdmission = (spec: HarnessRunSpec) => void | Promise<void>;

export async function admitPreparedProcessing(spec: HarnessRunSpec): Promise<void> {
  const admission = spec.extra["processingAdmission"];
  if (typeof admission === "function") await (admission as ProcessingAdmission)(spec);
}
