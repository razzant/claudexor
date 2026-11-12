import {
  type ControlProcessScope,
  RunProcessScopeLater,
  RunProcessScopeOutcome,
} from "@claudexor/schema";
import type { DaemonRunRecord } from "./run-record.js";
import { safeReadStructuredArtifact } from "./run-artifact-read.js";

/** The run lifecycle has ended (ControlRunState terminal members). */
function isTerminalRunState(state: string): boolean {
  return (
    state === "succeeded" || state === "failed" || state === "cancelled" || state === "interrupted"
  );
}

/**
 * `summary.processScope` of a run detail (INV-144): the compact scope outcome
 * projected from `final/process_scope.yaml` so a host can decide whether to
 * reuse the workspace. The artifact is written before the terminal is
 * published, so a live run can already carry it: the projection is null until
 * the run is terminal, and null for historical runs without the artifact
 * (unknown, never clean).
 */
export function projectProcessScope(
  rec: DaemonRunRecord,
  state: string,
): ControlProcessScope | null {
  if (!isTerminalRunState(state)) return null;
  const scope = safeReadStructuredArtifact(rec, "final/process_scope.yaml", RunProcessScopeOutcome);
  return scope ? compact(scope) : null;
}

/**
 * `summary.processScopeLater` of a run detail (#613): the latest later, separately
 * bounded settlement attempt, read from `final/process_scope_later.yaml` beside the
 * unchanged terminal record; null while live, when none ran or it is unreadable
 * (unknown, never clean).
 */
export function projectProcessScopeLater(
  rec: DaemonRunRecord,
  state: string,
): (ControlProcessScope & { attempt: number; at: string }) | null {
  if (!isTerminalRunState(state)) return null;
  const later = safeReadStructuredArtifact(
    rec,
    "final/process_scope_later.yaml",
    RunProcessScopeLater,
  );
  return later ? { ...compact(later.outcome), attempt: later.attempt, at: later.at } : null;
}

function compact(scope: RunProcessScopeOutcome): ControlProcessScope {
  return {
    settled: scope.settled,
    coverage: scope.coverage,
    completeness: scope.completeness,
    census: scope.census,
    survivors: scope.survivors.length,
    unreadable: scope.unreadable.length,
  };
}
