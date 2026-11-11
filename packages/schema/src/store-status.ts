import { z } from "zod/v3";
import { IsoTimestamp } from "./primitives.js";

const count = z.number().int().nonnegative();
const ms = z.number().nonnegative();

/** Import reports completed work, never a guessed percentage or ETA. */
export const StoreMigrationProgress = z.object({
  phase: z.enum(["reading", "importing", "verifying", "complete", "publishing", "failed"]),
  completedPartitions: count,
  totalPartitions: count,
  currentPartition: z.string().nullable(),
  processedBytes: count,
  totalBytes: count,
});
export type StoreMigrationProgress = z.infer<typeof StoreMigrationProgress>;

export const StoreFlusherFacts = z.object({
  state: z.enum(["starting", "up", "down"]),
  interval_ms: ms,
  generation: count,
  acknowledged_generation: count,
  pending_registrations: count,
  pending_waiters: count,
  flush_lag_ms: ms,
  last_barrier_at: IsoTimestamp.nullable(),
  last_pass: z
    .object({
      at: IsoTimestamp,
      pass_ms: ms,
      barrier_ms: ms.nullable(),
      dirty: z.boolean(),
      barrier: z.boolean(),
      wal_bytes: count.nullable(),
      checkpoint: z
        .object({ busy: count, log: z.number().int(), checkpointed: z.number().int() })
        .nullable(),
    })
    .nullable(),
  counters: z.object({
    passes: count,
    barriers: count,
    dirSyncs: count,
    busyPassive: count,
    walReopens: count,
    restarts: count,
    deaths: count,
  }),
});

/** One summary for the store's whole lifetime, not a rolling window. */
const StoreCommitFacts = z.object({
  attempts: count.describe("COMMIT calls entered, failed ones included."),
  failures: count.describe("COMMIT calls that threw."),
  last_ms: ms.nullable().describe("Duration of the latest COMMIT call; null before the first."),
  max_ms: ms.nullable().describe("Longest COMMIT call; null before the first."),
  p50_ms: ms
    .nullable()
    .optional()
    .describe(
      "Lifetime COMMIT p50, microsecond histogram with two significant digits; absent on older engines.",
    ),
  p99_ms: ms
    .nullable()
    .optional()
    .describe(
      "Lifetime COMMIT p99, microsecond histogram with two significant digits; absent on older engines.",
    ),
});

/** Missing on old engines; null metrics mean the SQL runtime is not open yet. */
export const DaemonStoreFacts = z.object({
  flusher: StoreFlusherFacts.nullable(),
  flush_lag_ms: ms.nullable(),
  last_barrier_at: IsoTimestamp.nullable(),
  interval_ms: ms.nullable(),
  wal_bytes: count.nullable(),
  busy_waits: count.nullable(),
  commit: StoreCommitFacts.nullable()
    .optional()
    .describe(
      "Request-thread transaction COMMIT calls since this engine store opened, timed around the native call only: a WAL header sync or automatic checkpoint SQLite runs inside it is included; BEGIN, the transaction body and ROLLBACK are not. A long call is a measurement, not proof of a disk cause. Null while the store is not open; older engines omit it.",
    ),
  obligations_open: count.nullable(),
  integrity: z.enum(["pending", "ok", "failed"]).nullable(),
  migration: StoreMigrationProgress.nullable(),
});
export type DaemonStoreFacts = z.infer<typeof DaemonStoreFacts>;
