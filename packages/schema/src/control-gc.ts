import { z } from "zod/v3";

/**
 * Disk-retention (GC) control operation (W3.6). The daemon owns the
 * retention service; this is its schema-first contract: a typed request
 * (dry-run first-class) and a typed receipt that discloses exactly what was
 * deleted and WHY every survivor survived — silent deletion or silent
 * retention are both bugs.
 */

/** Why a candidate run tree survived this GC pass. */
export const GcKeepReason = z
  .enum(["active", "recent", "young", "referenced", "actionable", "unknown_state"])
  .describe(
    "Why a run tree survived: active (nonterminal daemon record), recent (newest-N per project), young (inside the age window), referenced (a live thread points at it), actionable (undelivered/applyable/blocked work awaiting the operator), unknown_state (no terminal evidence — fail closed).",
  );
export type GcKeepReason = z.infer<typeof GcKeepReason>;

export const ControlGcRequest = z
  .object({
    dry_run: z
      .boolean()
      .default(false)
      .describe("Report what WOULD be deleted without touching disk."),
    retention_report: z
      .boolean()
      .optional()
      .describe("Include typed holds, root/home counts and truncation; lockstep clients only."),
    model_payload_report: z
      .boolean()
      .optional()
      .describe(
        "Include exact model-purpose resource cleanup outcomes. Cleanup itself always runs; opt-in keeps older strict receipt readers compatible.",
      ),
    data_root_report: z
      .boolean()
      .optional()
      .describe(
        "Opt in to the advisory data-root scan: when true, the receipt carries data_root_unrecognized. Capability negotiation for engine-version skew — a client omits this unless the serving daemon is the SAME engine version, so an older daemon never sees the unknown request key and an older client never receives the unknown receipt key.",
      ),
    native_home_report: z
      .boolean()
      .optional()
      .describe(
        "Include adapter-owned native-home retirement outcomes. Cleanup always runs; lockstep opt-in keeps older strict clients compatible.",
      ),
    trash_purge_report: z
      .boolean()
      .optional()
      .describe(
        "Opt in to the thread-purge disclosure: when true, the receipt carries purged_threads and purge_leftovers. The purges themselves always run; the same lockstep capability negotiation as data_root_report keeps older strict receipt readers compatible.",
      ),
  })
  .strict()
  .describe("Run one retention pass over engine-owned runtime artifacts.");
export type ControlGcRequest = z.infer<typeof ControlGcRequest>;

export const GcRunDeletion = z
  .object({
    run_id: z.string().describe("Deleted (or would-be-deleted) run id."),
    project_root: z
      .string()
      .describe(
        "Canonical project root, or the owned runtime namespace when no project record remains.",
      ),
    freed_bytes: z.number().int().nonnegative().describe("Bytes the tree occupied."),
  })
  .strict();
export type GcRunDeletion = z.infer<typeof GcRunDeletion>;

export const GcKeepCounts = z
  .object({
    active: z.number().int().nonnegative().default(0),
    recent: z.number().int().nonnegative().default(0),
    young: z.number().int().nonnegative().default(0),
    referenced: z.number().int().nonnegative().default(0),
    actionable: z.number().int().nonnegative().default(0),
    unknown_state: z.number().int().nonnegative().default(0),
  })
  .strict()
  .describe("Survivor counts per keep reason.");
export type GcKeepCounts = z.infer<typeof GcKeepCounts>;

export const GcHoldClass = z.enum([
  "missing_partition",
  "unbound_active_registration",
  "recovery_pending",
  "namespace_unreadable",
  "anchor_references_unreadable",
  "references_changed",
  "native_home_veto",
  "cleanup_suppressed",
]);
export type GcHoldClass = z.infer<typeof GcHoldClass>;

export const GcHold = z
  .object({
    class: GcHoldClass,
    count: z.number().int().positive(),
    example: z
      .string()
      .describe(
        "Named cause and affected owner, such as a changed registration, unreadable row or pending recovery partition.",
      ),
  })
  .strict();
export type GcHold = z.infer<typeof GcHold>;

export const GcHeldCounts = z
  .object({
    roots: z.number().int().nonnegative().default(0),
    native_homes: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe(
        "Vetoed native homes only; unsupported adapters and unknown native entries are informational.",
      ),
  })
  .strict()
  .describe("Held project roots and vetoed native homes, separate from run counts.");
export type GcHeldCounts = z.infer<typeof GcHeldCounts>;

export const GcLastPass = z
  .object({
    outcome: z.enum(["completed", "held", "truncated", "failed"]),
    started_at: z.string(),
    finished_at: z.string(),
    last_completed_at: z
      .string()
      .nullable()
      .default(null)
      .describe("Last completed non-preview pass time, or null when no completion is known."),
    failed_or_held_streak: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe(
        "Failed or held passes since the last completion; truncated passes preserve the count. Only a completed pass resets it.",
      ),
    freed_bytes: z.number().int().nonnegative(),
    kept: GcKeepCounts,
    held: GcHeldCounts,
    holds: z
      .array(
        GcHold.extend({
          example: z.string().max(160),
          since: z.string(),
        }),
      )
      .max(GcHoldClass.options.length),
    errors: z
      .object({
        count: z.number().int().nonnegative(),
        first: z.string().max(512).nullable(),
      })
      .strict(),
  })
  .strict()
  .describe(
    "One durable non-preview pass summary (at most 16 KiB), including outer cleanup failures.",
  );
