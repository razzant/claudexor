import { z } from "zod/v3";
import { AccessProfile, IsoTimestamp } from "./primitives.js";
import { RunFailureCategory, RunFailureCode } from "./control-run-failure.js";

/**
 * `GET /v2/daemon/route-health`: per-route run outcomes over a fixed window,
 * computed on demand from the retained run records. A route is one harness
 * crossed with one effective access profile. Facts only: nothing here carries
 * a threshold, an alarm or a remedy; the reader judges the shares.
 */

/** The fixed window every answer covers: the last seven days before `generatedAt`. */
export const ROUTE_HEALTH_WINDOW_DAYS = 7 as const;
/** Longest failure message a group carries (its first line, redacted). */
export const ROUTE_HEALTH_MESSAGE_MAX_CHARS = 160;
/** Most failure groups one route reports. */
export const ROUTE_HEALTH_TOP_FAILURES = 3;

const count = z.number().int().nonnegative();

export const ControlRouteHealthFailure = z
  .object({
    category: RunFailureCategory.describe(
      "Typed failure category shared by every run in the group; unknown when the run left no typed failure record.",
    ),
    code: RunFailureCode.nullable().describe(
      "Failure sub-code shared by the group; null when the failures carried none.",
    ),
    message: z
      .string()
      .max(ROUTE_HEALTH_MESSAGE_MAX_CHARS)
      .describe(
        "First line of the failures' display-safe message, redacted and cut to 160 characters; empty when the run left no message.",
      ),
    count: z.number().int().positive().describe("Failed runs of the route in this group."),
  })
  .strict()
  .describe("One group of a route's failed runs, keyed by category, code and message.");
export type ControlRouteHealthFailure = z.infer<typeof ControlRouteHealthFailure>;

export const ControlRouteHealthRoute = z
  .object({
    harnessId: z
      .string()
      .min(1)
      .describe(
        "Harness of the route: the run's settled route harness, else its failure's harness, else its primary harness, else unknown.",
      ),
    access: z
      .enum([...AccessProfile.options, "unknown"])
      .describe(
        "Effective access profile the engine passed to the route; unknown when the run recorded none. The retired external_sandbox_full counts as full.",
      ),
    runs: count.describe(
      "Terminal product runs of the route created inside the window; always succeeded + failed + cancelled + other.",
    ),
    succeeded: count.describe("Runs whose lifecycle ended succeeded."),
    failed: count.describe("Runs whose lifecycle ended failed."),
    cancelled: count.describe("Runs whose lifecycle ended cancelled or interrupted."),
    other: count.describe("Runs in any other terminal lifecycle."),
    topFailures: z
      .array(ControlRouteHealthFailure)
      .max(ROUTE_HEALTH_TOP_FAILURES)
      .describe("At most three groups of the route's failed runs, most frequent first."),
  })
  .strict()
  .refine(
    (route) => route.runs === route.succeeded + route.failed + route.cancelled + route.other,
    { message: "runs must equal succeeded + failed + cancelled + other", path: ["runs"] },
  )
  .refine(
    (route) => route.topFailures.reduce((sum, group) => sum + group.count, 0) <= route.failed,
    { message: "topFailures cannot count more runs than failed", path: ["topFailures"] },
  )
  .describe("Outcome counts of one route (harness x effective access) inside the window.");
export type ControlRouteHealthRoute = z.infer<typeof ControlRouteHealthRoute>;

export const ControlRouteHealth = z
  .object({
    windowDays: z.literal(ROUTE_HEALTH_WINDOW_DAYS).describe("Length of the fixed window in days."),
    from: IsoTimestamp.describe(
      "Start of the window: generatedAt minus windowDays. The window holds the terminal product runs created at or after it.",
    ),
    generatedAt: IsoTimestamp.describe("When the daemon computed this answer; nothing is stored."),
    scannedRuns: count.describe(
      "Terminal product runs read inside the window; the sum of every route's runs.",
    ),
    complete: z
      .boolean()
      .describe(
        "True when the scan reached the window start or the end of the retained run records (the engine keeps terminal records for at least thirty days, longer than the window); false when it stopped early.",
      ),
    incompleteReason: z
      .enum(["scan_bound"])
      .nullable()
      .describe(
        "Why the scan stopped early: scan_bound means the fixed newest-first record bound was reached inside the window, so older runs of the window are not counted. Null when complete.",
      ),
    routes: z
      .array(ControlRouteHealthRoute)
      .describe(
        "Every route with at least one run in the window, sorted by harnessId, then access.",
      ),
  })
  .strict()
  .describe(
    "Per-route run outcomes over the last seven days, computed on demand from retained run records. Facts only: no thresholds, no alarms.",
  );
export type ControlRouteHealth = z.infer<typeof ControlRouteHealth>;
