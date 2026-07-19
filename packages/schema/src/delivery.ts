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
    finalVerify: FinalVerifyRecord.describe("Fresh verifier evidence for this delivery attempt."),
    targetPreimageSha: z.string().describe("Target snapshot verified immediately before delivery."),
  })
  .strict()
  .describe("Immutable receipt for a freshly verified delivery attempt.");
export type DeliveryReceipt = z.infer<typeof DeliveryReceipt>;
