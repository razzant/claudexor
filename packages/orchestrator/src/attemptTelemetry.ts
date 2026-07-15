/**
 * Attempt-level telemetry: the single owner of tool-error records, web
 * evidence state, transient-failure observations, and the attempt outcome
 * truth. Adapters emit typed events; the orchestrator observes them here —
 * no regex over prose, and a tool error is "recovered" only when the SAME
 * tool later succeeds against the SAME target.
 */
import type {
  AttemptTelemetryRecord,
  ExternalContextPolicy,
  HarnessEvent,
  RequestRequirementResolution,
  TaskContract,
  ToolKind,
} from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";

export interface ToolErrorRecord {
  tool: string;
  kind: ToolKind;
  target: string | null;
  summary: string;
  toolUseId: string | null;
  /** True when a later successful result of the SAME tool against the SAME target exists in this attempt (INV-043). */
  recovered: boolean;
}

export type AttemptOutcomeStatus = "success" | "success_with_warnings" | "blocked" | "failed";

export interface AttemptOutcomeState {
  deliverablePresent: boolean;
  gatesPassed: boolean | null;
  harnessErrored: boolean;
  webRequiredUnsatisfied: boolean;
  toolWarningsCount: number;
  status: AttemptOutcomeStatus;
}

export interface WebEvidenceState {
  required: boolean;
  mode: ExternalContextPolicy;
  effectiveMode: ExternalContextPolicy;
  attempted: boolean;
  satisfied: boolean;
  failed: boolean;
  tool: string | null;
  target: string | null;
  errorSummary: string | null;
}

export interface AttemptTelemetry {
  requestRequirements: RequestRequirementResolution[];
  toolErrors: ToolErrorRecord[];
  /** tool_result events without a status field: never silently treated as ok. */
  statuslessResults: number;
  /** Native lines/events the adapter reported as dropped/unrecognized. */
  droppedEvents: number;
  web: WebEvidenceState;
  /** Model identity the harness stream actually reported (route evidence). */
  observedModel: string | null;
  /** Auth route the adapter disclosed for this attempt (route evidence; null = undisclosed). */
  authMode: "local_session" | "api_key" | null;
  /** Adapter-declared transient failures seen during this attempt. */
  transientFailures: {
    kind: NonNullable<HarnessEvent["transient"]>["kind"];
    retryDelayMs: number | null;
  }[];
  /** Contract/outcome truth for this attempt, produced by the orchestrator. */
  outcome: AttemptOutcomeState | null;
}

export function createAttemptTelemetry(
  policy: ExternalContextPolicy,
  webRequired: boolean,
  effectiveMode: ExternalContextPolicy = policy,
  requestRequirements: RequestRequirementResolution[] = [],
): AttemptTelemetry {
  return {
    requestRequirements,
    toolErrors: [],
    statuslessResults: 0,
    droppedEvents: 0,
    web: {
      required: webRequired,
      mode: policy,
      effectiveMode,
      attempted: false,
      satisfied: false,
      failed: false,
      tool: null,
      target: null,
      errorSummary: null,
    },
    observedModel: null,
    authMode: null,
    transientFailures: [],
    outcome: null,
  };
}

/**
 * Observe a normalized harness event into the attempt telemetry. Governance is
 * fully typed: only the `tool` ToolRef on tool_call/tool_result/file_change
 * events and the run-loop drop counters are consulted — never payload string
 * matching or tool-name heuristics.
 */
