/** The single owner of typed attempt evidence and outcome truth, never prose inference. */
import type {
  AttemptTelemetryRecord,
  EffortResolution,
  AuthSourceKind,
  ExternalContextPolicy,
  HarnessEvent,
  HarnessRequestRefusal,
  InputTokenUsage,
  RawContextReceipt,
  RequestRequirementResolution,
  TaskContract,
  ToolKind,
  VendorFailureEvidence,
  WorkState,
} from "@claudexor/schema";
import { commandOutcomeUnconfirmed } from "@claudexor/schema";
import {
  attemptUsageCostSummary,
  newAttemptUsageCost,
  observeAttemptUsageEvent,
  type AttemptUsageCost,
} from "./attemptUsageCost.js";
import { redactSecrets } from "@claudexor/util";
import * as belt from "./delegationToolEvidence.js";
import * as marks from "./attemptOutputMarkers.js";
import { observeProcessing, type ProcessingTelemetry } from "./processing-telemetry.js";
import { observeObservedModel, type ObservedModelTelemetry } from "./observed-model-telemetry.js";
import { observePromptCacheTtl, type PromptCacheTelemetry } from "./prompt-cache-telemetry.js";
import {
  type TransientFailureObservation,
  classifyCompletedCrash,
  classifyRateLimit,
  classifyPermissionDenial,
  classifyStatusError,
  classifyTransientSignal,
  completionVendorFailure,
} from "./transientClassify.js";

export { type TransientFailureObservation, classifyAdapterThrow } from "./transientClassify.js";

export interface ToolErrorRecord {
  tool: string;
  kind: ToolKind;
  target: string | null;
  summary: string;
  toolUseId: string | null;
  /** True when a later success matches tool + kind + target and any ids both records provide (INV-043). */
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
  /** Typed retrieval strength; never downgrades verified. */
  verification: "verified" | "dispatched" | "none";
  tool: string | null;
  target: string | null;
  errorSummary: string | null;
}

/** QA-040: browser evidence matches only the engine-injected MCP server namespace. */
export interface BrowserEvidenceState {
  requested: boolean;
  serverName: string | null;
  attempted: boolean;
  satisfied: boolean;
  failed: boolean;
}

/** QA-024: injection, typed startup and actual tool use remain independent facts.
 * Non-ok tool results live in toolErrors, with INV-043 invocation-aware recovery. */
export interface DelegationBeltState {
  requested: boolean;
  serverName: string | null;
  ready: boolean;
  failed: boolean;
  toolEvidence: boolean;
}

