import { stat } from "node:fs";
import os from "node:os";

/** libuv refuses a pool above this (MAX_THREADPOOL_SIZE). */
export const LIBUV_POOL_MAX = 1024;

/**
 * The size this process applied itself. The variable is removed again, so the
 * store's upload gate reads this instead. Same key as
 * `packages/claudexor/bin/libuv-pool.js` and the daemon's `store/libuv-pool.ts`.
 */
const APPLIED_POOL = Symbol.for("claudexor.libuvPoolSize");

/**
 * Threads for this machine: parallelism plus four, at least 8, at most
 * libuv's maximum. A physical pool size, not a policy. Four blocked upload
 * writes filled the default of 4 and `dns.lookup("localhost")` did not start
 * within 400 ms, while the request loop still ticked (46 ticks, mean 12 ms,
 * max 16 ms). Same formula as `packages/claudexor/bin/libuv-pool.js`.
 */
export function hostLibuvPoolSize(): number {
  return Math.min(LIBUV_POOL_MAX, Math.max(8, os.availableParallelism() + 4));
}

/**
 * An operator-set value is left untouched, including one libuv will clamp, and
 * harness children inherit it. Otherwise assign the host size and submit one
 * stat: libuv creates its pool on that first request, synchronously, reading
 * the variable once. Then record the size and remove the variable, so harness
 * children (and their tools and servers) start with their own default pool.
 */
export function applyHostLibuvPool(): void {
  const global = globalThis as Record<symbol, unknown>;
  if (process.env.UV_THREADPOOL_SIZE || global[APPLIED_POOL] !== undefined) return;
  const size = hostLibuvPoolSize();
  process.env.UV_THREADPOOL_SIZE = String(size);
  stat(".", () => undefined);
  global[APPLIED_POOL] = size;
  delete process.env.UV_THREADPOOL_SIZE;
}