export type GcLastPass = z.infer<typeof GcLastPass>;

export const ControlGcLastResponse = z
  .object({
    last: GcLastPass.nullable().describe(
      "Null when no readable non-preview pass has been recorded; reading never starts GC.",
    ),
    diagnostic: z
      .string()
      .max(512)
      .optional()
      .describe(
        "Why the stored summary could not be read; absent when no record exists or it is valid.",
      ),
  })
  .strict();
export type ControlGcLastResponse = z.infer<typeof ControlGcLastResponse>;

/** Adapter-owned native store retirement, including explicit unsupported formats. */
export const GcNativeHomeReport = z
  .object({
    harness_id: z.string(),
    profile_id: z.string().nullable(),
    home: z.string().nullable(),
    status: z.enum(["checked", "not_pruned"]),
    reason: z.string(),
    deleted_files: z.array(z.string()),
    errors: z.array(z.string()),
    freed_bytes: z.number().int().nonnegative(),
    kept_referenced: z.number().int().nonnegative(),
    kept_recent: z.number().int().nonnegative(),
    kept_unknown: z
      .number()
      .int()
      .nonnegative()
      .describe("Unknown native entries preserved without a hold; informational only."),
    truncated: z.boolean(),
  })
  .strict();
export type GcNativeHomeReport = z.infer<typeof GcNativeHomeReport>;

export const ControlGcReceipt = z
  .object({
    schema_version: z.literal(1).default(1),
    dry_run: z.boolean().describe("Whether disk was left untouched."),
    started_at: z.string().describe("Pass start (ISO 8601)."),
    finished_at: z.string().describe("Pass end (ISO 8601)."),
    policy: z
      .object({
        runs_max_age_days: z.number().int().positive(),
        reviews_max_age_days: z.number().int().positive(),
        keep_last_runs_per_project: z.number().int().nonnegative(),
      })
      .strict()
      .describe("The effective retention policy this pass applied."),
    examined_runs: z.number().int().nonnegative().describe("Run trees examined."),
    deleted_runs: z
      .array(GcRunDeletion)
      .default([])
      .describe("Run trees deleted (or would-be under dry_run), tombstones left behind."),
    kept: GcKeepCounts.describe("Why every surviving candidate survived."),
    held: GcHeldCounts.default({}),
    holds: z.array(GcHold).default([]),
    truncated: z.boolean().default(false),
    deleted_reviews: z
      .array(
        z
          .object({
            path: z.string().describe("Deleted standalone diff-review tree."),
            freed_bytes: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .default([])
      .describe("Standalone diff-review trees deleted (or would-be under dry_run)."),
    freed_bytes: z
      .number()
      .int()
      .nonnegative()
      .describe("Total bytes freed (or reclaimable under dry_run)."),
    errors: z
      .array(z.string())
      .default([])
      .describe("Non-fatal per-tree failures; the pass continues past them."),
    data_root_unrecognized: z
      .array(z.string())
      .optional()
      .describe(
        "Names of top-level entries in the Claudexor-owned data root that the engine does not own and will never touch (advisory only — nothing here is ever deleted). The full sorted list. Present ONLY when the request opted in via data_root_report; ABSENT (not empty) when the request did not opt in, the scan failed, or the serving daemon predates the feature; a scan failure is disclosed in errors instead.",
      ),
    native_homes: z
      .array(GcNativeHomeReport)
      .optional()
      .describe(
        "Per-home adapter retirement decisions; present only when native_home_report was requested. Unknown vendor data and unreadable references are kept with a reason.",
      ),
    model_payloads: z
      .object({
        released: z.array(z.string()),
        errors: z.array(z.string()),
      })
      .strict()
      .optional()
      .describe(
        "Model resource identifiers released (or would be under dry_run), plus cleanup failures; present only when model_payload_report was requested.",
      ),
    purged_threads: z
      .array(z.string())
      .optional()
      .describe(
        "Ids of trashed threads whose purge_after had passed and that this pass purged (or would purge under dry_run). Present only when trash_purge_report was requested; a skipped (busy) or failed purge is disclosed in errors instead.",
      ),
    purge_leftovers: z
      .array(z.string())
      .optional()
      .describe(
        "Ids of already purged threads whose directory cleanup had failed after the purge was journaled (an isolated worktree or lane home still on disk) and that this pass finished (or would finish under dry_run). Present only when trash_purge_report was requested; a cleanup that fails again is disclosed in errors and retried by the next pass.",
      ),
  })
  .strict()
  .describe("Typed receipt of one retention pass.");
export type ControlGcReceipt = z.infer<typeof ControlGcReceipt>;
