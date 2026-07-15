import { z } from "zod";
import { DeliveryReceipt } from "./delivery.js";

/** Apply an isolated thread's accumulated worktree diff to the project. */
export const ControlThreadApplyRequest = z
  .object({
    mode: z
      .enum(["apply", "branch", "commit", "pr"])
      .default("apply")
      .describe("Delivery mode: apply to the tree, or as a branch, commit, or PR."),
    branch: z.string().optional().describe("Branch name for branch/pr modes."),
    message: z.string().optional().describe("Commit message for commit/pr modes."),
  })
  .strict()
  .describe("Request body applying an isolated thread's accumulated worktree diff to the project.");
export type ControlThreadApplyRequest = z.infer<typeof ControlThreadApplyRequest>;

export const ControlThreadApplyResponse = z
  .object({
    applied: z.boolean().describe("Whether anything was delivered."),
    status: z
      .enum(["applied", "branched", "committed", "pr_opened", "empty", "conflict", "rejected"])
      .describe(
        "Delivery outcome: applied, branched, committed, pr_opened, empty (no diff), conflict, or rejected.",
      ),
    headMoved: z
      .boolean()
      .default(false)
      .describe("True when the project HEAD moved past the thread base since the thread started."),
    detail: z.string().nullable().default(null).describe("Human-readable detail."),
    delivery: DeliveryReceipt.nullable()
      .default(null)
      .describe(
        "Fresh verifier, target preimage, and mutation receipt; null when no delivery ran.",
      ),
  })
  .describe("Response to a thread apply.");
export type ControlThreadApplyResponse = z.infer<typeof ControlThreadApplyResponse>;
