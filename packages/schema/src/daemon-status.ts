import { z } from "zod/v3";
import { IsoTimestamp } from "./primitives.js";
import { RuntimeConcurrencyState, JobAdmissionActivity } from "./runtime-concurrency.js";
import { DaemonStoreFacts } from "./store-status.js";

const bytes = z.number().int().nonnegative();
export const DaemonMemoryFacts = z.object({
  heapUsedBytes: bytes,
  heapLimitBytes: bytes,
  rssBytes: bytes,
  externalBytes: bytes,
  nodeHeapArgs: z.array(z.string()),
  atAdmission: z.object({ heapUsedBytes: bytes, rssBytes: bytes, at: IsoTimestamp }).nullable(),
  sampledAt: IsoTimestamp,
});
export type DaemonMemoryFacts = z.infer<typeof DaemonMemoryFacts>;

const ms = z.number().nonnegative();
/** One completed measurement window of the daemon's JS event loop. Facts only:
 * nothing reads them to admit, delay or refuse work. */
export const DaemonLoopFacts = z.object({
  windowMs: ms.describe(
    "How long the window lasted. Windows roll every ten seconds; a stalled loop rolls late, so a longer window is itself evidence of a stall.",
  ),
  windowEndedAt: IsoTimestamp,
  delay: z
    .object({
      resolutionMs: ms.describe(
        "Sampling interval. Each sample is the time between two sampling ticks, so an idle loop's p50 sits near this value, not near zero.",
      ),
      samples: z.number().int().nonnegative(),
      p50Ms: ms,
      p99Ms: ms,
      maxMs: ms,
    })
    .nullable()
    .describe(
      "Event-loop delay percentiles over the window (perf_hooks.monitorEventLoopDelay, reset each window); null when the window recorded no sample.",
    ),
  utilization: z
    .number()
    .min(0)
    .max(1)
    .nullable()
    .describe(
      "Share of the window the loop spent busy (performance.eventLoopUtilization delta); null for a window too short to measure.",
    ),
  gc: z
    .object({ count: z.number().int().nonnegative(), totalMs: ms, maxMs: ms })
    .describe("Garbage-collection pauses observed in the window: count, summed and longest."),
});
export type DaemonLoopFacts = z.infer<typeof DaemonLoopFacts>;

/** Authenticated process facts, separate from the strict protocol handshake. */
export const ControlDaemonStatus = z.object({
  ok: z.literal(true),
  uptime_ms: z.number().nonnegative(),
  queue: z.number().int().nonnegative(),
  running: z.boolean(),
  active: z.number().int().nonnegative(),
  jobs: z.number().int().nonnegative(),
  stopping: z.boolean(),
  servingMode: z.enum(["normal", "recovery_only"]),
  capacity: RuntimeConcurrencyState.shape.effective.partial().required({ maxConcurrent: true }),
  admission: JobAdmissionActivity.optional(),
  memory: DaemonMemoryFacts,
  store: DaemonStoreFacts.optional(),
  loop: DaemonLoopFacts.nullable().describe(
    "The last completed event-loop window; null until the first window completes.",
  ),
});
export type ControlDaemonStatus = z.infer<typeof ControlDaemonStatus>;
