import { RETENTION_AGE_REVISIT_MS } from "@claudexor/daemon";
import { logLine } from "./daemon-lifecycle.js";
import type { RetentionRunner } from "./retention-service.js";

/** One lifecycle-owned timer: drain bounded passes promptly, then revisit age
 * eligibility hourly. The returned stop drains an in-flight pass before store close. */
export function scheduleStartupRetention(
  runner: RetentionRunner,
  opts: {
    logPath: string;
    shuttingDown: () => boolean;
    delayMs?: number;
    intervalMs?: number;
    continuationDelayMs?: number;
  },
): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flight: Promise<void> | null = null;
  const schedule = (delay: number) => {
    if (stopped || opts.shuttingDown()) return;
    timer = setTimeout(() => {
      if (stopped || opts.shuttingDown()) return;
      let more = false;
      flight = runner({ dry_run: false, trash_purge_report: true, native_home_report: true })
        .then(
          (receipt) => {
            more = runner.hasMore?.(receipt) ?? false;
            logLine(
              opts.logPath,
              `retention: freed ${receipt.freed_bytes} bytes (${receipt.deleted_runs.length} runs, ` +
                `${receipt.deleted_reviews.length} reviews, ${receipt.purged_threads?.length ?? 0} expired trash threads, ` +
                `${receipt.purge_leftovers?.length ?? 0} finished purges, ` +
                `${receipt.native_homes?.reduce((sum, home) => sum + home.deleted_files.length, 0) ?? 0} native files, ${receipt.errors.length} errors)`,
            );
          },
          (error: unknown) =>
            logLine(
              opts.logPath,
              `retention FAILED: ${error instanceof Error ? error.message : String(error)}`,
            ),
        )
        .finally(() => {
          flight = null;
          schedule(
            more
              ? (opts.continuationDelayMs ?? 1_000)
              : (opts.intervalMs ?? RETENTION_AGE_REVISIT_MS),
          );
        });
    }, delay);
    timer.unref?.();
  };
  schedule(opts.delayMs ?? 60_000);
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await runner.cancel?.();
    await flight;
  };
}
