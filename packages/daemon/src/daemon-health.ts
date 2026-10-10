import {
  CONCURRENCY_KEYS,
  ConcurrencyLimit,
  RuntimeConcurrencyCaps,
  concurrencyValues,
  runtimeConcurrencyCaps,
  type JobAdmissionActivity,
  type RuntimeConcurrencySources,
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
  caps: RuntimeConcurrencyCaps,
  activity: JobAdmissionActivity,
  strategiesDisclosed: boolean,
) {
  const values = concurrencyValues(caps);
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
    admission: activity,
    // A direct embedder's runner may use different strategy widths. Only the
    // startup-wired strategy snapshot certifies those independent values.
    capacity: strategiesDisclosed
      ? values
      : {
          maxConcurrent: values.maxConcurrent,
          maxConcurrentNonModelJobs: values.maxConcurrentNonModelJobs,
          maxConcurrentModelOperations: values.maxConcurrentModelOperations,
          sources: {
            ...values.sources,
            max_parallel_candidates: "unknown",
            max_deep_scan_width: "unknown",
            max_council_members: "unknown",
          },
        },
  };
}

/** Capture all admission axes once. Explicit legacy maxConcurrent remains a
 * GLOBAL override; omission has no hidden twelve-job or twenty-four-job cap. */
export function daemonConcurrencyCaps(options: {
  maxConcurrent?: ConcurrencyLimit;
  runtimeConcurrencyCaps?: RuntimeConcurrencyCaps;
}): RuntimeConcurrencyCaps {
  const supplied = options.runtimeConcurrencyCaps;
  const values = runtimeConcurrencyCaps({ runtime: supplied ?? {} });
  const sources = {
    ...Object.fromEntries(
      CONCURRENCY_KEYS.map((key) => [
        key,
        Object.hasOwn(supplied ?? {}, key) ? "embedder" : "default",
      ]),
    ),
    ...supplied?.sources,
  } as RuntimeConcurrencySources;
  if (options.maxConcurrent !== undefined) {
    sources.max_concurrent = "embedder";
  }
  return runtimeConcurrencyCaps(
    {
      runtime: {
        ...values,
        ...(options.maxConcurrent !== undefined
          ? { max_concurrent: ConcurrencyLimit.parse(options.maxConcurrent) }
          : {}),
      },
    },
    sources,
  );
}
