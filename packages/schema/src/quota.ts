import { z } from "zod";
import { Id } from "./primitives.js";

export const QuotaSource = z
  .enum([
    "codex_app_server",
    "codex_rollout",
    "claude_statusline",
    "claude_api_retry",
    "claude_oauth_usage",
  ])
  .describe("Vendor-owned machine-readable source of a quota snapshot.");
export type QuotaSource = z.infer<typeof QuotaSource>;

export const QuotaFreshness = z
  .enum(["fresh", "stale", "unknown"])
  .describe("Freshness of a quota snapshot at read time.");
export type QuotaFreshness = z.infer<typeof QuotaFreshness>;

export const QuotaSubject = z
  .object({
    harness: Id,
    credential_route: z.enum(["vendor_native", "managed_api_key", "local"]),
    plan_label: z.string().nullable().default(null),
    /** The CREDENTIAL SUBJECT the windows belong to (release wave round-16
     * #2): a Claudexor credential-profile id, or null for the harness's
     * engine-default credential. Every producer (oauth-usage refresher,
     * typed-event registry, adapter quota events) uses exactly this
     * vocabulary; budget routing filters snapshots by exact subject so one
     * account's exhaustion never cools another. */
    subject_id: z.string().nullable().default(null),
  })
  .strict()
  .describe(
    "Quota owner and credential route; subject_id is the credential-profile id (null = the engine-default credential).",
  );
export type QuotaSubject = z.infer<typeof QuotaSubject>;

export const QuotaConstraint = z
  .object({
    id: Id,
    label: z.string().min(1),
    used_ratio: z.number().min(0).max(1).nullable(),
    window_seconds: z.number().positive().nullable(),
    resets_at: z.string().datetime({ offset: true }).nullable(),
    cooldown_until: z.string().datetime({ offset: true }).nullable().default(null),
  })
  .strict()
  .describe("One independent vendor quota window; null usage stays unknown.");
export type QuotaConstraint = z.infer<typeof QuotaConstraint>;

export const QuotaSnapshot = z
  .object({
    subject: QuotaSubject,
    constraints: z.array(QuotaConstraint),
    source: QuotaSource,
    observed_at: z.string().datetime({ offset: true }),
    freshness: QuotaFreshness,
  })
  .strict()
  .describe("All independently reported quota windows for one vendor-owned subject.");
export type QuotaSnapshot = z.infer<typeof QuotaSnapshot>;

export const QuotaAbsenceReason = z
  .enum([
    "not_logged_in",
    "transport_unavailable",
    "platform_unsupported",
    "refresh_failed",
    "no_source",
  ])
  .describe("Why a registered subject has no quota snapshot, in the source's own vocabulary.");
export type QuotaAbsenceReason = z.infer<typeof QuotaAbsenceReason>;

export const QuotaAbsence = z
  .object({
    subject: QuotaSubject,
    reason: QuotaAbsenceReason,
    detail: z.string().nullable().default(null),
    observed_at: z.string().datetime({ offset: true }),
  })
  .strict()
  .describe("A registered subject's typed missing-snapshot — absence is stated, never inferred.");
export type QuotaAbsence = z.infer<typeof QuotaAbsence>;

export const ControlQuotaResponse = z
  .object({
    snapshots: z.array(QuotaSnapshot),
    absences: z
      .array(QuotaAbsence)
      .default([])
      .describe(
        "Every registered subject reports either a snapshot or a typed absence — absence is never silent emptiness (zen: absence ≠ empty).",
      ),
    refreshed_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
  .describe("Current quota snapshots without a fabricated aggregate.");
export type ControlQuotaResponse = z.infer<typeof ControlQuotaResponse>;
