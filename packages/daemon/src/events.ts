import type { RunEvent } from "@claudexor/schema";

export type RunEventListener = (event: RunEvent) => void;

/**
 * In-process run-event bus: the daemon's runner publishes every RunEvent the
 * orchestrator emits after the owning journal append, and live observers
 * subscribe for push delivery. This bus only removes polling latency. A throwing
 * listener must never break a run.
 */
export class RunEventBus {
  private readonly listeners = new Set<RunEventListener>();

  publish(event: RunEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* observer errors never break the run */
      }
    }
  }

  subscribe(listener: RunEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
