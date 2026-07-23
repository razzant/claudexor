import { z } from "zod";

/**
 * Deep-scan reducer outcome (#27 / D-6). A multi-scout `ask --deep-scan` runs
 * ONE bounded synthesis reducer over the raw scout reports so the final artifact
 * is a real merge, not a concatenation. `succeeded` = the reducer merged the
 * scouts; `failed` = the reducer errored/timed-out/was budget-denied (or no
 * synthesize-capable route existed) and the final artifact is an HONEST raw
 * scout bundle, never a fake synthesis; `skipped` = a single scout report needs
 * no merge (width-1). Null on non-deep-scan runs and legacy artifacts.
 */
export const DeepScanSynthesisStatus = z.enum(["succeeded", "failed", "skipped"]);
export type DeepScanSynthesisStatus = z.infer<typeof DeepScanSynthesisStatus>;

export const DeepScanSynthesis = z
  .object({
    status: DeepScanSynthesisStatus.describe(
      "succeeded = reducer merged the scouts; failed = honest raw bundle; skipped = single report, no merge.",
    ),
    reducer_attempt_id: z
      .string()
      .nullable()
      .default(null)
      .describe("The reducer attempt id (roster/cost visible); null when no reducer attempt ran."),
    reason: z
      .string()
      .nullable()
      .default(null)
      .describe("Why the reducer failed or was skipped; null on a clean merge."),
  })
  .describe(
    "Deep-scan reducer outcome: whether the scout reports were merged into a real synthesis, degraded to an honest raw bundle, or skipped as a single report.",
  );
export type DeepScanSynthesis = z.infer<typeof DeepScanSynthesis>;
