import { z } from "zod/v3";
import { Id } from "./primitives.js";

/**
 * Unified-accounts startup migration state (INV-135 rewrite, plan §L.3).
 *
 * The per-harness record lives in `~/.claudexor/v3/migration/accounts-unified.json`
 * — deliberately a SEPARATE file, never a config.yaml key: the 3.5.0 strict
 * config parser must keep reading the migrated config, and a downgraded engine
 * simply never opens this file. Phases are restart-idempotent; an INCOMPLETE
 * record is a typed refusal of that harness's runs only (other harnesses keep
 * working) until the next daemon start finishes the remaining phases.
 */
export const AccountsMigrationPhase = z
  .enum(["reserved", "registry_written", "continuity_migrated", "completed", "rolling_back"])
  .describe(
    "Crash-recoverable migration phase for one harness: reserved (id + backup persisted) → registry_written (row in config) → continuity_migrated (sessions/checkpoints/lane homes on the row id) → completed (legacy null quota subject retired). rolling_back marks an in-flight rollback: the startup migration never resumes it forward; re-running the rollback command finishes it.",
  );
export type AccountsMigrationPhase = z.infer<typeof AccountsMigrationPhase>;

export const AccountsHarnessMigration = z
  .object({
    phase: AccountsMigrationPhase,
    row_id: Id.describe(
      "The reserved registry row id (claude-default / codex-default, deterministic -2 suffix on collision) — persisted BEFORE any other phase so a crash can never re-reserve a different id.",
    ),
    legacy_aliases: z
      .array(z.string().nullable())
      .describe(
        "Every legacy identity this row absorbed — [null] for the engine-default subject. Deletion of the row must retire the canonical id PLUS these aliases in one lifecycle operation.",
      ),
    locator: z
      .string()
      .describe(
        "The exact legacy native store dir registered as the row's isolation_locator (bytes never move). Also the delete fence's exact-path allowlist entry for this row.",
      ),
    backup_ref: z
      .string()
      .nullable()
      .describe(
        "Pre-migration backup directory (config.yaml copy), the manual-recovery half of the supported downgrade path; null when the backup could not be written.",
      ),
  })
  .strict()
  .describe("Per-harness unified-accounts migration record.");
export type AccountsHarnessMigration = z.infer<typeof AccountsHarnessMigration>;

/** The whole migration file: harness id → its migration record. */
export const AccountsUnifiedMigrationFile = z
  .record(z.string(), AccountsHarnessMigration)
  .describe("accounts-unified.json: harness id → unified-accounts migration record.");
export type AccountsUnifiedMigrationFile = z.infer<typeof AccountsUnifiedMigrationFile>;

/** POST /accounts-migration/rollback — the supported downgrade path's first
 * step (run BEFORE installing 3.5.0, whose canonicalizers refuse the migrated
 * row's native locator). Surgically reverses the migration: sessions,
 * checkpoints, and lane homes return to the null engine-default keys, the
 * auto-registered row leaves the registry, and its `enabled` state returns to
 * the `native_credentials_enabled` setting. */
export const ControlAccountsMigrationRollbackRequest = z
  .object({
    harnessId: Id.optional().describe(
      "Roll back one harness's migration; omitted = every migrated harness.",
    ),
  })
  .strict()
  .describe("Request body for POST /accounts-migration/rollback.");
export type ControlAccountsMigrationRollbackRequest = z.infer<
  typeof ControlAccountsMigrationRollbackRequest
>;

export const ControlAccountsMigrationRollbackResponse = z
  .object({
    rolledBack: z
      .array(
        z
          .object({
            harness_id: Id,
            row_id: Id.describe("The auto-registered row the rollback removed."),
            sessions: z
              .number()
              .int()
              .describe("Thread sessions returned to the null engine-default subject."),
            checkpoints: z
              .number()
              .int()
              .describe("Lane checkpoints re-seeded onto the null lane."),
            lanes: z.number().int().describe("Durable lane home dirs renamed back."),
            skipped_partitions: z
              .array(z.string())
              .describe(
                "Quarantined project partitions whose sessions could NOT be rolled back (disclosed residual: recover them and rerun the rollback before downgrading).",
              ),
          })
          .strict(),
      )
      .describe("Per-harness rollback receipts (empty when nothing was migrated)."),
  })
  .strict()
  .describe("Receipt for a unified-accounts migration rollback.");
export type ControlAccountsMigrationRollbackResponse = z.infer<
  typeof ControlAccountsMigrationRollbackResponse
>;
