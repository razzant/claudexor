import { z } from "zod/v3";
import { FinalVerifyRecord } from "./decision.js";
import { GitDeliveryPair, GitResultRefusal } from "./git-result.js";

/** Why the publication scanner stopped `pr` before anything left the machine
 * (INV-146). Findings name rule and place only, never the matched text. */
export const PublicationRefusal = z
  .object({
    code: z
      .enum([
        "publication_scan_findings",
        "publication_scan_unavailable",
        "publication_scan_failed",
      ])
      .describe(
        "findings = the scanner reported secret-like content; unavailable = no pinned scanner; failed = the scan could not prove its result.",
      ),
    detail: z.string().describe("Human-readable refusal, without any matched value."),
    findings: z
      .array(
        z
          .object({
            ruleId: z.string().describe("Scanner rule that matched."),
            location: z.string().describe("Outgoing file path or metadata label."),
            line: z.number().int().nullable().describe("1-based line, when known."),
            commit: z.string().nullable().describe("Outgoing commit holding the finding."),
          })
          .strict(),
      )
      .optional()
      .describe("Present for publication_scan_findings."),
  })
  .strict()
  .describe("Typed publication-scanner refusal of a `pr` delivery.");
export type PublicationRefusal = z.infer<typeof PublicationRefusal>;

/** Immutable evidence for one DeliveryService attempt, shared by every apply surface. */
export const DeliveryReceipt = z
  .object({
    mode: z.enum(["apply", "branch", "commit", "pr"]),
    applied: z.boolean(),
    appliedPaths: z.array(z.string()).optional(),
    branch: z.string().optional(),
    commit: z.string().optional(),
    prUrl: z.string().optional(),
    detail: z.string().optional(),
    treeMutated: z.boolean().optional(),
    refused: z.boolean().optional(),
    publicationRefusal: PublicationRefusal.optional().describe(
      "Set when the publication scanner refused a `pr` delivery before any branch, commit or push.",
    ),
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
    /** #535: why an object delivery refused, typed, with the paths it concerns. */
    refusal: GitResultRefusal.optional().describe(
      "Typed refusal of an object-result delivery (code, message, bounded paths); absent on success or a legacy patch refusal.",
    ),
    /** #535: the actual pair an object delivery wrote; revert runs on it. */
    deliveryPair: GitDeliveryPair.optional().describe(
      "Pre/post trees of an object-result delivery whose write is on the target (revert runs on this pair); absent when nothing of it stayed, and for a legacy patch delivery.",
    ),
  })
  .strict()
  .describe("Immutable receipt for a freshly verified delivery attempt.");
export type DeliveryReceipt = z.infer<typeof DeliveryReceipt>;
