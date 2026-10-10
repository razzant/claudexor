import { z } from "zod/v3";

export const DAEMON_MAX_CONCURRENT_DEFAULT = "unlimited" as const;
export const MAX_PARALLEL_CANDIDATES_DEFAULT = 4;
export const MAX_DEEP_SCAN_WIDTH_DEFAULT = 8;
export const MAX_COUNCIL_MEMBERS_DEFAULT = 4;
const positiveCount = z.number().int().safe().positive();

/** Admission has no implicit finite ceiling; zero/null never mean unlimited. */
export const ConcurrencyLimit = z.union([positiveCount, z.literal("unlimited")]);
export type ConcurrencyLimit = z.infer<typeof ConcurrencyLimit>;

export const RuntimeConcurrencyCaps = z
  .object({
    max_concurrent: ConcurrencyLimit.default(DAEMON_MAX_CONCURRENT_DEFAULT).describe(
      "Global regular-job limit across model and non-model classes, or unlimited; applied at startup.",
    ),
    max_concurrent_non_model_jobs: ConcurrencyLimit.default(DAEMON_MAX_CONCURRENT_DEFAULT).describe(
      "Regular non-model jobs admitted at once, or unlimited; applied at startup.",
    ),
    max_concurrent_model_operations: ConcurrencyLimit.default(
      DAEMON_MAX_CONCURRENT_DEFAULT,
    ).describe("Model-operation runners admitted at once, or unlimited; applied at startup."),
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

type CapValues = z.infer<typeof RuntimeConcurrencyCaps>;
export type ConcurrencyKey = keyof CapValues;
export const CONCURRENCY_KEYS = Object.keys(RuntimeConcurrencyCaps.shape) as ConcurrencyKey[];
export const ConcurrencySource = z.enum([
  "default",
  "config",
  "environment",
  "embedder",
  "unknown",
]);
export type ConcurrencySource = z.infer<typeof ConcurrencySource>;
/** Derived metadata, never a writable GlobalConfig runtime field. */
export const RuntimeConcurrencySources = z.object({
  max_concurrent: ConcurrencySource,
  max_concurrent_non_model_jobs: ConcurrencySource,
  max_concurrent_model_operations: ConcurrencySource,
  max_parallel_candidates: ConcurrencySource,
  max_deep_scan_width: ConcurrencySource,
  max_council_members: ConcurrencySource,
});
export type RuntimeConcurrencySources = z.infer<typeof RuntimeConcurrencySources>;
export type RuntimeConcurrencyCaps = CapValues & { readonly sources?: RuntimeConcurrencySources };

export function runtimeConcurrencyCaps(
  config: { runtime: Partial<CapValues> },
  sources?: RuntimeConcurrencySources,
): RuntimeConcurrencyCaps {
  const values = RuntimeConcurrencyCaps.parse(
    Object.fromEntries(CONCURRENCY_KEYS.map((key) => [key, config.runtime[key]])),
  );
  return Object.freeze({
    ...values,
    ...(sources ? { sources: Object.freeze({ ...sources }) } : {}),
  });
}

const RuntimeConcurrencyValues = z.object({
  maxConcurrent: ConcurrencyLimit,
  // Absent in a pre-class engine. Readers must keep that support unknown.
  maxConcurrentNonModelJobs: ConcurrencyLimit.optional(),
  maxConcurrentModelOperations: ConcurrencyLimit.optional(),
  maxParallelCandidates: positiveCount,
  maxDeepScanWidth: positiveCount,
  maxCouncilMembers: positiveCount.min(2),
  sources: RuntimeConcurrencySources.optional(),
});

export const RuntimeConcurrencyState = z.object({
  configured: RuntimeConcurrencyValues,
  effective: RuntimeConcurrencyValues,
  restartRequired: z.boolean(),
});

export function concurrencyValues(caps: RuntimeConcurrencyCaps) {
  return {
    maxConcurrent: caps.max_concurrent,
    maxConcurrentNonModelJobs: caps.max_concurrent_non_model_jobs,
    maxConcurrentModelOperations: caps.max_concurrent_model_operations,
    maxParallelCandidates: caps.max_parallel_candidates,
    maxDeepScanWidth: caps.max_deep_scan_width,
    maxCouncilMembers: caps.max_council_members,
    ...(caps.sources ? { sources: caps.sources } : {}),
  };
}

export function concurrencyState(
  configured: RuntimeConcurrencyCaps,
  effective: RuntimeConcurrencyCaps,
) {
  return {
    configured: concurrencyValues(configured),
    effective: concurrencyValues(effective),
    restartRequired: CONCURRENCY_KEYS.some((key) => configured[key] !== effective[key]),
  };
}

export const JobAdmissionClass = z.enum(["model", "non_model"]);
export type JobAdmissionClass = z.infer<typeof JobAdmissionClass>;
export const JobAdmissionBlocker = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global_limit"), limit: positiveCount }),
  z.object({ kind: z.literal("class_limit"), limit: positiveCount }),
  z.object({ kind: z.literal("thread_busy") }),
  z.object({ kind: z.literal("stopping") }),
]);
export type JobAdmissionBlocker = z.infer<typeof JobAdmissionBlocker>;
/** Current scheduler observation only; terminal receipts do not persist it. */
export const JobAdmission = z.object({
  class: JobAdmissionClass,
  phase: z.enum(["queued", "active"]),
  blockers: z.array(JobAdmissionBlocker),
});
export type JobAdmission = z.infer<typeof JobAdmission>;
export const JobAdmissionActivity = z.object({
  active: z.object({
    model: z.number().int().nonnegative(),
    non_model: z.number().int().nonnegative(),
  }),
  queued: z.object({
    model: z.number().int().nonnegative(),
    non_model: z.number().int().nonnegative(),
  }),
});
export type JobAdmissionActivity = z.infer<typeof JobAdmissionActivity>;
