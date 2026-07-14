import { z } from "zod";
import {
  AccessProfile,
  ExternalContextPolicy,
  Id,
  IsoTimestamp,
  ModeKind,
  SchemaVersion,
} from "./primitives.js";
import { ToolKind } from "./harness.js";
import { AuthMode } from "./budget.js";

/**
 * Run telemetry artifact (`final/telemetry.yaml`).
 *
 * The orchestrator is the ONLY computer of web/tool evidence. Surfaces
 * (control-api, CLI, app) project this artifact; they must not re-derive
 * evidence from raw events. Legacy runs without the artifact render an honest
 * "telemetry unavailable" state instead of a recomputed guess.
 */

export const WebEvidenceStatus = z
  .enum(["none", "attempted", "satisfied", "failed", "unverified"])
  .describe(
    "Web-evidence verdict for an attempt/run: none (no web activity), attempted, satisfied (required evidence produced), failed, or unverified.",
  );
export type WebEvidenceStatus = z.infer<typeof WebEvidenceStatus>;

export const WebEvidenceRecord = z
  .object({
    required: z.boolean().default(false).describe("Whether the run required web evidence."),
    /** Requested policy for the run. */
    policy: ExternalContextPolicy.default("auto").describe("Requested web policy for the run."),
    /** Mode actually executed by the harness route (e.g. claude `cached` upgrades to `live`, disclosed). */
    effective_mode: ExternalContextPolicy.default("auto").describe(
      "Policy actually executed by the harness route (disclosed upgrades, e.g. cached to live).",
    ),
    attempted: z.boolean().default(false).describe("Whether any web activity was attempted."),
    satisfied: z
      .boolean()
      .default(false)
      .describe("Whether the web-evidence requirement was satisfied."),
    status: WebEvidenceStatus.default("none"),
    tool: z
      .string()
      .nullable()
      .default(null)
      .describe("Web tool that produced the evidence, when any."),
    target: z
      .string()
      .nullable()
      .default(null)
      .describe("Redacted target (query/url) of the web activity, when any."),
    error_summary: z
      .string()
      .nullable()
      .default(null)
      .describe("Redacted error detail when web activity failed."),
  })
  .describe(
    "Typed web-evidence record computed by the orchestrator; surfaces project it and never re-derive evidence from raw events.",
  );
export type WebEvidenceRecord = z.infer<typeof WebEvidenceRecord>;

export const ToolErrorRecord = z
  .object({
    tool: z.string().describe("Native tool name that errored."),
    kind: ToolKind.default("other"),
    target: z
      .string()
      .nullable()
      .default(null)
      .describe("Redacted target of the tool use, when known."),
    summary: z.string().describe("Redacted error summary."),
    /** True when a later successful result of the same tool exists in the same attempt. */
    recovered: z
      .boolean()
      .default(false)
      .describe("True when a later successful result of the same tool exists in the same attempt."),
    tool_use_id: z
      .string()
      .nullable()
      .default(null)
      .describe("Tool use id correlating the error to its call, when known."),
  })
  .describe("One tool error observed during an attempt.");
export type ToolErrorRecord = z.infer<typeof ToolErrorRecord>;

export const TransientFailureRecord = z
  .object({
    kind: z
      .enum(["network", "stream_disconnect", "service_unavailable", "timeout", "unknown"])
      .default("unknown")
      .describe("Kind of transient failure."),
    retry_delay_ms: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .default(null)
      .describe("Suggested retry delay in milliseconds, when reported."),
  })
  .describe("An adapter-declared transient failure that informed bounded retry policy.");
export type TransientFailureRecord = z.infer<typeof TransientFailureRecord>;

export const AttemptOutcomeStatus = z
  .enum(["success", "success_with_warnings", "blocked", "failed"])
  .describe("Outcome of one attempt: success, success_with_warnings, blocked, or failed.");
export type AttemptOutcomeStatus = z.infer<typeof AttemptOutcomeStatus>;

/**
 * Contract/outcome truth for one attempt. Tool errors are tracked separately
 * from whether the attempt produced the work product the intent asked for.
 */
export const AttemptOutcome = z
  .object({
    deliverable_present: z
      .boolean()
      .default(false)
      .describe("Whether the attempt produced the deliverable the intent asked for."),
    gates_passed: z
      .boolean()
      .nullable()
      .default(null)
      .describe("Whether deterministic gates passed; null when no gates ran."),
    harness_errored: z.boolean().default(false).describe("Whether the harness itself errored."),
    web_required_unsatisfied: z
      .boolean()
      .default(false)
      .describe("True when required web evidence was not satisfied."),
    tool_warnings_count: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("Count of tool warnings in the attempt."),
    status: AttemptOutcomeStatus.default("success"),
  })
  .describe(
    "Contract/outcome truth for one attempt; tool errors are tracked separately from deliverable production.",
  );
