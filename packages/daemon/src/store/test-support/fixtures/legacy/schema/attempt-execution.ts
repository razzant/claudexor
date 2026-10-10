import { z } from "zod/v3";
import { Id } from "./primitives.js";
import { ProcessingReceipt, ProcessingCostBasis } from "./processing.js";
import { UsageCostSummary } from "./budget.js";

export const AttemptExecutionEvidence = z
  .object({
    attemptId: Id,
    harnessId: Id,
    processing: ProcessingReceipt.optional(),
    processingCostBasis: ProcessingCostBasis.optional(),
    usageCost: UsageCostSummary.optional(),
  })
  .strict()
  .describe("Compact projection of existing attempt execution and amount evidence.");
export type AttemptExecutionEvidence = z.infer<typeof AttemptExecutionEvidence>;