export interface AttemptTelemetry
  extends ProcessingTelemetry, PromptCacheTelemetry, ObservedModelTelemetry {
  requestRefusal?: HarnessRequestRefusal;
  effortResolution?: EffortResolution;
  /** #147: the size of the last raw-api request a try prepared, receipted just
   * before its POST (one per try; the last wins). */
  rawContext?: RawContextReceipt;
  requestRequirements: RequestRequirementResolution[];
  toolErrors: ToolErrorRecord[];
  /** tool_result events without a status field: never silently treated as ok. */
  statuslessResults: number;
  /** Native lines/events the adapter reported as dropped/unrecognized. */
  droppedEvents: number;
  web: WebEvidenceState;
  /** Auth route the adapter disclosed for this attempt (route evidence; null = undisclosed). */
  authMode: "local_session" | "api_key" | null;
  /** Last typed route in the stream, used only for per-usage cost allocation. */
  currentAuthMode: "local_session" | "api_key" | null;
  /** Concrete credential source disclosed alongside the route (never guessed). */
  authSource: AuthSourceKind | null;
  /** Effective profile, last-wins across credential rotation (INV-135). */
  profileId: string | null;
  /** Model hint the engine SENT this attempt (requested side; observedModel is
   * the disclosed side of the model x route truth). */
  requestedModel: string | null;
  /** Adapter-declared transients, classified into the GH #31 taxonomy the retry policy gates on. */
  transientFailures: TransientFailureObservation[];
  transientRetries: number; // same-profile transient retries that actually RAN (observed)
  /** #414: the vendor's own typed failure of this attempt's current try, set by
   * its completion with or without exit evidence; reset per try (A3). */
  vendorFailure: VendorFailureEvidence | null;
  /** TYPED vendor rate-limit signals seen this attempt (W5.4): the rotation predicate's input. */
  rateLimits: { retryDelayMs: number | null; resetsAt: string | null }[];
  /** A2: agent-progress / file-change markers for the structural rotation predicate. */
  outputMarkers: marks.AttemptOutputMarkers;
  /** Delegation-belt runtime readiness (QA-024); requested=false on non-delegate attempts. */
  delegationBelt: DelegationBeltState;
  /** Browser-MCP runtime evidence; requested=false unless armed. */
  browser: BrowserEvidenceState;
  /** D-16: a terminal `capacity_exhausted` context signal was observed this
   * attempt (never a transient; consumed by the finalizer, not the retry loop). */
  contextExhausted: boolean;
  /** D-16d: the typed cause of the terminal capacity exhaustion (last-wins),
   * or null when none observed. The continuation controller keys eligibility on
   * `repeated_refill` (claude's rapid-refill breaker), never on `prompt_too_long`
   * (an irreducible packet). */
  contextExhaustedCause: NonNullable<HarnessEvent["context"]>["cause"] | null;
  /** #299: the vendor ended a native turn at the max-turns cap (typed `turn_limit`). */
  turnLimitReached: boolean;
  /** D-16c: the raw `{work_report}` payload a `side_tool` route surfaced on its
   * final message (claude StructuredOutput tool), or null. The unwrap validates
   * it while the markdown answer stays the deliverable. */
  sideToolWorkReport: unknown;
  outcome: AttemptOutcomeState | null;
  /** Legacy fields sum known reports with harness-specific input/cache semantics.
   * Normalized input fields require complete coverage. Money stays in the ledger. */
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    /** Complete normalized fields; undefined means no token contribution yet. */
    inputTokenUsage?: InputTokenUsage;
  };
  /** Per-usage-event billing split. Route can change across native retries,
   * so this is deliberately not derived from the attempt's first route. */
  usageCost: AttemptUsageCost;
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
  /** The browser MCP server name armed for THIS attempt (fixed `browser`
   * namespace), or null when the browser was not injected (QA-040). Non-null
   * marks the browser requested/armed. */
  browserServerName: string | null = null,
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
      verification: "none",
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
    transientRetries: 0,
    vendorFailure: null,
    rateLimits: [],
    outputMarkers: marks.newAttemptOutputMarkers(),
    delegationBelt: {
      requested: beltServerName !== null,
      serverName: beltServerName,
      ready: false,
      failed: false,
      toolEvidence: false,
    },
    browser: {
      requested: browserServerName !== null,
      serverName: browserServerName,
      attempted: false,
      satisfied: false,
      failed: false,
    },
    contextExhausted: false,
    contextExhaustedCause: null,
    turnLimitReached: false,
    sideToolWorkReport: null,
    outcome: null,
    usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null },
    usageCost: newAttemptUsageCost(),
  };
}

/** Add one present token field to a null-aware accumulator ("unreported" never reads as 0). */
function addToken(acc: number | null, value: number | undefined): number | null {
  return value === undefined ? acc : (acc ?? 0) + value;
}

/** Unknown on any contribution stays unknown; later values cannot revive a partial sum. */
function foldInputTokenUsage(
  acc: InputTokenUsage | undefined,
  value: InputTokenUsage | undefined,
): InputTokenUsage {
  const add = (key: keyof InputTokenUsage): number | null => {
    const next = value?.[key] ?? null;
    return acc === undefined ? next : acc[key] === null || next === null ? null : acc[key] + next;
  };
  return {
    total_tokens: add("total_tokens"),
    cache_read_tokens: add("cache_read_tokens"),
    cache_write_tokens: add("cache_write_tokens"),
  };
}

