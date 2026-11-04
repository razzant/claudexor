/**
 * The process libuv pool. The daemon entry sets `UV_THREADPOOL_SIZE` from the
 * host before any filesystem call when the operator has not set it. Unset here
 * means the pool was already created at libuv's default of 4; assigning the
 * variable later does not resize it. A non-positive value is libuv's 1, and
 * anything above 1024 is libuv's maximum.
 */
export function libuvPoolSizeFrom(raw: string | undefined): number {
  if (raw == null || raw === "") return 4;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.min(parsed, 1024);
}

export function libuvPoolSize(): number {
  return libuvPoolSizeFrom(process.env.UV_THREADPOOL_SIZE);
}

/** Upload writes leave two threads for DNS and other filesystem work.
 * A pool of one cannot spare them; that is the size the operator set. */
export function uploadWriteSlots(): number {
  return Math.max(1, libuvPoolSize() - 2);
}

export interface UploadWriteGate {
  acquire(cancelled?: () => void): Promise<() => void>;
  wake(): void;
}

/** One queue. `acquire` resolves with a release function. A caller who finds
 * the gate full waits on that promise (the event loop), not a spin. `wake`
 * rechecks every waiter, so a cancellation rejects without waiting for a slot.
 * Release is idempotent and hands the slot to the oldest waiter. */
export function createUploadWriteGate(slots: () => number): UploadWriteGate {
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

const uploadWrites = createUploadWriteGate(uploadWriteSlots);

export function acquireUploadWriteSlot(cancelled?: () => void): Promise<() => void> {
  return uploadWrites.acquire(cancelled);
}

export function wakeUploadWriteSlots(): void {
  uploadWrites.wake();
}
