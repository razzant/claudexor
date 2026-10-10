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
