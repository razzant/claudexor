/**
 * Queued jobs a pending run-deadline/1 transition holds in place: the
 * scheduler's `nextAdmission` and `admission` count them as about to run, so
 * their thread stays serialized and their slot taken, until the transition
 * settles. Also the durable cancel of a queued job its deadline ended: while
 * that write fails the job stays held — it never starts — and the write is
 * retried with backoff; once it lands the hold goes, the refusal is reported
 * and the queue is offered again.
 */
import type { JobRecord } from "./job-record.js";

const FIRST_RETRY_MS = 50;
const MAX_RETRY_MS = 5_000;

export interface DeadlineHoldDeps {
  /** The daemon's cancel of a queued job; throws when its terminal was not written. */
  cancel(id: string, patch: Partial<JobRecord>): void;
  /** The job is still in the daemon's queue. */
  queued(id: string): boolean;
  /** Offer the queue again (a no-op while the daemon stops). */
  redrain(): void;
}

export class DeadlineHolds {
  readonly held = new Set<string>();
  private readonly retries = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(private readonly deps: DeadlineHoldDeps) {}

  hold(id: string): void {
    this.held.add(id);
  }

  /** The hold goes; true when the job was held. */
  release(id: string): boolean {
    return this.held.delete(id);
  }

  /** Cancel a queued job its deadline ended; `cancelled` follows the durable write. */
  cancelExpired(id: string, patch: Partial<JobRecord>, cancelled: () => void, delayMs = 0): void {
    try {
      this.deps.cancel(id, patch);
    } catch {
      if (this.disposed || !this.deps.queued(id)) return void this.held.delete(id);
      this.held.add(id);
      const next = Math.min(Math.max(delayMs * 2, FIRST_RETRY_MS), MAX_RETRY_MS);
      const timer = setTimeout(() => {
        this.retries.delete(timer);
        this.cancelExpired(id, patch, cancelled, next);
      }, next);
      timer.unref?.();
      this.retries.add(timer);
      return;
    }
    this.held.delete(id);
    cancelled();
    this.deps.redrain();
  }

  /** The daemon stops: no cancel is retried any more. */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.retries) clearTimeout(timer);
    this.retries.clear();
  }
}
