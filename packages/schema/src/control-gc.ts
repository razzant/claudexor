import { z } from "zod";

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
  })
  .strict()
  .describe("Run one retention pass over engine-owned runtime artifacts.");
export type ControlGcRequest = z.infer<typeof ControlGcRequest>;

export const GcRunDeletion = z
  .object({
    run_id: z.string().describe("Deleted (or would-be-deleted) run id."),
    project_root: z.string().describe("Canonical project root owning the run tree."),
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
  })
  .strict()
  .describe("Typed receipt of one retention pass.");
export type ControlGcReceipt = z.infer<typeof ControlGcReceipt>;
