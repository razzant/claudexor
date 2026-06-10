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

/**
 * Run telemetry artifact (`final/telemetry.yaml`).
 *
 * The orchestrator is the ONLY computer of web/tool evidence. Surfaces
 * (control-api, CLI, app) project this artifact; they must not re-derive
 * evidence from raw events. Legacy runs without the artifact render an honest
 * "telemetry unavailable" state instead of a recomputed guess.
 */

export const WebEvidenceStatus = z.enum(["none", "attempted", "satisfied", "failed", "unverified"]);
export type WebEvidenceStatus = z.infer<typeof WebEvidenceStatus>;

export const WebEvidenceRecord = z.object({
  required: z.boolean().default(false),
  /** Requested policy for the run. */
  policy: ExternalContextPolicy.default("auto"),
  /** Mode actually executed by the harness route (e.g. claude `cached` upgrades to `live`, disclosed). */
  effective_mode: ExternalContextPolicy.default("auto"),
  attempted: z.boolean().default(false),
  satisfied: z.boolean().default(false),
  status: WebEvidenceStatus.default("none"),
  tool: z.string().nullable().default(null),
  target: z.string().nullable().default(null),
  error_summary: z.string().nullable().default(null),
});
export type WebEvidenceRecord = z.infer<typeof WebEvidenceRecord>;

export const ToolErrorRecord = z.object({
  tool: z.string(),
  kind: ToolKind.default("other"),
  target: z.string().nullable().default(null),
  summary: z.string(),
  /** True when a later successful result of the same tool exists in the same attempt. */
  recovered: z.boolean().default(false),
  tool_use_id: z.string().nullable().default(null),
});
export type ToolErrorRecord = z.infer<typeof ToolErrorRecord>;

export const AttemptTelemetryRecord = z.object({
  attempt_id: Id,
  harness_id: Id,
  web: WebEvidenceRecord,
  /** Bounded by the writer (most recent first when truncated; `tool_errors_total` keeps the true count). */
  tool_errors: z.array(ToolErrorRecord).default([]),
  tool_errors_total: z.number().int().nonnegative().default(0),
  unrecovered_tool_errors: z.number().int().nonnegative().default(0),
  /** Native lines/events the adapter could not parse or did not recognize (never silently zero). */
  dropped_events: z.number().int().nonnegative().default(0),
});
export type AttemptTelemetryRecord = z.infer<typeof AttemptTelemetryRecord>;

export const RunTelemetry = z.object({
  schema_version: SchemaVersion,
  run_id: Id,
  task_id: Id,
  mode: ModeKind,
  requested_access: AccessProfile,
  effective_access: AccessProfile,
  external_context_policy: ExternalContextPolicy,
  effective_web_mode: ExternalContextPolicy,
  web_required: z.boolean().default(false),
  /** Attempt whose output became the final answer/patch; null when no attempt succeeded. */
  final_attempt_id: Id.nullable().default(null),
  /** Run-level web evidence: the final attempt's evidence, else the most severe attempt evidence. */
  web: WebEvidenceRecord,
  attempts: z.array(AttemptTelemetryRecord).default([]),
  generated_at: IsoTimestamp,
});
export type RunTelemetry = z.infer<typeof RunTelemetry>;
