/**
 * The size the daemon entry applied when the operator had not set
 * `UV_THREADPOOL_SIZE`. The entry created the pool at that size and then removed
 * the variable, so harness children do not inherit it. Same key as
 * `packages/cli/src/host-libuv-pool.ts` and `packages/claudexor/bin/libuv-pool.js`.
 */
const APPLIED_POOL = Symbol.for("claudexor.libuvPoolSize");

/**
 * The pool an operator-set (or unset) `UV_THREADPOOL_SIZE` gives. Unset means
 * libuv's default of 4; assigning the variable after the pool exists does not
 * resize it. A non-positive value is libuv's 1, and anything above 1024 is
 * libuv's maximum.
 */
export function libuvPoolSizeFrom(raw: string | undefined): number {
  if (raw == null || raw === "") return 4;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.min(parsed, 1024);
}

export function libuvPoolSize(): number {
  const applied = (globalThis as Record<symbol, unknown>)[APPLIED_POOL];
  if (typeof applied === "number") return applied;
  return libuvPoolSizeFrom(process.env.UV_THREADPOOL_SIZE);
}

/** Pool writes (upload transfers, ordered appends) leave two threads for DNS
 * and other filesystem work. A pool of one cannot spare them; that is the size
 * the operator set. */
export function poolWriteSlots(): number {
  return Math.max(1, libuvPoolSize() - 2);
}

export interface PoolWriteGate {
  acquire(cancelled?: () => void): Promise<() => void>;
  wake(): void;
}

/** One queue. `acquire` resolves with a release function. A caller who finds
 * the gate full waits on that promise (the event loop), not a spin. `wake`
 * rechecks every waiter, so a cancellation rejects without waiting for a slot.
 * Release is idempotent and hands the slot to the oldest waiter. */
export function createPoolWriteGate(slots: () => number): PoolWriteGate {
  let active = 0;
  const queue: Array<() => void> = [];
  const attemptOf = (
    cancelled: (() => void) | undefined,
    settle: {
      resolve(release: () => void): void;
      reject(error: unknown): void;
    },
  ): (() => void) => {
    const attempt = (): void => {
      const index = queue.indexOf(attempt);
      if (index >= 0) queue.splice(index, 1);
      try {
        cancelled?.();
      } catch (error) {
        settle.reject(error);
        return;
      }
      if (active >= slots()) {
        queue.push(attempt);
        return;
      }
      active += 1;
      let released = false;
      settle.resolve(() => {
        if (released) return;
        released = true;
        active -= 1;
        queue.shift()?.();
      });
    };
    return attempt;
  };
  return {
    acquire(cancelled) {
      return new Promise((resolve, reject) => {
        attemptOf(cancelled, { resolve, reject })();
      });
    },
    wake() {
      const pending = queue.splice(0, queue.length);
      for (const attempt of pending) attempt();
    },
  };
}

/** The one gate of this process's pool: upload transfers and ordered appends share it. */
const poolWrites = createPoolWriteGate(poolWriteSlots);

/** One pool operation under one slot, released when the operation settles.
 * Callers do not hold a slot while they wait for network bytes or for any
 * other await, so slots never nest. */
export async function withPoolWriteSlot<T>(
  cancelled: (() => void) | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await poolWrites.acquire(cancelled);
  try {
    return await operation();
  } finally {
    release();
  }
}

export function wakePoolWriteSlots(): void {
  poolWrites.wake();
}