/** QA-040: generic MCP kind is insufficient; match the engine-armed namespace. */
function matchesBrowser(t: AttemptTelemetry, tool: { name: string; target?: string }): boolean {
  const server = t.browser.serverName;
  if (!t.browser.requested || !server) return false;
  return tool.name.startsWith(`mcp__${server}__`) || (tool.target ?? "").startsWith(`${server}:`);
}

/**
 * QA-040: the browser was armed but never called while generic web evidence
 * satisfied the run — a legitimately policy-satisfied run (e.g. web_search
 * answered) that nonetheless did not exercise the requested browser. Disclosure
 * only: it must NOT fail the run.
 */
export function browserUnused(t: AttemptTelemetry): boolean {
  return t.browser.requested && !t.browser.attempted && t.web.satisfied;
}

/** QA-042: raise the web retrieval strength, never downgrading a proven
 * `verified`. A typed success promotes to verified; any other satisfied web
 * activity is dispatch-strength (completed, content not typed-proven). */
function bumpWebVerification(t: AttemptTelemetry, retrieval: string | undefined): void {
  if (retrieval === "verified") t.web.verification = "verified";
  else if (t.web.verification !== "verified") t.web.verification = "dispatched";
}

/** Observe typed adapter evidence, never payload strings or tool-name heuristics. */
export function observeAttemptTelemetry(t: AttemptTelemetry, ev: HarnessEvent): void {
  if (ev.type === "error" && ev.request_refusal) t.requestRefusal = ev.request_refusal;
  observeProcessing(t, ev);
  observePromptCacheTtl(t, ev);
  if (ev.effort_resolution) t.effortResolution = ev.effort_resolution;
  if (ev.raw_context) t.rawContext = ev.raw_context;
  marks.observeAttemptOutputMarkers(t.outputMarkers, ev);
  // Delegation belt readiness (QA-024): normalized startup/error events carry
  // typed MCP server statuses. Read THAT server's status as first-class truth;
  // a failed belt must never launder into a native-subagent success.
  if (t.delegationBelt.requested && Array.isArray(ev.payload?.["mcp_servers"])) {
    belt.observeBeltStartup(t, ev);
  }
  // Exact adapter-neutral evidence distinguishes the belt from a native subagent;
  // recovery uses matching ids when both exist, else legacy tool+kind+target.
  const beltToolEvent =
    t.delegationBelt.requested &&
    t.delegationBelt.serverName &&
    belt.isDelegationBeltTool(ev.tool, t.delegationBelt.serverName);
  if (beltToolEvent) {
    t.delegationBelt.toolEvidence = true;
  }
  // Route evidence: the model identity the stream itself disclosed, with its proof.
  observeObservedModel(t, ev);
  // Route evidence: the adapter's first-class credential-route disclosure
  // (first-wins; the route is decided once before spawn).
  if (!t.authMode) {
    if (ev.credential_route === "vendor_native") t.authMode = "local_session";
    else if (ev.credential_route === "managed_api_key") t.authMode = "api_key";
  }
  t.currentAuthMode = observeAttemptUsageEvent(t.usageCost, ev, t.currentAuthMode);
  // First-wins like the route: the source is decided once before spawn.
  if (!t.authSource && ev.credential_source) t.authSource = ev.credential_source;
  // LAST-wins (unlike the route): W5.4 failover rotates the profile between
  // native tries of ONE attempt, and the receipt must name the try that
  // produced the deliverable.
  if (ev.credential_profile_id) t.profileId = ev.credential_profile_id;
  // Typed transient/auth/capability evidence owns retry and remediation;
  // rate limits also stay available to credential rotation.
  if (ev.transient) t.transientFailures.push(classifyTransientSignal(ev.transient));
  if (ev.permission_denial) t.transientFailures.push(classifyPermissionDenial());
  if (ev.rate_limit) {
    t.rateLimits.push({
      retryDelayMs: ev.rate_limit.retry_delay_ms ?? null,
      resetsAt: ev.rate_limit.resets_at ?? null,
    });
    t.transientFailures.push(classifyRateLimit(ev.rate_limit.retry_delay_ms ?? null));
  }
  const statusFailure = classifyStatusError(ev);
  if (statusFailure) t.transientFailures.push(statusFailure);
  // D-16 context signal: a terminal capacity_exhausted marks the attempt for the
  // finalizer's interrupted/context_capacity_exhausted mapping. Context signals
  // NEVER enter the transient-retry loop (they are not transient failures).
  if (ev.context?.kind === "capacity_exhausted") {
    t.contextExhausted = true;
    t.contextExhaustedCause = ev.context.cause ?? null;
  }
  if (ev.turn_limit) t.turnLimitReached = true;
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
    // A cost-only generation receipt still has unknown token coverage.
    t.usage.inputTokenUsage = foldInputTokenUsage(
      t.usage.inputTokenUsage,
      ev.usage.input_token_usage,
    );
  }
  if (ev.type === "completed") {
    const dropped =
      Number(ev.payload?.["dropped_unparsed_lines"] ?? 0) +
      Number(ev.payload?.["dropped_unrecognized_events"] ?? 0);
    if (Number.isFinite(dropped) && dropped > 0) t.droppedEvents += dropped;
    // #31 exit evidence: the run loop discloses a non-aborted signal kill, a
    // non-zero exit, or a spawn failure as TYPED payload fields (never prose).
    const crash = classifyCompletedCrash(ev.payload);
    if (crash) t.transientFailures.push(crash);
    t.vendorFailure = completionVendorFailure(ev);
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
    // QA-040: an armed browser MCP call is trusted live-web ACTIVITY even though
    // its kind is "mcp" — mark the browser attempted and count it as web
    // attempted (a successful result below records satisfied web activity).
    if (matchesBrowser(t, tool)) {
      t.browser.attempted = true;
      t.web.attempted = true;
      t.web.tool = t.web.tool ?? tool.name;
      t.web.target = tool.target ?? t.web.target;
    }
    return;
  }

  if (ev.type !== "tool_result") return;
  if (tool.status === undefined) {
    // A result without a status must never silently count as ok.
    t.statuslessResults += 1;
    if (beltToolEvent)
      belt.recordDelegationBeltResultFailure(
        t,
        tool,
        "required delegation belt tool result omitted status",
      );
    return;
  }
  if (tool.status === "cancelled" || tool.status === "denied") {
    if (beltToolEvent)
      belt.recordDelegationBeltResultFailure(
        t,
        tool,
        `required delegation belt tool result marked ${tool.status}`,
      );
    if (tool.kind === "web") {
      const summary = redactSecrets(
        tool.error_summary ?? tool.content_summary ?? `web tool result marked ${tool.status}`,
      ).slice(0, 1000);
      t.toolErrors.push({
        tool: tool.name,
        kind: tool.kind,
        target: tool.target ?? null,
        summary,
        toolUseId: tool.use_id ?? null,
        recovered: false,
      });
      t.web.attempted = true;
      t.web.failed = true;
      t.web.tool = tool.name;
      t.web.target = tool.target ?? t.web.target;
      t.web.errorSummary = summary;
    }
    if (matchesBrowser(t, tool)) {
      t.browser.attempted = true;
      t.web.attempted = true;
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
    // QA-040: a failed armed-browser call is browser activity that did not
    // satisfy. It contributes web `attempted` (a call was made) and, since the
    // browser is a live-egress channel, a web failure — but a later successful
    // web/browser call still records satisfied activity (the ok branch below).
    if (matchesBrowser(t, tool)) {
      t.browser.attempted = true;
      t.browser.failed = true;
      t.web.attempted = true;
      t.web.failed = true;
      t.web.errorSummary =
        t.web.errorSummary ??
        redactSecrets(tool.error_summary ?? "browser tool result marked error").slice(0, 1000);
    }
    return;
  }
  // status === "ok": recovery needs the same tool + kind + target, the same non-null
  // use id when both sides have one (else the legacy tuple key), and an observed
  // command end: a background handoff or elapsed timeout proves nothing (#450).
  const resultToolUseId = tool.use_id ?? null;
  for (const err of commandOutcomeUnconfirmed(tool.command_outcome) ? [] : t.toolErrors) {
    // INV-043: a later identical-looking invocation cannot launder an earlier
    // error when both vendor records prove different invocation ids.
    if (
      !err.recovered &&
      err.tool === tool.name &&
      err.kind === tool.kind &&
      err.target === (tool.target ?? null) &&
      (err.toolUseId === null || resultToolUseId === null || err.toolUseId === resultToolUseId)
    ) {
      err.recovered = true;
    }
  }
  if (tool.kind === "web") {
    t.web.attempted = true;
    // Any success marks web activity satisfied; invocation-keyed failures stay
    // disclosed until that same tool/target recovers (INV-043).
    t.web.satisfied = true;
    // Derived rollup, single source of truth: the invocation-keyed
    // toolErrors store (the recovery loop above already marked matching
    // errors recovered). Multiple failed invocations stay disclosed until EACH
    // recovers; a missing target never wildcards (exact null==null match).
    t.web.failed = t.toolErrors.some((e) => e.kind === "web" && !e.recovered);
    // Keep the summary in lockstep with the rollup: point at a live
    // unrecovered failure, or clear once everything recovered.
    t.web.errorSummary = t.web.failed
      ? (t.toolErrors.find((e) => e.kind === "web" && !e.recovered)?.summary ?? t.web.errorSummary)
      : null;
    t.web.tool = tool.name;
    t.web.target = tool.target ?? t.web.target;
    // QA-042: typed retrieval is verified; dispatch-only completion stays
    // dispatched. An absent stamp never claims verification.
    bumpWebVerification(t, tool.web_retrieval);
  }
  // QA-040: a successful engine-injected browser call is verified web activity;
  // user MCP servers cannot match this namespace.
  if (matchesBrowser(t, tool)) {
    t.browser.attempted = true;
    t.browser.satisfied = true;
    t.web.attempted = true;
    t.web.satisfied = true;
    t.web.verification = "verified";
    // The recovery loop above already marked a matching earlier browser error
    // recovered; recompute the disclosed failure rollup from what remains.
    t.browser.failed = t.toolErrors.some(
      (e) =>
        e.kind === "mcp" &&
        matchesBrowser(t, { name: e.tool, target: e.target ?? undefined }) &&
        !e.recovered,
    );
    t.web.failed = t.toolErrors.some((e) => e.kind === "web" && !e.recovered) || t.browser.failed;
    if (!t.web.failed) t.web.errorSummary = null;
    t.web.tool = t.web.tool ?? tool.name;
    t.web.target = tool.target ?? t.web.target;
  }
}

