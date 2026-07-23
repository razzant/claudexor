import { z } from "zod";
import { FinalVerifyRecord } from "./decision.js";

/** Immutable evidence for one DeliveryService attempt, shared by every apply surface. */
export const DeliveryReceipt = z
  .object({
    mode: z.enum(["apply", "branch", "commit", "pr"]),
    applied: z.boolean(),
    branch: z.string().optional(),
    commit: z.string().optional(),
    prUrl: z.string().optional(),
    detail: z.string().optional(),
    treeMutated: z.boolean().optional(),
    refused: z.boolean().optional(),
    /** #26: TRUE when this delivery was an idempotent already-applied no-op —
     * the tree was already this patch's exact postimage (reverse `git apply
     * --check` clean), so `applied:true` with NO mutation. Distinguishes a
     * fresh apply from a replay so a surface never claims it just changed files
     * it did not. Defaults false. */
    alreadyApplied: z
      .boolean()
      .default(false)
      .describe("True when delivery was an idempotent already-applied no-op (no files changed)."),
    /** #26: coarse typed delivery disposition, so a consumer reads the outcome
     * without parsing `detail` prose. Optional (older receipts omit it). */
    deliveryStatus: z
      .enum(["applied", "already_applied", "refused"])
      .optional()
      .describe("Coarse typed delivery disposition (applied / already_applied / refused)."),
    finalVerify: FinalVerifyRecord.describe("Fresh verifier evidence for this delivery attempt."),
    targetPreimageSha: z.string().describe("Target snapshot verified immediately before delivery."),
  })
  .strict()
  .describe("Immutable receipt for a freshly verified delivery attempt.");
export type DeliveryReceipt = z.infer<typeof DeliveryReceipt>;
