/**
 * The bounded per-run read behind `GET /v2/daemon/route-health`. Route health
 * needs four facts of a terminal run (its settled route, its failure record,
 * its primary harness and its effective access) and nothing else of the run
 * card, so it never goes through the shared summarizer, which also projects
 * budgets from the whole event journal and reads artifacts without a size
 * limit. This read opens at most three small engine artifacts, each capped at
 * ROUTE_HEALTH_ARTIFACT_MAX_BYTES, and never the event journal. An artifact
 * that is absent, malformed or over the cap counts as absent, so the run
 * falls back along the contract's attribution order, down to unknown. It runs
 * in the shared bulk worker (job kind `route-facts`), off the control plane.
 */
import { RunFailure, RunTelemetry, TaskContract, type ControlRunSummary } from "@claudexor/schema";
import { safeReadStructuredArtifact } from "./run-artifact-read.js";
import { controlRoute } from "./run-card-facts.js";
import { paramsRecord, type DaemonRunRecord } from "./run-record.js";

/** Read allowance per artifact; a larger artifact counts as absent. */
export const ROUTE_HEALTH_ARTIFACT_MAX_BYTES = 1_048_576;

/** The run-card fields route health reads, and only those. */
export type RouteHealthFacts = Pick<
  ControlRunSummary,
  "route" | "failure" | "primaryHarness" | "effectiveAccess" | "error"
>;

function bounded<T>(
  record: DaemonRunRecord,
  relPath: string,
  schema: { parse(value: unknown): T },
): T | null {
  try {
    return safeReadStructuredArtifact(record, relPath, schema, ROUTE_HEALTH_ARTIFACT_MAX_BYTES);
  } catch (error) {
    // Over the allowance, or rewritten mid-read: absent, like a missing file.
    if ((error as { status?: number }).status === 503) return null;
    throw error;
  }
}

export function routeHealthFactsOf(record: DaemonRunRecord): RouteHealthFacts {
  const params = paramsRecord(record);
  const telemetry = bounded(record, "final/telemetry.yaml", RunTelemetry);
  // Access truth comes from engine artifacts only, as on the run card; the
  // task contract is read only when telemetry names no effective access.
  const effectiveAccess =
    telemetry?.effective_access ??
    bounded(record, "context/task.yaml", TaskContract)?.access.effective_profile;
  // The run card's failure rule (run-card-facts readFailure) with a bounded read:
  // a typed failure record, else the job error as an unknown-category failure.
  const failure =
    bounded(record, "final/failure.yaml", RunFailure) ??
    (record.error
      ? RunFailure.parse({
          category: "unknown",
          safeMessage: record.error,
          runDir: record.runDir ?? null,
        })
      : null);
  return {
    route: controlRoute(telemetry, params),
    failure,
    primaryHarness:
      typeof params["primaryHarness"] === "string" ? params["primaryHarness"] : undefined,
    effectiveAccess,
    error: record.error,
  };
}
