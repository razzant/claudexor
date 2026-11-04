import os from "node:os";

/** libuv refuses a pool above this (MAX_THREADPOOL_SIZE). */
export const LIBUV_POOL_MAX = 1024;

/**
 * Threads for this machine: parallelism plus four, at least 8, at most
 * libuv's maximum. A physical pool size, not a policy. Four blocked upload
 * writes filled the default of 4 and `dns.lookup("localhost")` did not start
 * within 400 ms, while the request loop still ticked (46 ticks, mean 12 ms,
 * max 16 ms). Same formula as `packages/cli/src/host-libuv-pool.ts`.
 */
export function hostLibuvPoolSize() {
  return Math.min(LIBUV_POOL_MAX, Math.max(8, os.availableParallelism() + 4));
}

/** Leave an operator-set value untouched, including one libuv will clamp. */
export function applyHostLibuvPool() {
  if (process.env.UV_THREADPOOL_SIZE) return;
  process.env.UV_THREADPOOL_SIZE = String(hostLibuvPoolSize());
}
