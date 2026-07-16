import type { DurableJournal } from "@claudexor/journal";
import { ThreadHeadPing } from "@claudexor/schema";

/** Journal record type of the sidebar-staleness invalidation ping. */
const UPDATED = "thread.head.updated";

/**
 * GLOBAL-partition emitter of `thread.head.updated` — the content-free sidebar
 * invalidation ping `{thread_id, project_id, revision}`.
 *
 * Thread mutations persist to their OWNING partition (`project:{id}` for
 * project threads), which the app's single global stream never sees. This
 * projection holds a handle on the GLOBAL journal so every ThreadStore can
 * announce "this thread's summary changed" on the one stream consumers already
 * follow. Content-free by contract: no thread data rides the ping — consumers
 * refetch the authoritative ThreadSummary from the thread endpoints.
 *
 * `revision` is a monotonic per-thread counter, journal-backed so it survives
 * daemon restarts: consumers may drop a ping whose revision they have already
 * reflected without ever trusting payload content.
 */
export class ThreadHeadPingEmitter {
  private readonly revisions = new Map<string, number>();

  constructor(private readonly journal: DurableJournal) {
    this.replay();
  }

  private replay(): void {
    for (const record of this.journal.records()) {
      if (record.type !== UPDATED) continue;
      const ping = ThreadHeadPing.safeParse(record.payload);
      if (!ping.success) continue;
      const prior = this.revisions.get(ping.data.thread_id) ?? 0;
      if (ping.data.revision > prior) this.revisions.set(ping.data.thread_id, ping.data.revision);
    }
  }

  ping(input: { threadId: string; projectId: string | null }): void {
    const revision = (this.revisions.get(input.threadId) ?? 0) + 1;
    const payload = ThreadHeadPing.parse({
      thread_id: input.threadId,
      project_id: input.projectId,
      revision,
    });
    this.journal.append(UPDATED, payload);
    this.revisions.set(input.threadId, revision);
  }

  /** Last emitted revision for a thread (0 = never pinged). */
  revision(threadId: string): number {
    return this.revisions.get(threadId) ?? 0;
  }

  validateProjection(): void {
    for (const [threadId, revision] of this.revisions) {
      if (!threadId || !Number.isInteger(revision) || revision <= 0) {
        throw new Error(`invalid thread head revision: ${threadId} -> ${revision}`);
      }
    }
  }
}

export function threadHeadPingProjection() {
  return {
    name: "thread-head-ping",
    create: (journal: DurableJournal) => new ThreadHeadPingEmitter(journal),
    validate: (emitter: ThreadHeadPingEmitter) => emitter.validateProjection(),
  };
}
