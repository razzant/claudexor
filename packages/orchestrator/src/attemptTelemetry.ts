/**
 * Attempt-level telemetry: the single owner of tool-error records, web
 * evidence state, transient-failure observations, and the attempt outcome
 * truth. Adapters emit typed events; the orchestrator observes them here —
 * no regex over prose, and a tool error is "recovered" only when the SAME
 * tool later succeeds against the SAME target.
 */
import type {
  AttemptTelemetryRecord,
  AuthSourceKind,
  ExternalContextPolicy,
  HarnessEvent,
  RequestRequirementResolution,
  TaskContract,
  ToolKind,
  WorkState,
} from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import {
  type TransientFailureObservation,
  classifyCompletedCrash,
  classifyRateLimit,
  classifyStatusError,
  classifyTransientSignal,
} from "./transientClassify.js";

export { type TransientFailureObservation, classifyAdapterThrow } from "./transientClassify.js";

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
  /** D-16 model-attested work outcome (from the finalizer); absent on routes
   * with no work_report transport. */
  workState?: WorkState;
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

/**
 * Delegation-belt runtime readiness for one attempt (QA-024). `requested` is
 * set at attempt creation when a belt MCP server was injected into the spec;
 * `ready`/`failed` are filled from the harness's `started` event (its
 * `mcp_servers[<belt>].status`); `toolEvidence` flips when any `mcp__<belt>__*`
 * tool actually runs. A requested belt that reports `failed` with no tool
 * evidence is the false-success trap the outcome axis must catch.
 */
export interface DelegationBeltState {
  requested: boolean;
  serverName: string | null;
  ready: boolean;
  failed: boolean;
  toolEvidence: boolean;
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
  /** Last typed route in the stream, used only for per-usage cost allocation. */
  currentAuthMode: "local_session" | "api_key" | null;
  /** Concrete credential source disclosed alongside the route (never guessed). */
  authSource: AuthSourceKind | null;
  /** Credential profile the attempt ACTUALLY ran under (INV-135), first-wins
   * from the adapter's per-event stamp — rotation makes this differ from the
   * contract's requested id, and the receipt must carry the effective truth. */
  profileId: string | null;
  /** Model hint the engine SENT this attempt (requested side; observedModel is
   * the disclosed side of the model x route truth). */
  requestedModel: string | null;
  /** Adapter-declared transient failures seen during this attempt, each
   * classified into the GH #31 typed taxonomy the retry policy gates on. */
  transientFailures: TransientFailureObservation[];
  /** TYPED vendor rate-limit signals seen during this attempt (W5.4): the
   * rotation predicate reads these, never prose or plain transients. */
  rateLimits: { retryDelayMs: number | null; resetsAt: string | null }[];
  /** Delegation-belt runtime readiness (QA-024); requested=false on non-delegate attempts. */
  delegationBelt: DelegationBeltState;
  /** D-16: a terminal `capacity_exhausted` context signal was observed this
   * attempt (never a transient; consumed by the finalizer, not the retry loop). */
  contextExhausted: boolean;
  /** D-16d: the typed cause of the terminal capacity exhaustion (last-wins),
   * or null when none observed. The continuation controller keys eligibility on
   * `repeated_refill` (claude's rapid-refill breaker), never on `prompt_too_long`
   * (an irreducible packet). */
  contextExhaustedCause: NonNullable<HarnessEvent["context"]>["cause"] | null;
  /** D-16c: the raw `{work_report}` payload a `side_tool` route surfaced on its
   * final message (claude StructuredOutput tool), or null. The unwrap validates
   * it while the markdown answer stays the deliverable. */
  sideToolWorkReport: unknown;
  /** Contract/outcome truth for this attempt, produced by the orchestrator. */
  outcome: AttemptOutcomeState | null;
  /** Token usage summed across this attempt's usage events (money stays in the
   * ledger, not here). Each field is null until at least one usage event
   * reports it — cursor reports cost only (all null), raw-api has no cached —
   * so "not reported" is never conflated with a real 0. Cross-harness caution:
   * codex `cached ⊆ input`, claude `cached ∩ input = ∅` — never derive a total. */
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
  };
  /** Per-usage-event billing split. Route can change across native retries,
   * so this is deliberately not derived from the attempt's first route. */
  usageCost: { cashUsd: number; valuationUsd: number; unknownUsd: number };
}