export type AttemptOutcome = z.infer<typeof AttemptOutcome>;

export const AttemptTelemetryRecord = z
  .object({
    attempt_id: Id.describe("Attempt id."),
    harness_id: Id.describe("Harness that ran the attempt."),
    /**
     * Model identity the harness stream actually reported (route evidence).
     * Null when the stream never disclosed one; surfaces must render that as
     * unverified, never as a guess.
     */
    observed_model: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "Model the harness stream actually reported; null when never disclosed (rendered as unverified, never guessed).",
      ),
    /**
     * Auth route the attempt ACTUALLY ran under (route evidence, like
     * observed_model): adapters disclose their chosen route as a typed
     * `auth_route` payload on the started event, sourced from the credential
     * material itself (codex: the seeded auth.json's own auth_mode; claude:
     * the selected credentials/OAuth/api-key route). Null when never
     * disclosed — subscription-vs-API quota attribution must treat that as
     * unknown, never guess from manifests.
     */
    auth_mode: AuthMode.nullable()
      .default(null)
      .describe(
        "Auth route the attempt actually ran under (local_session subscription vs api_key), disclosed by the adapter's typed started payload; null when never disclosed (treated as unknown, never guessed).",
      ),
    web: WebEvidenceRecord,
    /** Bounded by the writer (most recent first when truncated; `tool_errors_total` keeps the true count). */
    tool_errors: z
      .array(ToolErrorRecord)
      .default([])
      .describe(
        "Tool errors, bounded by the writer (most recent first when truncated; tool_errors_total keeps the true count).",
      ),
    tool_errors_total: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("True total count of tool errors."),
    unrecovered_tool_errors: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("Tool errors with no later successful recovery."),
    /** tool_result events that arrived WITHOUT a status field (never treated as ok). */
    statusless_tool_results: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("tool_result events that arrived without a status field (never treated as ok)."),
    /** Native lines/events the adapter could not parse or did not recognize (never silently zero). */
    dropped_events: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe(
        "Native lines/events the adapter could not parse or did not recognize (never silently zero).",
      ),
    /** Adapter-declared transient failures that informed bounded retry policy. */
    transient_failures: z
      .array(TransientFailureRecord)
      .default([])
      .describe("Adapter-declared transient failures that informed bounded retry policy."),
    /** Contract/outcome projection for this attempt. */
    outcome: AttemptOutcome.default({}),
  })
  .describe(
    "Telemetry for one attempt: route evidence, web evidence, tool errors, dropped events, and outcome.",
  );
export type AttemptTelemetryRecord = z.infer<typeof AttemptTelemetryRecord>;

export const RunTelemetry = z
  .object({
    schema_version: SchemaVersion,
    run_id: Id.describe("Run the telemetry belongs to."),
    task_id: Id.describe("Task the run belongs to."),
    mode: ModeKind,
    requested_access: AccessProfile.describe("Access profile the caller requested."),
    effective_access: AccessProfile.describe("Access profile actually enforced by the engine."),
    external_context_policy: ExternalContextPolicy.describe("Requested web policy for the run."),
    effective_web_mode: ExternalContextPolicy.describe(
      "Web policy actually executed by the selected route.",
    ),
    web_required: z.boolean().default(false).describe("Whether the run required web evidence."),
    /** Attempt whose output became the final answer/patch; null when no attempt succeeded. */
    final_attempt_id: Id.nullable()
      .default(null)
      .describe(
        "Attempt whose output became the final answer/patch; null when no attempt succeeded.",
      ),
    /** Run-level web evidence: the final attempt's evidence, else the most severe attempt evidence. */
    web: WebEvidenceRecord.describe(
      "Run-level web evidence: the final attempt's evidence, else the most severe attempt evidence.",
    ),
    attempts: z
      .array(AttemptTelemetryRecord)
      .default([])
      .describe("Per-attempt telemetry records."),
    /** Sum of attempt outcome warnings; surfaces render this separately from terminal state. */
    tool_warnings_total: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("Sum of attempt tool warnings; rendered separately from terminal state."),
    generated_at: IsoTimestamp.describe("When the telemetry artifact was generated."),
  })
  .describe(
    "Run telemetry artifact (final/telemetry.yaml), the single computed source of web/tool evidence; surfaces project it and never re-derive evidence from raw events.",
  );
export type RunTelemetry = z.infer<typeof RunTelemetry>;