export function observeAttemptTelemetry(t: AttemptTelemetry, ev: HarnessEvent): void {
  // Route evidence: remember the model identity the stream itself disclosed.
  if (ev.observed_model && !t.observedModel) t.observedModel = ev.observed_model;
  // Route evidence: the adapter's first-class credential-route disclosure
  // (first-wins; the route is decided once before spawn).
  if (!t.authMode) {
    if (ev.credential_route === "vendor_native") t.authMode = "local_session";
    else if (ev.credential_route === "managed_api_key") t.authMode = "api_key";
  }
  if (ev.transient) {
    t.transientFailures.push({
      kind: ev.transient.kind,
      retryDelayMs: ev.transient.retry_delay_ms ?? null,
    });
  }
  if (ev.type === "completed") {
    const dropped =
      Number(ev.payload?.["dropped_unparsed_lines"] ?? 0) +
      Number(ev.payload?.["dropped_unrecognized_events"] ?? 0);
    if (Number.isFinite(dropped) && dropped > 0) t.droppedEvents += dropped;
    return;
  }
  const tool = ev.tool;
  if (!tool) return;

  if (ev.type === "tool_call" || ev.type === "file_change") {
    if (tool.kind === "web") {
      t.web.attempted = true;
      t.web.tool = tool.name;
      t.web.target = tool.target ?? t.web.target;
    }
    return;
  }

  if (ev.type !== "tool_result") return;
  if (tool.status === undefined) {
    // A result without a status must never silently count as ok.
    t.statuslessResults += 1;
    return;
  }
  if (tool.status === "cancelled" || tool.status === "denied") {
    if (tool.kind === "web") {
      t.web.attempted = true;
      t.web.tool = tool.name;
      t.web.target = tool.target ?? t.web.target;
    }
    return;
  }
  if (tool.status === "error") {
    t.toolErrors.push({
      tool: tool.name,
      kind: tool.kind,
      target: tool.target ?? null,
      summary: redactSecrets(
        tool.error_summary ?? tool.content_summary ?? "tool result marked error",
      ).slice(0, 1000),
      toolUseId: tool.use_id ?? null,
      recovered: false,
    });
    if (tool.kind === "web") {
      t.web.failed = true;
      t.web.attempted = true;
      t.web.tool = tool.name;
      t.web.target = tool.target ?? t.web.target;
      t.web.errorSummary = redactSecrets(
        tool.error_summary ?? "web tool result marked error",
      ).slice(0, 1000);
    }
    return;
  }
  // status === "ok": a later success of the SAME tool against the SAME target
  // is the verified recovery for that call's earlier errors within this
  // attempt (keying fix: `bash echo done` must NOT launder an earlier
  // `bash npm test` failure — the name alone proved nothing).
  for (const err of t.toolErrors) {
    // INV-043: recovery must be attributable to the failed operation — same
    // tool, same KIND, same target (a non-web tool sharing a name with a web
    // tool must not clear its web error).
    if (
      !err.recovered &&
      err.tool === tool.name &&
      err.kind === tool.kind &&
      err.target === (tool.target ?? null)
    ) {
      err.recovered = true;
    }
  }
  if (tool.kind === "web") {
    t.web.attempted = true;
    // DECIDED SEMANTICS (round-19/20 reviews): the web-evidence gate asks
    // "was web evidence OBTAINED", so ANY successful web call satisfies it —
    // reformulating a failed query and succeeding on the new one is
    // legitimate alternative-route recovery, not laundering (blocking it
    // would false-block the most common web workflow). What must NOT vanish
    // is the DISCLOSURE: `failed` clears only when the success matches the
    // failed call's target (INV-043 keying), so telemetry.yaml keeps the
    // unrecovered failure + errorSummary visible even on satisfied runs.
    t.web.satisfied = true;
    // Derived rollup, single source of truth: the tool+target-keyed
    // toolErrors store (the recovery loop above already marked matching
    // errors recovered). Multiple failed targets stay disclosed until EACH
    // recovers; a missing target never wildcards (exact null==null match).
    t.web.failed = t.toolErrors.some((e) => e.kind === "web" && !e.recovered);
    // Keep the summary in lockstep with the rollup: point at a live
    // unrecovered failure, or clear once everything recovered.
    t.web.errorSummary = t.web.failed
      ? (t.toolErrors.find((e) => e.kind === "web" && !e.recovered)?.summary ?? t.web.errorSummary)
      : null;
    t.web.tool = tool.name;
    t.web.target = tool.target ?? t.web.target;
  }
}

const TELEMETRY_TOOL_ERRORS_MAX = 20;

export function unrecoveredToolErrors(t: AttemptTelemetry): ToolErrorRecord[] {
  return t.toolErrors.filter((e) => !e.recovered);
}

export function toolWarnings(t: AttemptTelemetry): ToolErrorRecord[] {
  // Non-web tool errors are warnings once the attempt produced its contracted
  // deliverable. Unrecovered WEB errors count as warnings too WHEN the
  // evidence gate is satisfied by an alternative route (INV-043: the failure
  // stays attributable and disclosed; a green claim becomes
  // success_with_warnings, never a silent clean success). Unsatisfied web
  // errors flow through the hard gate (webUnsatisfied) instead.
  return unrecoveredToolErrors(t).filter((e) => e.kind !== "web" || t.web.satisfied);
}

export function setAttemptOutcome(
  t: AttemptTelemetry,
  opts: {
    deliverablePresent: boolean;
    gatesPassed: boolean | null;
    harnessErrored: boolean;
    webRequiredUnsatisfied: boolean;
  },
): void {
  const warnings = toolWarnings(t).length;
  const contractFailed = !opts.deliverablePresent || opts.gatesPassed === false;
  const status: AttemptOutcomeStatus = opts.webRequiredUnsatisfied
    ? "blocked"
    : opts.harnessErrored || contractFailed
      ? "failed"
      : warnings > 0
        ? "success_with_warnings"
        : "success";
  t.outcome = {
    deliverablePresent: opts.deliverablePresent,
    gatesPassed: opts.gatesPassed,
    harnessErrored: opts.harnessErrored,
    webRequiredUnsatisfied: opts.webRequiredUnsatisfied,
    toolWarningsCount: warnings,
    status,
  };
}

function webStatus(
  t: AttemptTelemetry,
): "none" | "attempted" | "satisfied" | "failed" | "unverified" {
  if (t.web.satisfied) return "satisfied";
  if (t.web.failed) return "failed";
  if (t.web.attempted) return "attempted";
  return t.web.required ? "unverified" : "none";
}