const TELEMETRY_TOOL_ERRORS_MAX = 20;

export function unrecoveredToolErrors(t: AttemptTelemetry): ToolErrorRecord[] {
  return t.toolErrors.filter((e) => !e.recovered);
}

export function toolWarnings(t: AttemptTelemetry): ToolErrorRecord[] {
  // Every unrecovered tool error remains warning evidence. Optional web
  // denial/error is never hidden merely because no later retrieval succeeded;
  // an explicitly persisted required-web contract is gated separately by
  // webUnsatisfied.
  return unrecoveredToolErrors(t);
}

export function setAttemptOutcome(
  t: AttemptTelemetry,
  opts: {
    captureFailed?: boolean;
    deliverablePresent: boolean;
    gatesPassed: boolean | null;
    harnessErrored: boolean;
    webRequiredUnsatisfied: boolean;
    /** D-16 work_state from the unified finalizer (INV-116): a needs_input/
     * incomplete veto rides HERE without flipping `status` — the lifecycle
     * stays succeeded-class; applyability and the CLI exit read the axis. */
    workState?: WorkState;
    /** A lane may accept a clean empty deliverable (read-only ask/report).
     * Harness, gate, web and belt failures still fail the attempt; only the
     * missing deliverable stops being a contract failure on its own. */
    emptyDeliverableAllowed?: boolean;
  },
): void {
  const warnings = toolWarnings(t).length;
  const contractFailed =
    (!opts.deliverablePresent && opts.emptyDeliverableAllowed !== true) ||
    opts.gatesPassed === false;
  // INV-030: after injection, startup failure or an unrecovered exact belt
  // operation is an unsatisfied required capability. It can only ELEVATE
  // severity, never soften into a warning or mask a harder terminal fact.
  const beltUnavailable = belt.delegationBeltUnavailable(t) || belt.delegationBeltToolFailure(t);
  const status: AttemptOutcomeStatus = opts.webRequiredUnsatisfied
    ? "blocked"
    : opts.harnessErrored || opts.captureFailed || contractFailed || beltUnavailable
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
    ...(t.requestRefusal ? { request_refusal: t.requestRefusal } : {}),
    web_evidence: {
      required: t.web.required,
      mode: t.web.mode,
      effective_mode: t.web.effectiveMode,
      attempted: t.web.attempted,
      satisfied: t.web.satisfied,
      status: webStatus(t),
      verification: t.web.verification,
      tool: t.web.tool,
      target: t.web.target,
      error_summary: t.web.errorSummary,
    },
    ...(t.browser.requested
      ? {
          browser_evidence: {
            server_name: t.browser.serverName,
            attempted: t.browser.attempted,
            satisfied: t.browser.satisfied,
            failed: t.browser.failed,
            unused: browserUnused(t),
          },
        }
      : {}),
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
            unavailable: belt.delegationBeltUnavailable(t),
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
    usage_cost: attemptUsageCostSummary(t.usageCost),
    effort_resolution: t.effortResolution,
    request_refusal: t.requestRefusal,
    raw_context: t.rawContext,
    processing: t.processing,
    processing_cost_basis: t.processingCostBasis,
    prompt_cache_ttl: t.promptCacheTtl,
    attempt_id: attemptId,
    harness_id: harnessId,
    observed_model: t.observedModel,
    observed_model_catalog_match: t.observedModelCatalogMatch ?? null,
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
      verification: t.web.verification,
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
      delegation_belt_unavailable: belt.delegationBeltUnavailable(t),
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
    // Only present when the browser was armed for this attempt (QA-040).
    ...(t.browser.requested
      ? {
          browser: {
            requested: t.browser.requested,
            server_name: t.browser.serverName,
            attempted: t.browser.attempted,
            satisfied: t.browser.satisfied,
            failed: t.browser.failed,
            unused: browserUnused(t),
          },
        }
      : {}),
    usage: {
      input_tokens: t.usage.inputTokens,
      output_tokens: t.usage.outputTokens,
      cached_input_tokens: t.usage.cachedInputTokens,
      ...(t.usage.inputTokenUsage === undefined
        ? {}
        : { input_token_usage: t.usage.inputTokenUsage }),
    },
  };
}

