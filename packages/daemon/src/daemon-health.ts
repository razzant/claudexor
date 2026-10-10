import {
  DAEMON_MAX_CONCURRENT_EMBEDDER_FALLBACK,
  concurrencyValues,
  type RuntimeConcurrencyCaps,
} from "@claudexor/schema";
import type { DaemonServingMode } from "./serving-admission.js";

import { loopFacts } from "./loop-facts.js";
import { memoryFacts } from "./memory-facts.js";

export function daemonHealth(
  startedAt: number,
  queue: number,
  active: number,
  jobs: number,
  stopping: boolean,
  servingMode: DaemonServingMode,
  maxConcurrent: number,
  caps?: RuntimeConcurrencyCaps,
) {
  return {
    ok: true,
    memory: memoryFacts(),
    loop: loopFacts(),
    uptime_ms: Date.now() - startedAt,
    queue,
    running: active > 0,
    active,
    jobs,
    stopping,
    servingMode,
    // Embedders that configure only the queue cannot attest strategy limits.
    capacity: caps ? { ...concurrencyValues(caps), maxConcurrent } : { maxConcurrent },
  };
}

/** Preserve the existing direct embedder override and twelve-job fallback. */
export function daemonConcurrencyLimit(options: {
  maxConcurrent?: number;
  runtimeConcurrencyCaps?: RuntimeConcurrencyCaps;
}): number {
  return (
    options.maxConcurrent ??
    options.runtimeConcurrencyCaps?.max_concurrent ??
    DAEMON_MAX_CONCURRENT_EMBEDDER_FALLBACK
  );
}