/** Bounded telemetry summary for events/artifacts (full detail lives in telemetry.yaml). */
export function telemetrySummary(t: AttemptTelemetry): Record<string, unknown> {
  const unrecovered = unrecoveredToolErrors(t);
  const warnings = toolWarnings(t);
  return {
    web_evidence: {
      required: t.web.required,
      mode: t.web.mode,
      effective_mode: t.web.effectiveMode,
      attempted: t.web.attempted,
      satisfied: t.web.satisfied,
      status: webStatus(t),
      tool: t.web.tool,
      target: t.web.target,
      error_summary: t.web.errorSummary,
    },
    tool_errors_total: t.toolErrors.length,
    unrecovered_tool_errors: unrecovered.length,
    tool_errors: unrecovered
      .slice(-5)
      .map((e) => ({ tool: e.tool, kind: e.kind, target: e.target, summary: e.summary })),
    tool_warnings_count: warnings.length,
    ...(warnings.length
      ? {
          tool_warnings: warnings
            .slice(-5)
            .map((e) => ({ tool: e.tool, kind: e.kind, target: e.target, summary: e.summary })),
        }
      : {}),
    ...(t.outcome ? { outcome: t.outcome } : {}),
    ...(t.transientFailures.length > 0
      ? {
          transient_failures: t.transientFailures
            .slice(-5)
            .map((e) => ({ kind: e.kind, retry_delay_ms: e.retryDelayMs })),
        }
      : {}),
    ...(t.droppedEvents > 0 ? { dropped_events: t.droppedEvents } : {}),
    ...(t.statuslessResults > 0 ? { statusless_tool_results: t.statuslessResults } : {}),
  };
}

export function attemptTelemetryRecord(
  attemptId: string,
  harnessId: string,
  t: AttemptTelemetry,
): AttemptTelemetryRecord {
  const errors = t.toolErrors.slice(-TELEMETRY_TOOL_ERRORS_MAX);
  const warnings = toolWarnings(t);
  return {
    attempt_id: attemptId,
    harness_id: harnessId,
    observed_model: t.observedModel,
    auth_mode: t.authMode,
    request_requirements: t.requestRequirements,
    web: {
      required: t.web.required,
      policy: t.web.mode,
      effective_mode: t.web.effectiveMode,
      attempted: t.web.attempted,
      satisfied: t.web.satisfied,
      status: webStatus(t),
      tool: t.web.tool,
      target: t.web.target,
      error_summary: t.web.errorSummary,
    },
    tool_errors: errors.map((e) => ({
      tool: e.tool,
      kind: e.kind,
      target: e.target,
      summary: e.summary,
      recovered: e.recovered,
      tool_use_id: e.toolUseId,
    })),
    tool_errors_total: t.toolErrors.length,
    unrecovered_tool_errors: unrecoveredToolErrors(t).length,
    statusless_tool_results: t.statuslessResults,
    dropped_events: t.droppedEvents,
    transient_failures: t.transientFailures
      .slice(-TELEMETRY_TOOL_ERRORS_MAX)
      .map((e) => ({ kind: e.kind, retry_delay_ms: e.retryDelayMs })),
    outcome: {
      deliverable_present: t.outcome?.deliverablePresent ?? false,
      gates_passed: t.outcome?.gatesPassed ?? null,
      harness_errored: t.outcome?.harnessErrored ?? false,
      web_required_unsatisfied: t.outcome?.webRequiredUnsatisfied ?? false,
      tool_warnings_count: t.outcome?.toolWarningsCount ?? warnings.length,
      status: t.outcome?.status ?? (warnings.length > 0 ? "success_with_warnings" : "success"),
    },
  };
}

export function aggregateRunWebEvidence(
  records: AttemptTelemetryRecord[],
  contract: TaskContract,
): AttemptTelemetryRecord["web"] {
  const satisfied = records.find((r) => r.web.satisfied);
  if (satisfied) return satisfied.web;
  const severityRank = { none: 0, attempted: 1, unverified: 2, failed: 3, satisfied: 4 } as const;
  const worst = [...records].sort(
    (a, b) => (severityRank[b.web.status] ?? 0) - (severityRank[a.web.status] ?? 0),
  )[0];
  return (
    worst?.web ?? {
      required: contract.external_context.web_required,
      policy: contract.external_context.policy,
      effective_mode: contract.external_context.effective_mode,
      attempted: false,
      satisfied: false,
      status: contract.external_context.web_required ? ("unverified" as const) : ("none" as const),
      tool: null,
      target: null,
      error_summary: null,
    }
  );
}

/**
 * Web evidence gating (locked v0.7 semantics):
 * - web_required && !satisfied  -> blocked, INCLUDING the never-attempted case;
 * - attempted && failed && !satisfied -> blocked (a later successful web call
 *   is the verified recovery that clears it).
 */
export function webUnsatisfied(t: AttemptTelemetry): boolean {
  if (t.web.satisfied) return false;
  if (t.web.required) return true;
  return t.web.attempted && t.web.failed;
}
