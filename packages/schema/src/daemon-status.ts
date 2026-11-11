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

const LatencyFacts = z.object({
  count: z.number().int().nonnegative(),
  p50Ms: ms.nullable(),
  p99Ms: ms.nullable(),
  maxMs: ms.nullable(),
});
export const DaemonTimingFacts = z.object({
  windowMs: ms.nullable(),
  windowEndedAt: IsoTimestamp.nullable(),
  routes: z
    .array(
      z.object({
        method: z.string(),
        route: z.string(),
        outcomes: z
          .array(
            z.object({
              outcome: z.enum([
                "served",
                "not_found",
                "disconnected_at_entry",
                "disconnected",
                "failed",
              ]),
              lifetime: LatencyFacts,
              window: LatencyFacts.nullable(),
            }),
          )
          .max(5)
          .optional(),
        lifetime: LatencyFacts,
        window: LatencyFacts.nullable(),
      }),
    )
    .max(256)
    .describe(
      "Completed responses or disconnects by method and catalog template (never raw URLs). SSE latency includes the stream lifetime. At most 256 keys including OTHER <unmatched>. Fixed histograms use microseconds and two significant digits; max is exact to a microsecond. Window is the last completed loop-facts window, null before the first; empty windows have count zero and null latencies.",
    ),
  worstSync: z
    .array(
      z.object({
        operation: z.enum([
          "store.begin_immediate",
          "store.commit",
          "store.external_write",
          "control.run_detail",
          "control.run_summary",
          "scope.persist",
        ]),
        durationMs: ms,
        at: IsoTimestamp,
      }),
    )
    .max(32)
    .describe(
      "The 32 longest instrumented synchronous sections since process start, descending by duration, retaining later samples on ties. Labels contain no SQL, paths, IDs or payloads. Scope persistence measures synchronous serialization only; its file writes are asynchronous. Sections can overlap; these facts do not attribute a stall to disk or another cause.",
    ),
  bulk: z
    .array(
      z.object({
        kind: z.enum(["cursor", "detail", "summary", "event-replay", "artifact"]),
        queue: LatencyFacts,
        projection: LatencyFacts,
      }),
    )
    .optional()
    .describe(
      "Finite bulk reads: lifetime queue residence and worker execution wall times, including scheduling and asynchronous retained-output publication. These are not main-thread synchronous sections.",
    ),
});
export type DaemonTimingFacts = z.infer<typeof DaemonTimingFacts>;

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
  timing: DaemonTimingFacts.optional().describe(
    "Bounded process timing facts; absent on older engines.",
  ),
  loop: DaemonLoopFacts.nullable().describe(
    "The last completed event-loop window; null until the first window completes.",
  ),
});
export type ControlDaemonStatus = z.infer<typeof ControlDaemonStatus>;
