import { z } from "zod/v3";

export const DAEMON_MAX_CONCURRENT_DEFAULT = 24;
export const DAEMON_MAX_CONCURRENT_EMBEDDER_FALLBACK = 12;
export const MAX_PARALLEL_CANDIDATES_DEFAULT = 4;
export const MAX_DEEP_SCAN_WIDTH_DEFAULT = 8;
export const MAX_COUNCIL_MEMBERS_DEFAULT = 4;
const positiveCount = z.number().int().safe().positive();

/** Operator capacity, separate from per-request strategy width and nested Delegate. */
export const RuntimeConcurrencyCaps = z
  .object({
    max_concurrent: positiveCount
      .default(DAEMON_MAX_CONCURRENT_DEFAULT)
      .describe("Regular daemon jobs per data root; applied at daemon startup."),
    max_parallel_candidates: positiveCount
      .default(MAX_PARALLEL_CANDIDATES_DEFAULT)
      .describe("Active best-of candidates or deep-scan scouts within one run."),
    max_deep_scan_width: positiveCount
      .default(MAX_DEEP_SCAN_WIDTH_DEFAULT)
      .describe("Maximum scout count in one deep scan."),
    max_council_members: positiveCount
      .min(2)
      .default(MAX_COUNCIL_MEMBERS_DEFAULT)
      .describe("Maximum distinct Council members; Council requires at least two."),
  })
  .strict();
export type RuntimeConcurrencyCaps = z.infer<typeof RuntimeConcurrencyCaps>;

export function runtimeConcurrencyCaps(config: {
  runtime: RuntimeConcurrencyCaps;
}): RuntimeConcurrencyCaps {
  const { max_concurrent, max_parallel_candidates, max_deep_scan_width, max_council_members } =
    config.runtime;
  return Object.freeze(
    RuntimeConcurrencyCaps.parse({
      max_concurrent,
      max_parallel_candidates,
      max_deep_scan_width,
      max_council_members,
    }),
  );
}

const RuntimeConcurrencyValues = z.object({
  maxConcurrent: positiveCount,
  maxParallelCandidates: positiveCount,
  maxDeepScanWidth: positiveCount,
  maxCouncilMembers: positiveCount.min(2),
});

/** Omitted on older engines; never fabricate their running capacity from defaults. */
export const RuntimeConcurrencyState = z.object({
  configured: RuntimeConcurrencyValues,
  effective: RuntimeConcurrencyValues,
  restartRequired: z.boolean(),
});

export function concurrencyValues(caps: RuntimeConcurrencyCaps) {
  return {
    maxConcurrent: caps.max_concurrent,
    maxParallelCandidates: caps.max_parallel_candidates,
    maxDeepScanWidth: caps.max_deep_scan_width,
    maxCouncilMembers: caps.max_council_members,
  };
}

export function concurrencyState(
  configured: RuntimeConcurrencyCaps,
  effective: RuntimeConcurrencyCaps,
) {
  return {
    configured: concurrencyValues(configured),
    effective: concurrencyValues(effective),
    restartRequired: (Object.keys(configured) as Array<keyof RuntimeConcurrencyCaps>).some(
      (key) => configured[key] !== effective[key],
    ),
  };
}