export function createAttemptTelemetry(
  policy: ExternalContextPolicy,
  webRequired: boolean,
  effectiveMode: ExternalContextPolicy = policy,
  requestRequirements: RequestRequirementResolution[] = [],
  requestedModel: string | null = null,
  /** The delegation-belt MCP server name injected into THIS attempt's spec, or
   * null when no belt was injected (QA-024). Non-null marks the belt requested. */
  beltServerName: string | null = null,
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
    currentAuthMode: null,
    authSource: null,
    profileId: null,
    requestedModel,
    transientFailures: [],
    rateLimits: [],
    delegationBelt: {
      requested: beltServerName !== null,
      serverName: beltServerName,
      ready: false,
      failed: false,
      toolEvidence: false,
    },
    contextExhausted: false,
    contextExhaustedCause: null,
    sideToolWorkReport: null,
    outcome: null,
    usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null },
    usageCost: { cashUsd: 0, valuationUsd: 0, unknownUsd: 0 },
  };
}

/** Add one present token field to a null-aware accumulator (null stays null
 *  until a value actually arrives, so "unreported" never reads as 0). */
function addToken(acc: number | null, value: number | undefined): number | null {
  return value === undefined ? acc : (acc ?? 0) + value;
}

/**
 * Read the injected belt server's status out of the harness `started` frame's
 * `mcp_servers` list (QA-024). The shape is the vendor's — claude emits
 * `{ name, status }` entries — so we defensively narrow each entry and match by
 * the injected belt server name. `status:"failed"` (or "error") is the startup
 * failure the outcome axis must not let terminalize a silent success.
 */
function observeBeltStartup(t: AttemptTelemetry, ev: HarnessEvent): void {
  const payload = (ev as { payload?: Record<string, unknown> }).payload;
  const servers = payload?.["mcp_servers"];
  if (!Array.isArray(servers)) return;
  for (const raw of servers) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as { name?: unknown; status?: unknown };
    if (entry.name !== t.delegationBelt.serverName) continue;
    const status = typeof entry.status === "string" ? entry.status.toLowerCase() : "";
    if (status === "failed" || status === "error") t.delegationBelt.failed = true;
    else if (status === "connected" || status === "ready" || status === "ok") {
      t.delegationBelt.ready = true;
    }
    return;
  }
}

/**
 * The delegation belt was requested (--delegate injected it) but never became
 * operational: the harness reported the server `failed` and no belt tool ever
 * ran (QA-024). This is the false-success trap — the harness may have answered
 * from its own native subagent with no Claudexor sub-run provenance. A belt
 * that was ready-but-unused is NOT unavailable (docs leave the spawn decision to
 * the harness); only a startup failure counts.
 */
export function delegationBeltUnavailable(t: AttemptTelemetry): boolean {
  return t.delegationBelt.requested && t.delegationBelt.failed && !t.delegationBelt.toolEvidence;
}

/**
 * Observe a normalized harness event into the attempt telemetry. Governance is
 * fully typed: only the `tool` ToolRef on tool_call/tool_result/file_change
 * events and the run-loop drop counters are consulted — never payload string
 * matching or tool-name heuristics.
 */
