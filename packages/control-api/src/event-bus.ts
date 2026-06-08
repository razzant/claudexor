/**
 * In-process per-run event bus with bounded buffering and Last-Event-ID replay.
 *
 * The canonical event log is always `.claudexor/runs/<runId>/events.jsonl` on disk;
 * this bus is an ephemeral fan-out so a reconnecting GUI/service client can resume
 * a live stream cheaply. On overflow it drops the oldest events and reports a `gap`
 * so the client knows to backfill from the canonical file instead of silently
 * losing data (no silent truncation).
 */

/** A sequence-numbered envelope. `seq` is monotonic per run (the SSE id). */
export interface BusEnvelope {
  seq: number;
  /** Discriminates the payload shape for the client (e.g. "run" | "harness"). */
  kind: string;
  event: unknown;
}

export type BusListener = (env: BusEnvelope) => void;

interface RunChannel {
  events: BusEnvelope[];
  nextSeq: number;
  /** seq of the earliest event still buffered; > 1 means earlier events were evicted. */
  earliestSeq: number;
  done: boolean;
  listeners: Set<BusListener>;
  completionListeners: Set<() => void>;
}

export interface EventBusOptions {
  /** Max buffered envelopes per run before the oldest are evicted. Default 5000. */
  maxBufferPerRun?: number;
}

export class EventBus {
  private readonly channels = new Map<string, RunChannel>();
  private readonly maxBuffer: number;

  constructor(opts: EventBusOptions = {}) {
    this.maxBuffer = Math.max(1, opts.maxBufferPerRun ?? 5000);
  }

  private channel(runId: string): RunChannel {
    let ch = this.channels.get(runId);
    if (!ch) {
      ch = { events: [], nextSeq: 1, earliestSeq: 1, done: false, listeners: new Set(), completionListeners: new Set() };
      this.channels.set(runId, ch);
    }
    return ch;
  }

  /** Publish an event for a run. Returns the assigned envelope. */
  publish(runId: string, kind: string, event: unknown): BusEnvelope {
    const ch = this.channel(runId);
    const env: BusEnvelope = { seq: ch.nextSeq++, kind, event };
    ch.events.push(env);
    if (ch.events.length > this.maxBuffer) {
      const removed = ch.events.length - this.maxBuffer;
      ch.events.splice(0, removed);
      ch.earliestSeq += removed;
    }
    for (const l of ch.listeners) {
      try {
        l(env);
      } catch {
        /* a misbehaving listener must never break publishing */
      }
    }
    return env;
  }

  /** Mark a run's stream complete; late subscribers can still replay the buffer. */
  complete(runId: string): void {
    const ch = this.channel(runId);
    if (ch.done) return;
    ch.done = true;
    for (const l of ch.completionListeners) {
      try {
        l();
      } catch {
        /* a misbehaving completion listener must never break completion */
      }
    }
    ch.completionListeners.clear();
    ch.listeners.clear();
  }

  /**
   * Register a callback fired once when the run completes. If already complete it
   * fires synchronously. Returns an unsubscribe function.
   */
  onComplete(runId: string, cb: () => void): () => void {
    const ch = this.channel(runId);
    if (ch.done) {
      cb();
      return () => {};
    }
    ch.completionListeners.add(cb);
    return () => {
      ch.completionListeners.delete(cb);
    };
  }

  isDone(runId: string): boolean {
    return this.channels.get(runId)?.done ?? false;
  }

  /**
   * Subscribe to a run. Replays buffered events after `lastEventId` (0 = from start),
   * then streams live. If `lastEventId` points before the earliest buffered event,
   * a single `{kind:"gap"}` envelope is delivered first so the client backfills from
   * the canonical events.jsonl. Returns an unsubscribe function.
   */
  subscribe(runId: string, lastEventId: number, listener: BusListener): () => void {
    const ch = this.channel(runId);

    // If events before the earliest buffered one were evicted (or never seen because
    // lastEventId=0 starts from the beginning), tell the client to backfill from disk.
    if (ch.earliestSeq - 1 > lastEventId) {
      listener({ seq: ch.earliestSeq - 1, kind: "gap", event: { droppedBefore: ch.earliestSeq } });
    }
    for (const env of ch.events) {
      if (env.seq > lastEventId) listener(env);
    }

    if (ch.done) return () => {};
    ch.listeners.add(listener);
    return () => {
      ch.listeners.delete(listener);
    };
  }

  /** Drop a run's buffer/listeners (e.g. after delivery + TTL). */
  evict(runId: string): void {
    this.channels.delete(runId);
  }

  /** Number of tracked runs (for diagnostics/tests). */
  size(): number {
    return this.channels.size;
  }
}
