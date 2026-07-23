import { join } from "node:path";
import {
  SCHEMA_VERSION,
  deriveAuthRouteReason,
  RunTelemetry as RunTelemetrySchema,
  type DeepScanSynthesis,
  type ModeKind,
  type RouteRankingRationale,
  type TaskContract,
} from "@claudexor/schema";
import type { ArtifactStore } from "@claudexor/artifact-store";
import { nowIso } from "@claudexor/util";
import {
  aggregateRunTokenUsage,
  aggregateRunWebEvidence,
  attemptTelemetryRecord,
  type AttemptTelemetry,
} from "./attemptTelemetry.js";

/** The run's final telemetry artifact incl. the auth-route receipt (one owner). */
export function writeRunTelemetryArtifact(args: {
  store: ArtifactStore;
  finalDir: string;
  contract: TaskContract;
  runId: string;
  taskId: string;
  mode: ModeKind;
  attempts: { attemptId: string; harnessId: string; telemetry: AttemptTelemetry }[];
  finalAttemptId: string | null;
  /** QA-034: typed routing rationale recorded at pool ordering; null when no
   * ranking was computed (explicit single-harness pool) or on legacy runs. */
  routingRationale?: RouteRankingRationale | null;
  /** Deep-scan reducer outcome (#27); null/omitted on non-deep-scan runs. */
  deepScanSynthesis?: DeepScanSynthesis | null;
  resolveAuthPreference: (harnessId: string) => TaskContract["auth_preference"];
}): void {
  const { store, finalDir, contract, runId, taskId, mode, attempts, finalAttemptId } = args;
  {
    const records = attempts.map((a) =>
      attemptTelemetryRecord(a.attemptId, a.harnessId, a.telemetry),
    );
    const finalRecord = finalAttemptId
      ? records.find((r) => r.attempt_id === finalAttemptId)
      : undefined;
    const runWeb = finalRecord?.web ?? aggregateRunWebEvidence(records, contract);
    const telemetry = RunTelemetrySchema.parse({
      schema_version: SCHEMA_VERSION,
      run_id: runId,
      task_id: taskId,
      mode,
      requested_access: contract.access.requested_profile,
      effective_access: contract.access.effective_profile,
      external_context_policy: contract.external_context.policy,
      effective_web_mode:
        finalRecord?.web.effective_mode ?? contract.external_context.effective_mode,
      web_required: contract.external_context.web_required,
      final_attempt_id: finalAttemptId,
      web: runWeb,
      attempts: records,
      request_requirements: records.flatMap((record) => record.request_requirements),
      tool_warnings_total: records.reduce((sum, r) => sum + r.outcome.tool_warnings_count, 0),
      usage_totals: aggregateRunTokenUsage(records),
      auth_route: (() => {
        // The FINAL attempt's disclosure decides the run's route receipt (it
        // produced the deliverable); fall back to the first disclosing attempt.
        const disclosing =
          (finalRecord?.auth_mode ? finalRecord : undefined) ??
          records.find((r) => r.auth_mode !== null) ??
          finalRecord ??
          records[0];
        const requestedModel = disclosing?.requested_model ?? null;
        const observedModel = disclosing?.observed_model ?? null;
        // The requested route is the RESOLVED per-harness preference of the
        // disclosing lane (run-level scalar → per-harness config → global),
        // not the bare run-level scalar — otherwise a configured
        // harnesses.<id>.auth_preference=api_key reads as requested=auto.
        const requestedRoute = disclosing?.harness_id
          ? args.resolveAuthPreference(disclosing.harness_id)
          : contract.auth_preference;
        return {
          requested: requestedRoute,
          effective: disclosing?.auth_mode ?? null,
          source: disclosing?.auth_source ?? null,
          reason: deriveAuthRouteReason(requestedRoute, disclosing?.auth_mode ?? null),
          harness_id: disclosing?.harness_id ?? null,
          attempt_id: disclosing?.attempt_id ?? null,
          // The DECIDING attempt's disclosed profile (adapters stamp it on
          // stream events; rotation makes it differ from the contract's
          // requested id) — never the frozen request.
          profile_id: disclosing?.profile_id ?? null,
          // Typed mismatch, only when BOTH sides are known and differ.
          model_mismatch:
            requestedModel !== null && observedModel !== null && requestedModel !== observedModel
              ? { requested: requestedModel, observed: observedModel }
              : null,
        };
      })(),
      routing_rationale: args.routingRationale ?? null,
      deep_scan_synthesis: args.deepScanSynthesis ?? null,
      generated_at: nowIso(),
    });
    store.writeYaml(join(finalDir, "telemetry.yaml"), telemetry);
  }
}