export function observeAttemptTelemetry(t: AttemptTelemetry, ev: HarnessEvent): void {
  // Delegation belt readiness (QA-024): the harness's `started` frame lists its
  // MCP servers and each one's status. When the engine injected a belt, read
  // THAT server's status as first-class readiness truth — never prose. A
  // `failed` belt with no later tool evidence is the false-success trap.
  if (ev.type === "started" && t.delegationBelt.requested) {
    observeBeltStartup(t, ev);
  }
  // Belt tool evidence: any `mcp__<belt>__*` tool call/result proves the belt
  // was actually reachable and used (a real Claudexor sub-run path), which
  // distinguishes a used belt from one the harness silently substituted.
  if (t.delegationBelt.requested && t.delegationBelt.serverName && ev.tool?.name) {
    if (ev.tool.name.startsWith(`mcp__${t.delegationBelt.serverName}`)) {
      t.delegationBelt.toolEvidence = true;
    }
  }
  // Route evidence: remember the model identity the stream itself disclosed.
  if (ev.observed_model && !t.observedModel) t.observedModel = ev.observed_model;
  // Route evidence: the adapter's first-class credential-route disclosure
  // (first-wins; the route is decided once before spawn).
  if (!t.authMode) {
    if (ev.credential_route === "vendor_native") t.authMode = "local_session";
    else if (ev.credential_route === "managed_api_key") t.authMode = "api_key";
  }
  if (ev.credential_route === "vendor_native") t.currentAuthMode = "local_session";
  else if (ev.credential_route === "managed_api_key") t.currentAuthMode = "api_key";
  if (ev.type === "message" && ev.payload?.["auth_switched"] === true) {
    if (ev.payload["to_auth_mode"] === "subscription") t.currentAuthMode = "local_session";
    if (ev.payload["to_auth_mode"] === "api_key") t.currentAuthMode = "api_key";
  }
  if (ev.usage?.cost_usd) {
    const usageMode =
      ev.credential_route === "vendor_native"
        ? "local_session"
        : ev.credential_route === "managed_api_key"
          ? "api_key"
          : t.currentAuthMode;
    if (usageMode === "local_session") t.usageCost.valuationUsd += ev.usage.cost_usd;
    else if (usageMode === "api_key") t.usageCost.cashUsd += ev.usage.cost_usd;
    else t.usageCost.unknownUsd += ev.usage.cost_usd;
  }
  // First-wins like the route: the source is decided once before spawn.
  if (!t.authSource && ev.credential_source) t.authSource = ev.credential_source;
  // LAST-wins (unlike the route): W5.4 failover rotates the profile between
  // native tries of ONE attempt, and the receipt must name the try that
  // produced the deliverable.
  if (ev.credential_profile_id) t.profileId = ev.credential_profile_id;
  // #31: classify every disclosed transient into the typed taxonomy (see
  // transientClassify.ts). An adapter `transient` and a `rate_limit` are
  // retryable failures; the vendor's typed `status.error_category` surfaces only
  // the deterministic FAILURE classes (auth/capability/config) so required-
  // actions attach the right remediation. Rate limits ALSO stay in rateLimits
  // for the W5.4 rotation predicate.
  if (ev.transient) t.transientFailures.push(classifyTransientSignal(ev.transient));
  if (ev.rate_limit) {
    t.rateLimits.push({
      retryDelayMs: ev.rate_limit.retry_delay_ms ?? null,
      resetsAt: ev.rate_limit.resets_at ?? null,
    });
    t.transientFailures.push(classifyRateLimit(ev.rate_limit.retry_delay_ms ?? null));
  }
  if (ev.status?.error_category) {
    const obs = classifyStatusError(ev.status.error_category, ev.status.retry_delay_ms ?? null);
    if (obs) t.transientFailures.push(obs);
  }
  // D-16 context signal: a terminal capacity_exhausted marks the attempt for the
  // finalizer's interrupted/context_capacity_exhausted mapping. Context signals
  // NEVER enter the transient-retry loop (they are not transient failures).
  if (ev.context?.kind === "capacity_exhausted") {
    t.contextExhausted = true;
    t.contextExhaustedCause = ev.context.cause ?? null;
  }
  // D-16c side_tool: capture the raw work_report the StructuredOutput tool
  // surfaced on the final message (last-wins). The unwrap validates it.
  const sideTool = ev.payload?.["work_report_side_tool"];
  if (sideTool !== undefined) t.sideToolWorkReport = sideTool;
  // Token usage: SUM across the attempt's usage events (single-event adapters
  // sum == last-wins; codex per-turn needs the sum). Money is the ledger's job.
  if (ev.type === "usage" && ev.usage) {
    t.usage.inputTokens = addToken(t.usage.inputTokens, ev.usage.input_tokens);
    t.usage.outputTokens = addToken(t.usage.outputTokens, ev.usage.output_tokens);
    t.usage.cachedInputTokens = addToken(t.usage.cachedInputTokens, ev.usage.cached_input_tokens);
  }
  if (ev.type === "completed") {
    const dropped =
      Number(ev.payload?.["dropped_unparsed_lines"] ?? 0) +
      Number(ev.payload?.["dropped_unrecognized_events"] ?? 0);
    if (Number.isFinite(dropped) && dropped > 0) t.droppedEvents += dropped;
    // #31 process crash: the run loop discloses a non-aborted signal kill, a
    // non-zero exit, or a spawn failure as TYPED payload fields (never prose).
    const crash = classifyCompletedCrash(ev.payload);
    if (crash) t.transientFailures.push(crash);
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
    /** D-16 work_state from the unified finalizer (INV-116): a needs_input/
     * incomplete veto rides HERE without flipping `status` — the lifecycle
     * stays succeeded-class; applyability and the CLI exit read the axis. */
    workState?: WorkState;
  },
): void {
  const warnings = toolWarnings(t).length;
  const contractFailed = !opts.deliverablePresent || opts.gatesPassed === false;
  // QA-024: a requested belt that failed to start with no tool evidence is an
  // explicitly-requested capability that never became operational — treated
  // like an unsatisfied hard requirement (never a silent clean success). It
  // rides the same axis order as web: it can only ELEVATE severity, never mask
  // a harder failure. NOTE (D-16 seam): this producer maps belt-unavailable to
  // `failed`; a future finalizer that prefers a softer disclosure would flip
  // this to `success_with_warnings` — the typed telemetry fact
  // (delegation_belt.*) is what a consumer reads either way.
  const beltUnavailable = delegationBeltUnavailable(t);
  const status: AttemptOutcomeStatus = opts.webRequiredUnsatisfied
    ? "blocked"
    : opts.harnessErrored || contractFailed || beltUnavailable
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
    ...(opts.workState ? { workState: opts.workState } : {}),
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
    ...(t.delegationBelt.requested
      ? {
          delegation_belt: {
            server_name: t.delegationBelt.serverName,
            ready: t.delegationBelt.ready,
            failed: t.delegationBelt.failed,
            tool_evidence: t.delegationBelt.toolEvidence,
            unavailable: delegationBeltUnavailable(t),
          },
        }
      : {}),
    ...(t.transientFailures.length > 0
      ? {
          transient_failures: t.transientFailures.slice(-5).map((e) => ({
            kind: e.kind,
            category: e.category,
            retryable: e.retryable,
            retry_delay_ms: e.retryDelayMs,
          })),
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
    auth_source: t.authSource,
    profile_id: t.profileId,
    requested_model: t.requestedModel,
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
    transient_failures: t.transientFailures.slice(-TELEMETRY_TOOL_ERRORS_MAX).map((e) => ({
      kind: e.kind,
      category: e.category,
      retryable: e.retryable,
      retry_delay_ms: e.retryDelayMs,
      http_status: e.httpStatus,
      signal: e.signal,
      adapter_code: e.adapterCode,
    })),
    outcome: {
      deliverable_present: t.outcome?.deliverablePresent ?? false,
      gates_passed: t.outcome?.gatesPassed ?? null,
      harness_errored: t.outcome?.harnessErrored ?? false,
      web_required_unsatisfied: t.outcome?.webRequiredUnsatisfied ?? false,
      delegation_belt_unavailable: delegationBeltUnavailable(t),
      tool_warnings_count: t.outcome?.toolWarningsCount ?? warnings.length,
      status: t.outcome?.status ?? (warnings.length > 0 ? "success_with_warnings" : "success"),
      ...(t.outcome?.workState ? { work_state: t.outcome.workState } : {}),
    },
    // Only present when a belt was actually injected into this attempt (QA-024).
    ...(t.delegationBelt.requested
      ? {
          delegation_belt: {
            requested: t.delegationBelt.requested,
            server_name: t.delegationBelt.serverName,
            ready: t.delegationBelt.ready,
            failed: t.delegationBelt.failed,
            tool_evidence: t.delegationBelt.toolEvidence,
          },
        }
      : {}),
    usage: {
      input_tokens: t.usage.inputTokens,
      output_tokens: t.usage.outputTokens,
      cached_input_tokens: t.usage.cachedInputTokens,
    },
  };
}

/** Sum token usage across attempt records (candidates + synthesis), the same
 *  scope as the ledger's spend. A field stays null unless some attempt reported
 *  it, so "no harness reported tokens" never reads as a real 0. */
export function aggregateRunTokenUsage(records: AttemptTelemetryRecord[]): {
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
} {
  const sum = (pick: (u: AttemptTelemetryRecord["usage"]) => number | null): number | null => {
    let total: number | null = null;
    for (const r of records) {
      const v = pick(r.usage);
      if (v !== null) total = (total ?? 0) + v;
    }
    return total;
  };
  return {
    input_tokens: sum((u) => u.input_tokens),
    output_tokens: sum((u) => u.output_tokens),
    cached_input_tokens: sum((u) => u.cached_input_tokens),
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