/** Sum all attempt records (candidates + synthesis). Legacy fields sum known
 * reports; normalized fields require complete coverage, never a partial total. */
export function aggregateRunTokenUsage(
  records: AttemptTelemetryRecord[],
): AttemptTelemetryRecord["usage"] {
  const sum = (pick: (u: AttemptTelemetryRecord["usage"]) => number | null): number | null => {
    let total: number | null = null;
    for (const r of records) {
      const v = pick(r.usage);
      if (v !== null) total = (total ?? 0) + v;
    }
    return total;
  };
  const inputTokenUsage = records.reduce<InputTokenUsage | undefined>(
    (acc, record) => foldInputTokenUsage(acc, record.usage.input_token_usage),
    undefined,
  );
  return {
    input_tokens: sum((u) => u.input_tokens),
    output_tokens: sum((u) => u.output_tokens),
    cached_input_tokens: sum((u) => u.cached_input_tokens),
    ...(inputTokenUsage === undefined ? {} : { input_token_usage: inputTokenUsage }),
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
      verification: "none" as const,
      tool: null,
      target: null,
      error_summary: null,
    }
  );
}

/**
 * Web evidence gating for explicitly persisted required-web contracts.
 * Ordinary off/auto/cached/live run construction stores required=false, so
 * unused, denied, errored, or unavailable optional web never decides terminal
 * success. The compatibility field remains enforceable when it is explicitly
 * true in an existing contract.
 */
export function webUnsatisfied(t: AttemptTelemetry): boolean {
  return t.web.required && !t.web.satisfied;
}
