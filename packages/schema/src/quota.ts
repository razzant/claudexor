import { z } from "zod";
import { Id } from "./primitives.js";

export const QuotaSource = z
  .enum(["codex_app_server", "codex_rollout", "claude_statusline", "claude_api_retry"])
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
    subject_id: z.string().nullable().default(null),
  })
  .strict()
  .describe("Quota owner and credential route; subject ids are opaque and optional.");
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

export const ControlQuotaResponse = z
  .object({
    snapshots: z.array(QuotaSnapshot),
    refreshed_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
  .describe("Current quota snapshots without a fabricated aggregate.");
export type ControlQuotaResponse = z.infer<typeof ControlQuotaResponse>;
