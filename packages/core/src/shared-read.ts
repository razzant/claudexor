/** Await one reader's lifetime without giving it ownership of other readers. */
export function waitForRead<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

interface ReadEntry<T> {
  key: string | null;
  controller: AbortController;
  promise: Promise<T>;
  waiters: number;
}

/** Raw I/O only. Nothing survives completion; each caller owns its decisions.
 * Keys must contain non-secret identity evidence, never credential material.
 * A null key cannot prove equivalence and therefore never joins another read. */
export class SharedRead<T> {
  private readonly entries = new Map<string, Set<ReadEntry<T>>>();

  async read(
    scope: string,
    key: string | null,
    signal: AbortSignal,
    acquire: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    let group = this.entries.get(scope);
    if (!group) this.entries.set(scope, (group = new Set()));
    for (const entry of group) {
      if (entry.key !== key) {
        entry.controller.abort(
          Object.assign(new Error("Read identity changed"), { code: "auth_changed" }),
        );
        group.delete(entry);
      }
    }
    let entry = key === null ? undefined : [...group].find((item) => item.key === key);
    if (!entry) {
      const controller = new AbortController();
      entry = { key, controller, waiters: 0, promise: Promise.resolve(null as T) };
      const owned = entry;
      group.add(owned);
      owned.promise = waitForRead(
        Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return acquire(controller.signal);
        }),
        controller.signal,
      ).finally(() => this.remove(scope, owned));
    }
    entry.waiters += 1;
    try {
      return await waitForRead(entry.promise, signal);
    } finally {
      if (--entry.waiters === 0) {
        entry.controller.abort();
        this.remove(scope, entry);
      }
    }
  }

  invalidate(scope?: string): void {
    for (const [id, group] of this.entries) {
      if (scope !== undefined && id !== scope) continue;
      this.entries.delete(id);
      for (const entry of group)
        entry.controller.abort(
          Object.assign(new Error("Read epoch invalidated"), { code: "auth_changed" }),
        );
    }
  }

  private remove(scope: string, entry: ReadEntry<T>): void {
    const group = this.entries.get(scope);
    group?.delete(entry);
    if (group?.size === 0) this.entries.delete(scope);
  }
}
