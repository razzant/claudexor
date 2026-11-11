import { z } from "zod/v3";
import { IsoTimestamp, NonBlankString } from "./primitives.js";

/** Service of the selected cognitive model, independent of routing and effort. */
export const ProcessingPreference = z
  .enum(["standard", "fast", "economy"])
  .describe(
    "Advisory service preference. Fast or Economy may use ordinary Standard service; fallback never introduces Fast. Omission preserves native defaults. Explicit native serviceTier takes precedence.",
  );
export type ProcessingPreference = z.infer<typeof ProcessingPreference>;

export const ProcessingCapability = z
  .object({
    modes: z.array(ProcessingPreference).nullable(),
    nativeModes: z.array(z.object({ mode: ProcessingPreference, id: NonBlankString }).strict()),
    defaultNativeMode: NonBlankString.nullable(),
    eligible: z.boolean().nullable(),
    source: NonBlankString,
    observedAt: IsoTimestamp.nullable(),
  })
  .strict()
  .describe(
    "Exact model/account service evidence. Null modes or eligibility means unknown, not unsupported; native IDs remain adapter-owned. Transport support is declared separately.",
  );
export type ProcessingCapability = z.infer<typeof ProcessingCapability>;

export const ProcessingReceipt = z
  .object({
    requested: ProcessingPreference.nullable(),
    submitted: ProcessingPreference.nullable(),
    submittedNative: NonBlankString.nullable(),
    observed: z.enum(["standard", "fast", "economy", "mixed", "unknown"]),
    observedNative: z.array(NonBlankString),
    reason: NonBlankString.nullable(),
    source: NonBlankString,
  })
  .strict()
  .describe(
    "Requested intent, submitted native control, and observed execution are independent facts. A submitted flag never proves observed service; mixed or missing session observations remain explicit.",
  );
export type ProcessingReceipt = z.infer<typeof ProcessingReceipt>;

export const ProcessingCostBasis = z
  .object({
    nativeMode: NonBlankString.nullable(),
    kind: z.enum(["included", "paid_credits", "cash", "valuation", "unknown"]),
    source: NonBlankString,
    debit: z
      .literal("unobserved")
      .optional()
      .describe(
        "The route reports no actual cash or purchased-credit debit. Included service still admits the work, but its cash stays unknown instead of zero and is outside the finite cap; absence keeps proven ordinary inclusion as zero cash.",
      ),
  })
  .strict()
  .describe(
    "Mode-qualified billing evidence for an existing cost record. Authentication alone does not establish included premium service; credits, cash, and token valuation stay distinct.",
  );
export type ProcessingCostBasis = z.infer<typeof ProcessingCostBasis>;

export const UsageCostBasis = z
  .object({
    kind: z.enum(["cash", "valuation", "unknown"]),
    source: NonBlankString,
  })
  .strict()
  .describe(
    "Observed meaning of this usage.cost_usd amount, separate from prospective processing billing. List-price valuation is not a cash or credit debit receipt. Native paid-credit consumption remains unknown when the vendor exposes no amount evidence.",
  );
export type UsageCostBasis = z.infer<typeof UsageCostBasis>;

/** `context/processing_intent.yaml`: the speed each routed harness lane chose
 * without a preference, frozen at its first routing. */
export const RunProcessingIntent = z
  .object({
    schema_version: z.literal(1),
    harnesses: z
      .record(NonBlankString, ProcessingReceipt)
      .describe(
        "Routing-time receipt per routed harness; its source keeps the original provenance (for example codex.managed_config).",
      ),
  })
  .strict()
  .describe(
    "Speed each routed harness chose without a processing preference, written once at its first routing. Exact Retry keeps it instead of a changed or different account's native setting, and a retry records the intent it kept, so a retry chain keeps the original even after an ordinary fallback.",
  );
export type RunProcessingIntent = z.infer<typeof RunProcessingIntent>;
