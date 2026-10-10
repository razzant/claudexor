import { z } from "zod/v3";
import { QuotaConstraint, QuotaSource } from "./quota.js";
export const HarnessAccountUsageFields = {
  account_usage: z
    .array(z.object({ code: z.string(), detail: z.string().nullable() }).strict())
    .optional()
    .describe(
      "Native informational overage diagnostics translated by the adapter; never inference admission authority.",
    ),
  /** Vendor-owned quota windows. All reported windows remain independent. */
  quota: z
    .object({
      source: QuotaSource,
      plan_label: z.string().nullable().default(null),
      subject_id: z.string().nullable().default(null),
      constraints: z.array(QuotaConstraint),
    })
    .strict()
    .optional()
    .describe(
      "All quota windows from a vendor-owned machine-readable source; never scraped from prose or collapsed into a fake aggregate.",
    ),
};
