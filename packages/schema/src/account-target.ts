import { z } from "zod/v3";
import { QuotaRequestKind } from "./quota-request-kind.js";
export const AccountTarget = z
  .object({ harness: z.string().min(1), profile_id: z.string().min(1) })
  .strict();
export type AccountTarget = z.infer<typeof AccountTarget>;

/** Whose resources a row or refresh names: a registered account, or with a
 * null profile_id the harness's unregistered default API-key route (INV-135:
 * a route, never an account row). Reset and management keep AccountTarget. */
export const AccountResourceTarget = z
  .object({
    harness: z.string().min(1),
    profile_id: z
      .string()
      .min(1)
      .nullable()
      .describe(
        "Registered account id; null names the harness's default API-key route, which is not an account.",
      ),
  })
  .strict();
export type AccountResourceTarget = z.infer<typeof AccountResourceTarget>;

export const ControlQuotaRefreshRequest = z
  .object({
    target: AccountResourceTarget.optional().describe(
      "Exact refresh subject. A null profile_id (the default API-key route) and registered API-key accounts require includeApiKeys=true.",
    ),
    requestKind: QuotaRequestKind.optional().describe(
      "Availability scope; omitted means text. Raw constraints retain every scope.",
    ),
    model: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional model id/alias the caller intends to spend against. When present, each snapshot's availability.state is computed against this model (case-insensitive alias containment in either direction), so windows scoped to OTHER models never report the subject exhausted.",
      ),
  })
  .strict()
  .describe(
    "Optional POST /v2/quota body; an empty or absent body keeps the model-agnostic projection.",
  );
export type ControlQuotaRefreshRequest = z.infer<typeof ControlQuotaRefreshRequest>;
