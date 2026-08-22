import { existsSync } from "node:fs";
import {
  effectiveAuthPreference,
  observeNativeSessionEvent,
  resumeSessionForProfile,
  rotateSpecOnTypedLimit,
  selectedProfileAvailability,
} from "./credential-profiles.js";
import { OrchestratorCredentials, rotatedSpecInLaneHome } from "./orchestrator-credentials.js";
import { accountPoolRows } from "./account-pool.js";
import { writeRunTelemetryArtifact } from "./runTelemetryWriter.js";
import {
  buildFileBackedSynthesisInput,
  materializeWinnerOutputs,
  stageFileBackedContext,
  writeCandidateAttemptArtifacts,
} from "./candidateOutputs.js";
import { processAttemptUsage } from "./attemptUsage.js";
import {
  appliedAttemptFacts,
  assertDelegatedEvidence,
  isMutatingAccess,
  outerBoundaryNotice,
  scopedHarnessHome,
  type ScopedHarnessHome,
} from "./delegatedHome.js";
import * as AC from "./attemptUsageCost.js";
import {
  type CandidateRun,
  candidateRoster,
  convergenceOutcomeFacts,
  isWorkingCandidate,
  partitionCandidates,
  toCandidateEvidence,
  unanimousDeclaredFailure,
} from "./candidateEvidence.js";
import { capabilityIntents } from "@claudexor/gateway";
import { policyFindings } from "./policyFindings.js";

import { join } from "node:path";
import type {
  AccessProfile,
  AuthSourceReadiness,
  DeepScanSynthesis,
  RouteRankingRationale,
  RouteDropStage,
  Attachment,
  ControlReviewerPanelEntry,
  EffortHint,
  HarnessCapabilities,
  KnownModelEntry,
  ExternalContextPolicy,
  HarnessEvent,
  Intent,
  InteractionHandlerResult,
  InteractionRequest,
  ModeKind,
  PaidBudget,
  CredentialUnusableObservation,
  QuotaAbsence,
  QuotaSnapshot,
  RoutingGoal,
  ProtectedPathApproval,
  ProjectConfig,
  RequestRequirementResolution,
  ReviewFinding,
  RunEvent,
  RunLifecycle,
  RunOutcomeFacts,
  ActiveTaskContract,
  TestCommandInvocation,
  ProviderFamily,
  AuthPreference,
  CredentialProfile,
  ImplementationTransport,
  RawGitPatchEnvelope,
  WebPolicySupport,
  WorkspaceEnvelope,
} from "@claudexor/schema";
import {
  type PlanRunDeps,
  finalizePlanRun,
  runCouncilPlan,
  writePlanHarnessFailure,
} from "./planRun.js";
import {
  runPlannerAttempt as executePlannerAttempt,
  type PlannerAttemptArgs,
  type PlannerAttemptDeps,
  type PlannerAttemptOutcome,
} from "./plannerAttempt.js";
export type { PlannerAttemptArgs, PlannerAttemptOutcome } from "./plannerAttempt.js";
import {
  HarnessRunSpec,
  type ExtraMcpServer,
  FinalVerifyRecord,
  ModeKind as ModeKindSchema,
  QuotaSnapshot as QuotaSnapshotSchema,
  isBlocking,
  makeOutcomeFacts,
  strictifyOutputSchema,
  estimateEffectiveAuthRoute,
} from "@claudexor/schema";
import { globalConfigDir, loadConfig } from "@claudexor/config";
import type { AdapterRegistry, HarnessAdapter, InteractionChannel } from "@claudexor/core";
import {
  acceptedTryOutput,
  AccessProfileIncompatibleError,
  AnswerAssembly,
  CLAUDEXOR_BROWSER_ARTIFACT_SUBDIR,
  countsAsAgentProgress,
  HarnessUnavailableError,
  summarizeDiffPaths as diffStats,
  withInactivityWatchdog,
} from "@claudexor/core";
import { assertRouteModelsAllowed, runModelGovernedRoute } from "./modelGovernance.js";
import { authModeForCredentialRoute, authModeForPreference } from "./auth-route-classification.js";
import { governRouteEffort } from "./effortGovernance.js";
import { isFullAccess, RequestRequirementsResolver } from "./requestRequirements.js";
import { DelegationBudgetAuthority } from "./delegationBudgetAuthority.js";
import { activateDelegationParent } from "./delegation-parent-activation.js";
import { writeRoutingFailureTerminal } from "./routing-failure.js";
export { routingFailureClassification } from "./routing-failure.js";
import { runBounded } from "./run-bounded.js";
import { planPrompt } from "./plan-prompt.js";
import { verifiedPlanBrief, withPlanBrief } from "./planBrief.js";
import { resolveRunInputDefaults } from "./run-input-resolution.js";
import { beginAnnouncedRun } from "./runEventLog.js";
import { arbitrationBudgetOptions, decisionBudgetSummary } from "./decisionBudget.js";
import { buildRevisePrompt } from "./revisePrompt.js";
import {
  type AnnouncedRunContext,
  cancelledResult,
  declaredFailure,
  failTerminally,
  guardAnnouncedRun,
  writeFailure,
} from "./runTerminals.js";
import { type BudgetDenial, budgetFailureRecord, classifyBudgetFailure } from "./budgetFailure.js";
import { finalizeStructuredOutput } from "./structuredOutput.js";
import { admitRun } from "./runAdmission.js";
import {
  dropDeltaPastBudget,
  emitPlanProgress,
  emitTransientExhausted,
  emitTransientRetryPlan,
  observeReadonlySpend,
} from "./laneStreamEvents.js";
import {
  promptWithEngineConstraints,
  sleep,
  redactHarnessEvent,
  harnessEventPayload,
  safeErrorMessage,
  renderSummary,
  observeBudgetSignals,
  rotateOnStall,
  recordCleanAttemptMetrics,
  envInheritance,
  transientRetryPolicy,
  reviewerTimeoutMs,
  harnessInactivityTimeoutMs,
  observeAuthSwitch,
  emitPrimaryDivergence,
  emitPoolDegraded,
  deliveryRefusalFailure,
  winnerNeedsHuman,
  writeRaceDeliveryDecision,
} from "./runSupport.js";
import {
  candidateStatusInRouteContext,
  resolveReadOnlyRouteContext,
  type ResolvedRouteContext,
} from "./routeContext.js";
import { resolveAutoReviewerPanel, resolveExplicitReviewerPanel } from "./reviewerPanel.js";
import { ensureWriteModeGitBoundary } from "./git-precondition.js";
import {
  buildContinuation,
  type ContinuityDisclosureResult,
  type ContinuityRequest,
  type ContinuityTurn,
} from "./continuity.js";
import {
  activePlanPointer,
  resolveContinuitySummary,
  workspaceAnchor,
} from "./continuity-facts.js";
import { runDiffReview, type DiffReviewInput, type DiffReviewResult } from "./diffReview.js";
import {
  type DeepScanReducerDeps,
  rawScoutBundle,
  resolveDeepScanSynthesis,
} from "./deepScanReducer.js";
import {
  type AttemptTelemetry,
  classifyAdapterThrow,
  createAttemptTelemetry,
  observeAttemptTelemetry,
  setAttemptOutcome,
  telemetrySummary,
  toolWarnings,
  unrecoveredToolErrors,
  webUnsatisfied,
} from "./attemptTelemetry.js";
import { newAttemptOutputMarkers } from "./attemptOutputMarkers.js";
import * as delegateFailure from "./delegationFailure.js";
import * as secretDiff from "./secretDiff.js";
import { dominantHarnessFailureCategory, harnessFailureNextActions } from "./harnessFailure.js";
import {
  finalizeAttempt,
  readOnlyNoSuccessTerminal,
  resolveWorkReportEnvelope,
  unrecoveredToolErrorFailure,
  unwrapWorkReportEnvelope,
  webEvidenceFailure,
  type AttemptOutcomeClass,
  type ResolvedWorkReportEnvelope,
  type WorkReportEnvelopeMode,
} from "./attemptFinalize.js";
import {
  buildContinuationPacket,
  decideContinuation,
  synthesizeContinuationRequest,
} from "./continuation.js";
import { interactionChannelFor } from "./interaction.js";
import { gateSpecsFromContract, renderTestsEvidence } from "./contract-gates.js";
import { buildTaskContract } from "./task-contract-builder.js";
import { ArtifactStore, type RunPaths } from "@claudexor/artifact-store";
import type { EventLog } from "@claudexor/event-log";
import {
  buildContextPack,
  rawContextForEnvelope,
  preflightEvidence,
  writeEvidencePacket,
} from "@claudexor/context";
import {
  WorkspaceManager,
  captureRawPatchEnvelope,
  createRevertAnchorFromPatchOrNull,
  createRevertAnchorOrNull,
  ensureClaudeBridge,
  consumeRawPatchEnvelope,
  snapshotTree,
  type EnsureGitRepositoryResult,
} from "@claudexor/workspace";
import {
  blockedDecisionOverride,
  finalVerifyBlocks,
  finalVerifyPatch,
  verifyAndDeliver,
} from "@claudexor/delivery";
import { HarnessGateway } from "@claudexor/gateway";
import {
  ReadinessLedger,
  type ReviewerSpec,
  evaluateConvergence,
  failureSignature,
  gatesPassed,
  reviewCandidate,
  revalidateFindings,
  runGates,
} from "@claudexor/review";
import { type CandidateEvidence, arbitrate } from "@claudexor/arbitration";
import { type SynthesisMode, buildSynthesisPlan, decideSynthesis } from "@claudexor/synthesis";
import {
  attemptCostEvidence,
  attemptUsageCostSettlement,
  BudgetLedger,
  isBudgetTerminal,
  type RouteAuthEvidence,
  type RouterCandidate,
  explainRanking,
  loadHarnessMetrics,
  promptFingerprint,
  rankHarnesses,
  reviewUsageCostSettlement,
} from "@claudexor/budget";
import {
  readTextSafe,
  appendLine,
  assertNoInlineSecretValues,
  DELEGATION_ENV,
  hashJson,
  newId,
  noProjectRepoRoot,
  redactSecrets,
  safeInvoke,
  sha256,
  userConfigDir,
  writeText,
} from "@claudexor/util";

export interface OrchestratorDeps {
  registry: AdapterRegistry;
  /** Daemon-lifetime Delegate family budget authority. */
  delegationBudgetAuthority?: DelegationBudgetAuthority;
  reviewers?: ReviewerSpec[];
  paidBudget?: PaidBudget;
  routingGoal?: RoutingGoal;
  /** Durable global quota projection, injected by the daemon boundary. */
  quotaSnapshots?: () => readonly QuotaSnapshot[];
  /** The same projection's typed ABSENCES — the half that carries
   * `auth_revoked`, i.e. the vendor's own rejection of a profile's credential.
   * Without it, admission can only read the local login store. */
  quotaAbsences?: () => readonly QuotaAbsence[];
  /** Persist typed live quota/cooldown events into that same projection. */
  quotaEventSink?: (harnessId: string, event: HarnessEvent) => void;
  /** Live typed `credential_unusable` observations (A7): dead-credential
   * evidence rotation must not rediscover by spending attempts. */
  credentialUnusable?: () => readonly CredentialUnusableObservation[];
  /** Evidence sink for a fresh differential-probe verdict (A7). */
  recordCredentialUnusable?: (obs: CredentialUnusableObservation) => void;
  /** Typed per-harness run refusal while that harness's unified-accounts
   * migration is incomplete (crash between phases; INV-137). Null = not blocked. */
  accountsMigrationGate?: (harnessId: string) => { reason: string } | null;
  /** Ordered explicit reviewer panel. Unlike legacy per-family overrides this
   * preserves duplicate harness entries, so one provider can review through
   * multiple requested models in a single panel pass. */
  reviewerPanel?: ControlReviewerPanelEntry[];
  /**
   * Optional per-provider-family reviewer model override. No hardcoded versions: the caller supplies the
   * model id, default keeps each harness's own default reviewer model.
   */
  reviewerModels?: Partial<Record<ProviderFamily, string>>;
  /** Optional per-provider-family reviewer effort override where the harness supports it. */
  reviewerEfforts?: Partial<Record<ProviderFamily, EffortHint>>;
}

/**
 * Continuity facts the daemon hands the engine for a thread turn (INV-137).
 * Cheap thread-store data only; the engine reads prior outputs + git anchor
 * itself (it owns the artifact store) and does the checkpoint math.
 */
export interface ThreadContinuityContext {
  /** The current turn being run (the disclosure is stamped here). */
  turnId: string;
  /** Requested credential profile for this run (null = engine default). */
  profileId: string | null;
  /** Prior turns of the thread, in order (EXCLUDES the current turn). */
  priorTurns: Array<{ id: string; prompt: string; runId: string | null }>;
  /** All lane checkpoints of the thread (to locate the prior head's lane). */
  laneCheckpoints: Array<{ harness: string; profileId: string | null; turnId: string }>;
}

export interface RunInput {
  repoRoot: string;
  /**
   * Tree the harness actually executes in, when different from `repoRoot`.
   * `repoRoot` always anchors config/artifacts/contract (the project); for an
   * ISOLATED thread the turn runs in the thread's persistent worktree, so
   * `executionRoot` points there while artifacts still land under the project.
   * Defaults to `repoRoot` (in-place threads and ordinary runs).
   */
  executionRoot?: string;
  /** Frozen retry provenance: historical replay may omit workspaceRoot; fresh writes may not. */
  retryOf?: string | null;
  /** Project Git initialization that had to happen before an isolated thread
   * worktree could be materialized. Announced immediately after run.created. */
  projectGitInitialization?: EnsureGitRepositoryResult | null;
  prompt: string;
  /** Caller-supplied system-level instructions layered onto every task-producing
   *  lane (primary, candidate, planner, explorer, orchestrate-planner) — never
   *  reviewers, synthesis, or the auth smoke. */
  instructions?: string;
  /** Files/images attached to this turn, resolved to scoped on-disk paths. */
  attachments?: Attachment[];
  /**
   * Request the agent-driven browser. Preflight resolves it per selected lane;
   * a zero-effective pool refuses and a mixed pool carries explicit receipts.
   */
  browser?: boolean;
  mode?: ModeKind;
  contextMode?: "off" | "auto";
  harnesses?: string[];
  primaryHarness?: string;
  /** Internal provenance: only an explicit primary blocks Delegate's Any-capable
   * single-lane preference. */
  primaryHarnessExplicit?: boolean;
  routingGoal?: RoutingGoal;
  n?: number;
  baseRef?: string;
  attempts?: number | null;
  /** agent flag: iterate until the convergence predicate is clean (no fixed cap). */
  untilClean?: boolean;
  /** ask flag: bounded multi-scout research sweep with synthesis. */
  deepScan?: boolean;
  /** Server-owned frozen-plan reference (implement-plan turns): the engine
   * verifies the hash and materializes the plan as a file in the run context —
   * plan text NEVER rides the prompt (D17/D27). */
  planRef?: { runId: string; sha256: string; path: string };
  /** agent flag: create-from-scratch intent (the old `create` mode). */
  create?: boolean;
  /** plan strategy (INV-031): N harnesses draft plans in parallel, the primary
   * merges them into one unified plan + one question set. Plan mode only;
   * `n` sets the member count (2..4). */
  council?: boolean;
  /** agent flag (D32): the harness may spawn bounded isolated sub-runs through
   * the injected delegation belt. Requires a lane with
   * `capability_profile.mcp_injection`; known pre-start unavailability degrades
   * to an ordinary Agent run with a durable warning. */
  delegate?: boolean;
  /** Ordinary run lineage; not proof of belt delegation by itself. */
  parentRunId?: string | null;
  /** Belt-only provenance minted by the scoped belt runner. */
  delegatedFromRunId?: string | null;
  /** Daemon job id whose atomic admission authorized this child. */
  delegationAdmissionId?: string | null;
  /** @internal Marks that this invocation, rather than merely this caller-
   * supplied run id, acquired a delegated child ledger. */
  onDelegatedLedgerAttached?: () => void;
  /** Current top-level Delegate run id, bound after strategy allocation. */
  delegationParentRunId?: string | null;
  /** The daemon-built delegation belt MCP server descriptor (carries the
   * delegation env: parent run id, depth, sub-run cap, budget snapshot). Injected
   * into agent lanes when `delegate` is on and the lane supports mcp_injection.
   * Null when the embedder knows it cannot build one; the run then continues as
   * ordinary Agent with a durable typed degradation receipt. */
  delegationBelt?: ExtraMcpServer | null;
  synthesis?: SynthesisMode;
  /** Explicit typed-argv deterministic gates from caller-provided run configuration. */
  tests?: TestCommandInvocation[];
  /** Typed per-run approval for changing auto-protected gate/test paths. */
  protectedPathApprovals?: ProtectedPathApproval[];
  paidBudget?: PaidBudget;
  /** Access profile; e.g. `full` for autonomous terminal tasks (agent and in-place convergence). */
  access?: AccessProfile;
  /** External/web context policy. Separate from shell/network sandboxing. */
  web?: ExternalContextPolicy;
  externalContextPolicy?: ExternalContextPolicy;
  /**
   * Scalar model convenience: expands to the RESOLVED PRIMARY harness only
   * (never the pool). Rejected when no primary is resolvable (INV-103).
   * Cleared during input resolution — routing reads `models`.
   */
  model?: string;
  /** Harness-scoped model map (harness id → model id). Specific beats general:
   * an entry wins over the scalar `model` and the per-harness settings default. */
  models?: Record<string, string>;
  /** Optional reasoning-effort hint forwarded to harnesses that support it. */
  effort?: EffortHint;
  /** Harness-scoped effort map (harness id → effort). Specific beats general: an
   * entry wins over the scalar `effort` and the per-harness settings default,
   * analogous to `models`. Exact Retry replays the frozen per-lane efforts here
   * so a non-primary lane keeps its own effort (QA-035 completeness). */
  efforts?: Record<string, EffortHint>;
  /** Pre-assigned ids so a caller (daemon/control-api) knows them before the run starts. */
  runId?: string;
  taskId?: string;
  /** Thread this run is a turn of (chat/session-first); recorded in events. */
  threadId?: string;
  /** Preferred auth route for harness attempts (subscription/api_key/auto). */
  authPreference?: "subscription" | "api_key" | "auto";
  /** Explicit credential profile for this turn (INV-135): resolved once per
   * routed harness; unknown/disabled/mismatched ids refuse, never default. */
  credentialProfileId?: string | null;
  /** The thread's durable per-harness account bindings (D-U1 order 2),
   * daemon-derived from the thread's own lane evidence; supplied only for
   * unpinned thread turns — an explicit pin always wins. */
  threadAccountBindings?: Record<string, string>;
  /**
   * Native CLI session ids to resume, keyed by harness id (the thread's vendor
   * session cache). A routed harness with an entry continues its own native
   * conversation (`codex exec resume` / `claude --resume`) instead of starting fresh.
   */
  resumeSessions?: Record<string, { sessionId: string; profileId: string | null }>;
  /** Called when a harness emits its native session id (recorded for future resume). */
  /** profileId = the EFFECTIVE profile the session was created under
   * (adapter-stamped; rotation makes it differ from the requested id). */
  onSessionObserved?: (
    harnessId: string,
    nativeSessionId: string,
    observedModel?: string | null,
    profileId?: string | null,
  ) => void;
  /**
   * Continuity facts for this thread turn (INV-137), supplied by the daemon
   * which owns the thread store. The engine computes the per-lane continuation
   * packet at spec-build (checkpoint math + delta/budget), materializes it as a
   * file, and points the prompt at it. Absent for non-thread one-shots.
   */
  threadContinuity?: ThreadContinuityContext;
  /** Records the resolved continuity disclosure onto the current turn (the
   * daemon writes it to the thread store). Called once per resolved lane. */
  onContinuityResolved?: (turnId: string, disclosure: ContinuityDisclosureResult) => void;
  /** Best-effort live sink for every RunEvent, called after durable persistence. */
  onEvent?: (event: RunEvent) => void;
  /** Durable RunEvent sink owned by the daemon journal; failures fail the run. */
  onEventPersist?: (event: RunEvent) => void;
  /** In-process sink for the full per-harness event stream (richer than RunEvent). */
  onHarnessEvent?: (event: HarnessEvent) => void;
  /** Called once when the run id/dir are known, before any harness work begins. */
  onRunStart?: (info: { runId: string; taskId: string; runDir: string }) => void;
  /**
   * Interactive answer surface (waiting_on_user). When a harness raises a
   * question, the orchestrator emits `interaction.requested`, calls this
   * handler, and blocks ONLY that attempt's tool until answers arrive, a finite
   * configured timeout elapses (then a benign decline), or run termination.
   * A disabled timeout waits until answer/cancel/terminal/restart. When the
   * handler is absent, runs are non-interactive end to end.
   */
  onInteraction?: (ctx: PendingInteractionContext) => Promise<InteractionHandlerResult>;
  /** Answer timeout: finite milliseconds, or null to wait until external release. */
  interactionTimeoutMs?: number | null;
  /** Cancellation: aborts the run and cancels in-flight harness work. */
  signal?: AbortSignal;
  /**
   * Run the convergence loop against the live `repoRoot` directly (no git worktree).
   * For external stateful harness environments where runtime state, not a patch,
   * is the deliverable. Only honored by convergence modes.
   */
  inPlace?: boolean;
  /** External-orchestrator run: every attempt uses a scoped harness HOME even
   * in-place, keeping profile and writable vendor state explicit. This is not
   * an OS boundary. */
  delegated?: boolean;
  /**
   * Per-run globs no candidate may touch (create/modify/delete/rename). Unlike
   * project protected paths, these produce a deny-path violation; both require
   * a human decision before delivery. The engine's post-diff policy gate is the
   * authoritative enforcement (violation → blocking finding → blocked,
   * patch undelivered). An in-place run with denyPaths is refused at preflight:
   * a live tree offers no pre-delivery containment, and silent non-enforcement
   * is never acceptable. accept_risk MAY still deliver (INV-111).
   */
  denyPaths?: string[];
  /**
   * JSON Schema the run's final ANSWER must conform to (normalized at the
   * engine boundary). MANDATORY when present: every answer-producing lane is
   * constrained natively, an incapable lane is a typed preflight refusal, and
   * ONE engine validator writes final/output.json + a conformance receipt. A
   * non-conformant answer ends success-with-warnings, never a hard fail.
   * Applies to agent race/ask answers; other strategies refuse loudly.
   */
  outputSchema?: Record<string, unknown> | null;
  /**
   * Per-run turn cap. Run-level beats per-harness settings (specific beats
   * general); a lane whose manifest lacks max_turns support discloses the
   * ignored knob instead of silently dropping it.
   */
  maxTurns?: number | null;
}

/** Context handed to RunInput.onInteraction for one pending question. */
export interface PendingInteractionContext {
  runId: string;
  taskId: string;
  attemptId: string;
  harnessId: string;
  request: InteractionRequest;
  requestedAt: string;
  timeoutAt: string | null;
}

export interface OrchestratorResult {
  runId: string;
  taskId: string;
  mode: ModeKind;
  /** Terminal run LIFECYCLE (D8) — how far the process got. */
  lifecycle: RunLifecycle;
  /** The terminal outcome AXES (checks/review/reason/noChanges). */
  facts: RunOutcomeFacts;
  winner: string | null;
  runDir: string;
  summary: string;
  candidates: { attemptId: string; harnessId: string; status: string }[];
  decisionPath?: string;
  reviewVerified?: boolean;
  /** Settled ledger spend for this run (USD); null when no ledger tracked it.
   * Consumer: the orchestrate executor's aggregate budget across sub-runs. */
  spendUsd?: number | null;
  /** Why a `cancelled` run was cancelled, when it was NOT a plain user cancel —
   * today only `wall_clock_exceeded` (the maxSeconds deadline). Absent for a
   * user-initiated cancel. */
  cancelReason?: string;
}

/** User-level per-harness defaults (from the global config) applied at route time. */
interface HarnessRouteSettings {
  defaultModel: string | null;
  effort: EffortHint | null;
  web: ExternalContextPolicy | null;
  maxTurns: number | null;
  maxRounds: number | null;
  toolsAllow: string[];
  toolsDeny: string[];
  fallbackModel: string | null;
}

/** A routed candidate adapter plus its manifest capabilities and user settings. */
export interface RoutedAdapter {
  adapter: HarnessAdapter;
  adapterAccess: AccessProfile;
  webSupport: WebPolicySupport;
  providerFamily: ProviderFamily;
  supportsMaxTurns: boolean;
  supportsToolLists: boolean;
  browserRequirement: RequestRequirementResolution;
  /** Per-lane deny-path enforcement disclosure (postdiff_only until an adapter
   * supports native pre-write deny). */
  denyRequirement: RequestRequirementResolution;
  /** Per-lane Delegate requested/effective truth. */
  delegationRequirement: RequestRequirementResolution;
  /** Harness-wide advertised effort ladder (empty = not tunable → the requested
   * effort is DISCLOSED as ignored); the adapter re-resolves per model in its own env. */
  effortLevels: readonly EffortHint[];
  /** Manifest model truth source (used when the adapter has no live models()). */
  knownModels: readonly KnownModelEntry[];
  /** Pre-spawn credential-route estimate (INV-061 projection of preference x
   * doctor source readiness); null = undecidable, model gates stay fail-closed. */
  authRouteEstimate: "local_session" | "api_key" | null;
  /** Quota identity resolved before pool ranking. The model is frozen for the
   * initial route; a fallback/downgrade model forces a fresh profile preflight
   * before spawn instead of reusing this admission. */
  quotaAdmission: {
    model: string | null;
    profile: CredentialProfile | null;
    route: "vendor_native" | "managed_api_key" | null;
  };
  /** Manifest `synthesize` capability (#27 / D-6): only such routes are eligible
   * to run the deep-scan bounded synthesis reducer over the scout reports. */
  supportsSynthesize: boolean;
  /** Manifest `interactive` capability: only such routes are OFFERED an
   * InteractionChannel (gate). */
  supportsInteractive: boolean;
  /** Manifest `json_schema_output`: only such routes receive
   * HarnessRunSpec.output_schema (gate); others keep fenced-JSON parsing. */
  supportsJsonSchemaOutput: boolean;
  /** Manifest `work_report_transport` (D-16): whether/how this route carries a
   * WorkReport envelope. `unsupported` leaves the attempt's work_state
   * `unverified` (a disclosed absence). */
  workReportTransport: HarnessCapabilities["work_report_transport"];
  /** Manifest `structured_output_channel` (D-16): decides the no-caller-schema
   * envelope shape (side_tool = `{work_report}`; final_message = `{work_report,
   * output:string}`). */
  structuredOutputChannel: HarnessCapabilities["structured_output_channel"];
  /** Manifest `capability_profile.mcp_injection`: only such routes can receive
   * engine-injected MCP servers (browser, delegation belt). Delegate on a lane
   * without it degrades to ordinary Agent with a typed receipt. */
  supportsMcpInjection: boolean;
  /** Manifest `capability_profile.mcp_injection_requires_full_access`: the
   * injected belt can only reach the daemon at full access (codex's sandbox
   * cancels it below full). A delegate lane below full access on such a harness
   * degrades to ordinary Agent with a typed receipt. */
  mcpInjectionRequiresFullAccess: boolean;
  implementationTransport: ImplementationTransport;
  settings: HarnessRouteSettings | null;
}
const LABELS = "ABCDEFGHIJ".split("");
const NO_PROJECT_ROOT = noProjectRepoRoot();
/** Concurrency cap for parallel candidates/explorers (locked decision: min(n, 4)). */
const MAX_PARALLEL_CANDIDATES = 4;
/** Default wait for one interactive answer before a benign decline. */
const DEFAULT_INTERACTION_TIMEOUT_MS = 900_000;

export class Orchestrator {
  private readonly gateway: HarnessGateway;
  private readonly requestRequirements = new RequestRequirementsResolver();
  /** QA-034: the typed routing rationale computed ONCE at pool ordering, keyed
   * by run id so the terminal telemetry writer can record it as run evidence
   * (RunTelemetry.routing_rationale). Cleared when the run's telemetry is
   * written. Absent for runs with an explicit single-harness pool (no ranking). */
  private readonly routingRationaleByRun = new Map<string, RouteRankingRationale>();
  /** Per-attempt cap on forwarded live delta chunks (W-C4 flood guard, sol
   * #10): past this the deltas are dropped and the cutoff is disclosed once;
   * the complete message always still lands. */
  static readonly MAX_DELTAS_PER_ATTEMPT = 4000;

  constructor(private readonly deps: OrchestratorDeps) {
    this.gateway = new HarnessGateway(deps.registry);
  }

  /** Scoped DIFF review — thin delegate; mechanics live in diffReview.ts. */
  async reviewDiff(input: DiffReviewInput): Promise<DiffReviewResult> {
    return runDiffReview(input, {
      resolveReviewers: (root, pref) => this.resolveReviewers(root, pref),
      reviewScoped: (i) => this.reviewScoped(i),
      execRootOf: (root) => this.execRootOf({ repoRoot: root } as RunInput),
      envInheritance: (root) => envInheritance(this.config(root)),
    });
  }

  async run(input: RunInput): Promise<OrchestratorResult> {
    let resolved = this.resolveRunInput(input);
    // INV-062 at the ENGINE boundary: every surface fences prompts already,
    // but a direct embedder (or the daemon-less local REPL fallback) reaches
    // this entry without one. Prompts, per-run instructions, AND outputSchema
    // are durable artifacts (all land in the TaskContract) — the hard block
    // applies here too, so no in-process path can ever bypass it. outputSchema
    // rides the schema-aware branch: its property NAMES are field names (a
    // `token` field is legitimate), but string VALUES (const/default/enum) are
    // scanned for real secrets, matching the HTTP boundary exactly.
    assertNoInlineSecretValues(
      {
        prompt: resolved.prompt,
        instructions: resolved.instructions,
        outputSchema: resolved.outputSchema ?? undefined,
      },
      "$",
      "run input",
    );
    const parsedMode = ModeKindSchema.safeParse(resolved.mode ?? "agent");
    if (!parsedMode.success) {
      throw new Error(`unknown mode: ${String(resolved.mode)}`);
    }
    const mode: ModeKind = parsedMode.data;
    if (resolved.delegate === true && mode !== "agent") {
      throw new Error(`Delegate is an agent-only strategy (got mode=${mode})`);
    }
    const runId = resolved.runId ?? newId("run");
    let delegatedLedgerAttached = false;
    resolved = {
      ...resolved,
      runId,
      taskId: resolved.taskId ?? newId("task"),
      onDelegatedLedgerAttached: () => {
        delegatedLedgerAttached = true;
      },
    };
    if (resolved.delegate === true) {
      resolved = {
        ...resolved,
        delegationParentRunId: runId,
      };
    }
    resolved.outputSchema = admitRun(resolved, mode, {
      accessDefault: this.config(resolved.repoRoot).trust.access_default,
      projectProtectedPaths: () =>
        this.projectConfig(resolved.repoRoot).constraints.protected_paths,
      mandatoryFiles: () => this.projectConfig(resolved.repoRoot).context.mandatory_files,
    });
    // Reviewer panels are validated only inside Agent strategies that actually
    // review (race/convergence; Plan Council is the plan critique path) — AFTER run-dir
    // creation, so a doomed explicit panel yields typed failure ARTIFACTS
    // (failure.yaml naming the refusal) instead of a bare pre-run throw.
    // Ask and Plan never spawn code reviewers, so a panel there never spends doctor/
    // model probes and never fails a run that would not use it.
    // Whole-strategy terminal net: once a strategy ANNOUNCES its
    // run, any escaped throw still stamps failure.yaml + summary + run.failed
    // instead of orphaning events.jsonl.
    const releaseRunState = (settledRunId: string) => {
      this.routingRationaleByRun.delete(settledRunId);
      this.deps.delegationBudgetAuthority?.releaseRun(settledRunId);
    };
    try {
      return await guardAnnouncedRun(
        resolved.signal,
        (announce) => {
          switch (mode) {
            case "ask":
              // `--deep-scan` widens the answer into the bounded multi-scout
              // research sweep with synthesis (the old `audit --swarm`/`explore`).
              return resolved.deepScan
                ? this.runDeepScan(resolved, announce)
                : this.runAsk(resolved, announce);
            case "agent":
              // Engine strategies are FLAGS on agent (v0.9 collapse): `--until-clean`
              // and `--attempts` select the convergence loop; `--n` selects the race
              // width; `--create` switches the candidate intent to create_from_scratch.
              if (resolved.untilClean) return this.runConvergence(resolved, mode, null, announce);
              if (resolved.attempts !== undefined && resolved.attempts !== null) {
                return this.runConvergence(resolved, mode, resolved.attempts, announce);
              }
              return this.runRace({ ...resolved, n: resolved.n ?? 1 }, mode, announce);
            case "plan":
              return this.runPlan(resolved, announce);
          }
        },
        async ({ runId }) => {
          const authority = this.deps.delegationBudgetAuthority;
          if (!authority?.hasParent(runId)) return;
          authority.beginParentClose(runId);
          await authority.waitForChildren(runId);
        },
        // Single per-run terminalization hook: release the routing-rationale map
        // entry on EVERY terminal (incl. a run that died before its telemetry
        // writer ran, which is the leak this closes).
        releaseRunState,
      );
    } catch (error) {
      // A durable startup sink may refuse `run.created` before the strategy can
      // announce its context. Release only a delegated child ledger acquired by
      // THIS invocation; a caller-supplied run-id collision must never release
      // another live parent/child authority or its routing state.
      if (delegatedLedgerAttached) {
        this.deps.delegationBudgetAuthority?.releaseRun(runId);
      }
      throw error;
    }
  }

  private async resolveReviewers(
    cwd: string,
    runAuthPreference?: AuthPreference,
    onIgnoredSetting?: (detail: string) => void,
  ): Promise<ReviewerSpec[]> {
    if (this.deps.reviewers) return this.deps.reviewers;
    if (this.deps.reviewerPanel && this.deps.reviewerPanel.length > 0) {
      return this.resolveExplicitReviewerPanel(cwd, this.deps.reviewerPanel, runAuthPreference);
    }
    return resolveAutoReviewerPanel(
      {
        cwd,
        registry: this.deps.registry,
        harnessSettings: this.config(cwd)?.global.harnesses ?? {},
        authPreferenceFor: (id) => this.authPreferenceForHarness(cwd, id, runAuthPreference),
        onIgnoredSetting,
      },
      { reviewerModels: this.deps.reviewerModels, reviewerEfforts: this.deps.reviewerEfforts },
    );
  }

  /**
   * Resolve reviewers INSIDE a strategy, after run-dir creation: an explicit
   * panel whose harness/model/effort fails validation ends the run through
   * the routing-failure artifact path (failure.yaml + summary + run.failed
   * naming the refusal) BEFORE any candidate spends money — never a bare
   * pre-announce throw with no artifacts (artifact clause).
   */
  private async resolveReviewersWithArtifacts(
    input: RunInput,
    log: EventLog,
    store: ArtifactStore,
    paths: ReturnType<ArtifactStore["runPaths"]>,
    runId: string,
    taskId: string,
    mode: ModeKind,
  ): Promise<{ reviewers: ReviewerSpec[] } | { failed: OrchestratorResult }> {
    try {
      // Auto-panel dropped knobs (reviewerEfforts) → ignored-settings channel (QA-070):
      const warn = (d: string) => void log.emit("review.preflight", { ignored_settings: [d] });
      return { reviewers: await this.resolveReviewers(input.repoRoot, input.authPreference, warn) };
    } catch (err) {
      const message = safeErrorMessage(err);
      store.writeText(
        join(paths.contextDir, "context_error.md"),
        `# Reviewer Panel Error\n\n${message}\n`,
      );
      writeFailure(store, paths, {
        phase: "review_preflight",
        category: "harness_unavailable",
        safeMessage: message,
        runDir: paths.root,
      });
      store.writeText(
        join(paths.finalDir, "summary.md"),
        `# Run ${runId} (${mode})\n\n- Lifecycle: failed\n- Phase: review preflight\n\n${message}\n`,
      );
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      log.emit("run.failed", {
        lifecycle: "failed",
        facts: makeOutcomeFacts("failed", { reason: "harness_failed" }),
        reason: "harness_failed",
        phase: "review_preflight",
        error: message,
        failure_ref: "final/failure.yaml",
      });
      return {
        failed: {
          runId,
          taskId,
          mode,
          lifecycle: "failed",
          facts: makeOutcomeFacts("failed", { reason: "harness_failed" }),
          winner: null,
          runDir: paths.root,
          summary: message,
          candidates: [],
        },
      };
    }
  }

  private async resolveExplicitReviewerPanel(
    cwd: string,
    panel: ControlReviewerPanelEntry[],
    runAuthPreference?: AuthPreference,
  ): Promise<ReviewerSpec[]> {
    return resolveExplicitReviewerPanel(
      {
        cwd,
        registry: this.deps.registry,
        harnessSettings: this.config(cwd)?.global.harnesses ?? {},
        authPreferenceFor: (id) => this.authPreferenceForHarness(cwd, id, runAuthPreference),
      },
      panel,
    );
  }

  private authPreferenceForHarness(
    repoRoot: string,
    harnessId: string,
    runAuthPreference?: AuthPreference,
  ): AuthPreference {
    const cfg = this.config(repoRoot)?.global;
    return effectiveAuthPreference(
      runAuthPreference,
      cfg?.harnesses?.[harnessId]?.auth_preference,
      cfg?.routing?.auth_preference,
    );
  }

  private artifactStore(input: RunInput): ArtifactStore {
    if (input.mode === "ask" && input.contextMode === "off" && input.repoRoot === NO_PROJECT_ROOT) {
      return new ArtifactStore(input.repoRoot, { claudexorDir: userConfigDir() });
    }
    return new ArtifactStore(input.repoRoot);
  }

  /** The producing intent a candidate plays (create flag switches it; not hardcoded to implement). */
  private candidateIntent(input: RunInput): Intent {
    return input.create === true ? "create_from_scratch" : "implement";
  }

  /**
   * Session fields for a route's run spec: auth route preference + native
   * resume id. Preference precedence: explicit per-run > per-harness
   * config > global routing config > auto.
   */
  /** The tree the harness reads/operates in: the thread worktree for an isolated
   * thread, else the project. Config/artifacts/contract stay anchored to repoRoot. */
  /** Per-candidate reservation floor from user config. */
  private estimateUsdFloor(repoRoot: string): number {
    return this.config(repoRoot)?.global.budget.estimate_usd_floor ?? 0.05;
  }

  /** Delegate children overlap their still-running parent, so child-side paid
   * units use the same bounded floor as later slots in a parallel wave. */
  private reservationEstimateUsd(input: RunInput, parallel = false): number | undefined {
    return parallel || Boolean(input.delegatedFromRunId)
      ? this.estimateUsdFloor(input.repoRoot)
      : undefined;
  }

  private execRootOf(input: RunInput): string {
    return input.executionRoot ?? input.repoRoot;
  }

  private async sessionSpecFields(
    input: RunInput,
    harnessId: string,
    model: string | null,
    log?: EventLog,
    defaultRoute: "local_session" | "api_key" | null = null,
    quotaAdmission?: RoutedAdapter["quotaAdmission"],
  ): Promise<Pick<HarnessRunSpec, "auth_preference" | "resume_session_id" | "credential_profile">> {
    const cfg = this.config(input.repoRoot)?.global;
    const profile =
      quotaAdmission?.model === model
        ? quotaAdmission.profile
        : await this.credentials.preflightProfile(input, harnessId, model, log, defaultRoute);
    // Q3=A: the PAID api_key route serves ONLY the EXPLICIT api_key
    // preference (the user's paid election, or the sole permitted service of
    // an empty/exhausted pool) — never silently under auto, which terminalizes
    // typed instead; quotaAdmission.route carries the admission verdict.
    const forcedApiKeyRoute =
      profile === null &&
      (quotaAdmission?.model === model
        ? quotaAdmission.route === "managed_api_key"
        : this.credentials.poolApiKeyRoute(input, harnessId));
    return {
      // "auto" at ANY level falls through (thread turns send the thread default
      // "auto" as a per-run value; it must not shadow a configured preference).
      auth_preference: forcedApiKeyRoute
        ? "api_key"
        : effectiveAuthPreference(
            input.authPreference,
            cfg?.harnesses?.[harnessId]?.auth_preference,
            cfg?.routing?.auth_preference,
          ),
      resume_session_id: resumeSessionForProfile(input.resumeSessions?.[harnessId], profile),
      credential_profile: profile,
    };
  }

  /**
   * The DURABLE per-lane read-only HOME env for a THREAD turn (INV-034), or
   * null for a non-thread one-shot (which keeps the disposable route-context
   * home). Anchored to the PROJECT partition (`input.repoRoot`), not the
   * per-turn execution root, so the home is the SAME across turns of the same
   * lane and the lifecycle owners (which key off `thread.repo.root`) reach it.
   * Keyed by the run's REQUESTED credential profile — the same key the daemon's
   * `resumeMap` lookup uses (INV-135), so record and resume land in one home.
   */
  private laneHomeEnvFor(
    input: RunInput,
    harnessId: string,
    // Keyed by the RESOLVED account (INV-135/137): the same key the recorded
    // native session carries, so record and resume share one home.
    resolvedProfileId: string | null,
  ): Record<string, string> | null {
    if (!input.threadId) return null;
    return new WorkspaceManager(input.repoRoot).laneHomeEnv(
      input.threadId,
      harnessId,
      resolvedProfileId,
    ).env;
  }

  /** Credential-resolution cluster (INV-135), split to orchestrator-credentials.ts. */
  private readonly credentials = new OrchestratorCredentials({
    // Accessor functions: the field initializer runs before the constructor
    // assigns this.deps, so every read defers to call time.
    config: (repoRoot) => this.config(repoRoot),
    registry: () => this.deps.registry,
    quotaSnapshots: () => this.deps.quotaSnapshots?.() ?? [],
    quotaAbsences: () => this.deps.quotaAbsences?.() ?? [],
    credentialUnusable: () => this.deps.credentialUnusable?.() ?? [],
    recordCredentialUnusable: (obs) => this.deps.recordCredentialUnusable?.(obs),
    authPreferenceForHarness: (repoRoot, harnessId, runPreference) =>
      this.authPreferenceForHarness(repoRoot, harnessId, runPreference),
  });

  /**
   * Resolve candidate adapters: explicit `--harness`, else available real harnesses, then
   * **capability-gate** to those that can actually produce work for `intent` (e.g. a
   * a planner-only adapter with `implement: false` is dropped from an implement race), and
   * expand to n. Fails loudly if nothing can perform the intent.
   */
  private resolveRunInput(input: RunInput): RunInput {
    return resolveRunInputDefaults(input, {
      config: this.config(input.repoRoot),
      registryIds: this.deps.registry.keys(),
      routingGoal: this.deps.routingGoal,
    });
  }

  private async resolveCandidateAdapters(
    input: RunInput,
    intent: Intent,
    ledger?: BudgetLedger,
    log?: EventLog,
    routeContext?: ResolvedRouteContext,
    /** QA-034: when provided, the pool-ordering rationale is recorded under this
     * run id so the terminal telemetry writer can persist it. */
    runId?: string,
    /** Deep-scan opts in: multi-scout coverage repeats a surviving harness to
     * reach the requested width (distinct SLICES, not distinct harnesses), so a
     * dropped lane must not clamp the scout count. Best-of leaves this false —
     * its width is distinct-harness diversity, so a dropped lane clamps rather
     * than self-races (QA-043). */
    allowDuplicateFill = false,
  ): Promise<RoutedAdapter[]> {
    let ids = input.harnesses;
    const explicitPool = Boolean(ids && ids.length > 0);
    const harnessSettings = this.config(input.repoRoot)?.global.harnesses ?? {};
    const disabledHarnessIds = new Set(
      Object.entries(harnessSettings)
        .filter(([, settings]) => settings.enabled === false)
        .map(([id]) => id),
    );
    const probeIds =
      ids && ids.length > 0
        ? ids.filter((id) => !disabledHarnessIds.has(id))
        : [...this.deps.registry.keys()].filter((id) => !disabledHarnessIds.has(id));
    const statuses =
      probeIds.length > 0 ? await this.gateway.statusAll({ cwd: input.repoRoot }, probeIds) : [];
    const statusById = new Map(statuses.map((s) => [s.id, s]));
    if (!ids || ids.length === 0) {
      // INV-135 (round-18 BLOCK): an explicit credential profile NAMES its
      // harness — the implicit pool is exactly the profile's enabled
      // harness(es) from the registry, and the profile probe (below) is the
      // auth verdict. Deriving the pool from default doctor-OK status would
      // exclude a valid profile whose default store is logged out while
      // keeping unrelated harnesses that later fail profile resolution.
      const profilePool = input.credentialProfileId
        ? [
            ...new Set(
              (this.config(input.repoRoot)?.global.credential_profiles ?? [])
                .filter((p) => p.enabled && p.profile_id === input.credentialProfileId)
                .map((p) => p.harness_id)
                .filter((hid) => !disabledHarnessIds.has(hid) && this.deps.registry.has(hid)),
            ),
          ]
        : [];
      if (profilePool.length > 0) {
        ids = profilePool;
      } else if (input.credentialProfileId) {
        // Fable-checkpoint NIT: an unknown/disabled profile id must refuse
        // HERE, not fall through to the default auto-pool — that would run on
        // the DEFAULT credentials while the caller explicitly named an
        // account, surfacing later as a per-harness "not registered" error.
        const registered = (this.config(input.repoRoot)?.global.credential_profiles ?? []).filter(
          (p) => p.profile_id === input.credentialProfileId,
        );
        throw new HarnessUnavailableError(
          registered.length === 0
            ? `credential profile "${input.credentialProfileId}" is not registered (see \`claudexor profiles list\`)`
            : registered.every((p) => !p.enabled)
              ? `credential profile "${input.credentialProfileId}" is disabled`
              : `credential profile "${input.credentialProfileId}" belongs to unavailable harness(es): ${registered.map((p) => p.harness_id).join(", ")}`,
        );
      } else {
        // Auto-pools take doctor-OK harnesses (BIBLE §2: doctor decides
        // readiness; a key string or degraded route is visible but not
        // routable) PLUS harnesses with enabled account rows: the default
        // doctor only sees the default store, and a signed-in registry row is
        // invisible to it (cursor after the host-Keychain retirement, or a
        // named-rows-only claude/codex install). Row-bearing lanes still pass
        // the per-lane row probe below before they are admitted.
        const registry = this.config(input.repoRoot)?.global.credential_profiles ?? [];
        ids = statuses
          .filter(
            (s) =>
              s.manifest?.kind !== "fake" &&
              ((s.status === "ok" && s.enabledIntents.includes(intent)) ||
                accountPoolRows(registry, s.id).length > 0),
          )
          .map((s) => s.id);
        if (ids.length === 0) {
          throw new HarnessUnavailableError(
            "no doctor-ok harness for this mode; install/login codex/claude/cursor/opencode (see `claudexor doctor`), or pass --harness explicitly",
          );
        }
      }
    }
    const attachments = input.attachments ?? [];
    // Resolve the complete attachment pool once from manifest truth. If any
    // lane still lacks usable discovery truth, preserve the existing per-lane
    // discovery/doctor precedence and resolve that lane inside the route loop.
    const canResolveAttachmentPool =
      attachments.length > 0 &&
      ids.every((id) => {
        const status = statusById.get(id);
        return status?.manifest != null && status.status !== "unavailable";
      });
    const attachmentPoolAdmission = canResolveAttachmentPool
      ? this.requestRequirements.resolveAttachmentPool(
          explicitPool ? "explicit" : "auto",
          attachments,
          ids.map((id) => ({
            harnessId: id,
            declarations:
              statusById.get(id)?.manifest?.capability_profile.attachment_inputs ?? null,
            available: true,
          })),
        )
      : null;
    if (attachmentPoolAdmission?.outcome === "refused") {
      throw new HarnessUnavailableError(
        attachmentPoolAdmission.message ??
          "no available harness lane can receive the selected attachments",
      );
    }
    const attachmentRejectionById = new Map(
      attachmentPoolAdmission?.rejected.map(
        (admission) => [admission.harnessId, admission] as const,
      ) ?? [],
    );
    const policy = input.web ?? input.externalContextPolicy ?? "auto";
    const pool: RoutedAdapter[] = [];
    const dropped: string[] = [];
    // Every auto-pool drop is recorded with its typed STAGE so the disclosure preserves the
    // real cause instead of collapsing to one reason.
    const droppedLanes: { harnessId: string; stage: RouteDropStage; detail: string }[] = [];
    // The ONE explicit-lane admission gate shared by every drop site (QA-043 /
    // QA-047 meta-move): an EXPLICITLY selected lane that becomes ineligible is
    // a loud typed refusal naming the lane + reason — never a silent
    // substitution or self-race duplication; an AUTO lane is dropped with a
    // typed omission recorded for the degradation receipt.
    const dropLane = (harnessId: string, stage: RouteDropStage, detail: string): void => {
      if (explicitPool) {
        if (stage === "access") throw new AccessProfileIncompatibleError(detail);
        throw new HarnessUnavailableError(detail);
      }
      dropped.push(detail);
      droppedLanes.push({ harnessId, stage, detail });
    };
    // One observation set for the whole admission pass, so two lanes cannot be
    // judged against different vendor epochs.
    const vendorQuota = this.credentials.vendorQuotaObservations();
    const liveUnusable = this.deps.credentialUnusable?.() ?? [];
    for (const id of ids) {
      const adapter = this.deps.registry.get(id);
      if (!adapter) {
        // An EXPLICIT --harness typo (e.g. `fake` instead of `fake-success`)
        // fails loudly and lists the registered ids, instead of being silently
        // dropped into a generic "no harness can perform" message.
        if (explicitPool) {
          const known = [...this.deps.registry.keys()].sort().join(", ");
          throw new HarnessUnavailableError(
            `unknown harness '${id}' (registered: ${known}); run \`claudexor harness list --all\``,
          );
        }
        dropLane(id, "discovery", `${id} (not registered)`);
        continue;
      }
      // Per-harness settings: a user-disabled harness never routes. Explicit
      // selection of a disabled harness fails loudly before any doctor/model
      // probe instead of silently running or spending readiness checks.
      const cfgEntry = harnessSettings[id];
      if (cfgEntry && cfgEntry.enabled === false) {
        const why = `${id} is disabled in settings (harnesses.${id}.enabled=false)`;
        dropLane(id, "settings", why);
        continue;
      }
      // Incomplete unified-accounts migration refuses THIS harness only.
      const migrationBlock = this.deps.accountsMigrationGate?.(id) ?? null;
      if (migrationBlock) {
        dropLane(id, "credential", migrationBlock.reason);
        continue;
      }
      // INV-135: native login excluded + no rows + no pin ⇒ only the
      // EXPLICITLY-requested paid route can serve (Q3=A — `auto` never
      // silently takes the API key); everything else refuses/drops here,
      // never a silent spawn INTO the disabled login.
      if (
        this.credentials.effectiveProfileId(input, id) === null &&
        this.credentials.nativeCredentialsDisabled(input.repoRoot, id) &&
        accountPoolRows(this.config(input.repoRoot)?.global.credential_profiles ?? [], id)
          .length === 0 &&
        this.authPreferenceForHarness(input.repoRoot, id, input.authPreference) !== "api_key"
      ) {
        const why = `${id} has no routable credential: the CLI login is disabled (harnesses.${id}.native_credentials_enabled=false), no account is signed in, and the paid API-key route requires the explicit api_key preference (pin an account with --profile or connect one)`;
        dropLane(id, "credential", why);
        continue;
      }
      // W3.3 (TZ-1 §B): a route is admitted on readiness truth from the SAME
      // resolved env/cwd its run will spawn with (see routeContext.ts).
      let status = await candidateStatusInRouteContext(
        this.gateway,
        routeContext,
        id,
        this.authPreferenceForHarness(input.repoRoot, id, input.authPreference),
        statusById,
      );
      const manifest = status?.manifest ?? null;
      if (!status || !manifest) {
        // QA-047: an explicit member with no doctor manifest (absent binary /
        // unconfigured provider) is unavailable — it must fail LOUDLY for an
        // explicit pool (naming the real doctor reasons), not vanish before the
        // later explicit-status guard because a healthier lane survived.
        const reasons = status?.reasons?.length ? `: ${status.reasons.join("; ")}` : "";
        dropLane(id, "doctor", `${id} is unavailable${reasons || " (no manifest / not ready)"}`);
        continue;
      }
      // Doctor status is the readiness truth. A DEGRADED harness (e.g. key present but
      // unproven by isolated smoke) is admitted only by explicit user
      // selection — degraded means usable-with-caveats, and the caveats are
      // visible in doctor output and run events.
      // INV-135 (round-13, extended by the round-18 BLOCK): an EXPLICIT
      // profile is authenticated by ITS store — the profile probe overrides
      // the default auth verdict for ANY non-ok default status, and a
      // profile-admitted route joins even an AUTO pool (the run spawns with
      // the profile's transport, so the default store's state is not the
      // routing truth). Capability/manifest gating above still applies.
      let profileAdmitted = false;
      const profileAdapter = this.deps.registry.get(id);
      const profileProbe = profileAdapter?.probeCredentialProfile?.bind(profileAdapter);
      const explicitPin = this.credentials.effectiveProfileId(input, id);
      const model = input.models?.[id] ?? cfgEntry?.default_model ?? null;
      // Pins and bound/pool rows are checked against their own readiness.
      const rowCandidateIds: string[] = [];
      if (explicitPin) {
        rowCandidateIds.push(explicitPin);
      } else if (status.status !== "ok") {
        const pool = accountPoolRows(
          this.config(input.repoRoot)?.global.credential_profiles ?? [],
          id,
        );
        const bound = input.threadAccountBindings?.[id] ?? null;
        rowCandidateIds.push(
          ...(bound && pool.some((row) => row.profile_id === bound) ? [bound] : []),
          ...pool.map((row) => row.profile_id).filter((rowId) => rowId !== bound),
        );
      }
      let lastRowVerdict: string | null = null;
      for (const candidateId of rowCandidateIds) {
        const verdict = await selectedProfileAvailability({
          registry: this.config(input.repoRoot)?.global.credential_profiles ?? [],
          profileId: candidateId,
          harnessId: id,
          probe: profileProbe,
          // `verification: passed` from the local store only means a login file
          // is present. The poller's authenticated vendor call is the only
          // liveness evidence; admission must act on it or dispatch may use a revoked token.
          quota: vendorQuota,
          unusable: liveUnusable,
          model,
          // Only an explicit/bound route may consume bounded stale LKG evidence.
          allowStale: explicitPin !== null || input.threadAccountBindings?.[id] === candidateId,
        });
        if (verdict === "available") {
          profileAdmitted = true;
          break;
        }
        lastRowVerdict = verdict;
      }
      if (profileAdmitted) {
        // A valid account row restores manifest intent truth when the default store failed.
        if (status.status !== "ok") {
          status = {
            ...status,
            status: "degraded",
            enabledIntents: capabilityIntents(manifest.capabilities),
          };
          statusById.set(id, status);
        }
      } else if (explicitPin) {
        // An explicit pin that is not ready refuses/drops the lane; a
        // not-ready UNPINNED row merely leaves the default doctor verdict in
        // charge (the gates below keep the refusal honest when neither a row
        // nor a default login exists).
        const why = `${id} credential profile is not ready: ${lastRowVerdict}`;
        dropLane(id, "credential", why);
        continue;
      }
      if (status.status === "unavailable" && !profileAdmitted) {
        const why = `${id} is unavailable${status.reasons.length ? `: ${status.reasons.join("; ")}` : ""}`;
        dropLane(id, "doctor", why);
        continue;
      }
      if (status.status !== "ok" && !explicitPool && !profileAdmitted) {
        dropLane(
          id,
          "doctor",
          `${id} is ${status.status}${status.reasons.length ? `: ${status.reasons.join("; ")}` : ""}`,
        );
        continue;
      }
      const readOnlyIntent =
        intent === "plan" || intent === "spec" || intent === "explain" || intent === "audit";
      const requiredAccess = this.requestRequirements.adapterAccess(
        intent,
        manifest.capabilities.implementation_transport,
        readOnlyIntent
          ? "readonly"
          : (input.access ?? this.config(input.repoRoot).trust.access_default),
      );
      const accessSupported =
        !requiredAccess || manifest.access_profiles_supported.includes(requiredAccess);
      const webSupport = manifest.capabilities.web_policy;
      // Match routeSpecKnobs: a per-harness web default upgrades run-level auto,
      // so judge the effective per-route policy.
      const routePolicy =
        policy === "auto" && cfgEntry?.web && cfgEntry.web !== "auto" ? cfgEntry.web : policy;
      // Only explicit off is an enforceable capability requirement. Every
      // non-off policy is an optional web preference: a route may use web, lack
      // it, or have a native approval deny it without becoming ineligible.
      const webIncompatible = routePolicy === "off" && webSupport === "uncontrolled";
      if (webIncompatible) {
        const why = `${id} cannot guarantee web is disabled (manifest web_policy=uncontrolled); rerun with --web auto, --web cached, or --web live, or select a harness that can enforce --web off`;
        dropLane(id, "web", why);
        continue;
      }
      const attachmentAdmission =
        attachmentRejectionById.get(id) ??
        this.requestRequirements.resolveAttachmentLane(
          id,
          attachments,
          manifest.capability_profile.attachment_inputs,
        );
      if (!attachmentAdmission.admitted) {
        dropLane(id, "attachment", attachmentAdmission.message ?? `${id} rejects attachments`);
        continue;
      }
      const reason = status.reasons.length > 0 ? `: ${status.reasons.join("; ")}` : "";
      if (status.enabledIntents.includes(intent) && accessSupported) {
        pool.push({
          adapter,
          adapterAccess: requiredAccess,
          webSupport,
          providerFamily: manifest.provider_family,
          supportsMaxTurns: manifest.capabilities.max_turns,
          supportsToolLists: manifest.capabilities.tool_lists,
          browserRequirement: this.requestRequirements.resolveBrowser({
            harnessId: id,
            requested: input.browser === true,
            manifestCapable: manifest.capabilities.browser_tool,
            requiresFullAccess: manifest.capability_profile.mcp_injection_requires_full_access,
            webPolicy: routePolicy,
            access: requiredAccess,
          }),
          denyRequirement: this.requestRequirements.resolveDenyPaths(
            id,
            (input.denyPaths?.length ?? 0) > 0,
          ),
          delegationRequirement: this.requestRequirements.resolveDelegation({
            harnessId: id,
            requested: input.delegate === true,
            runtimeAvailable: input.delegationBelt != null,
            manifestCapable: manifest.capability_profile.mcp_injection,
            requiresFullAccess: manifest.capability_profile.mcp_injection_requires_full_access,
            fullAccess: isFullAccess(requiredAccess),
          }),
          effortLevels: manifest.capabilities.effort_levels,
          knownModels: manifest.capabilities.known_models,
          // A selected profile's credential_kind IS the route (round-18 #2);
          // the default store's sources apply only to profile-less runs.
          authRouteEstimate:
            this.credentials.profileAuthRoute(input, id) ??
            estimateEffectiveAuthRoute(
              this.authPreferenceForHarness(input.repoRoot, id, input.authPreference),
              status.authSources,
            ),
          quotaAdmission: { model: null, profile: null, route: null },
          supportsSynthesize: manifest.capabilities.synthesize,
          supportsInteractive: manifest.capabilities.interactive,
          supportsJsonSchemaOutput: manifest.capabilities.json_schema_output,
          workReportTransport: manifest.capabilities.work_report_transport,
          structuredOutputChannel: manifest.capabilities.structured_output_channel,
          supportsMcpInjection: manifest.capability_profile.mcp_injection,
          mcpInjectionRequiresFullAccess:
            manifest.capability_profile.mcp_injection_requires_full_access,
          implementationTransport: manifest.capabilities.implementation_transport,
          settings: cfgEntry
            ? {
                defaultModel: cfgEntry.default_model,
                effort: cfgEntry.effort,
                web: cfgEntry.web === "auto" ? null : cfgEntry.web,
                maxTurns: cfgEntry.max_turns,
                maxRounds: cfgEntry.max_rounds,
                toolsAllow: cfgEntry.tools_allow,
                toolsDeny: cfgEntry.tools_deny,
                fallbackModel: cfgEntry.fallback_model,
              }
            : null,
        });
      } else {
        // QA-043: an intent- or access-incompatible lane. For an EXPLICIT pool
        // this is a loud refusal (dropLane throws) naming the lane and the
        // exact capability gap — never a silent omission that a surviving lane
        // then masks by modulo self-duplication. The typed stage distinguishes
        // an access refusal from a capability one so the disclosure is honest.
        dropLane(
          id,
          accessSupported ? "capability" : "access",
          `${id} (${accessSupported ? `cannot ${intent}${reason}` : `cannot enforce ${requiredAccess}`})`,
        );
      }
    }
    if (pool.length === 0) {
      if (droppedLanes.length > 0 && droppedLanes.every((lane) => lane.stage === "access")) {
        throw new AccessProfileIncompatibleError(
          `no harness can enforce the requested access profile (${droppedLanes.map((lane) => lane.detail).join(", ")})`,
        );
      }
      throw new HarnessUnavailableError(
        `no harness can perform '${intent}' for this mode${dropped.length ? ` (skipped: ${dropped.join(", ")})` : ""}`,
      );
    }
    // Quota admission must use the account that will actually spawn. In
    // particular, an opt-in default-subject rotation has to select its ready
    // profile before the budget router filters the exhausted default away.
    // The same resolved profile is reused by the first spec build below.
    const quotaPrepared = await Promise.all(
      pool.map(async (routed) => {
        const model = input.models?.[routed.adapter.id] ?? routed.settings?.defaultModel ?? null;
        let profile: CredentialProfile | null;
        try {
          profile = await this.credentials.preflightProfile(
            input,
            routed.adapter.id,
            model,
            log,
            routed.authRouteEstimate,
          );
        } catch (err) {
          // Q3=A: ONE harness's exhausted account pool must not kill an AUTO
          // multi-harness run — the lane drops with the typed disclosure and a
          // surviving sibling serves. An EXPLICIT pool (and the last remaining
          // auto lane) keeps the typed `credential_pool_exhausted` terminal so
          // its code + earliest reset reach failure.yaml intact.
          if (
            !explicitPool &&
            pool.length > 1 &&
            (err as { code?: string }).code === "credential_pool_exhausted"
          ) {
            dropLane(routed.adapter.id, "credential", safeErrorMessage(err));
            return null;
          }
          throw err;
        }
        const route = profile
          ? profile.credential_kind === "api_key"
            ? ("managed_api_key" as const)
            : ("vendor_native" as const)
          : // The explicitly-opted PAID route (Q3=A) classifies as managed_api_key.
            this.credentials.poolApiKeyRoute(input, routed.adapter.id)
            ? ("managed_api_key" as const)
            : routed.authRouteEstimate === "api_key"
              ? ("managed_api_key" as const)
              : routed.authRouteEstimate === "local_session"
                ? ("vendor_native" as const)
                : null;
        return { ...routed, quotaAdmission: { model, profile, route } };
      }),
    );
    const quotaPreparedPool = quotaPrepared.filter(
      (routed): routed is NonNullable<typeof routed> => routed !== null,
    );
    const ordered = this.orderPool(quotaPreparedPool, input, intent, statusById, ledger, runId);
    if (ordered.length === 0) {
      throw new HarnessUnavailableError(
        `no harness remains eligible for '${intent}' after budget and quota routing`,
      );
    }
    emitPrimaryDivergence(log, input.primaryHarness, ordered, quotaPreparedPool, dropped);
    const n = input.n ?? ordered.length;
    const selectionOrder = ordered;
    const out: RoutedAdapter[] = [];
    if (droppedLanes.length > 0 && !allowDuplicateFill) {
      // QA-043: lanes were dropped from an AUTO best-of pool (an explicit pool
      // would have thrown at the drop). NEVER refill a dropped lane's slot by
      // duplicating a surviving harness — that manufactures a self-race that
      // masks the omission. Clamp to distinct survivors and disclose below.
      // (Deep-scan sets allowDuplicateFill: its width is scout coverage, not
      // harness diversity, so a dropped lane must not cut the scout count.)
      for (let i = 0; i < Math.min(n, selectionOrder.length); i++)
        out.push(selectionOrder[i] as RoutedAdapter);
    } else {
      // No lane was dropped: a pool smaller than `n` is an intentional
      // best-of-N on the available harness(es) (e.g. explicit `--harness codex
      // -n 3`), so the historical width fill is preserved.
      for (let i = 0; i < n; i++)
        out.push(selectionOrder[i % selectionOrder.length] as RoutedAdapter);
    }
    // Disclose an auto-pool omission / width clamp once, with the
    // requested-vs-effective route receipt (never silent — QA-043).
    emitPoolDegraded(log, {
      requestedHarnesses: ids,
      effectiveHarnesses: [...new Set(out.map((lane) => lane.adapter.id))],
      requestedN: n,
      effectiveN: out.length,
      droppedLanes,
    });
    this.requestRequirements.requireEffectiveBrowser(
      input.browser === true,
      out.map((lane) => lane.browserRequirement),
    );
    // Owner decision (2026-07-26): known PRE-START belt unavailability does
    // not discard the requested Agent work. Continue without Delegate and emit
    // a durable typed warning. Once a descriptor is injected, typed startup
    // failure stays terminal in attemptTelemetry (no mid-attempt downgrade).
    if (input.delegate === true) {
      const unavailable = out
        .map((lane) => lane.delegationRequirement)
        .filter((resolution) => !resolution.effective);
      if (unavailable.length > 0) {
        log?.emit("delegation.belt.degraded", {
          requested: true,
          effective: out.some((lane) => lane.delegationRequirement.effective),
          reason: unavailable[0]?.reason ?? "runtime_unavailable",
          lanes: unavailable.map((resolution) => ({
            harness_id: resolution.harness_id,
            reason: resolution.reason,
          })),
        });
      }
    }
    // outputSchema is MANDATORY (Quiz-6a): a selected lane that cannot
    // natively constrain its final message would deliver best-effort text —
    // that is a typed preflight refusal, never silent degradation. The
    // interactive stream-json transport x --json-schema is an unverified
    // vendor combination, so lanes that would ride it refuse too.
    if (input.outputSchema !== undefined && input.outputSchema !== null) {
      const incapable = out.filter((lane) => !lane.supportsJsonSchemaOutput);
      if (incapable.length > 0) {
        throw new HarnessUnavailableError(
          `outputSchema is mandatory but selected lane(s) cannot constrain output natively: ${[...new Set(incapable.map((lane) => lane.adapter.id))].join(", ")} (manifest capabilities.json_schema_output=false); choose schema-capable harnesses or drop the schema`,
        );
      }
      // NOTE (DT2.1-16): the daemon ALWAYS arms an interaction channel, so an
      // interactive-capable lane (claude) is refused for outputSchema on every
      // daemon/CLI run today — the --json-schema x stream-json interactive combo
      // is not yet live-verified. Structured-output runs therefore route through
      // a non-interactive lane (codex). The message names that reality instead
      // of pointing at a channel a daemon caller cannot turn off.
      const interactive = Boolean(input.onInteraction)
        ? out.filter((lane) => lane.supportsInteractive)
        : [];
      if (interactive.length > 0) {
        throw new HarnessUnavailableError(
          `outputSchema is not yet available on interactive-transport lane(s): ${[...new Set(interactive.map((lane) => lane.adapter.id))].join(", ")} (the --json-schema x stream-json combination is unverified). Route structured-output runs through a non-interactive schema-capable harness (e.g. codex), or drop the schema`,
        );
      }
    }
    // Strict pre-run model gate (INV-104) — see modelGovernance.ts.
    await assertRouteModelsAllowed(out, input.models, this.execRootOf(input), (id) =>
      routeContext ? (routeContext.envForHarness?.(id) ?? routeContext.env) : undefined,
    );
    return out;
  }

  /**
   * Order the eligible pool by the selected routing goal (budget router): an
   * explicit user pool keeps the user's order; an explicit primary harness is
   * always pinned first. Cross-family diversity is encouraged for later slots.
   */
  private orderPool(
    pool: RoutedAdapter[],
    input: RunInput,
    intent: Intent,
    statusById: Map<
      string,
      { manifest?: { auth_modes?: string[] } | null; authSources?: AuthSourceReadiness[] }
    >,
    ledger?: BudgetLedger,
    runId?: string,
  ): RoutedAdapter[] {
    let ordered = pool;
    let rationale: RouteRankingRationale | null = null;
    let selectionReason: RouteRankingRationale["reason"] | null = null;
    if (pool.length > 0) {
      const routeLedger = ledger ?? new BudgetLedger();
      const config = this.config(input.repoRoot).global;
      const goal = input.routingGoal ?? this.deps.routingGoal ?? config.routing.goal;
      const byId = new Map(pool.map((r) => [r.adapter.id, r]));
      // Settled cost is evidence for economy routing, never a provider quality prior.
      const metrics = loadHarnessMetrics(globalConfigDir());
      const remaining: RouterCandidate[] = pool.map((r) => {
        const status = statusById.get(r.adapter.id);
        const authModes = status?.manifest?.auth_modes ?? [];
        const metric = metrics[r.adapter.id];
        // Auth mode for routing: prefer the ROUTE EVIDENCE from the
        // last settled attempt (adapter-disclosed, persisted in metrics) over
        // the manifest capability guess — auth_modes lists what a harness CAN
        // use, not what it actually runs under.
        const guessedAuthMode = authModes.includes("local_session")
          ? ("local_session" as const)
          : authModes.includes("api_key")
            ? ("api_key" as const)
            : ("unknown" as const);
        // The FROZEN quota-admission route decides outright (round-18 #2):
        // the admitted profile's credential_kind when a profile exists, else
        // the config-aware estimate — an api_key lane must never inherit a
        // subscription classification from the default store's metric. With
        // no route fact, the RESOLVED preference (per-run > per-harness
        // config > global config) speaks, never the raw run input (#121);
        // only then the last settled metric / manifest guess.
        const authMode =
          authModeForCredentialRoute(r.quotaAdmission.route) ??
          authModeForPreference(
            this.authPreferenceForHarness(input.repoRoot, r.adapter.id, input.authPreference),
          ) ??
          metric?.last_auth_mode ??
          guessedAuthMode;
        // The exact quota subject selected before ranking: profile id or the
        // engine default. Profile A's cooldown never excludes profile B or the
        // default on the same harness and route.
        const credentialSubjectId = r.quotaAdmission.profile?.profile_id ?? null;
        // QA-034: the typed auth-route evidence (doctor source verification x the
        // resolved route) is AUTHORITATIVE for billing knowledge in the router —
        // a VERIFIED native route proves subscription_entitlement, so it survives
        // paid_fallback:never and ranks with a real economy tuple instead of
        // reading as unknown/paid. Absent (unknown route) falls back to the
        // metric-derived billingKnowledge below.
        const authRoute = this.authRouteEvidenceFor(authMode, status?.authSources ?? []);
        return {
          harnessId: r.adapter.id,
          available: true,
          model: r.quotaAdmission.model,
          effort:
            input.efforts?.[r.adapter.id] ??
            input.effort ??
            config.harnesses[r.adapter.id]?.effort ??
            undefined,
          billingKnowledge: authMode === "api_key" ? "metered" : "unknown",
          incrementalCostUsd: authMode === "api_key" ? (metric?.avg_cost_usd ?? null) : null,
          credentialRoute:
            r.quotaAdmission.route ??
            (authMode === "api_key"
              ? "managed_api_key"
              : authMode === "local_session"
                ? "vendor_native"
                : undefined),
          ...(authRoute ? { authRoute } : {}),
          credentialSubjectId,
        };
      });
      const routeCtx = {
        goal,
        paidFallback: config.routing.paid_fallback,
        intent,
        qualityTiers: config.routing.quality_tiers,
        ledger: routeLedger,
        now: Date.now(), // ONE instant for the sort AND the rationale below
      };
      const ranked = rankHarnesses(remaining, routeCtx)
        .map((candidate) => byId.get(candidate.harnessId))
        .filter((candidate): candidate is RoutedAdapter => Boolean(candidate));
      rationale = explainRanking(remaining, routeCtx);
      ordered = ranked;
    }
    if (input.delegate === true && input.primaryHarnessExplicit !== true) {
      const delegateFirst = [
        ...ordered.filter((lane) => lane.delegationRequirement.effective),
        ...ordered.filter((lane) => !lane.delegationRequirement.effective),
      ];
      if (delegateFirst.some((lane, index) => lane !== ordered[index])) {
        ordered = delegateFirst;
        selectionReason = "delegate_effective_first";
      }
    }
    if (input.primaryHarness) {
      const primary = ordered.find((r) => r.adapter.id === input.primaryHarness);
      if (primary && primary !== ordered[0]) {
        ordered = [primary, ...ordered.filter((r) => r !== primary)];
        selectionReason = "explicit_primary";
      }
    }
    // QA-034: persist the FINAL selected order, including request constraints
    // that intentionally override the underlying cost/quota ranking. This is
    // what keeps route evidence aligned with the lane actually executed.
    if (runId && rationale) {
      this.routingRationaleByRun.set(runId, {
        ...rationale,
        order: ordered.map((lane) => lane.adapter.id),
        reason: selectionReason ?? rationale.reason,
      });
    }
    return ordered;
  }

  /** Harness-only convergence helpers still need the exact quota identity
   * selected before ranking. This facade keeps their small interface while
   * preventing a scoped limit on one model/account from cooling another. */
  private quotaLedgerView(
    ledger: BudgetLedger,
    routes: readonly RoutedAdapter[],
  ): {
    bindingPaceSlack(id: string): number | null;
    cooldownActive(id: string): boolean;
  } {
    const byId = new Map(routes.map((route) => [route.adapter.id, route]));
    const identity = (id: string) => {
      const route = byId.get(id);
      return route
        ? {
            credentialRoute: route.quotaAdmission.route ?? undefined,
            credentialSubjectId: route.quotaAdmission.profile?.profile_id ?? null,
            model: route.quotaAdmission.model,
          }
        : null;
    };
    return {
      bindingPaceSlack: (id) => {
        const selected = identity(id);
        return selected
          ? ledger.bindingPaceSlack(
              id,
              selected.credentialRoute,
              selected.credentialSubjectId,
              Date.now(),
              selected.model,
            )
          : ledger.bindingPaceSlack(id);
      },
      cooldownActive: (id) => {
        const selected = identity(id);
        return selected
          ? ledger.cooldownActive(
              id,
              selected.credentialRoute,
              selected.credentialSubjectId,
              Date.now(),
              selected.model,
            )
          : ledger.cooldownActive(id);
      },
    };
  }

  /**
   * Typed auth-route evidence for one candidate (QA-034): the concrete
   * credential route the resolved auth mode maps to, plus the doctor's
   * verification for the source that route runs under. `local_session` →
   * vendor_native + the native/OAuth source verification; `api_key` →
   * managed_api_key + the key source verification. Unknown route → no evidence
   * (the router keeps its conservative metric-derived billing). Verification is
   * the source's typed verdict — never inferred from mere availability.
   */
  private authRouteEvidenceFor(
    authMode: "local_session" | "api_key" | "unknown",
    sources: AuthSourceReadiness[],
  ): RouteAuthEvidence | undefined {
    const usable = (s: AuthSourceReadiness): boolean =>
      s.availability === "available" && s.verification !== "failed";
    if (authMode === "local_session") {
      const native = sources.find(
        (s) => usable(s) && (s.source === "native_session" || s.source === "oauth_token_env"),
      );
      return { route: "vendor_native", verification: native?.verification ?? "not_run" };
    }
    if (authMode === "api_key") {
      const key = sources.find(
        (s) =>
          usable(s) &&
          (s.source === "api_key_env" ||
            s.source === "api_key_flag" ||
            s.source === "provider_auth_file"),
      );
      return { route: "managed_api_key", verification: key?.verification ?? "not_run" };
    }
    return undefined;
  }

  /**
   * Lazy ContextPack: built ONLY for the read-only report modes
   * (explore/plan/readonly_audit) that consume it. Persisted to
   * context/context_pack.yaml, announced via `context.pack.created`, and
   * rendered as a compact scope-atlas prompt section. Agent modes skip it —
   * candidates explore the live tree inside their own envelopes.
   */
  private async lazyContextSection(
    input: RunInput,
    contract: ActiveTaskContract,
    store: ArtifactStore,
    paths: ReturnType<ArtifactStore["runPaths"]>,
    log: EventLog,
  ): Promise<string> {
    if (input.repoRoot === NO_PROJECT_ROOT || input.contextMode === "off") return "";
    // the versioned project config drives the context pack — mandatory files
    // (fail-closed when listed), plus include/exclude globs for the Scope Atlas.
    const projectCtx = this.projectConfig(input.repoRoot).context;
    const pack = await buildContextPack(input.repoRoot, contract, {
      mandatory: projectCtx.mandatory_files.length > 0 ? projectCtx.mandatory_files : undefined,
      include: projectCtx.include,
      exclude: projectCtx.exclude,
    });
    store.writeYaml(join(paths.contextDir, "context_pack.yaml"), pack);
    log.emit("context.pack.created", {
      hash: pack.hash,
      files: pack.atlas.length,
      estimated_tokens: pack.token_budget?.estimated_used ?? null,
    });
    const readable = pack.atlas.filter(
      (e) => e.disposition === "full" || e.disposition === "included",
    );
    const omitted = pack.atlas.length - readable.length;
    const lines = readable
      .slice(0, 200)
      .map((e) => `- ${e.path}${e.bytes !== undefined ? ` (${e.bytes}B)` : ""}`);
    if (readable.length > 200)
      lines.push(
        `- … ${readable.length - 200} more readable paths (see context/context_pack.yaml)`,
      );
    return [
      "",
      "## Repository scope atlas (compact)",
      `Tracked paths: ${pack.atlas.length} (${omitted} omitted/excluded are listed in context/context_pack.yaml). Read files directly for content; this atlas is the navigation map.`,
      ...lines,
      "",
    ].join("\n");
  }

  /**
   * The web mode a routed harness actually executes for a requested policy.
   * Tools-permissioned web (e.g. claude) has no cached index: `cached` upgrades
   * to `live` and MUST be disclosed via a `policy.web.upgraded` event.
   */
  private effectiveWebMode(
    policy: ExternalContextPolicy,
    webSupport: WebPolicySupport,
  ): ExternalContextPolicy {
    if (policy === "cached" && webSupport === "tools") return "live";
    return policy;
  }

  private discloseWebUpgrade(
    log: EventLog,
    routed: RoutedAdapter,
    policy: ExternalContextPolicy,
    attemptId: string,
  ): ExternalContextPolicy {
    const effective = this.effectiveWebMode(policy, routed.webSupport);
    if (effective !== policy) {
      log.emit("policy.web.upgraded", {
        harness_id: routed.adapter.id,
        attempt_id: attemptId,
        from: policy,
        to: effective,
        reason: `web_policy=${routed.webSupport} has no cached web index`,
      });
    }
    return effective;
  }

  /** Honest cross-family route proof: verified only when ≥2 DISTINCT provider families review. */
  private routeVerified(reviewers: ReviewerSpec[]): boolean {
    return new Set(reviewers.map((r) => r.providerFamily)).size >= 2;
  }

  private config(repoRoot: string): ReturnType<typeof loadConfig> {
    return loadConfig(repoRoot);
  }

  private projectConfig(repoRoot: string): ProjectConfig {
    return this.config(repoRoot).project;
  }

  private buildContract(input: RunInput, taskId: string, mode: ModeKind): ActiveTaskContract {
    return buildTaskContract(input, taskId, mode, {
      paidBudget: this.deps.paidBudget,
      routingGoal: this.deps.routingGoal,
    });
  }

  /**
   * Per-harness settings applied to one route's run spec (model/effort/web
   * defaults, max_turns, tool lists). Knobs the manifest does not support are
   * RETURNED as ignored reasons (disclosed by the caller), never silently sent.
   */
  /**
   * The HarnessRunSpec fields every TASK-PRODUCING lane shares (primary,
   * candidate, planner, explorer, orchestrate-planner). Extracting the identical
   * block into ONE owner means a new task-producing field lands here once —
   * never forgotten in one of the HarnessRunSpec.parse sites (the multi-path
   * trap). Per-run `instructions` ride every task-producing lane but are withheld
   * from `synthesize` (a merge of existing candidates, not a fresh task
   * execution — owner Quiz-5a); reviewers and the auth smoke build their own
   * specs and never call this.
   */
  /** The extra MCP servers injected into one agent lane's sandbox. Today only
   * the delegation belt (D32): present when `--delegate` is on, the daemon built
   * a belt descriptor, the lane's adapter can inject MCP servers, and the lane is
   * a WRITING agent intent (the delegator integrates results in its workspace;
   * read lanes and reviewers have nothing to delegate). */
  private delegationBeltFor(
    input: RunInput | undefined,
    intent: Intent,
    routed: RoutedAdapter,
    resolvedBudget: PaidBudget,
  ): ExtraMcpServer[] {
    if (
      !input?.delegate ||
      !input.delegationBelt ||
      !input.delegationParentRunId ||
      !routed.delegationRequirement.effective
    )
      return [];
    // A lane that sandbox-cancels the belt below full access (codex) must NOT
    // receive a belt it cannot use. Per-lane requirement resolution records the
    // typed degradation, while a mixed pool keeps the belt on lanes that can
    // host it.
    if (routed.mcpInjectionRequiresFullAccess && !isFullAccess(routed.adapterAccess)) return [];
    const writingIntents: Intent[] = ["implement", "create_from_scratch", "repair"];
    if (!writingIntents.includes(intent)) return [];
    // The CLI built the descriptor from the RAW request budget (undefined when
    // the caller relied on a config/dep default), which would leave the belt
    // unlimited while the real run is capped. Rebind the belt's parent-budget
    // env to the RESOLVED budget (resolvePaidBudget output) so sub-run draws are
    // bounded by the same headroom the parent run enforces — one budget owner.
    return [
      {
        ...input.delegationBelt,
        env: {
          ...input.delegationBelt.env,
          [DELEGATION_ENV.parentRunId]: input.delegationParentRunId,
          [DELEGATION_ENV.repoRoot]: input.repoRoot,
          [DELEGATION_ENV.budget]: JSON.stringify(resolvedBudget),
        },
      },
    ];
  }

  private harnessSpecKnobs(
    contract: ActiveTaskContract,
    knobs: {
      webPolicy: ExternalContextPolicy;
      toolsAllow: string[];
      toolsDeny: string[];
      model: string | null;
      effort: EffortHint | null;
      maxTurns: number | null;
    },
    intent: Intent,
  ): Pick<
    HarnessRunSpec,
    | "external_context_policy"
    | "tool_permission_policy"
    | "model_hint"
    | "effort_hint"
    | "max_turns"
    | "instructions"
    | "output_schema"
  > {
    return {
      external_context_policy: knobs.webPolicy,
      tool_permission_policy: {
        web: knobs.webPolicy,
        allow: [...new Set([...contract.tool_permission_policy.allow, ...knobs.toolsAllow])],
        deny: [...new Set([...contract.tool_permission_policy.deny, ...knobs.toolsDeny])],
      },
      model_hint: knobs.model,
      effort_hint: knobs.effort,
      max_turns: knobs.maxTurns,
      ...(intent === "synthesize" ? {} : { instructions: contract.instructions }),
      // The user's answer contract rides every answer-producing lane INCLUDING
      // synthesis (its answer can become the final one). The adapter gets the
      // vendor-STRICT transport form; the engine validator keeps the ORIGINAL
      // contract as the conformance authority.
      ...(contract.output_schema
        ? { output_schema: strictifyOutputSchema(contract.output_schema) }
        : {}),
    };
  }

  /**
   * D-16: the WorkReport transport envelope for one route. Called at every
   * task-producing spec-build site AFTER harnessSpecKnobs so it OVERRIDES the
   * plain caller-schema transport with the resolved WorkReport channel on
   * capable routes. The returned `mode` is retained by the caller and handed
   * to `unwrapWorkReportEnvelope` when the answer is finalized.
   */
  private workReportEnvelopeFor(
    routed: RoutedAdapter,
    contract: ActiveTaskContract,
    interactive: boolean,
  ): ResolvedWorkReportEnvelope {
    return resolveWorkReportEnvelope({
      transport: routed.workReportTransport,
      channel: routed.structuredOutputChannel,
      supportsJsonSchemaOutput: routed.supportsJsonSchemaOutput,
      interactive,
      callerSchema: contract.output_schema ?? null,
    });
  }

  /**
   * D-16: apply the resolved WorkReport transport to a built spec — set the
   * envelope output_schema (constrained/side_tool routes) and APPEND the fenced
   * metadata instruction (validated routes, e.g. cursor). Mutates the spec in
   * place and returns the mode the answer unwrap consumes. Called at every
   * task-producing spec-build site so the transport is never wired one-off.
   */
  private applyWorkEnvelope(
    spec: HarnessRunSpec,
    workEnvelope: ResolvedWorkReportEnvelope,
  ): WorkReportEnvelopeMode {
    if (workEnvelope.outputSchema !== undefined) spec.output_schema = workEnvelope.outputSchema;
    const instruction = workEnvelope.mode.instruction;
    if (instruction) {
      spec.instructions =
        spec.instructions && spec.instructions.trim()
          ? `${spec.instructions}\n\n${instruction}`
          : instruction;
    }
    return workEnvelope.mode;
  }

  private routeSpecKnobs(
    routed: RoutedAdapter,
    contract: ActiveTaskContract,
    overrideModel?: string,
    effortHint?: EffortHint,
  ): {
    model: string | null;
    effort: EffortHint | null;
    webPolicy: ExternalContextPolicy;
    maxTurns: number | null;
    toolsAllow: string[];
    toolsDeny: string[];
    ignored: string[];
  } {
    const s = routed.settings;
    const contractPolicy = contract.external_context.policy;
    const ignored: string[] = [];
    let maxTurns: number | null = null;
    let toolsAllow: string[] = [];
    let toolsDeny: string[] = [];
    // Run-level cap beats per-harness settings (specific beats general).
    const requestedMaxTurns = contract.max_turns ?? s?.maxTurns ?? null;
    if (requestedMaxTurns) {
      if (routed.supportsMaxTurns) maxTurns = requestedMaxTurns;
      else
        ignored.push(
          `max_turns=${requestedMaxTurns} (manifest capabilities.max_turns=false for ${routed.adapter.id})`,
        );
    }
    if ((s?.toolsAllow.length ?? 0) > 0 || (s?.toolsDeny.length ?? 0) > 0) {
      if (routed.supportsToolLists) {
        toolsAllow = s?.toolsAllow ?? [];
        toolsDeny = s?.toolsDeny ?? [];
      } else {
        ignored.push(
          `tools_allow/tools_deny (manifest capabilities.tool_lists=false for ${routed.adapter.id})`,
        );
      }
    }
    // The per-harness web default applies only when the run-level policy is the
    // default "auto"; an explicit run policy always wins.
    const webPolicy = contractPolicy === "auto" && s?.web ? s.web : contractPolicy;
    // Harness-scoped model resolution (INV-103): explicit per-attempt
    // override (budget downgrade / fallback retry) beats the contract's
    // per-harness map, which beats the per-harness settings default. There is
    // no run-global model.
    const model =
      overrideModel ?? contract.routing_models[routed.adapter.id] ?? s?.defaultModel ?? null;
    // Effort disclosure (INV-105) against the harness's advertised ladder. This
    // gate only DISCLOSES an unplaceable level; the clamp belongs to the adapter,
    // which resolves against the catalog for the profile env the child runs in
    // (the manifest here is the DEFAULT account's — see effortGovernance.ts). The
    // contract's FROZEN per-lane effort (QA-035) wins so Exact Retry replays it
    // without re-reading settings; `effortHint`/settings apply only to an unfrozen lane.
    const governed = governRouteEffort(
      contract.routing_efforts[routed.adapter.id] ?? effortHint ?? s?.effort ?? null,
      { id: routed.adapter.id, ...routed },
    );
    const effort = governed.effort;
    if (governed.ignored) ignored.push(governed.ignored);
    return {
      model,
      effort,
      webPolicy,
      maxTurns,
      toolsAllow,
      toolsDeny,
      ignored,
    };
  }

  /**
   * Build the per-lane continuation packet for a thread turn (INV-137).
   * Resolves the lane (harness + effective profile), computes the delta since
   * the lane's checkpoint, reads prior outputs + the git anchor, and — for a
   * lane switch or gap — materializes `context/THREAD.md` and returns the
   * one-line prompt pointer. Emits `session.continuity` and stamps the turn.
   * Returns null (no packet, no pointer) for native resume, a fresh thread, or
   * a non-thread run. Never throws: continuity failure degrades to no packet.
   */
  private async resolveContinuity(
    runInput: RunInput,
    harnessId: string,
    resolvedProfileId: string | null,
    nativeResumeAvailable: boolean,
    sessionFields: Pick<
      HarnessRunSpec,
      "auth_preference" | "resume_session_id" | "credential_profile"
    >,
    store: ArtifactStore,
    paths: RunPaths,
    repoRoot: string,
    log?: EventLog,
  ): Promise<{ pointerLine: string | null } | null> {
    const ctx = runInput.threadContinuity;
    if (!runInput.threadId || !ctx) return null;
    try {
      const profileId = resolvedProfileId ?? ctx.profileId ?? null;
      const lane = { harness: harnessId, profileId };
      const checkpoint = ctx.laneCheckpoints.find(
        (c) => c.harness === harnessId && (c.profileId ?? null) === profileId,
      );
      const headTurnId = ctx.priorTurns.length
        ? ctx.priorTurns[ctx.priorTurns.length - 1].id
        : null;
      const priorHeadOwner = headTurnId
        ? ctx.laneCheckpoints.find((c) => c.turnId === headTurnId)
        : undefined;
      const priorHeadLane = priorHeadOwner
        ? { harness: priorHeadOwner.harness, profileId: priorHeadOwner.profileId ?? null }
        : null;
      const priorTurns: ContinuityTurn[] = ctx.priorTurns.map((t) => ({
        id: t.id,
        prompt: t.prompt,
        outputText: t.runId
          ? (readTextSafe(join(store.runPaths(t.runId).finalDir, "answer.md")) ?? "")
          : "",
      }));
      const req: ContinuityRequest = {
        lane,
        priorTurns,
        laneCheckpointTurnId: checkpoint?.turnId ?? null,
        nativeResumeAvailable,
        priorHeadLane,
        activePlan: activePlanPointer(ctx.priorTurns, store),
        anchor: await workspaceAnchor(repoRoot),
      };
      // V9c: when the packet would collapse an older prefix, replace the
      // mechanical one-liners with a cached (or freshly summarized) prose
      // summary. Same credential route + scoped lane home a real read-only
      // thread turn uses (INV-034/135). Best-effort in its OWN guard — a summary
      // failure keeps the full mechanical packet, never drops it.
      req.cachedSummary = await resolveContinuitySummary({
        req,
        threadId: runInput.threadId,
        projectRoot: runInput.repoRoot,
        cwd: repoRoot,
        adapter: this.deps.registry.get(harnessId),
        credentialProfile: sessionFields.credential_profile,
        authPreference: sessionFields.auth_preference ?? "auto",
        laneEnv: this.laneHomeEnvFor(runInput, harnessId, profileId) ?? {},
        envInheritance: envInheritance(this.config(runInput.repoRoot)),
        signal: runInput.signal,
      });
      const result = buildContinuation(req);
      // Disclose on every lane and stamp the turn (INV-137: never silent).
      log?.emit("session.continuity", {
        thread_id: runInput.threadId,
        harness_id: harnessId,
        kind: result.disclosure.kind,
        packet_turns: result.disclosure.packetTurns,
        summarized: result.disclosure.summarized,
        lane_switched_from: result.disclosure.laneSwitchedFrom,
      });
      runInput.onContinuityResolved?.(ctx.turnId, result.disclosure);
      if (!result.packetMarkdown) return { pointerLine: null };
      const briefPath = join(paths.contextDir, "THREAD.md");
      store.writeText(briefPath, result.packetMarkdown);
      return {
        pointerLine: `Earlier conversation context for this thread is at: ${briefPath} — read it before answering.`,
      };
    } catch (err) {
      // Continuity is best-effort — a packet-build failure must never fail the
      // run — but it is NEVER silent (INV-137). Disclose the degradation: emit
      // the session.continuity event carrying the reason (so the failure is in
      // the run log), and stamp the turn as fresh — it honestly ran WITHOUT the
      // thread packet. Absent this, a summarization/anchor/read failure vanished.
      const reason = err instanceof Error ? err.message : String(err);
      log?.emit("session.continuity", {
        thread_id: runInput.threadId,
        harness_id: harnessId,
        kind: "fresh",
        packet_turns: 0,
        summarized: false,
        lane_switched_from: null,
        degraded: true,
        reason,
      });
      runInput.onContinuityResolved?.(ctx.turnId, {
        kind: "fresh",
        packetTurns: 0,
        summarized: false,
        laneSwitchedFrom: null,
      });
      return { pointerLine: null };
    }
  }

  /**
   * The ONE place an attempt's HOME and OS boundary are decided.
   *
   * Called by every caller of `runCandidateInEnvelope` INSIDE that caller's
   * try, so a delegated refusal is caught by the same catch that writes the
   * attempt record, and so the decided home is in scope there.
   */
  private harnessHomeFor(
    wsm: WorkspaceManager,
    envelope: WorkspaceEnvelope,
    routed: RoutedAdapter,
    runInput: RunInput | undefined,
  ): ScopedHarnessHome {
    // Refuses (never silently degrades) when a delegated run cannot be confined.
    return scopedHarnessHome(
      wsm,
      envelope,
      envelope.worktree_path === envelope.repo_root,
      runInput?.delegated === true,
      routed.adapterAccess,
    );
  }

  private async runCandidateInEnvelope(
    routed: RoutedAdapter,
    envelope: WorkspaceEnvelope,
    attemptId: string,
    label: string,
    contract: ActiveTaskContract,
    prompt: string,
    store: ArtifactStore,
    paths: ReturnType<ArtifactStore["runPaths"]>,
    wsm: WorkspaceManager,
    ledger: BudgetLedger,
    access: AccessProfile,
    onHarnessEvent: ((event: HarnessEvent) => void) | undefined,
    signal: AbortSignal | undefined,
    modelHint: string | undefined,
    effortHint: EffortHint | undefined,
    intent: Intent,
    log: EventLog | undefined,
    effectiveWebMode: ExternalContextPolicy | undefined,
    interaction: InteractionChannel | undefined,
    budgetGuard: ((streamedUsd: number) => boolean) | undefined,
    runInput: RunInput | undefined,
    streamDeltas: boolean,
    fileBackedContext: string | undefined,
    /** D-16d: when set, the mechanical continuation checkpoint pointer for a
     * one-shot fresh-session continuation — appended to the prompt so the model
     * (and the offline fake) re-grounds in the exhausted attempt's partial work. */
    continuationPointer: string | undefined,
    /** Decided by `harnessHomeFor` in the CALLER, so the per-attempt applied
     * facts exist in the caller's catch too: an attempt that ran and then threw
     * must record what it ran under, not just why it stopped. REQUIRED (no
     * default): a silent fallback here would spawn a delegated attempt on the
     * operator's real home while the record still claimed scoped state. */
    harnessHome: ScopedHarnessHome,
  ): Promise<CandidateRun> {
    const adapter = routed.adapter;
    const knobs = this.routeSpecKnobs(routed, contract, modelHint, effortHint);
    // Isolated scoped-home sessions are never retained after disposal.
    const inPlaceEnvelope = envelope.worktree_path === envelope.repo_root;
    const rawContextPacket = await rawContextForEnvelope(routed.implementationTransport, envelope);
    const sessionFields = runInput
      ? await this.sessionSpecFields(
          runInput,
          adapter.id,
          knobs.model,
          log,
          routed.authRouteEstimate,
          routed.quotaAdmission,
        )
      : undefined;
    // Continuity (INV-137): once the lane (harness + resolved profile) is known,
    // build the continuation packet, materialize context/THREAD.md, and point
    // the prompt at it — never embed the packet body in the prompt. Replaces the
    // old static session.rebound "not_portable" phrase with a real disclosure.
    const laneContinuity = runInput
      ? await this.resolveContinuity(
          runInput,
          adapter.id,
          sessionFields?.credential_profile?.profile_id ?? runInput.credentialProfileId ?? null,
          inPlaceEnvelope && !!sessionFields?.resume_session_id,
          sessionFields!,
          store,
          paths,
          envelope.repo_root,
          log,
        )
      : null;
    const artifactRelativeDir = routed.browserRequirement.effective
      ? (wsm.ensureArtifactDirectory(envelope), wsm.ownedArtifactRelativeDirectory(envelope))
      : null;
    if (routed.browserRequirement.effective && artifactRelativeDir === null) {
      throw new Error("browser artifact ownership marker was not persisted");
    }
    let spec = HarnessRunSpec.parse({
      session_id: newId("ses"),
      intent,
      // Engine-derived read-only prompt constraints: protected/auto-protected
      // paths PLUS the exact typed gate argv the run will execute (QA-022 FIX B).
      prompt: promptWithEngineConstraints(
        // The child is told that Claudexor adds no outer OS boundary (disclosure 2 of 3).
        [prompt, outerBoundaryNotice(harnessHome), laneContinuity?.pointerLine, continuationPointer]
          .filter((s): s is string => typeof s === "string" && s.length > 0)
          .join("\n\n"),
        contract.constraints.protected_paths,
        contract.constraints.auto_protected_paths,
        contract.constraints.protected_path_approvals,
        contract.tests.commands,
      ),
      attachments: runInput?.attachments ?? [],
      browser: this.requestRequirements.browserSpec(
        routed.browserRequirement,
        // Browser-MCP screenshots land in this envelope's marker-bound child
        // below the shared root. Only that child is excluded/collected/cleaned.
        artifactRelativeDir === null
          ? ""
          : join(envelope.worktree_path, artifactRelativeDir, CLAUDEXOR_BROWSER_ARTIFACT_SUBDIR),
      ),
      extra_mcp_servers: this.delegationBeltFor(
        runInput,
        intent,
        routed,
        contract.budget.paid_budget,
      ),
      cwd: envelope.worktree_path,
      access: routed.adapterAccess,
      ...this.harnessSpecKnobs(contract, knobs, intent),
      env_inheritance: envInheritance(this.config(contract.repo.root)),
      ...(sessionFields
        ? {
            auth_preference: sessionFields.auth_preference,
            credential_profile: sessionFields.credential_profile,
          }
        : {}),
      ...(inPlaceEnvelope && sessionFields?.resume_session_id
        ? { resume_session_id: sessionFields.resume_session_id }
        : {}),
      // Scoped harness home for isolated envelopes AND for every delegated run;
      // an ordinary in-place run keeps the native environment so the resumed
      // vendor session is reachable. See scopedHarnessHome for the cost a
      // delegated in-place attempt pays for that scoped state.
      ...(harnessHome.env ? { env: harnessHome.env } : {}),
      raw_context_packet: rawContextPacket,
      stream_deltas: streamDeltas,
    });
    if (interaction) spec.extra["interactionChannel"] = interaction;
    // D-16: compile the WorkReport envelope onto the spec (overriding the plain
    // caller-schema transport) and keep the mode for the answer unwrap.
    const workEnvelope = this.workReportEnvelopeFor(routed, contract, Boolean(interaction));
    const workReportMode: WorkReportEnvelopeMode = this.applyWorkEnvelope(spec, workEnvelope);
    const inactivityMs = harnessInactivityTimeoutMs(this.config(contract.repo.root));

    // Named once: the attempt record, the CandidateRun and the terminal gate all
    // read the SAME applied facts rather than three re-derivations. Derived
    // from the LIVE spec, so a W5.4 failover that rotates the credential
    // mid-attempt is re-recorded at the point it becomes true — the receipt
    // must name the profile that ran, never the one the request asked for.
    const appliedNow = () =>
      appliedAttemptFacts(
        harnessHome,
        spec.access,
        spec.credential_profile?.profile_id ?? runInput?.credentialProfileId ?? null,
      );
    let applied = appliedNow();
    const attemptStartedMs = Date.now();
    const budgetSignalState = { quotaPressureDisclosed: false };
    const triedProfiles = new Set<string>(); // W5.4 failover: each profile at most once
    let cost = 0;
    let costEstimated = false;
    let harnessErrored = false;
    let poolExhausted: Error | null = null; // A5: typed pool-exhausted refusal
    const deltaFlood = { count: 0, disclosed: false }; // W-C4 per-attempt delta budget
    // QA-024: emit the belt-failure disclosure event at most once per attempt.
    let beltFailureDisclosed = false;
    const errors: string[] = [];
    let answer = new AnswerAssembly();
    const retryPolicy = transientRetryPolicy(this.config(contract.repo.root));
    // QA-024: the delegation belt is the ONLY engine-owned extra MCP server
    // injected into an agent lane (the browser MCP rides its own field), so its
    // presence in the spec marks the belt requested-and-injected for THIS
    // attempt. A mixed pool leaves it off lanes that cannot host it, so this is
    // per-attempt truth, not the run-wide --delegate flag.
    const beltServerName = spec.extra_mcp_servers?.[0]?.name ?? null;
    // QA-040: the browser MCP is injected under the fixed `browser` namespace
    // (codex `mcp_servers.browser.*`, claude `mcp__browser__*`). Its presence in
    // the spec marks the browser armed for THIS attempt — the telemetry fold
    // then recognizes browser tool calls as trusted live-web evidence.
    const browserServerName = spec.browser ? "browser" : null;
    const telemetry = createAttemptTelemetry(
      knobs.webPolicy,
      contract.external_context.web_required,
      effectiveWebMode ?? knobs.webPolicy,
      [routed.browserRequirement, routed.denyRequirement, routed.delegationRequirement],
      knobs.model,
      beltServerName,
      browserServerName,
    );
    let activeSessionId = spec.session_id;
    const onAbort = () => {
      void adapter.cancel?.(activeSessionId)?.catch(() => {});
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      for (let nativeTry = 0; !signal?.aborted; nativeTry += 1) {
        // A3 per-try isolation: neither output nor progress markers leak across tries.
        if (nativeTry > 0) {
          answer = new AnswerAssembly();
          telemetry.outputMarkers = newAttemptOutputMarkers();
        }
        const clearFileBackedContext = stageFileBackedContext(
          envelope.worktree_path,
          fileBackedContext,
        );
        const runSpec =
          nativeTry === 0
            ? spec
            : HarnessRunSpec.parse({ ...spec, session_id: newId("ses"), extra: { ...spec.extra } });
        // Per-TRY abort controller: the inactivity watchdog aborts THIS try's
        // stream (killing the process group through the existing abort
        // plumbing) without touching the run-level cancel signal, so a timeout
        // and a user cancel stay distinguishable. Recreated per
        // nativeTry — a transient retry must get a LIVE signal, not the
        // previous try's already-aborted composite.
        const attemptAbort = new AbortController();
        runSpec.extra["abortSignal"] = signal
          ? AbortSignal.any([signal, attemptAbort.signal])
          : attemptAbort.signal;
        activeSessionId = runSpec.session_id;
        const transientStart = telemetry.transientFailures.length;
        const rateLimitStart = telemetry.rateLimits.length;
        let rawPatch: RawGitPatchEnvelope | null = null;
        try {
          const watched = withInactivityWatchdog(runModelGovernedRoute(routed, runSpec), {
            timeoutMs: inactivityMs,
            countsAsProgress: countsAsAgentProgress,
            onTimeout: () => {
              attemptAbort.abort();
              void adapter.cancel?.(activeSessionId)?.catch(() => {});
            },
            // Waiting on the USER is legitimate silence. The interaction policy
            // either enforces a finite deadline or waits until answer/cancel/
            // terminal/restart when the timeout is disabled.
            isSuspended: () => (interaction?.pendingCount?.() ?? 0) > 0,
            suspensionVersion: () => interaction?.suspensionVersion?.() ?? 0,
          });
          for await (const ev of watched) {
            if (signal?.aborted) break;
            rawPatch = captureRawPatchEnvelope(rawContextPacket !== null, rawPatch, ev);
            if (ev.type === "patch_produced") continue;
            const safeEv = redactHarnessEvent(ev);
            if (
              dropDeltaPastBudget(
                safeEv,
                deltaFlood,
                Orchestrator.MAX_DELTAS_PER_ATTEMPT,
                (t, p) => log?.emit(t, p),
                adapter.id,
                attemptId,
              )
            )
              continue;
            safeInvoke(onHarnessEvent, safeEv);
            // In-place turns run in the live tree under the native environment, so
            // the session they emit IS reachable for the next turn: record it. An
            // ISOLATED envelope-born session lives in the scoped home that dispose()
            // deletes, so observing it would poison the thread resume map with
            // unreachable ids — skip it there.
            if (inPlaceEnvelope) observeNativeSessionEvent(runInput, adapter.id, safeEv);
            observeAuthSwitch(log, adapter.id, attemptId, safeEv);
            observeAttemptTelemetry(telemetry, safeEv);
            // QA-024: the injected delegation belt's MCP server reported a
            // terminal startup failure. Disclose it ONCE while live; recoverable
            // exact tool-result failures are evaluated at attempt finalization.
            // The terminal outcome axis (delegationBeltUnavailable) reflects it
            // too; this event makes the failure visible while the run is live.
            if (
              telemetry.delegationBelt.requested &&
              telemetry.delegationBelt.failed &&
              !beltFailureDisclosed
            ) {
              beltFailureDisclosed = true;
              log?.emit("delegation.belt.unavailable", {
                attempt_id: attemptId,
                harness_id: adapter.id,
                server_name: telemetry.delegationBelt.serverName,
                reason: "mcp_server_failed_to_start",
              });
            }
            emitPlanProgress((t, p) => log?.emit(t, p), adapter.id, attemptId, safeEv);
            if (safeEv.type === "usage") {
              const usage = processAttemptUsage({
                event: safeEv,
                telemetry,
                harnessId: adapter.id,
                attemptId,
                cost,
                costEstimated,
                emit: (type, payload) => log?.emit(type, payload),
                budgetGuard,
                cancel: () => void adapter.cancel?.(runSpec.session_id)?.catch(() => {}),
              });
              cost = usage.cost;
              costEstimated = usage.costEstimated;
              if (usage.hardCapReached) {
                harnessErrored = true;
                errors.push("budget hard cap reached mid-attempt; stream aborted");
                break;
              }
            }
            if (safeEv.type === "error") {
              harnessErrored = true;
              errors.push(redactSecrets(safeEv.error ?? safeEv.text ?? "harness emitted error"));
            }
            // Capture assistant prose so an answer-only turn (no file changes) still
            // has an honest output artifact; a TYPED final message wins verbatim.
            answer.observe(safeEv);
            // Observe ALL budget/quota signals (one codex usage event carries
            // BOTH spend and quota); pressure disclosed once per attempt.
            observeBudgetSignals(ledger, log, adapter.id, attemptId, safeEv, budgetSignalState);
            this.deps.quotaEventSink?.(adapter.id, safeEv);
          }
          if (rawContextPacket && !harnessErrored)
            await consumeRawPatchEnvelope({
              repoRoot: envelope.repo_root,
              worktreePath: envelope.worktree_path,
              baseCommitSha: envelope.base_sha ?? "HEAD",
              context: rawContextPacket,
              envelope: rawPatch,
            });
        } catch (err) {
          // A throwing adapter must not lose the cost already streamed: record the
          // error here and let the caller settle the REAL accumulated spend. #31:
          // classify the throw (watchdog timeout vs process crash) so the retry
          // gate and required-actions read a typed category, not a bare boolean.
          harnessErrored = true;
          errors.push(safeErrorMessage(err));
          telemetry.transientFailures.push(
            classifyAdapterThrow({ errorName: err instanceof Error ? err.name : null }),
          );
        } finally {
          clearFileBackedContext();
        }

        const newTransients = telemetry.transientFailures.slice(transientStart);
        const transient = newTransients.at(-1) ?? null;
        // #31: the centralized retry gate reads the classified `retryable` verdict.
        const sawRetryable = newTransients.some((f) => f.retryable);
        const sawTypedLimit = telemetry.rateLimits.length > rateLimitStart;
        const currentDiff = await wsm.diff(envelope);
        const deliverableEmpty = currentDiff.trim().length === 0 && answer.text().length === 0;
        // W5.4 + A2 failover: a typed-limit hit OR a structural pre-progress
        // death rebuilds the spec on a NEW session under the next profile.
        if (harnessErrored && runInput && !signal?.aborted) {
          const rotated = await rotateSpecOnTypedLimit({
            spec,
            harnessId: adapter.id,
            attemptId,
            policy: this.credentials.profilePolicy(contract.repo.root, adapter.id),
            registry: this.config(contract.repo.root)?.global.credential_profiles ?? [],
            snapshots: this.deps.quotaSnapshots?.() ?? [],
            probeReadyProfiles: () =>
              this.credentials.readyProfileIdsForRotation(
                runInput,
                adapter.id,
                spec.credential_profile ?? null,
                triedProfiles,
                spec.model_hint ?? null,
              ),
            ...this.credentials.rotationObservations(adapter, spec, newTransients),
            triedProfiles,
            markers: telemetry.outputMarkers,
            sawTypedLimit,
            sawRetryable,
            attemptErrored: harnessErrored,
            // Rotation evidence reads the POLICY-accepted try output: refusal
            // prose arriving as mid-stream MESSAGE events (claude org-disabled)
            // is no deliverable; the transient gate keeps RAW deliverableEmpty.
            deliverableEmpty:
              currentDiff.trim().length === 0 &&
              acceptedTryOutput(answer, harnessErrored).length === 0,
            workspaceDiffNonEmpty: currentDiff.trim().length > 0,
            lastLimit: telemetry.rateLimits.at(-1) ?? null,
            emit: (type, payload) => log?.emit(type, payload),
            newSessionId: () => newId("ses"),
            defaultRouteWasVendorNative: routed.authRouteEstimate === "local_session",
            // D-U6: an explicit pin never rotates; pool-selected rows do.
            pinned: runInput.credentialProfileId != null,
          });
          // A5 ordering: an exhausted pool terminalizes TYPED here, BEFORE the
          // transient gate below burns same-profile retries (limits classify
          // as retryable) on the already-refused subject.
          if (rotated && "poolExhausted" in rotated) {
            poolExhausted = rotated.poolExhausted;
            errors.push(safeErrorMessage(poolExhausted));
            break;
          }
          if (rotated) {
            // INV-137: the rotated row runs in ITS OWN lane home (no-op for
            // isolated envelopes and native-env in-place turns).
            spec = rotatedSpecInLaneHome(
              spec,
              rotated,
              (id) => this.laneHomeEnvFor(runInput, adapter.id, id),
              runInput.credentialProfileId ?? null,
            );
            applied = appliedNow();
            errors.length = 0;
            harnessErrored = false;
            continue;
          }
        }
        if (
          !harnessErrored ||
          !sawRetryable ||
          !deliverableEmpty ||
          nativeTry >= retryPolicy.maxRetries ||
          signal?.aborted
        )
          break;

        const delayMs = emitTransientRetryPlan(
          (t, p) => log?.emit(t, p),
          adapter.id,
          attemptId,
          transient,
          nativeTry,
          retryPolicy,
        );
        errors.length = 0;
        harnessErrored = false;
        await sleep(delayMs);
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    // A pool-exhausted terminal is rotation's verdict, not the transient
    // machinery's — no `route.transient.exhausted` rides along with it.
    if (harnessErrored && !poolExhausted) {
      emitTransientExhausted(
        (t, p) => log?.emit(t, p),
        adapter.id,
        attemptId,
        telemetry,
        retryPolicy.maxRetries,
      );
    }
    const attemptStreamEndedMs = Date.now();
    if (webUnsatisfied(telemetry)) {
      errors.push(webEvidenceFailure(telemetry.web));
    }
    // D-16: answer.md persists only the deliverable. A3: an errored attempt
    // with no typed final contributes no answer material (acceptedTryOutput).
    const unwrapped = unwrapWorkReportEnvelope(
      acceptedTryOutput(answer, harnessErrored),
      workReportMode,
      { sideToolReport: telemetry.sideToolWorkReport ?? undefined },
    );
    const redacted = redactSecrets(unwrapped.deliverable);
    const candidateAnswer = redacted.trim().length > 0 ? redacted : undefined;
    const { diff, refusal: secretDiffRefusal } = await secretDiff.quarantineCandidateWorkspace(
      wsm,
      envelope,
      inPlaceEnvelope,
      candidateAnswer,
    );
    harnessErrored = secretDiff.recordSecretDiffRefusal(secretDiffRefusal, errors, harnessErrored);
    const answerText = secretDiffRefusal ? undefined : candidateAnswer;
    const deliverableEvidence = diff.trim().length > 0 || Boolean(answerText);
    // Cancelled attempts skip gates: running a 600s-per-gate suite delays the ack
    // and burns compute on a result nobody will adopt. Diff/attempt.yaml
    // still land, so partial work stays inspectable.
    const gateSignalAborted = signal?.aborted === true || secretDiffRefusal !== undefined;
    if (!gateSignalAborted) {
      log?.emit("gate.started", {
        attempt_id: attemptId,
        gates: gateSpecsFromContract(contract).length,
      });
    }
    const gates = gateSignalAborted
      ? []
      : await runGates(gateSpecsFromContract(contract), {
          cwd: envelope.worktree_path,
          env: wsm.envFor(envelope),
          signal,
        });
    if (!gateSignalAborted) {
      log?.emit("gate.completed", {
        attempt_id: attemptId,
        gates: gates.map((g) => ({
          id: g.id,
          status: g.status,
          exit_code: g.exit_code,
          duration_ms: g.duration_ms,
          stdout_tail: g.stdout_tail,
          stderr_tail: g.stderr_tail,
          output_truncated: g.output_truncated,
        })),
        passed: gatesPassed(gates),
      });
    }
    const webBlocked = webUnsatisfied(telemetry);
    // A descriptor that was injected and then reported failed is past the
    // pre-start degradation boundary. Hard-fail this attempt; never continue as
    // ordinary Agent or let a native vendor subagent masquerade as belt work.
    const delegationError = delegateFailure.delegationFailureError(telemetry);
    if (delegationError) {
      harnessErrored = true;
      errors.push(delegationError);
    }
    // D-16 unified finalizer: fold the WorkReport / context signals into the
    // deliverable + work_state. A broken contract on a constrained route
    // elevates harnessErrored (never a prose success).
    const finalized = finalizeAttempt({
      deliverableEvidence,
      harnessErrored,
      workReport: unwrapped.workReport,
      workReportSource: unwrapped.source,
      workReportViolation: unwrapped.contractViolation,
      contextTerminalExhausted: telemetry.contextExhausted,
    });
    harnessErrored = finalized.harnessErrored;
    if (finalized.outcomeClass === "contract_failure" && unwrapped.contractViolation)
      errors.push(`work_report contract: ${unwrapped.contractViolation}`);
    const deliverablePresent = finalized.deliverablePresent;
    const errored = harnessErrored || webBlocked;
    setAttemptOutcome(telemetry, {
      deliverablePresent,
      gatesPassed: gates.length > 0 ? gatesPassed(gates) : null,
      harnessErrored,
      webRequiredUnsatisfied: webBlocked,
      workState: finalized.workState,
    });
    const attemptDir = join(paths.attemptsDir, attemptId);
    recordCleanAttemptMetrics(globalConfigDir(), adapter.id, {
      costUsd: cost,
      streamMs: attemptStreamEndedMs - attemptStartedMs,
      errored,
      aborted: signal?.aborted === true,
      authMode: telemetry.authMode,
    });
    const producedFiles = AC.withAttemptFailureCost(
      () =>
        writeCandidateAttemptArtifacts({
          store,
          attemptDir,
          worktreePath: envelope.worktree_path,
          artifactRelativeDir,
          diff,
          persistPatch: secretDiffRefusal === undefined && isMutatingAccess(access),
          persistProducedMedia: secretDiffRefusal === undefined,
          answerText,
          record: {
            attempt_id: attemptId,
            harness_id: adapter.id,
            label,
            cost_usd: cost,
            cost_estimated: costEstimated,
            errored,
            errors: errors.slice(0, 5),
            ...telemetrySummary(telemetry),
            outcome: telemetry.outcome,
            ...(secretDiffRefusal ? { secret_diff_refusal: secretDiffRefusal } : {}),
            gates: gates.map((g) => ({ id: g.id, status: g.status })),
            branch: envelope.branch_name,
            // Applied facts, not promises: historical proofs stay readable and
            // current delegated runs state deliberate outer-boundary absence.
            // Built by the SAME shape the failure path writes.
            ...applied,
          },
        }),
      {
        totalUsd: cost,
        estimated: costEstimated,
        settlement: attemptUsageCostSettlement(
          cost,
          costEstimated,
          attemptId,
          adapter.id,
          telemetry.authMode,
          telemetry.usageCost,
        ),
      },
    );
    return {
      attemptId,
      harnessId: adapter.id,
      label,
      diff,
      answerText,
      reviewCwd: envelope.worktree_path,
      baseSha: envelope.base_sha ?? undefined,
      producedFiles,
      gates,
      cost,
      errored,
      costEstimated,
      errors: errors.slice(0, 8),
      telemetry,
      ...(secretDiffRefusal ? { secretDiffRefusal } : {}),
      // A5: the typed refusal survives NORMAL attempt finalization (no throw).
      ...(poolExhausted ? { declaredFailure: declaredFailure(poolExhausted) } : {}),
      outcomeClass: finalized.outcomeClass,
      applied,
    };
  }

  private interactionChannelFor(
    input: RunInput,
    log: EventLog,
    runId: string,
    taskId: string,
    attemptId: string,
    harnessId: string,
    // REQUIRED (no default): every call site must state the routed manifest's
    // `interactive` capability, or a future site would silently bypass the gate.
    supportsInteractive: boolean,
  ): InteractionChannel | undefined {
    // Thin delegate — the channel mechanics live in interaction.ts.
    return interactionChannelFor(
      input,
      log,
      runId,
      taskId,
      attemptId,
      harnessId,
      supportsInteractive,
      DEFAULT_INTERACTION_TIMEOUT_MS,
    );
  }

  /**
   * D-14 layer 3 (AGENTS.md unification, INV-113): the ONE new live-tree write.
   * When the PROJECT root has `AGENTS.md` and no `CLAUDE.md`, drop a thin
   * `CLAUDE.md` (`@AGENTS.md` import + Claudexor ownership marker) so a Claude
   * Code route reads the same instruction file codex/cursor read natively.
   *
   * The project-root bridge has its own narrower fence: read-only modes never
   * reach this run-prep stage and `--in-place` stateful targets are left
   * untouched. Git admission is independently owned by `runStartRequiresGit`.
   * The write targets the PROJECT root (`repoRoot`), never a worktree envelope.
   * The workspace helper adds exclusive-create + no-follow +
   * idempotency, so a hand-written or symlinked `CLAUDE.md` is never overwritten
   * and a concurrent/second prep is a no-op. Announced via a typed
   * `project.claude_bridge.created` event on an actual create only — the git-init
   * pattern. A bridge is a convenience, not a precondition: any failure is
   * swallowed so it can never fail an otherwise-valid write run.
   */
  private ensureClaudeBridgeForRun(repoRoot: string, inPlace: boolean, log: EventLog): void {
    if (repoRoot === NO_PROJECT_ROOT || inPlace) return;
    let result;
    try {
      result = ensureClaudeBridge(repoRoot);
    } catch {
      return;
    }
    if (result.created) {
      log.emit("project.claude_bridge.created", {
        project_root: repoRoot,
        path: "CLAUDE.md",
        source: "AGENTS.md",
      });
    }
  }

  private async runRace(
    input: RunInput,
    mode: ModeKind,
    announce: (a: AnnouncedRunContext) => void,
  ): Promise<OrchestratorResult> {
    const taskId = input.taskId ?? newId("task");
    const runId = input.runId ?? newId("run");
    // Contract validation (trust gates, secret scans) runs BEFORE the run is
    // announced: a refused run must fail the request loudly, not 200 a runId
    // and leave an orphaned run dir without a terminal event.
    const contract = this.buildContract(input, taskId, mode);
    const mutatingRun = isMutatingAccess(contract.access.effective_profile);
    const planBrief = verifiedPlanBrief(input);
    const quotaSnapshots = this.quotaSnapshotPreflight();
    const { store, paths, log, ledger } = beginAnnouncedRun(
      {
        input,
        contract,
        quotaSnapshots,
        store: this.artifactStore(input),
        authority: this.deps.delegationBudgetAuthority,
        runId,
        taskId,
        mode,
        phase: "race",
        prompt: input.prompt,
      },
      announce,
    );
    input = withPlanBrief(input, store, paths, log, planBrief);
    // The execution root is the tree the harness mutates: the project itself
    // for in-place threads/ordinary runs, or the thread's persistent worktree
    // for an isolated thread. Config/artifacts/contract stay anchored to
    // repoRoot. Both the WorkspaceManager and the git boundary resolve against
    // this SINGLE root.
    const execRoot = this.execRootOf(input);
    const wsm = new WorkspaceManager(execRoot);

    store.writeYaml(join(paths.contextDir, "task.yaml"), contract);
    log.emit("task.contract.created", { task_contract_hash: hashJson(contract) });

    // Write modes need a git boundary for worktree isolation and honest diffs.
    // A non-git project folder is initialized automatically (baseline commit),
    // announced in the timeline — except an implausible root (the user home
    // directory, a filesystem root, or one that cannot be classified), which
    // gets a typed refusal BEFORE any mutation (INV-075). For an isolated
    // thread the execution root is already a git worktree: a no-op there.
    if (mutatingRun) {
      const gitPreconditionError = await ensureWriteModeGitBoundary(
        execRoot,
        log,
        store,
        paths,
        runId,
        mode,
      );
      if (gitPreconditionError) {
        return {
          runId,
          taskId,
          mode,
          lifecycle: "failed",
          facts: makeOutcomeFacts("failed", { reason: gitPreconditionError.reason }),
          winner: null,
          runDir: paths.root,
          summary: gitPreconditionError.message,
          candidates: [],
        };
      }
    }
    // Same run-prep stage as the git boundary: if the PROJECT root uses AGENTS.md
    // with no CLAUDE.md, bridge it so a Claude Code candidate reads it (INV-113).
    if (mutatingRun) {
      this.ensureClaudeBridgeForRun(input.repoRoot, input.inPlace === true, log);
    }
    // Pre-turn snapshot of the live tree for in-place runs: the revert restore
    // target (server-owned revertInPlace). A snapshot failure must never fail the
    // run — revert is simply unavailable then.
    let preTurnSha: string | null = null;
    if (mutatingRun && input.inPlace === true) {
      try {
        preTurnSha = await snapshotTree(execRoot);
      } catch {
        preTurnSha = null;
      }
    }

    // ContextPack is LAZY: agent/race candidates explore the live tree
    // themselves inside their envelopes; only the read-only report modes
    // (explore/plan/readonly_audit) build and attach the compact atlas.

    const reviewDir = join(paths.root, "review-evidence");
    writeEvidencePacket(reviewDir, {
      userIntent: redactSecrets(input.prompt),
      diff: "(per-candidate diffs are supplied to reviewers individually)\n",
      tests: renderTestsEvidence(contract),
    });

    let adapters: RoutedAdapter[];
    try {
      // Best-of races the whole pool. The `log` is passed so an AUTO pool that
      // drops a lane / clamps width discloses `route.pool.degraded` (QA-043) —
      // the resolver never refills a dropped slot with a duplicate harness.
      adapters = await this.resolveCandidateAdapters(
        input,
        this.candidateIntent(input),
        ledger,
        log,
        undefined,
        runId,
      );
    } catch (err) {
      const message = safeErrorMessage(err);
      writeRoutingFailureTerminal(store, paths, log, {
        runId,
        modeLabel: mode,
        message,
        err,
      });
      return {
        runId,
        taskId,
        mode,
        lifecycle: "failed",
        facts: makeOutcomeFacts("failed", { reason: "harness_failed" }),
        winner: null,
        runDir: paths.root,
        summary: message,
        candidates: [],
      };
    }
    activateDelegationParent(
      this.deps.delegationBudgetAuthority,
      input,
      runId,
      ledger,
      adapters,
      log,
    );
    const reviewersOutcome = await this.resolveReviewersWithArtifacts(
      input,
      log,
      store,
      paths,
      runId,
      taskId,
      mode,
    );
    if ("failed" in reviewersOutcome) return reviewersOutcome.failed;
    const reviewers = reviewersOutcome.reviewers;
    const reviewVerified = this.routeVerified(reviewers);

    const reviewEnvelopes: WorkspaceEnvelope[] = [];
    const disposeReviewEnvelopes = async () => {
      const envelopes = reviewEnvelopes.splice(0);
      for (const env of envelopes) await wsm.dispose(env);
    };
    const candidateAccess = contract.access.effective_profile;

    interface CandidateSlot {
      routed: RoutedAdapter;
      attemptId: string;
      label: string;
      leaseId: string;
    }
    let budgetStopped = false;
    // QA-050: keep the ledger's typed denial so the zero-candidate terminal
    // emits budget remediation (not an empty/auth action list).
    let budgetDenial: BudgetDenial | null = null;
    let softWarned = false;
    const requestedSingleCandidate = adapters.length === 1;
    const slots: CandidateSlot[] = [];
    for (let i = 0; i < adapters.length; i++) {
      const routed = adapters[i] as RoutedAdapter;
      const attemptId = `a${String(i + 1).padStart(2, "0")}`;
      const lease = ledger.reserve({
        taskId,
        attemptId,
        intent: this.candidateIntent(input),
        harnessId: routed.adapter.id,
        cost: attemptCostEvidence(
          routed.adapter.id,
          attemptId,
          this.reservationEstimateUsd(input, i > 0),
          this.routeBillingKnowledge(input, routed.adapter.id),
        ),
      });
      log.emit("budget.lease.created", {
        granted: lease.granted,
        reason: lease.reason,
        attempt_id: attemptId,
        harness_id: routed.adapter.id,
      });
      if (!lease.granted) {
        // Wave-guard denial stops ADDING slots but must not cancel the ones
        // already granted; only a tripped hard cap stops everything.
        if (lease.denied !== "estimate_headroom") budgetStopped = true;
        budgetDenial ??= {
          code: lease.denied ?? "hard_cap",
          reason: lease.reason ?? "budget lease denied",
          harnessId: routed.adapter.id,
          attemptId,
        };
        break; // do not spawn more paid work
      }
      slots.push({
        routed,
        attemptId,
        label: `Candidate ${LABELS[i] ?? i + 1}`,
        leaseId: lease.lease?.lease_id ?? "",
      });
    }

    const runsBySlot = new Array<CandidateRun | undefined>(slots.length);
    // D-16d: one-shot continuation budget shared across the concurrent candidate
    // slots (parity with the read-only chain's single counter). Claimed
    // synchronously (check-then-increment with no await between), so two slots
    // that both exhaust cannot both consume the single continuation.
    let candidateContinuationCount = 0;
    const runSlot = async (slot: CandidateSlot, slotIdx: number): Promise<void> => {
      if (input.signal?.aborted) {
        ledger.cancel(slot.leaseId);
        return;
      }
      // Leases are granted upfront (before spend exists); a worker still
      // re-checks the circuit breaker so queued slots beyond the parallel wave
      // do not start after earlier candidates already blew the hard cap.
      if (budgetStopped || ledger.tier() === "hard") {
        ledger.cancel(slot.leaseId);
        log.emit("budget.lease.created", {
          granted: false,
          reason: "budget exhausted (hard cap reached)",
          attempt_id: slot.attemptId,
          harness_id: slot.routed.adapter.id,
          cancelled_after_grant: true,
        });
        budgetStopped = true;
        return;
      }
      const adapter = slot.routed.adapter;
      // Soft + downgrade breaker (before the hard cap): soft = a one-time
      // warning; downgrade = run this attempt on the per-harness fallback_model
      // (cheaper) instead of hard-killing — gives fallback_model a real job.
      const breakerTier = ledger.tier();
      if (breakerTier === "soft" && !softWarned) {
        softWarned = true;
        log.emit("budget.observation", {
          harness_id: adapter.id,
          attempt_id: slot.attemptId,
          kind: "manual",
          detail: "budget soft cap reached — approaching the run ceiling",
        });
      }
      const downgradeModel =
        breakerTier === "downgrade" ? (slot.routed.settings?.fallbackModel ?? null) : null;
      if (downgradeModel) {
        log.emit("budget.observation", {
          harness_id: adapter.id,
          attempt_id: slot.attemptId,
          kind: "manual",
          detail: `budget downgrade — switching to fallback model ${downgradeModel}`,
        });
      }
      const knobs = this.routeSpecKnobs(
        slot.routed,
        contract,
        downgradeModel ?? undefined,
        input.effort,
      );
      const effectiveWeb = this.discloseWebUpgrade(
        log,
        slot.routed,
        knobs.webPolicy,
        slot.attemptId,
      );
      let envelope: WorkspaceEnvelope | undefined;
      // Declared OUTSIDE the try so the catch below can state what the attempt
      // actually ran under, not merely that it stopped.
      let harnessHome: ScopedHarnessHome | undefined;
      try {
        log.emit("harness.started", {
          harness_id: adapter.id,
          attempt_id: slot.attemptId,
          external_context_policy: knobs.webPolicy,
          ...(knobs.ignored.length > 0 ? { ignored_settings: knobs.ignored } : {}),
        });
        envelope = await wsm.create({
          taskId,
          attemptId: slot.attemptId,
          baseRef: contract.repo.base_ref,
          dirtyPolicy: "snapshot",
          accessProfile: candidateAccess,
          // Direct-workspace singletons run in place. Races and patch-envelope
          // transports stay isolated and adopt through the delivery service.
          inPlace:
            !mutatingRun ||
            (input.inPlace === true &&
              requestedSingleCandidate &&
              slot.routed.implementationTransport !== "git_patch_envelope"),
        });
        harnessHome = this.harnessHomeFor(wsm, envelope, slot.routed, input);
        const run = await this.runCandidateInEnvelope(
          slot.routed,
          envelope,
          slot.attemptId,
          slot.label,
          contract,
          input.prompt,
          store,
          paths,
          wsm,
          ledger,
          candidateAccess,
          (ev) => {
            const safeEv = redactHarnessEvent(ev);
            safeInvoke(input.onHarnessEvent, safeEv);
            log.emit("harness.event", harnessEventPayload(adapter.id, slot.attemptId, safeEv));
          },
          input.signal,
          downgradeModel ?? undefined,
          input.effort,
          this.candidateIntent(input),
          log,
          effectiveWeb,
          this.interactionChannelFor(
            input,
            log,
            runId,
            taskId,
            slot.attemptId,
            adapter.id,
            slot.routed.supportsInteractive,
          ),
          (streamedUsd) => {
            ledger.updateHold(slot.leaseId, streamedUsd);
            if (ledger.tier() !== "hard") return false;
            budgetStopped = true;
            return true;
          },
          input,
          requestedSingleCandidate, // W-C4 deltas: single-candidate chat lane only (racing = noise x N)
          undefined,
          undefined,
          harnessHome,
        );
        ledger.settle(
          slot.leaseId,
          attemptUsageCostSettlement(
            run.cost,
            run.costEstimated,
            run.attemptId,
            run.harnessId,
            run.telemetry.authMode,
            run.telemetry.usageCost,
          ),
        );
        log.emit("harness.completed", {
          harness_id: adapter.id,
          attempt_id: slot.attemptId,
          // QA-027: never claim `success` over an attempt the operator/deadline
          // cut short. An abort makes the run non-successful; the top-level
          // status axis must say `cancelled` (the nested outcome axis already
          // rides in telemetrySummary), not launder a torn-off stream as clean.
          status: input.signal?.aborted ? "cancelled" : run.errored ? "failed" : "success",
          cost_usd: run.cost,
          ...telemetrySummary(run.telemetry),
        });
        // D-16d one-shot continuation for an ENVELOPED candidate (parity with the
        // read-only loop, which had the ONLY continuation wiring). An eligible
        // terminal context exhaustion (repeated_refill, no completed report) gets
        // ONE fresh-session re-run in the SAME envelope, re-grounded by a
        // mechanical checkpoint packet; the exhausted candidate is superseded ONLY
        // after the continuation completes. In-place candidates are excluded (a
        // fresh session cannot safely resume mutation of the live tree).
        let effectiveRun = run;
        const envInPlace = envelope.worktree_path === envelope.repo_root;
        if (!run.errored && !input.signal?.aborted && candidateContinuationCount === 0) {
          const contDecision = decideContinuation({
            contextExhausted: run.telemetry.contextExhausted,
            contextExhaustedCause: run.telemetry.contextExhaustedCause,
            workStateCompleted: run.telemetry.outcome?.workState?.state === "completed",
            continuationCount: candidateContinuationCount,
            runKind: envInPlace ? "in_place" : "enveloped",
          });
          if (contDecision.eligible) {
            const contAttemptId = `${slot.attemptId}c`;
            const packet = buildContinuationPacket(
              synthesizeContinuationRequest({
                harness: adapter.id,
                profileId: input.credentialProfileId ?? null,
                priorPrompt: input.prompt,
                priorOutput: run.answerText ?? run.diff ?? "",
              }),
            );
            // Reserve the continuation lease BEFORE any disclosure: a denied lease
            // must never emit run.continuation (which claims a continuation
            // launched) and must not consume the one-shot with no attempt. Grant ->
            // claim + disclose + run; refusal -> typed run.continuation.denied.
            const contLease = ledger.reserve({
              taskId,
              attemptId: contAttemptId,
              intent: this.candidateIntent(input),
              harnessId: adapter.id,
              cost: attemptCostEvidence(
                adapter.id,
                contAttemptId,
                this.estimateUsdFloor(input.repoRoot),
                this.routeBillingKnowledge(input, adapter.id),
              ),
            });
            if (contLease.granted) {
              candidateContinuationCount += 1; // claim the one-shot only once it launches
              log.emit("run.continuation", {
                from_attempt: run.attemptId,
                cause: run.telemetry.contextExhaustedCause,
                continuation_count: candidateContinuationCount,
                packet_turns: packet.continuity.disclosure.packetTurns,
              });
              log.emit("harness.started", {
                harness_id: adapter.id,
                attempt_id: contAttemptId,
                external_context_policy: knobs.webPolicy,
                ...(knobs.ignored.length > 0 ? { ignored_settings: knobs.ignored } : {}),
                continuation_of: run.attemptId,
              });
              const contLeaseId = contLease.lease?.lease_id ?? "";
              try {
                const contRun = await this.runCandidateInEnvelope(
                  slot.routed,
                  envelope,
                  contAttemptId,
                  slot.label,
                  contract,
                  input.prompt,
                  store,
                  paths,
                  wsm,
                  ledger,
                  candidateAccess,
                  (ev) => {
                    const safeEv = redactHarnessEvent(ev);
                    safeInvoke(input.onHarnessEvent, safeEv);
                    log.emit(
                      "harness.event",
                      harnessEventPayload(adapter.id, contAttemptId, safeEv),
                    );
                  },
                  input.signal,
                  downgradeModel ?? undefined,
                  input.effort,
                  this.candidateIntent(input),
                  log,
                  effectiveWeb,
                  this.interactionChannelFor(
                    input,
                    log,
                    runId,
                    taskId,
                    contAttemptId,
                    adapter.id,
                    slot.routed.supportsInteractive,
                  ),
                  (streamedUsd) => {
                    ledger.updateHold(contLeaseId, streamedUsd);
                    if (ledger.tier() !== "hard") return false;
                    budgetStopped = true;
                    return true;
                  },
                  input,
                  requestedSingleCandidate,
                  undefined,
                  packet.pointerLine ?? undefined,
                  harnessHome,
                );
                ledger.settle(
                  contLeaseId,
                  attemptUsageCostSettlement(
                    contRun.cost,
                    contRun.costEstimated,
                    contRun.attemptId,
                    contRun.harnessId,
                    contRun.telemetry.authMode,
                    contRun.telemetry.usageCost,
                  ),
                );
                log.emit("harness.completed", {
                  harness_id: adapter.id,
                  attempt_id: contAttemptId,
                  status: input.signal?.aborted
                    ? "cancelled"
                    : contRun.errored
                      ? "failed"
                      : "success",
                  cost_usd: contRun.cost,
                  ...telemetrySummary(contRun.telemetry),
                });
                // Supersede the exhausted candidate ONLY after the continuation
                // actually completes cleanly (never over a torn-off/aborted stream).
                if (!contRun.errored && !input.signal?.aborted) effectiveRun = contRun;
              } catch (err) {
                ledger.settle(
                  contLeaseId,
                  AC.attemptFailureCost(err, "continuation-error", 0).settlement,
                );
                log.emit("harness.completed", {
                  harness_id: adapter.id,
                  attempt_id: contAttemptId,
                  status: "failed",
                  error: safeErrorMessage(err),
                });
              }
            } else {
              ledger.cancel(contLease.lease?.lease_id ?? "");
              log.emit("run.continuation.denied", {
                from_attempt: run.attemptId,
                cause: run.telemetry.contextExhaustedCause,
                reason: contLease.reason ?? contLease.denied ?? "budget lease denied",
              });
            }
          }
        }
        runsBySlot[slotIdx] = effectiveRun;
        reviewEnvelopes.push(envelope);
        envelope = undefined;
      } catch (err) {
        const failureCost = AC.attemptFailureCost(err, "post-stream-error", 0);
        ledger.settle(slot.leaseId, failureCost.settlement);
        const message = safeErrorMessage(err);
        const declared = declaredFailure(err);
        const infraPhase: "workspace" | "harness" =
          envelope === undefined ? "workspace" : "harness";
        log.emit("harness.completed", {
          harness_id: adapter.id,
          attempt_id: slot.attemptId,
          status: "failed",
          error: message,
          phase: infraPhase,
        });
        store.writeYaml(
          join(paths.attemptsDir, slot.attemptId, "attempt.yaml"),
          AC.attemptFailureRecord(
            slot.attemptId,
            adapter.id,
            failureCost,
            infraPhase,
            message,
            appliedAttemptFacts(
              harnessHome,
              slot.routed.adapterAccess,
              this.credentials.effectiveProfileId(input, adapter.id),
            ),
          ),
        );
        runsBySlot[slotIdx] = {
          attemptId: slot.attemptId,
          harnessId: adapter.id,
          label: slot.label,
          diff: "",
          gates: [],
          cost: failureCost.totalUsd,
          errored: true,
          costEstimated: failureCost.estimated,
          errors: [message],
          telemetry: createAttemptTelemetry(
            knobs.webPolicy,
            contract.external_context.web_required,
            effectiveWeb,
            [
              slot.routed.browserRequirement,
              slot.routed.denyRequirement,
              slot.routed.delegationRequirement,
            ],
            knobs.model,
          ),
          infraPhase,
          // Keep a TYPED pre-spawn refusal (spent quota window + its reset)
          // alive past this catch; `message` alone would force the terminal to
          // read prose back out.
          ...(declared.code ? { declaredFailure: declared } : {}),
          applied: appliedAttemptFacts(
            harnessHome,
            slot.routed.adapterAccess,
            this.credentials.effectiveProfileId(input, adapter.id),
          ),
        };
      } finally {
        if (envelope) await wsm.dispose(envelope); // no worktree leak even on create/run error
      }
    };
    await runBounded(slots, Math.min(slots.length, MAX_PARALLEL_CANDIDATES), runSlot);
    const runs: CandidateRun[] = runsBySlot.filter((r): r is CandidateRun => r !== undefined);
    // Fail-closed terminal: a delegated mutating run whose attempts state
    // neither historical proof nor deliberate absence refuses instead of passing.
    assertDelegatedEvidence(input.delegated === true, candidateAccess, runs);
    const cancelledCandidates = () =>
      runs.map((r) => ({
        attemptId: r.attemptId,
        harnessId: r.harnessId,
        status: gatesPassed(r.gates) && !r.errored ? "green" : "red",
      }));
    /** The one cancellation terminal this race can reach, from any of its three
     * abort checks. Every argument is re-read at call time, exactly as it was
     * when each check spelled the whole call out for itself. */
    const cancelledRaceResult = () =>
      cancelledResult(
        log,
        runId,
        taskId,
        mode,
        paths.root,
        cancelledCandidates(),
        () =>
          this.writeRunTelemetry(
            store,
            paths,
            contract,
            runId,
            taskId,
            mode,
            candidateRoster(runs),
            null,
          ),
        ledger.spend(),
        input.signal,
        store,
      );

    // Revert divergence fence for the single-candidate in-place path: the
    // candidate mutated the LIVE tree during execution above, so the post-turn
    // snapshot must be taken NOW — before review/synthesis/arbitration, which can
    // run for a long time during which the user may edit files. Snapshotting after
    // arbitration (as the race-adoption path does) would fold those user edits
    // into the revert target and let a later revert clobber them.
    let earlyPostTurnSha: string | null = null;
    if (
      mutatingRun &&
      input.inPlace &&
      requestedSingleCandidate &&
      runs.every((run) => !run.secretDiffRefusal)
    ) {
      try {
        earlyPostTurnSha = await snapshotTree(execRoot);
      } catch {
        earlyPostTurnSha = null;
      }
    }

    if (input.signal?.aborted) {
      await disposeReviewEnvelopes();
      return cancelledRaceResult();
    }

    const failedDelegation = delegateFailure.dominantRaceCandidateFailure(runs);
    if (failedDelegation) {
      const failure = delegateFailure.candidateFailureTerminal(failedDelegation, "race");
      await disposeReviewEnvelopes();
      if (mutatingRun) {
        await delegateFailure.persistFailedInPlaceWorkProduct({
          ...{ store, log, paths, execRoot, preTurnSha, taskId, mode },
          live: input.inPlace === true && failedDelegation.reviewCwd === execRoot,
          run: failedDelegation,
          postTurnSha: earlyPostTurnSha,
          kind: input.create === true ? "new_repo" : "patch",
        });
      }
      this.writeRunTelemetry(
        store,
        paths,
        contract,
        runId,
        taskId,
        mode,
        candidateRoster(runs),
        null,
      );
      return failTerminally(
        log,
        store,
        paths,
        runId,
        taskId,
        mode,
        failure.phase,
        failure.error,
        ledger.spend(),
        failure.metadata,
      );
    }

    if (runs.length === 0) {
      const budgetReason = ledger.terminal();
      // QA-050: when the zero-candidate cause is a budget refusal, the shared
      // classifier owns the typed code, the refused route/slot, and actionable
      // budget remediation (previously an empty nextActions array).
      const agentBudgetMapping =
        budgetStopped || budgetReason
          ? classifyBudgetFailure({ denial: budgetDenial, terminal: budgetReason })
          : null;
      const facts = makeOutcomeFacts("failed", {
        reason:
          agentBudgetMapping?.reason ?? (budgetStopped ? "budget_exhausted" : "harness_failed"),
        noChanges: true,
      });
      const why = agentBudgetMapping?.safeMessage ?? "no candidates produced";
      store.writeYaml(join(paths.arbitrationDir, "decision.yaml"), {
        winner: null,
        facts,
        why_winner: why,
        evidence_facts: ["no candidates were produced"],
        apply_recommendation: "continue",
        budget_summary: decisionBudgetSummary(ledger),
      });
      store.writeText(
        join(paths.finalDir, "summary.md"),
        `# Run ${runId} (${mode})\n\n- Lifecycle: ${facts.lifecycle}${facts.reason ? ` (${facts.reason})` : ""}\n- Phase: ${agentBudgetMapping ? "budget" : "executor"}\n\n${why}\n`,
      );
      if (agentBudgetMapping) {
        writeFailure(store, paths, budgetFailureRecord(agentBudgetMapping, { runDir: paths.root }));
      } else {
        writeFailure(store, paths, {
          phase: "executor",
          category: "internal",
          safeMessage: why,
          runDir: paths.root,
          nextActions: ["Open diagnostics", "Retry the run"],
        });
      }
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      log.emit("run.failed", {
        lifecycle: facts.lifecycle,
        facts,
        reason: facts.reason,
        phase: agentBudgetMapping ? "budget" : "executor",
        ...(agentBudgetMapping?.harnessId ? { harness_id: agentBudgetMapping.harnessId } : {}),
        error: why,
        failure_ref: "final/failure.yaml",
      });
      return {
        runId,
        taskId,
        mode,
        lifecycle: facts.lifecycle,
        facts,
        winner: null,
        runDir: paths.root,
        summary: why,
        candidates: [],
        spendUsd: ledger.spend(),
      };
    }

    // Reviewers, synthesis, and arbitration only ever see candidates WITH
    // work (a real diff or a completed stream). Attempts that died before
    // producing anything are corpses: reviewing "(empty diff)" spends real
    // reviewer money on nothing and buries the root cause behind an
    // arbitration scoring string.
    const workingRuns = partitionCandidates(runs).working;
    if (workingRuns.length === 0) {
      await disposeReviewEnvelopes();
      const first = runs[0] as CandidateRun;
      const phase = first.secretDiffRefusal ? "artifact_security" : (first.infraPhase ?? "harness");
      const { facts, why: rootCause } = partitionCandidates(runs);
      store.writeYaml(join(paths.arbitrationDir, "decision.yaml"), {
        winner: null,
        facts,
        why_winner: rootCause,
        evidence_facts: runs.map(
          (r) => `${r.attemptId} produced no work: ${r.errors[0] ?? "unknown"}`,
        ),
        apply_recommendation: "continue",
        budget_summary: decisionBudgetSummary(ledger),
      });
      this.writeRunTelemetry(
        store,
        paths,
        contract,
        runId,
        taskId,
        mode,
        candidateRoster(runs),
        null,
      );
      store.writeText(
        join(paths.finalDir, "summary.md"),
        `# Run ${runId} (${mode})\n\n- Lifecycle: ${facts.lifecycle}\n- Phase: ${phase}\n\n${rootCause}\n`,
      );
      const existingEventRefs = runs
        .map((r) => `attempts/${r.attemptId}/events.jsonl`)
        .filter((rel) => existsSync(join(paths.root, rel)));
      // #31: auth guidance only on a classified auth failure; every other
      // harness cause (timeout, rate limit, crash, config) gets remediation that
      // fits it, instead of a doomed "Check harness authentication".
      const harnessCategory = dominantHarnessFailureCategory(first.telemetry.transientFailures);
      // A run speaks with a candidate's TYPED refusal only when EVERY candidate
      // died of the same one (candidateEvidence owns that rule); mixed causes
      // keep the honest harness terminal.
      const unanimous = unanimousDeclaredFailure(runs);
      writeFailure(store, paths, {
        phase,
        category: unanimous?.category ?? (phase === "workspace" ? "project" : "harness_error"),
        code: unanimous?.code ?? null,
        harnessId: first.harnessId,
        attemptId: first.attemptId,
        safeMessage: rootCause,
        rawDetailRef: `attempts/${first.attemptId}/attempt.yaml`,
        eventRefs: existingEventRefs,
        runDir: paths.root,
        resetsAt: unanimous?.resetsAt ?? null,
        nextActions: first.secretDiffRefusal
          ? secretDiff.secretDiffNextActions(first.secretDiffRefusal)
          : phase === "workspace"
            ? ["Check the project folder", "Open diagnostics", "Retry the run"]
            : harnessFailureNextActions(harnessCategory),
      });
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      log.emit("run.failed", {
        lifecycle: facts.lifecycle,
        facts,
        reason: facts.reason,
        phase,
        error: rootCause,
        failure_ref: "final/failure.yaml",
      });
      return {
        runId,
        taskId,
        mode,
        lifecycle: facts.lifecycle,
        facts,
        winner: null,
        runDir: paths.root,
        summary: rootCause,
        candidates: runs.map((r) => ({
          attemptId: r.attemptId,
          harnessId: r.harnessId,
          status: "red",
        })),
        spendUsd: ledger.spend(),
      };
    }

    // QA-025: only announce that review STARTED when the panel will actually
    // run. A candidate that changed no files is skipped inside reviewRuns; a
    // start event before that check falsely claims a paid review began (and its
    // `review_verified` payload was the PRELIMINARY route-family count, not any
    // real verification). Compute the reviewable set first and emit a typed
    // `review.skipped` when nothing is reviewable, so every start has a matching
    // terminal and the no-diff path records `not_run` consistently.
    const reviewableRuns = workingRuns.filter((r) => r.diff.trim().length > 0);
    const configuredFamilies = new Set(reviewers.map((r) => r.providerFamily)).size;
    if (reviewableRuns.length === 0 || reviewers.length === 0) {
      log.emit("review.skipped", {
        reason: reviewers.length === 0 ? "no_reviewers" : "no_changes",
        reviewable_candidates: reviewableRuns.length,
        configured_reviewers: reviewers.length,
        configured_provider_families: configuredFamilies,
      });
    } else {
      log.emit("review.started", {
        reviewers: reviewers.length,
        reviewable_candidates: reviewableRuns.length,
        configured_provider_families: configuredFamilies,
        cross_family_route_eligible: reviewVerified,
      });
    }
    let evidences: CandidateEvidence[];
    try {
      // reviewRuns internally SKIPS the paid reviewer call for empty-diff
      // candidates (a trivial greeting in agent mode no longer burns two reviewers on
      // "(empty diff)"). Candidates still flow through arbitration/gates so the
      // no_op/answer outcome and gate failures are unchanged.
      evidences = await this.reviewRuns(
        workingRuns,
        reviewers,
        reviewVerified,
        reviewDir,
        input.repoRoot,
        contract,
        store,
        paths,
        log,
        ledger,
        taskId,
        input.signal,
        this.reservationEstimateUsd(input),
      );
    } catch (err) {
      // Review preflight/evidence failures end TERMINALLY with artifacts —
      // never as an escaped throw that orphans the run dir.
      return failTerminally(log, store, paths, runId, taskId, mode, "review", err, ledger.spend());
    } finally {
      // Review preflight failures must not leak candidate worktrees.
      await disposeReviewEnvelopes();
    }
    if (input.signal?.aborted) {
      return cancelledRaceResult();
    }

    // Synthesis: if worthwhile, run a synthesizer as a NEW, re-checked candidate.
    const synth = mutatingRun
      ? decideSynthesis(evidences, input.synthesis ?? "auto")
      : {
          synthesize: false,
          reason: "readonly access has no write-backed synthesis lifecycle",
          sources: evidences.map((evidence) => evidence.attemptId),
        };
    store.writeYaml(join(paths.arbitrationDir, "synthesis.yaml"), synth);
    log.emit("synthesis.started", { synthesize: synth.synthesize, reason: synth.reason });
    if (synth.synthesize && !budgetStopped) {
      const synthRouted = adapters[0] as RoutedAdapter;
      const lease = ledger.reserve({
        taskId,
        attemptId: "synth",
        intent: "synthesize",
        harnessId: synthRouted.adapter.id,
        cost: attemptCostEvidence(
          synthRouted.adapter.id,
          "synth",
          this.reservationEstimateUsd(input),
          this.routeBillingKnowledge(input, synthRouted.adapter.id),
        ),
      });
      if (lease.granted) {
        let envelope: WorkspaceEnvelope | undefined;
        try {
          const plan = buildSynthesisPlan(evidences);
          const synthesisInput = buildFileBackedSynthesisInput({
            instructions: plan.instructions,
            findings: plan.fixFindings,
            candidates: workingRuns,
          });
          const synthAdapter = synthRouted.adapter;
          // Disclose against the PER-ROUTE policy (per-harness web defaults
          // included), exactly like the candidate slots do.
          const synthKnobs = this.routeSpecKnobs(synthRouted, contract, undefined, input.effort);
          const effectiveWeb = this.discloseWebUpgrade(
            log,
            synthRouted,
            synthKnobs.webPolicy,
            "synth",
          );
          envelope = await wsm.create({
            taskId,
            attemptId: "synth",
            baseRef: contract.repo.base_ref,
            dirtyPolicy: "snapshot",
            accessProfile: candidateAccess,
          });
          const synthHome = this.harnessHomeFor(wsm, envelope, synthRouted, input);
          const run = await this.runCandidateInEnvelope(
            synthRouted,
            envelope,
            "synth",
            "Synthesis",
            contract,
            synthesisInput.prompt,
            store,
            paths,
            wsm,
            ledger,
            candidateAccess,
            (ev) => {
              const safeEv = redactHarnessEvent(ev);
              safeInvoke(input.onHarnessEvent, safeEv);
              log.emit("harness.event", harnessEventPayload(synthAdapter.id, "synth", safeEv));
            },
            input.signal,
            undefined,
            input.effort,
            "synthesize",
            log,
            effectiveWeb,
            this.interactionChannelFor(
              input,
              log,
              runId,
              taskId,
              "synth",
              synthAdapter.id,
              synthRouted.supportsInteractive,
            ),
            undefined,
            input,
            false,
            synthesisInput.content,
            undefined,
            synthHome,
          );
          ledger.settle(
            lease.lease?.lease_id ?? "",
            attemptUsageCostSettlement(
              run.cost,
              run.costEstimated,
              run.attemptId,
              run.harnessId,
              run.telemetry.authMode,
              run.telemetry.usageCost,
            ),
          );
          reviewEnvelopes.push(envelope);
          envelope = undefined;
          // D-16 r8: only a WORKING synth is reviewed/adopted (same veto owner
          // as the race lane); `runs` still records it for telemetry.
          runs.push(run);
          try {
            if (isWorkingCandidate(run)) {
              const synthEvidence = await this.reviewRuns(
                [run],
                reviewers,
                reviewVerified,
                reviewDir,
                input.repoRoot,
                contract,
                store,
                paths,
                log,
                ledger,
                taskId,
                input.signal,
                this.reservationEstimateUsd(input),
              );
              evidences.push(...synthEvidence);
              workingRuns.push(run);
            }
            if (input.signal?.aborted) {
              return cancelledResult(
                log,
                runId,
                taskId,
                mode,
                paths.root,
                cancelledCandidates(),
                () =>
                  this.writeRunTelemetry(
                    store,
                    paths,
                    contract,
                    runId,
                    taskId,
                    mode,
                    candidateRoster(runs),
                    null,
                  ),
                ledger.spend(),
                input.signal,
                store,
              );
            }
          } finally {
            await disposeReviewEnvelopes();
          }
        } catch (err) {
          ledger.settle(
            lease.lease?.lease_id ?? "",
            AC.attemptFailureCost(err, "synthesis-error").settlement,
          );
          log.emit("harness.completed", {
            attempt_id: "synth",
            status: "failed",
            error: safeErrorMessage(err),
          });
        } finally {
          if (envelope) await wsm.dispose(envelope);
        }
      }
    }
    if (input.signal?.aborted) {
      return cancelledRaceResult();
    }

    let result: ReturnType<typeof arbitrate>;
    try {
      result = arbitrate(evidences, arbitrationBudgetOptions(ledger));
    } catch (err) {
      // Arbitration throws end terminally with artifacts, never as an orphan.
      return failTerminally(
        log,
        store,
        paths,
        runId,
        taskId,
        mode,
        "arbitration",
        err,
        ledger.spend(),
      );
    }
    log.emit("arbitration.completed", {
      winner: result.decision.winner,
      lifecycle: result.decision.facts.lifecycle,
      // QA-028: surface the axis that actually separated the winner from the
      // runner-up (null on an exact tie) so live surfaces can explain the pick.
      ...(result.decision.decisive_axis
        ? { decisive_axis: result.decision.decisive_axis.key }
        : {}),
    });

    // Winner can only be a candidate that actually produced work; corpses are
    // excluded from arbitration upstream and from the fallback here.
    const winnerRun =
      workingRuns.find((r) => r.attemptId === result.decision.winner) ?? workingRuns[0];
    const winnerEvidence = winnerRun
      ? evidences.find((e) => e.attemptId === winnerRun.attemptId)
      : undefined;
    // D9 winner-only NEEDS_HUMAN gate, fail-closed on a winner with no review
    // evidence record (see winnerNeedsHuman).
    const needsHuman = winnerNeedsHuman(winnerRun?.attemptId ?? null, evidences);
    // Run-level review_verified is the WINNER's verification: an
    // empty-diff loser's unverified route must not drag the shipped result's
    // flag false. No winner -> fall back to the all-candidates view.
    const actualReviewVerified = winnerRun
      ? (evidences.find((e) => e.attemptId === winnerRun.attemptId)?.reviewVerified ?? false)
      : evidences.length > 0 && evidences.every((e) => e.reviewVerified);
    let facts: RunOutcomeFacts = result.decision.facts;
    // A reviewer NEEDS_HUMAN escalation forces the REVIEW axis to blocked (a
    // needs-decision terminal), unless the decision is already applyable-clean.
    if (needsHuman && facts.lifecycle === "succeeded" && facts.review !== "blocked") {
      facts = { ...facts, review: "blocked", reason: facts.reason ?? "review_blocked" };
    }
    // A budget terminal turns a succeeded lifecycle into a failed one (D8): the
    // budget reason IS a RunReason.
    const budgetTerminal = ledger.terminal();
    if (facts.lifecycle === "succeeded" && budgetTerminal) {
      facts = makeOutcomeFacts("failed", { reason: budgetTerminal, noChanges: facts.noChanges });
    }
    // FinalVerifier blocks adoption until the patch and gates pass on a fresh base.
    let finalVerify: FinalVerifyRecord | null = null;
    let finalVerifyFailed = false;
    let deliveryFailureReason: string | null = null;
    let raceDeliveryReceipt: Awaited<ReturnType<typeof verifyAndDeliver>> | null = null;
    // A single in-place turn already mutated its execution tree; race adoption
    // instead defers verification until immediately before delivery.
    const inPlaceWinner = winnerRun?.reviewCwd === execRoot;
    const deferredRaceVerify = input.inPlace === true && !inPlaceWinner;
    if (
      mutatingRun &&
      winnerRun &&
      !inPlaceWinner &&
      !deferredRaceVerify &&
      winnerRun.diff.trim().length > 0 &&
      facts.lifecycle === "succeeded" &&
      facts.review !== "blocked" &&
      !input.signal?.aborted
    ) {
      finalVerify = await finalVerifyPatch(
        execRoot,
        winnerRun,
        gateSpecsFromContract(contract),
        log,
      );
      // Verify errors block like proven failures; accept_risk stays available.
      // A failed fresh verify lands on the CHECKS axis (a needs-decision block).
      finalVerifyFailed = finalVerifyBlocks(finalVerify);
      if (finalVerifyFailed) facts = { ...facts, checks: "failed", reason: "checks_failed" };
    }
    // A needs-decision terminal (review blocked or checks failed) overrides the
    // persisted green arbitration fields; otherwise the facts pass through.
    const needsDec = facts.review === "blocked" || facts.checks === "failed";
    store.writeYaml(join(paths.arbitrationDir, "decision.yaml"), {
      ...result.decision,
      ...(needsDec
        ? blockedDecisionOverride(result.decision.evidence_facts, facts, finalVerify)
        : { facts }),
      review_verified: actualReviewVerified,
      final_verify: finalVerify,
    });
    store.writeYaml(join(paths.arbitrationDir, "pairwise.yaml"), result.pairwise);
    const decisionPath = join(paths.arbitrationDir, "decision.yaml");
    if (winnerRun) {
      for (const path of materializeWinnerOutputs({
        attemptDir: join(paths.attemptsDir, winnerRun.attemptId),
        runRoot: paths.root,
        paths: winnerRun.producedFiles ?? [],
      })) {
        log.emit("output.ready", { kind: "artifact", path });
      }
      const winnerAnswer = winnerRun.answerText ?? "";
      // The winner's final MESSAGE is the human-facing answer and materializes
      // for diff-ful runs too: the chat renders final/answer.md (the projection
      // prefers it), never the arbitration summary — "Run … Winner: a01 …" is
      // machine telemetry, not what the agent said. The diff stays in the
      // Diff tab; summary.md remains a diagnostics artifact.
      if (winnerAnswer.length > 0) {
        store.writeText(join(paths.finalDir, "answer.md"), winnerAnswer + "\n");
      }
      // The run's structured-output contract: ONE engine validator, called on
      // the winner's answer regardless of diff presence (a non-conformant
      // answer stays success-with-warnings; the receipt is the truth).
      if (contract.output_schema) {
        finalizeStructuredOutput({
          store,
          finalDir: paths.finalDir,
          log,
          schema: contract.output_schema,
          answerText: winnerAnswer,
        });
      }
      if (mutatingRun) {
        secretDiff.assertNoSecretLikeTokens("final patch diff", winnerRun.diff);
        const patchSha256 = sha256(winnerRun.diff);
        store.writeText(join(paths.finalDir, "patch.diff"), winnerRun.diff);
        const wstats = diffStats(winnerRun.diff);
        const hasDiff = winnerRun.diff.trim().length > 0;
        const blockers = winnerEvidence
          ? winnerEvidence.findings.filter((f) => isBlocking(f)).length
          : 0;
        const resultKind = hasDiff ? "patch" : winnerAnswer.length > 0 ? "answer" : "none";
        // Only a fully verified, applyable success may auto-adopt; a not-verified
        // or needs-decision terminal remains an inspectable artifact.
        const adoptable =
          facts.lifecycle === "succeeded" &&
          facts.review === "approved" &&
          facts.checks !== "failed";
        let adopted: boolean | null = null;
        let applyState: "not_applied" | "applied" | "applied_review_blocked" | "reverted" =
          "not_applied";
        let postTurnSha: string | null = null;
        let revertAnchorId: string | null = null;
        if (input.inPlace === true && hasDiff) {
          if (inPlaceWinner) {
            // Already live: the candidate ran in-place and wrote the tree itself.
            adopted = true;
            applyState = adoptable ? "applied" : "applied_review_blocked";
            // The pre-review fence excludes later user edits from the target.
            postTurnSha = earlyPostTurnSha;
          } else if (adoptable) {
            // Protected apply preserves the live tree or reports tree_mutated.
            const applied = await verifyAndDeliver(
              execRoot,
              winnerRun.diff,
              { mode: "apply", protectedApply: true },
              gateSpecsFromContract(contract),
              (freshVerify) => {
                finalVerify = freshVerify;
                return finalVerifyBlocks(freshVerify)
                  ? (freshVerify.reason ?? "final verify failed before race adoption")
                  : null;
              },
              log,
            );
            raceDeliveryReceipt = applied;
            store.writeYaml(join(paths.finalDir, "delivery_receipt.yaml"), applied);
            finalVerify = applied.finalVerify;
            if (applied.applied) {
              adopted = true;
              applyState = "applied";
              log.emit("work_product.adopted", {
                applied: true,
                patch_sha256: patchSha256,
                winner: winnerRun.attemptId,
              });
              try {
                postTurnSha = await snapshotTree(execRoot);
              } catch {
                postTurnSha = null;
              }
              revertAnchorId = createRevertAnchorFromPatchOrNull(execRoot, winnerRun.diff);
            } else {
              adopted = false;
              applyState = "not_applied";
              deliveryFailureReason = applied.detail ?? "race adoption delivery was refused";
              facts = { ...facts, checks: "failed", reason: "checks_failed" };
              if (finalVerifyBlocks(finalVerify)) finalVerifyFailed = true;
              log.emit("work_product.adopted", {
                applied: false,
                patch_sha256: patchSha256,
                detail: redactSecrets(applied.detail ?? "apply failed"),
                tree_mutated: applied.treeMutated,
              });
            }
          }
        }
        writeRaceDeliveryDecision(store, decisionPath, {
          decision: result.decision,
          facts,
          reviewVerified: actualReviewVerified,
          finalVerify,
          deliveryFailureReason,
          deliveryReceiptPath: raceDeliveryReceipt ? "final/delivery_receipt.yaml" : null,
        });
        if (inPlaceWinner && requestedSingleCandidate && adopted === true) {
          revertAnchorId = await createRevertAnchorOrNull(execRoot, preTurnSha, postTurnSha);
        }
        store.writeYaml(join(paths.finalDir, "work_product.yaml"), {
          id: newId("wp"),
          kind: input.create === true ? "new_repo" : "patch",
          source_task_id: taskId,
          producer_attempt_id: winnerRun.attemptId,
          ...(raceDeliveryReceipt
            ? { files: { delivery_receipt: "final/delivery_receipt.yaml" } }
            : {}),
          meta: {
            harness_id: winnerRun.harnessId,
            synthesis: synth,
            mode,
            // Artifact-only apply reads the same terminal axes as the daemon (D8).
            lifecycle: facts.lifecycle,
            outcome_facts: facts,
            review_verified: actualReviewVerified,
            budget_stopped: budgetStopped,
            patch_sha256: patchSha256,
            result_kind: resultKind,
            diffstat: {
              files: wstats.paths.length,
              additions: wstats.additions,
              deletions: wstats.deletions,
            },
            blockers,
            adopted,
            apply_state: applyState,
            pre_turn_sha: preTurnSha,
            post_turn_sha: postTurnSha,
            revert_anchor_id: revertAnchorId,
          },
        });
      }
      store.writeText(
        join(paths.finalDir, "summary.md"),
        renderSummary(
          runId,
          mode,
          { ...result.decision, facts },
          evidences,
          synth.reason,
          actualReviewVerified,
        ),
      );
      // summary.md is a DIAGNOSTIC artifact only (V8/PLAN addendum 2): it no
      // longer carries primary-output authority. A clean applyable success or a
      // winner answer still marks it ready for legacy INV-116 ordering; any
      // other terminal is diagnostic context.
      log.emit("output.ready", {
        kind: "summary",
        path: "final/summary.md",
        state:
          (facts.lifecycle === "succeeded" &&
            facts.review === "approved" &&
            facts.checks !== "failed") ||
          winnerAnswer.length > 0
            ? "ready"
            : "diagnostic",
      });
    }

    this.writeRunTelemetry(
      store,
      paths,
      contract,
      runId,
      taskId,
      mode,
      candidateRoster(runs),
      result.decision.facts.lifecycle === "succeeded"
        ? result.decision.winner
        : (winnerRun?.attemptId ?? null),
    );

    // A needs-decision terminal (review blocked or checks failed) OR a
    // non-succeeded lifecycle writes a failure record and fires
    // run.blocked/run.failed; a succeeded, non-needs-decision terminal
    // (applyable, no_changes, or not-verified) is an honest completion.
    const needsDecisionTerminal = facts.review === "blocked" || facts.checks === "failed";
    const isFailureTerminal = facts.lifecycle !== "succeeded" || needsDecisionTerminal;
    if (deliveryFailureReason && !finalVerifyFailed) {
      writeFailure(store, paths, deliveryRefusalFailure(deliveryFailureReason, paths.root));
    } else if (finalVerifyFailed) {
      writeFailure(store, paths, {
        phase: "verification",
        // RunFailure.category is a closed enum; "validation" is the honest
        // bucket (the winner failed re-validation on a fresh base).
        category: "validation",
        safeMessage:
          finalVerify?.applied_cleanly === null
            ? `final verify ERRORED before proving the patch against a clean base: ${finalVerify?.reason ?? "verify infrastructure error"}`
            : `final verify failed: ${finalVerify?.reason ?? (finalVerify?.gates_passed === false ? "deterministic gates failed on the fresh verify tree" : "unknown")}`,
        runDir: paths.root,
        nextActions:
          finalVerify?.applied_cleanly === null
            ? [
                "Inspect arbitration/decision.yaml (final_verify) for the verifier error",
                "Fix the verify infrastructure (git worktree/tmp) and re-run, or accept_risk to override",
              ]
            : [
                "Inspect arbitration/decision.yaml (final_verify)",
                "Re-run after fixing the base conflict or the failing gates",
              ],
      });
    } else if (isFailureTerminal) {
      // QA-010c: a reviewer-accepted BLOCK/FIX_FIRST (or a failed deterministic
      // gate) that BLOCKS the run is an operator-decision terminal, not an
      // internal engine error. Only a genuinely unexpected non-decision terminal
      // stays `internal`. A review/checks block is `policy` (the acceptance
      // path), phase `review`, and its remedy names the decision, not "retry
      // with a different harness".
      const decisionBlock = needsHuman || needsDecisionTerminal;
      writeFailure(store, paths, {
        phase: decisionBlock ? "review" : "arbitration",
        category: decisionBlock
          ? "policy"
          : winnerRun?.errored
            ? "harness_error"
            : isBudgetTerminal(facts.reason)
              ? "budget"
              : "internal",
        harnessId: winnerRun?.errored ? winnerRun.harnessId : undefined,
        attemptId: winnerRun?.errored ? winnerRun.attemptId : undefined,
        safeMessage: needsHuman
          ? `review escalated to a human decision: ${result.decision.why_winner}`
          : needsDecisionTerminal
            ? `review blocked before apply: ${result.decision.why_winner}`
            : result.decision.why_winner,
        rawDetailRef: winnerRun?.errored
          ? `attempts/${winnerRun.attemptId}/attempt.yaml`
          : undefined,
        runDir: paths.root,
        nextActions: decisionBlock
          ? [
              "Review the blocking findings on the run's turn",
              "Accept the risk to apply this exact patch, or discard the change",
              ...(facts.checks === "failed"
                ? ["Configure/approve the deterministic test command, then re-run"]
                : []),
            ]
          : [
              "Open diagnostics",
              "Inspect candidate artifacts",
              "Retry with a narrower prompt or different harness pool",
            ],
      });
      if (!winnerRun) {
        store.writeText(
          join(paths.finalDir, "summary.md"),
          `# Run ${runId} (${mode})\n\n- Lifecycle: ${facts.lifecycle}${facts.reason ? ` (${facts.reason})` : ""}\n- Phase: arbitration\n\n${result.decision.why_winner}\n`,
        );
        log.emit("output.ready", {
          kind: "summary",
          path: "final/summary.md",
          state: "diagnostic",
        });
      }
    }

    if (mutatingRun && winnerRun) {
      log.emit("work_product.emitted", { winner: result.decision.winner });
    }
    if (!isFailureTerminal) {
      log.emit("run.completed", { lifecycle: facts.lifecycle, facts, reason: facts.reason });
    } else if (facts.lifecycle === "succeeded") {
      // needsDecision at terminal — the event's phase must agree with
      // failure.yaml (a verify block is phase "verification", not "review").
      log.emit("run.blocked", {
        lifecycle: facts.lifecycle,
        facts,
        phase:
          deliveryFailureReason && !finalVerifyFailed
            ? "delivery"
            : finalVerifyFailed
              ? "verification"
              : "review",
        failure_ref: "final/failure.yaml",
      });
    } else {
      log.emit("run.failed", {
        lifecycle: facts.lifecycle,
        facts,
        reason: facts.reason,
        phase: "arbitration",
        failure_ref: "final/failure.yaml",
      });
    }

    return {
      runId,
      taskId,
      mode,
      lifecycle: facts.lifecycle,
      facts,
      winner: result.decision.winner,
      runDir: paths.root,
      summary: result.decision.why_winner,
      candidates: runs.map((r) => ({
        attemptId: r.attemptId,
        harnessId: r.harnessId,
        status: gatesPassed(r.gates) && !r.errored ? "green" : "red",
      })),
      decisionPath,
      reviewVerified: actualReviewVerified,
      spendUsd: ledger.spend(),
    };
  }

  /** Single-owner telemetry artifact (final/telemetry.yaml); surfaces project it, never recompute. */
  private writeRunTelemetry(
    store: ArtifactStore,
    paths: ReturnType<ArtifactStore["runPaths"]>,
    contract: ActiveTaskContract,
    runId: string,
    taskId: string,
    mode: ModeKind,
    attempts: { attemptId: string; harnessId: string; telemetry: AttemptTelemetry }[],
    finalAttemptId: string | null,
    deepScanSynthesis?: DeepScanSynthesis | null,
  ): void {
    // QA-034: attach the routing rationale recorded at pool ordering (if this
    // run computed one), then clear it — telemetry is written once at terminal.
    const routingRationale = this.routingRationaleByRun.get(runId) ?? null;
    this.routingRationaleByRun.delete(runId);
    writeRunTelemetryArtifact({
      store,
      finalDir: paths.finalDir,
      contract,
      runId,
      taskId,
      mode,
      attempts,
      finalAttemptId,
      routingRationale,
      deepScanSynthesis: deepScanSynthesis ?? null,
      resolveAuthPreference: (harnessId) =>
        this.authPreferenceForHarness(contract.repo.root, harnessId, contract.auth_preference),
    });
  }

  /** Review a set of runs and return their evidence (with finalReviewClean + review_verified caveat). */

  /**
   * SINGLE funnel for every reviewer-panel invocation: run it inside a per-review
   * scoped harness HOME (Bible §6) so reviewer scratch state and injected auth
   * routes do not enter the project or ordinary operator HOME. Native
   * Codex/Claude routes deliberately keep their vendor-owned host-user stores;
   * no credential file is copied into the scoped home. Every call site MUST go
   * through here so the non-native scoping cannot drift. Disposed once the
   * panel settles (resolve OR reject).
   */
  private reviewScoped(
    input: Omit<Parameters<typeof reviewCandidate>[0], "env">,
  ): ReturnType<typeof reviewCandidate> {
    const reviewHome = new WorkspaceManager(input.cwd).readOnlyHomeEnv();
    return reviewCandidate({
      ...input,
      reviewerTimeoutMs: input.reviewerTimeoutMs ?? reviewerTimeoutMs(this.config(input.cwd)),
      transientRetryPolicy:
        input.transientRetryPolicy ?? transientRetryPolicy(this.config(input.cwd)),
      env: reviewHome.env,
    }).finally(() => reviewHome.dispose());
  }

  private async reviewRuns(
    runs: CandidateRun[],
    reviewers: ReviewerSpec[],
    reviewVerified: boolean,
    reviewDir: string,
    cwd: string,
    contract: ActiveTaskContract,
    store: ArtifactStore,
    paths: ReturnType<ArtifactStore["runPaths"]>,
    log: EventLog,
    ledger?: BudgetLedger,
    taskId?: string,
    signal?: AbortSignal,
    reservationEstimateUsd?: number,
  ): Promise<CandidateEvidence[]> {
    const evidences: CandidateEvidence[] = [];
    for (const run of runs) {
      const candidateCwd = run.reviewCwd ?? cwd;
      const candidateEvidenceDir = this.prepareReviewEvidenceDir(reviewDir, candidateCwd);
      try {
        writeText(
          join(candidateEvidenceDir, "TESTS.txt"),
          renderTestsEvidence(contract, run.gates).trim() + "\n",
        );
        // a candidate that changed NO files has nothing to review — never
        // spend a reviewer panel on "(empty diff)" (a trivial greeting in agent mode used to
        // cost two reviewers). It still flows through policy gates and arbitration
        // (so a failing test gate or no_op outcome is unchanged), just unreviewed.
        const hasDiff = run.diff.trim().length > 0;
        // Reviewer panels spend real money: reserve before, settle the observed cost.
        const reviewLease =
          hasDiff && reviewers.length > 0
            ? ledger?.reserve({
                taskId: taskId ?? "task",
                attemptId: run.attemptId,
                intent: "review",
                harnessId: "review-panel",
                cost: attemptCostEvidence("review-panel", run.attemptId, reservationEstimateUsd),
              })
            : undefined;
        const result =
          hasDiff && reviewers.length > 0 && (reviewLease?.granted ?? true)
            ? await this.reviewScoped({
                candidateLabel: run.label,
                diff: run.diff,
                evidenceDir: candidateEvidenceDir,
                artifactsDir: join(paths.reviewsDir, `${run.attemptId}-reviewers`),
                cwd: candidateCwd,
                reviewers,
                reviewerTimeoutMs: reviewerTimeoutMs(this.config(contract.repo.root)),
                envInheritance: envInheritance(this.config(cwd)),
                signal,
                onReviewerEvent: (event) => log.emit(event.type, { ...event }),
              })
            : {
                findings: [],
                routeProofs: [],
                reviewerRequests: [],
                crossFamilyHealthy: false,
                healthyProviders: [],
                crossFamilyVerified: false,
                distinctProviders: [],
                reviewSpendUsd: 0,
                reviewSpendEstimated: false,
                reviewCashUsd: 0,
                reviewCashKnowledge: "unknown" as const,
                reviewValuationUsd: 0,
                reviewValuationKnowledge: "unknown" as const,
                reviewUnknownUsd: 0,
              };
        if (reviewLease?.granted) {
          ledger?.settle(
            reviewLease.lease?.lease_id ?? "",
            reviewUsageCostSettlement(
              result.reviewCashUsd,
              result.reviewValuationUsd,
              {
                cash: result.reviewCashKnowledge,
                valuation: result.reviewValuationKnowledge,
              },
              [`attempt:${run.attemptId}`, "review:panel"],
              result.reviewUnknownUsd,
            ),
          );
          if ((result.reviewSpendUsd ?? 0) > 0) {
            log.emit("budget.observation", {
              harness_id: "review-panel",
              attempt_id: run.attemptId,
              kind: "spend",
              usd: result.reviewSpendUsd,
              cash_usd: result.reviewCashUsd,
              valuation_usd: result.reviewValuationUsd,
              unknown_usd: result.reviewUnknownUsd,
              estimated: result.reviewSpendEstimated === true,
            });
          }
        } else if (reviewLease && !reviewLease.granted) {
          log.emit("budget.lease.created", {
            granted: false,
            reason: reviewLease.reason,
            attempt_id: run.attemptId,
            harness_id: "review-panel",
          });
        }
        const revalidated = await revalidateFindings(result.findings, {
          candidateRoot: candidateCwd,
          evidenceDir: candidateEvidenceDir,
        });
        // The high-risk human gate must key off the ACTUAL cross-family verification
        // (stream-observed route proofs), not the preliminary routeVerified (families
        // merely configured). Otherwise a high-risk diff skips its NEEDS_HUMAN gate
        // when two families were configured but their route proofs went unverified.
        // Mirrors the convergence path (actualReviewVerified).
        const candidateReviewVerified =
          reviewVerified && result.crossFamilyHealthy && result.crossFamilyVerified;
        // Typed policy gate (risk + protected paths) merges with reviewer findings.
        const policy = policyFindings(
          run,
          candidateReviewVerified,
          contract.constraints.protected_paths,
          contract.constraints.auto_protected_paths,
          contract.constraints.protected_path_approvals,
          contract.constraints.deny_paths,
        );
        const allFindings = [...policy.findings, ...revalidated];
        const inconclusive = allFindings.some(
          (f) => f.severity === "INSUFFICIENT_EVIDENCE" || f.status === "insufficient_evidence",
        );
        const noBlockers = !allFindings.some((f) => isBlocking(f));
        const reviewClean =
          result.crossFamilyHealthy && result.crossFamilyVerified && noBlockers && !inconclusive;
        store.writeYaml(join(paths.reviewsDir, `${run.attemptId}.yaml`), {
          attempt_id: run.attemptId,
          review_verified: candidateReviewVerified,
          final_review_clean: reviewClean,
          cross_family_healthy: result.crossFamilyHealthy,
          cross_family_verified: result.crossFamilyVerified,
          healthy_providers: result.healthyProviders,
          verified_providers: result.distinctProviders,
          reviewer_requests: result.reviewerRequests,
          risk: policy.risk,
          findings: allFindings,
          route_proofs: result.routeProofs,
        });
        for (const f of allFindings)
          log.emit("finding.revalidated", {
            attempt_id: run.attemptId,
            severity: f.severity,
            status: f.status,
          });
        evidences.push(
          toCandidateEvidence(run, contract, allFindings, reviewClean, candidateReviewVerified),
        );
      } finally {
        this.recordReviewEvidenceCleanup(
          store,
          join(paths.reviewsDir, `${run.attemptId}-evidence-cleanup.yaml`),
          run.attemptId,
          candidateEvidenceDir,
          candidateCwd,
        );
      }
    }
    return evidences;
  }

  private prepareReviewEvidenceDir(sourceDir: string, _candidateCwd: string): string {
    // Evidence is an external runtime artifact. ReviewEngine builds a separate
    // reviewer workspace and copies the packet there; writing/copying it into
    // the candidate tree would contaminate the Git diff and, worse, overwrite a
    // user-owned path with the same name.
    if (!existsSync(sourceDir)) {
      throw new Error(`review evidence preflight failed for ${sourceDir}: source packet missing`);
    }
    return this.requireReviewEvidence(sourceDir);
  }

  private requireReviewEvidence(dir: string): string {
    const result = preflightEvidence(dir);
    if (result.ok) return dir;
    const missing = result.missing.length ? `missing=${result.missing.join(",")}` : "";
    const empty = result.empty.length ? `empty=${result.empty.join(",")}` : "";
    throw new Error(
      `review evidence preflight failed for ${dir}: ${[missing, empty].filter(Boolean).join(" ")}`,
    );
  }

  private cleanupReviewEvidenceDir(
    _candidateEvidenceDir: string,
    _candidateCwd: string,
  ): Record<string, string> | null {
    // No candidate-tree packet exists in v2; external runtime retention is
    // governed by the artifact/journal lifecycle rather than best-effort rm.
    return null;
  }

  private recordReviewEvidenceCleanup(
    store: ArtifactStore,
    metadataPath: string,
    attemptId: string,
    candidateEvidenceDir: string,
    candidateCwd: string,
  ): void {
    const cleanupMetadata = this.cleanupReviewEvidenceDir(candidateEvidenceDir, candidateCwd);
    if (!cleanupMetadata) return;
    try {
      store.writeYaml(metadataPath, {
        ...cleanupMetadata,
        attempt_id: attemptId,
      });
    } catch {
      // Cleanup telemetry must not mask the review/revalidation failure that
      // triggered best-effort cleanup.
    }
  }

  private async runConvergence(
    input: RunInput,
    mode: ModeKind,
    maxAttempts: number | null,
    announce: (a: AnnouncedRunContext) => void,
  ): Promise<OrchestratorResult> {
    const taskId = input.taskId ?? newId("task");
    const runId = input.runId ?? newId("run");
    // Contract validation BEFORE the run is announced (see runRace).
    const contract = this.buildContract(input, taskId, mode);
    const planBrief = verifiedPlanBrief(input);
    const quotaSnapshots = this.quotaSnapshotPreflight();
    const { store, paths, log, ledger } = beginAnnouncedRun(
      {
        input,
        contract,
        quotaSnapshots,
        store: this.artifactStore(input),
        authority: this.deps.delegationBudgetAuthority,
        runId,
        taskId,
        mode,
        phase: "convergence",
        prompt: input.prompt,
      },
      announce,
    );
    input = withPlanBrief(input, store, paths, log, planBrief);
    // The execution root is the tree the harness mutates (thread worktree for an
    // isolated thread, else the project). The WorkspaceManager AND the git
    // boundary must resolve against the SAME root — the race path does so via the
    // local `execRoot`; this path previously ensured the boundary on repoRoot,
    // which for an isolated thread is the project, not the mutated worktree.
    const execRoot = this.execRootOf(input);
    const wsm = new WorkspaceManager(execRoot);
    const readiness = new ReadinessLedger();
    store.writeYaml(join(paths.contextDir, "task.yaml"), contract);

    // Live (in-place) isolation deliberately tolerates non-git stateful
    // environments; only envelope isolation needs the git boundary.
    if (!input.inPlace) {
      const gitPreconditionError = await ensureWriteModeGitBoundary(
        execRoot,
        log,
        store,
        paths,
        runId,
        mode,
      );
      if (gitPreconditionError) {
        return {
          spendUsd: ledger.spend(),
          runId,
          taskId,
          mode,
          lifecycle: "failed",
          facts: makeOutcomeFacts("failed", { reason: gitPreconditionError.reason }),
          winner: null,
          runDir: paths.root,
          summary: gitPreconditionError.message,
          candidates: [],
        };
      }
      // Same run-prep stage as the git boundary (and the same `!inPlace`
      // exclusion — we are inside that branch, so inPlace is false here): bridge
      // an AGENTS.md-only PROJECT root so a Claude Code convergence attempt reads
      // it (INV-113).
      this.ensureClaudeBridgeForRun(input.repoRoot, false, log);
    }

    const reviewDir = join(paths.root, "review-evidence");
    writeEvidencePacket(reviewDir, {
      userIntent: redactSecrets(input.prompt),
      diff: "(per-attempt)\n",
      tests: renderTestsEvidence(contract),
    });
    const reviewersOutcome = await this.resolveReviewersWithArtifacts(
      input,
      log,
      store,
      paths,
      runId,
      taskId,
      mode,
    );
    if ("failed" in reviewersOutcome) return reviewersOutcome.failed;
    const reviewers = reviewersOutcome.reviewers;
    const reviewVerified = this.routeVerified(reviewers);

    // One envelope carried forward across attempts so the harness can repair its own work.
    let adapterPool: RoutedAdapter[];
    try {
      adapterPool = await this.resolveCandidateAdapters(
        { ...input, n: undefined },
        this.candidateIntent(input),
        ledger,
        log,
        undefined,
        runId,
      );
      this.requestRequirements.assertConvergenceWorkspace(input.inPlace === true, adapterPool);
    } catch (err) {
      const message = safeErrorMessage(err);
      writeRoutingFailureTerminal(store, paths, log, {
        runId,
        modeLabel: mode,
        message,
        err,
      });
      return {
        spendUsd: ledger.spend(),
        runId,
        taskId,
        mode,
        lifecycle: "failed",
        facts: makeOutcomeFacts("failed", { reason: "harness_failed" }),
        winner: null,
        runDir: paths.root,
        summary: message,
        candidates: [],
      };
    }
    activateDelegationParent(
      this.deps.delegationBudgetAuthority,
      input,
      runId,
      ledger,
      adapterPool,
      log,
    );
    // Fail fast on a provably unwinnable predicate instead of burning paid
    // rounds: the default convergence predicate requires a clean cross-family
    // review, which needs >=2 healthy reviewer provider families.
    if (contract.convergence.require_final_cross_family_clean_review && !reviewVerified) {
      const message =
        `convergence requires a cross-family clean review (>=2 healthy reviewer provider families); found ${new Set(reviewers.map((r) => r.providerFamily)).size}. ` +
        "Configure reviewers from a second provider family and check `claudexor doctor` for reviewer readiness.";
      store.writeText(
        join(paths.contextDir, "context_error.md"),
        `# Convergence Preflight Error\n\n${message}\n`,
      );
      writeFailure(store, paths, {
        phase: "review",
        category: "policy",
        safeMessage: message,
        runDir: paths.root,
        nextActions: [
          "Configure a second reviewer family",
          "Check harness doctor for reviewer readiness",
        ],
      });
      store.writeText(
        join(paths.finalDir, "summary.md"),
        `# Run ${runId} (${mode})\n\n- Lifecycle: failed\n- Phase: review preflight\n\n${message}\n`,
      );
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      log.emit("run.failed", {
        lifecycle: "failed",
        facts: makeOutcomeFacts("failed", { reason: "harness_failed" }),
        reason: "harness_failed",
        phase: "review",
        error: message,
        failure_ref: "final/failure.yaml",
      });
      return {
        spendUsd: ledger.spend(),
        runId,
        taskId,
        mode,
        lifecycle: "failed",
        facts: makeOutcomeFacts("failed", { reason: "harness_failed" }),
        winner: null,
        runDir: paths.root,
        summary: message,
        candidates: [],
      };
    }
    let adapterIdx = 0;
    let routed = adapterPool[0] as RoutedAdapter;
    let adapter = routed.adapter;
    let envelope: WorkspaceEnvelope | undefined;

    let attempt = 0;
    let converged = false;
    let exhausted = false;
    let interrupted = false; // D-16 r8: terminalizes the run interrupted

    let lastFindings: ReviewFinding[] = [];
    let lastRun: CandidateRun | null = null;
    let actualReviewVerified = false;
    let lastFinalReviewClean = false;
    // Honest apply-state for in-place convergence: the attempts mutate the LIVE
    // tree directly, so record the revert fence (pre-turn snapshot) and the
    // post-mutation snapshot of the last attempt (captured before its review, so
    // user edits during review are not folded into the revert target — see runRace).
    let preTurnSha: string | null = null;
    let lastPostTurnSha: string | null = null;
    let triedSinceProgress = new Set<string>();
    let lastSig = "";
    let lastFailingGateDiffHash = "";
    let sameFailingGateDiffs = 0;
    let stuckNoProgress = false;
    let stuckNoProgressReason: string | null = null;
    // until_clean has NO fixed attempt cap; it stops on convergence, budget hard tier,
    // observed quota cooldown across all harnesses, or genuine no-progress (a stall on the same
    // failure signature after every available harness has tried it).
    const stallThreshold = input.untilClean === true ? 4 : 2;
    const convergenceQuotaLedger = this.quotaLedgerView(ledger, adapterPool);
    const allCooledDown = () =>
      adapterPool.every((a) => convergenceQuotaLedger.cooldownActive(a.adapter.id));
    const attemptTelemetries: {
      attemptId: string;
      harnessId: string;
      telemetry: AttemptTelemetry;
    }[] = [];
    let lastDiffStable = true;

    try {
      // The contract's ENGINE-COMPUTED effective profile drives the envelope and
      // every attempt spec (parity with runRace); telemetry must never claim an
      // access level the envelope did not actually run with.
      const convergenceAccess = contract.access.effective_profile;
      if (input.inPlace === true) {
        try {
          preTurnSha = await snapshotTree(execRoot);
        } catch {
          preTurnSha = null;
        }
      }
      envelope = await wsm.create({
        taskId,
        attemptId: "converge",
        baseRef: contract.repo.base_ref,
        dirtyPolicy: "snapshot",
        inPlace: input.inPlace ?? false,
        accessProfile: convergenceAccess,
      });
      for (;;) {
        if (input.signal?.aborted) break;
        attempt += 1;
        const attemptId = `a${String(attempt).padStart(2, "0")}`;

        // Repair prompts must include the RUNTIME errors that actually failed the
        // previous attempt (harness stream errors / unsatisfied web evidence),
        // not only the review findings — otherwise the harness repairs blind.
        const runtimeErrors = lastRun?.errors?.length
          ? `\n\nRuntime errors from the previous attempt (fix or recover these):\n${lastRun.errors.map((e) => `- ${e}`).join("\n")}`
          : "";
        const prompt =
          attempt === 1
            ? input.prompt
            : buildRevisePrompt(input.prompt, lastFindings, runtimeErrors);

        // Loop detection (budget router): the 3rd identical repair prompt means
        // findings/errors are not changing — stop burning paid attempts.
        const fingerprint = promptFingerprint(prompt);
        ledger.recordPrompt(fingerprint);
        if (ledger.isLoop(fingerprint)) {
          log.emit("budget.observation", {
            harness_id: adapter.id,
            attempt_id: attemptId,
            kind: "loop_detected",
            fingerprint,
          });
          exhausted = true;
          break;
        }

        const lease = ledger.reserve({
          taskId,
          attemptId,
          intent: "repair",
          harnessId: adapter.id,
          cost: attemptCostEvidence(
            adapter.id,
            attemptId,
            this.reservationEstimateUsd(input),
            this.routeBillingKnowledge(input, adapter.id),
          ),
        });
        if (!lease.granted) {
          exhausted = true;
          break;
        }

        const knobs = this.routeSpecKnobs(routed, contract, undefined, input.effort);
        const effectiveWeb = this.discloseWebUpgrade(log, routed, knobs.webPolicy, attemptId);
        let run: CandidateRun;
        let harnessHome: ScopedHarnessHome | undefined;
        try {
          harnessHome = this.harnessHomeFor(wsm, envelope, routed, input);
          log.emit("harness.started", {
            harness_id: adapter.id,
            attempt_id: attemptId,
            external_context_policy: knobs.webPolicy,
            ...(knobs.ignored.length > 0 ? { ignored_settings: knobs.ignored } : {}),
          });
          run = await this.runCandidateInEnvelope(
            routed,
            envelope,
            attemptId,
            `Attempt ${attempt}`,
            contract,
            prompt,
            store,
            paths,
            wsm,
            ledger,
            convergenceAccess,
            (ev) => {
              const safeEv = redactHarnessEvent(ev);
              safeInvoke(input.onHarnessEvent, safeEv);
              log.emit("harness.event", harnessEventPayload(adapter.id, attemptId, safeEv));
            },
            input.signal,
            undefined,
            input.effort,
            "repair",
            log,
            effectiveWeb,
            this.interactionChannelFor(
              input,
              log,
              runId,
              taskId,
              attemptId,
              adapter.id,
              routed.supportsInteractive,
            ),
            (streamedUsd) => {
              ledger.updateHold(lease.lease?.lease_id ?? "", streamedUsd);
              return ledger.tier() === "hard";
            },
            input,
            true, // convergence runs one candidate: live deltas on (W-C4)
            undefined,
            undefined,
            harnessHome,
          );
          ledger.settle(
            lease.lease?.lease_id ?? "",
            attemptUsageCostSettlement(
              run.cost,
              run.costEstimated,
              run.attemptId,
              run.harnessId,
              run.telemetry.authMode,
              run.telemetry.usageCost,
            ),
          );
          log.emit("harness.completed", {
            harness_id: adapter.id,
            attempt_id: attemptId,
            // QA-027: an aborted attempt is `cancelled`, never a clean `success`.
            status: input.signal?.aborted ? "cancelled" : run.errored ? "failed" : "success",
            cost_usd: run.cost,
            ...telemetrySummary(run.telemetry),
          });
        } catch (err) {
          // Setup failures remain unknown; post-stream persistence failures
          // carry their route-specific settlement from runCandidateInEnvelope.
          const failureCost = AC.attemptFailureCost(err, "attempt-error");
          const message = safeErrorMessage(err);
          // A5: keep a TYPED refusal alive past this catch (race-lane parity).
          const declared = declaredFailure(err);
          ledger.settle(lease.lease?.lease_id ?? "", failureCost.settlement);
          log.emit("harness.completed", {
            harness_id: adapter.id,
            attempt_id: attemptId,
            status: "failed",
            error: message,
          });
          store.writeYaml(
            join(paths.attemptsDir, attemptId, "attempt.yaml"),
            AC.attemptFailureRecord(
              attemptId,
              adapter.id,
              failureCost,
              "harness",
              message,
              appliedAttemptFacts(
                harnessHome,
                routed.adapterAccess,
                this.credentials.effectiveProfileId(input, adapter.id),
              ),
            ),
          );
          run = {
            applied: appliedAttemptFacts(
              harnessHome,
              routed.adapterAccess,
              this.credentials.effectiveProfileId(input, adapter.id),
            ),
            attemptId,
            harnessId: adapter.id,
            label: `Attempt ${attempt}`,
            diff: "",
            gates: [],
            cost: failureCost.totalUsd,
            errored: true,
            costEstimated: failureCost.estimated,
            errors: [message],
            ...(declared.code ? { declaredFailure: declared } : {}),
            telemetry: createAttemptTelemetry(
              knobs.webPolicy,
              contract.external_context.web_required,
              effectiveWeb,
              [routed.browserRequirement, routed.denyRequirement, routed.delegationRequirement],
              knobs.model,
            ),
          };
        }
        lastRun = run;
        // Fail-closed twin of the candidate lane's gate: this loop terminalizes
        // per attempt, so the proof is spent per attempt.
        assertDelegatedEvidence(input.delegated === true, convergenceAccess, [run]);
        attemptTelemetries.push({ attemptId, harnessId: adapter.id, telemetry: run.telemetry });
        // Cancellation/deadline keeps priority over a belt failure finalized concurrently.
        if (input.signal?.aborted) break;
        if (delegateFailure.candidateFailureKind(run)) {
          const failure = delegateFailure.candidateFailureTerminal(run, "convergence");
          await delegateFailure.persistFailedInPlaceWorkProduct({
            ...{ store, log, paths, execRoot, preTurnSha, taskId, mode },
            live: input.inPlace === true,
            run,
            kind: input.create === true ? "new_repo" : "patch",
            attempts: attempt,
          });
          this.writeRunTelemetry(
            store,
            paths,
            contract,
            runId,
            taskId,
            mode,
            attemptTelemetries,
            null,
          );
          return failTerminally(
            log,
            store,
            paths,
            runId,
            taskId,
            mode,
            failure.phase,
            failure.error,
            ledger.spend(),
            failure.metadata,
          );
        }
        // D-16 r8: interrupted (errored===false) would CONVERGE a partial diff
        // as clean — break BEFORE review; a harness error still gate-retries.
        if (run.outcomeClass === "interrupted") {
          interrupted = true;
          break;
        }
        // Post-mutation fence for in-place: snapshot the live tree NOW (after the
        // harness mutated it, before this attempt's review). The last attempt's
        // value is the revert target persisted into work_product.yaml.
        if (input.inPlace === true) {
          try {
            lastPostTurnSha = await snapshotTree(execRoot);
          } catch {
            lastPostTurnSha = null;
          }
        }

        // The review round is wrapped so a preflight/revalidation throw ends the
        // run TERMINALLY with artifacts instead of orphaning the run dir.
        let conv: ReturnType<typeof evaluateConvergence>;
        try {
          conv = await (async () => {
            const candidateReviewCwd = run.reviewCwd ?? input.repoRoot;
            const candidateReviewEvidenceDir = this.prepareReviewEvidenceDir(
              reviewDir,
              candidateReviewCwd,
            );
            try {
              writeText(
                join(candidateReviewEvidenceDir, "TESTS.txt"),
                renderTestsEvidence(contract, run.gates).trim() + "\n",
              );
              // Reviewer panels spend real money in convergence too: reserve before,
              // settle the observed cost, and surface it as a budget observation
              // (parity with the race path's reviewRuns metering).
              const reviewLease =
                reviewers.length > 0
                  ? ledger.reserve({
                      taskId,
                      attemptId,
                      intent: "review",
                      harnessId: "review-panel",
                      cost: attemptCostEvidence(
                        "review-panel",
                        attemptId,
                        this.reservationEstimateUsd(input),
                      ),
                    })
                  : null;
              const reviewResult =
                reviewers.length > 0 && (reviewLease?.granted ?? false)
                  ? await this.reviewScoped({
                      candidateLabel: `Attempt ${attempt}`,
                      diff: run.diff,
                      evidenceDir: candidateReviewEvidenceDir,
                      artifactsDir: join(paths.reviewsDir, `${attemptId}-reviewers`),
                      cwd: candidateReviewCwd,
                      reviewers,
                      envInheritance: envInheritance(this.config(input.repoRoot)),
                      signal: input.signal,
                      onReviewerEvent: (event) => log.emit(event.type, { ...event }),
                    })
                  : {
                      findings: [],
                      routeProofs: [],
                      reviewerRequests: [],
                      crossFamilyHealthy: false,
                      healthyProviders: [],
                      crossFamilyVerified: false,
                      distinctProviders: [],
                      reviewSpendUsd: 0,
                      reviewSpendEstimated: false,
                      reviewCashUsd: 0,
                      reviewCashKnowledge: "unknown" as const,
                      reviewValuationUsd: 0,
                      reviewValuationKnowledge: "unknown" as const,
                      reviewUnknownUsd: 0,
                    };
              if (reviewLease?.granted) {
                ledger.settle(
                  reviewLease.lease?.lease_id ?? "",
                  reviewUsageCostSettlement(
                    reviewResult.reviewCashUsd,
                    reviewResult.reviewValuationUsd,
                    {
                      cash: reviewResult.reviewCashKnowledge,
                      valuation: reviewResult.reviewValuationKnowledge,
                    },
                    [`attempt:${attemptId}`, "review:panel"],
                    reviewResult.reviewUnknownUsd,
                  ),
                );
                if ((reviewResult.reviewSpendUsd ?? 0) > 0) {
                  log.emit("budget.observation", {
                    harness_id: "review-panel",
                    attempt_id: attemptId,
                    kind: "spend",
                    usd: reviewResult.reviewSpendUsd,
                    cash_usd: reviewResult.reviewCashUsd,
                    valuation_usd: reviewResult.reviewValuationUsd,
                    unknown_usd: reviewResult.reviewUnknownUsd,
                    estimated: reviewResult.reviewSpendEstimated === true,
                  });
                }
              } else if (reviewLease && !reviewLease.granted) {
                log.emit("budget.lease.created", {
                  granted: false,
                  reason: reviewLease.reason,
                  attempt_id: attemptId,
                  harness_id: "review-panel",
                });
              }
              actualReviewVerified =
                reviewVerified &&
                reviewResult.crossFamilyHealthy &&
                reviewResult.crossFamilyVerified;
              const revalidated = await revalidateFindings(reviewResult.findings, {
                candidateRoot: candidateReviewCwd,
                evidenceDir: candidateReviewEvidenceDir,
              });
              // Typed policy gate (risk + protected paths) merges with reviewer findings.
              const policy = policyFindings(
                run,
                actualReviewVerified,
                contract.constraints.protected_paths,
                contract.constraints.auto_protected_paths,
                contract.constraints.protected_path_approvals,
                contract.constraints.deny_paths,
              );
              const allFindings = [...policy.findings, ...revalidated];
              lastFindings = allFindings;
              const inconclusive = allFindings.some(
                (f) =>
                  f.severity === "INSUFFICIENT_EVIDENCE" || f.status === "insufficient_evidence",
              );
              const finalReviewClean =
                reviewResult.crossFamilyHealthy &&
                reviewResult.crossFamilyVerified &&
                !inconclusive &&
                !allFindings.some((f) => isBlocking(f));
              store.writeYaml(join(paths.reviewsDir, `${attemptId}.yaml`), {
                attempt_id: attemptId,
                review_verified: actualReviewVerified,
                final_review_clean: finalReviewClean,
                cross_family_healthy: reviewResult.crossFamilyHealthy,
                cross_family_verified: reviewResult.crossFamilyVerified,
                healthy_providers: reviewResult.healthyProviders,
                verified_providers: reviewResult.distinctProviders,
                reviewer_requests: reviewResult.reviewerRequests,
                risk: policy.risk,
                findings: allFindings,
                route_proofs: reviewResult.routeProofs,
              });
              lastFinalReviewClean = finalReviewClean;

              // Measure diff stability instead of asserting it: the tree must not have
              // changed between the candidate diff capture and the end of review.
              const postReviewDiff = await wsm.diff(envelope);
              const diffStableAfterReview = sha256(postReviewDiff) === sha256(run.diff);
              lastDiffStable = diffStableAfterReview;

              const evaluated = evaluateConvergence({
                predicate: contract.convergence,
                gates: run.errored
                  ? [
                      ...run.gates,
                      {
                        id: "harness",
                        command: "harness",
                        exit_code: 1,
                        status: "failed",
                        duration_ms: 0,
                        required: true,
                        stdout_tail: null,
                        stderr_tail: null,
                        output_truncated: false,
                      },
                    ]
                  : run.gates,
                findings: allFindings,
                finalReviewClean,
                diffStableAfterReview,
              });
              log.emit("finding.revalidated", {
                attempt_id: attemptId,
                converged: evaluated.converged,
                reasons: evaluated.reasons,
                diff_stable_after_review: diffStableAfterReview,
              });
              return evaluated;
            } finally {
              this.recordReviewEvidenceCleanup(
                store,
                join(paths.reviewsDir, `${attemptId}-evidence-cleanup.yaml`),
                attemptId,
                candidateReviewEvidenceDir,
                candidateReviewCwd,
              );
            }
          })();
        } catch (err) {
          return failTerminally(
            log,
            store,
            paths,
            runId,
            taskId,
            mode,
            "review",
            err,
            ledger.spend(),
          );
        }

        if (conv.converged) {
          converged = true;
          break;
        }

        const requiredGateFailing = run.gates.length > 0 && !gatesPassed(run.gates);
        const diffHash = sha256(run.diff);
        if (requiredGateFailing && diffHash === lastFailingGateDiffHash) {
          sameFailingGateDiffs += 1;
        } else {
          sameFailingGateDiffs = requiredGateFailing ? 1 : 0;
          lastFailingGateDiffHash = requiredGateFailing ? diffHash : "";
        }
        if (sameFailingGateDiffs >= 2) {
          stuckNoProgress = true;
          const failedGateIds = run.gates
            .filter((g) => g.required && g.status !== "passed")
            .map((g) => g.id);
          stuckNoProgressReason = `same candidate diff (${diffHash}) produced ${sameFailingGateDiffs} consecutive failing required gate round(s): ${failedGateIds.join(", ") || "unknown gate"}`;
          log.emit("finding.revalidated", {
            attempt_id: attemptId,
            stuck_no_progress: true,
            diff_sha256: diffHash,
            failed_gates: failedGateIds,
          });
          break;
        }

        const sig = failureSignature(conv.reasons);
        readiness.recordRound(sig, conv.reasons.join("; "));
        if (sig !== lastSig) {
          triedSinceProgress = new Set();
          lastSig = sig;
        }
        triedSinceProgress.add(adapter.id);

        if (ledger.tier() === "hard") {
          exhausted = true;
          break;
        }
        if (allCooledDown()) {
          exhausted = true; // quota exhausted across all harnesses
          break;
        }
        // until_clean honors a user-configured per-harness round cap; an explicit
        // --attempts cap (max_attempts mode) always wins when set.
        const roundCap = maxAttempts ?? routed.settings?.maxRounds ?? null;
        if (roundCap !== null && attempt >= roundCap) break;
        if (readiness.isStalled(sig, stallThreshold)) {
          if (adapterPool.length > 1 && triedSinceProgress.size < adapterPool.length) {
            // Quota-headroom consumer (mid-run, where quota observations EXIST);
            // pick + honest route event owned by runSupport.rotateOnStall.
            adapterIdx = rotateOnStall(
              adapterPool.map((a) => a.adapter.id),
              adapterIdx,
              convergenceQuotaLedger,
              triedSinceProgress,
              log,
              lastRun?.harnessId ?? null,
            );
            routed = adapterPool[adapterIdx] as RoutedAdapter;
            adapter = routed.adapter;
          } else {
            break; // tried every available harness on this failure and still stuck -> stop
          }
        }
      }
    } finally {
      if (envelope) await wsm.dispose(envelope);
    }

    // Base terminal AXES (D8) from the convergence loop outcome. Attempts-cap
    // exhaustion maps to budget_exhausted (an attempt budget); the give-up
    // states map to their matching RunReason.
    //
    // QA-041 terminal-causality precedence: convergence used to hard-code EVERY
    // aborted signal to `user_cancelled`, which (a) fabricated an operator action
    // that never happened when the maxSeconds wall-clock deadline fired, and
    // (b) discarded an already-proven `stuck_no_progress` terminal. The typed
    // abort reason (`wall_clock_exceeded` from the deadline controller, carried
    // on `input.signal.reason` via AbortSignal.any) is now read at the source,
    // and an established semantic terminal (stuck_no_progress) wins over the
    // abort so the deadline that only ended a redundant post-proof panel does
    // not overwrite the actionable no-progress reason. `user_cancelled` is
    // emitted ONLY for a real control cancel (no typed deadline reason).
    const convAbortReason =
      typeof input.signal?.reason === "string" && input.signal.reason
        ? input.signal.reason
        : undefined;
    const convCancelFacts = () =>
      makeOutcomeFacts("cancelled", {
        reason:
          convAbortReason === "wall_clock_exceeded" ? "wall_clock_exceeded" : "user_cancelled",
      });
    let facts = convergenceOutcomeFacts(
      {
        converged,
        interrupted,
        stuckNoProgress,
        aborted: Boolean(input.signal?.aborted),
        exhausted,
      },
      convCancelFacts,
    );
    let decision: ReturnType<typeof arbitrate>["decision"] | null = null;
    // D-16 r8: interrupted is never arbitrated; the partial stays diagnostic.
    if (lastRun && !interrupted) {
      const arb = arbitrate(
        [
          toCandidateEvidence(
            lastRun,
            contract,
            lastFindings,
            lastFinalReviewClean,
            actualReviewVerified,
          ),
        ],
        arbitrationBudgetOptions(ledger),
      );
      decision = arb.decision;
      store.writeYaml(join(paths.arbitrationDir, "decision.yaml"), decision);
      // A converged run adopts the arbitration axes (checks/review); an
      // otherwise not-converged loop that nonetheless produced an applyable
      // decision adopts it too.
      if (converged) {
        facts = decision.facts;
      } else if (facts.reason === "not_converged" && decision.facts.lifecycle === "succeeded") {
        facts = decision.facts;
      }
    }
    // A budget terminal turns a succeeded lifecycle into a failed one (D8).
    const convBudgetTerminal = ledger.terminal();
    if (facts.lifecycle === "succeeded" && convBudgetTerminal) {
      facts = makeOutcomeFacts("failed", {
        reason: convBudgetTerminal,
        noChanges: facts.noChanges,
      });
    }
    // A reviewer escalation to a human forces the REVIEW axis to blocked.
    const needsHuman = lastFindings.some((f) => f.severity === "NEEDS_HUMAN" && isBlocking(f));
    if (needsHuman && facts.lifecycle === "succeeded" && facts.review !== "blocked") {
      facts = { ...facts, review: "blocked", reason: facts.reason ?? "review_blocked" };
    }
    // FinalVerifier (INV-115) applies to EVERY applyable envelope-mode patch,
    // not only race winners: a convergence run's delivered patch must also
    // survive a fresh tree at its own base + the deterministic gates there.
    // In-place convergence is exempt for the same reason as in-place turns
    // (the diff was produced against the LIVE tree; a bare snapshot worktree
    // lacks gitignored deps and would false-block green runs).
    let convFinalVerify: FinalVerifyRecord | null = null;
    if (
      input.inPlace !== true &&
      lastRun &&
      lastRun.diff.trim().length > 0 &&
      facts.lifecycle === "succeeded" &&
      facts.review !== "blocked" &&
      !input.signal?.aborted
    ) {
      convFinalVerify = await finalVerifyPatch(
        execRoot,
        lastRun,
        gateSpecsFromContract(contract),
        log,
      );
      if (finalVerifyBlocks(convFinalVerify))
        facts = { ...facts, checks: "failed", reason: "checks_failed" };
    }
    const convNeedsDecision = facts.review === "blocked" || facts.checks === "failed";
    if (decision) {
      // Shared honesty owner (same as the race path): a needs-decision terminal
      // overrides the persisted decision; final_verify is recorded either way.
      decision = {
        ...decision,
        ...(convNeedsDecision
          ? blockedDecisionOverride(decision.evidence_facts, facts, convFinalVerify)
          : { facts }),
        final_verify: convFinalVerify,
      };
      store.writeYaml(join(paths.arbitrationDir, "decision.yaml"), decision);
    }
    this.writeRunTelemetry(
      store,
      paths,
      contract,
      runId,
      taskId,
      mode,
      attemptTelemetries,
      lastRun?.attemptId ?? null,
    );

    // Deliver the converged/last work to final/ so `apply` and `inspect` can
    // use it. D-16 r8: an INTERRUPTED envelope run delivers no applyable
    // work_product (its partial patch.diff stays diagnostic via attempts/);
    // in-place keeps the product so the honest Revert offer survives.
    if (lastRun && (!interrupted || input.inPlace === true)) {
      secretDiff.assertNoSecretLikeTokens("final patch diff", lastRun.diff);
      const patchSha256 = sha256(lastRun.diff);
      store.writeText(join(paths.finalDir, "patch.diff"), lastRun.diff);
      // Honest apply-state (parity with runRace single-candidate in-place): a
      // convergence run with inPlace mutated the live tree directly across its
      // attempts, so it is "applied" even when review blocked (Revert offered).
      const convHasDiff = lastRun.diff.trim().length > 0;
      const convAdoptable =
        facts.lifecycle === "succeeded" && facts.review === "approved" && facts.checks !== "failed";
      const convAdopted: boolean | null = input.inPlace === true && convHasDiff ? true : null;
      const convApplyState: "not_applied" | "applied" | "applied_review_blocked" | "reverted" =
        convAdopted === true
          ? convAdoptable
            ? "applied"
            : "applied_review_blocked"
          : "not_applied";
      const revertAnchorId =
        convAdopted === true
          ? await createRevertAnchorOrNull(execRoot, preTurnSha, lastPostTurnSha)
          : null;
      store.writeYaml(join(paths.finalDir, "work_product.yaml"), {
        id: newId("wp"),
        kind: "patch",
        source_task_id: taskId,
        producer_attempt_id: lastRun.attemptId,
        meta: {
          harness_id: lastRun.harnessId,
          result_kind: "patch",
          mode,
          attempts: attempt,
          lifecycle: facts.lifecycle,
          outcome_facts: facts,
          review_verified: actualReviewVerified,
          patch_sha256: patchSha256,
          adopted: convAdopted,
          apply_state: convApplyState,
          pre_turn_sha: convAdopted === true ? preTurnSha : null,
          post_turn_sha: convAdopted === true ? lastPostTurnSha : null,
          revert_anchor_id: revertAnchorId,
        },
      });
      store.writeText(
        join(paths.finalDir, "summary.md"),
        `# Run ${runId} (${mode})\n\n- Lifecycle: ${facts.lifecycle}${facts.reason ? ` (${facts.reason})` : ""}\n- Attempts: ${attempt}\n- Winner: ${lastRun.attemptId}\n- Review verified (cross-family): ${actualReviewVerified}\n- Apply recommendation: ${decision?.apply_recommendation ?? "inspect"}${stuckNoProgressReason ? `\n- No-progress reason: ${stuckNoProgressReason}` : ""}\n`,
      );
      // Lifecycle invariant (all modes): output.ready precedes the terminal
      // event so a client that applied the terminal event has the output.
      log.emit("output.ready", {
        kind: "summary",
        path: "final/summary.md",
        ...(convAdoptable ? {} : { state: "diagnostic" }),
      });
    }

    // A needs-decision terminal (review blocked / checks failed) writes a
    // failure record + fires run.blocked even though the lifecycle succeeded.
    const convIsFailureTerminal = facts.lifecycle !== "succeeded" || convNeedsDecision;
    if (convIsFailureTerminal) {
      // A5 last-result lift: the LAST attempt's typed mid-attempt refusal
      // survives onto the terminal; budget/cancel/needs-decision outrank it.
      const convDeclared =
        !convNeedsDecision && facts.lifecycle === "failed" && !isBudgetTerminal(facts.reason)
          ? lastRun?.declaredFailure
          : undefined;
      writeFailure(store, paths, {
        phase: convNeedsDecision ? "review" : "convergence",
        category: isBudgetTerminal(facts.reason)
          ? "budget"
          : facts.lifecycle === "cancelled"
            ? "cancelled"
            : convNeedsDecision
              ? "policy"
              : (convDeclared?.category ?? "internal"),
        code: convDeclared?.code ?? null,
        resetsAt: convDeclared?.resetsAt ?? null,
        safeMessage: convNeedsDecision
          ? `review escalated to a human decision after ${attempt} attempt(s)`
          : facts.reason === "stuck_no_progress"
            ? (stuckNoProgressReason ?? `stuck_no_progress after ${attempt} attempt(s)`)
            : `${facts.lifecycle}${facts.reason ? ` (${facts.reason})` : ""} after ${attempt} attempt(s)${lastDiffStable ? "" : " (diff changed after review; review is stale)"}`,
        harnessId: lastRun?.harnessId,
        attemptId: lastRun?.attemptId,
        runDir: paths.root,
        nextActions:
          facts.lifecycle === "cancelled"
            ? facts.reason === "wall_clock_exceeded"
              ? [
                  "Inspect the partial work kept from before the deadline",
                  "Increase --max-seconds or narrow the scope, then re-run",
                ]
              : ["Retry if cancellation was accidental"]
            : convNeedsDecision
              ? [
                  "Review the blocking findings on the run's turn",
                  "Accept the risk to apply this exact patch, or discard the change",
                ]
              : facts.reason === "stuck_no_progress"
                ? [
                    "Inspect the stable patch",
                    "Inspect the failing gate output",
                    "Fix the gate or provide a different repair instruction",
                  ]
                : [
                    "Open diagnostics",
                    "Inspect latest patch and review findings",
                    "Retry with more attempts or a narrower prompt",
                  ],
      });
      // D-16 r8/r9: an INTERRUPTED envelope run still gets its diagnostic
      // summary + output.ready (only patch/work_product are withheld) — the
      // ARCHITECTURE event contract guarantees output.ready precedes the
      // terminal in every mode.
      if (!lastRun || (interrupted && input.inPlace !== true)) {
        store.writeText(
          join(paths.finalDir, "summary.md"),
          `# Run ${runId} (${mode})\n\n- Lifecycle: ${facts.lifecycle}${facts.reason ? ` (${facts.reason})` : ""}\n- Attempts: ${attempt}\n`,
        );
        log.emit("output.ready", {
          kind: "summary",
          path: "final/summary.md",
          state: "diagnostic",
        });
      }
    }

    // work_product.emitted only when a product was actually written (r9).
    if (lastRun && (!interrupted || input.inPlace === true)) {
      log.emit("work_product.emitted", { winner: lastRun.attemptId });
    }
    if (!convIsFailureTerminal) {
      log.emit("run.completed", {
        lifecycle: facts.lifecycle,
        facts,
        reason: facts.reason,
        attempts: attempt,
      });
    } else if (facts.lifecycle === "succeeded") {
      log.emit("run.blocked", {
        lifecycle: facts.lifecycle,
        facts,
        attempts: attempt,
        phase: "review",
        failure_ref: "final/failure.yaml",
      });
    } else {
      log.emit("run.failed", {
        lifecycle: facts.lifecycle,
        facts,
        reason: facts.reason,
        attempts: attempt,
        phase: "convergence",
        failure_ref: "final/failure.yaml",
        // QA-041: surface the typed deadline reason on the terminal event so the
        // daemon job result / Control API can distinguish it from a user cancel.
        ...(facts.lifecycle === "cancelled" && convAbortReason
          ? { cancel_reason: convAbortReason }
          : {}),
      });
    }
    return {
      spendUsd: ledger.spend(),
      runId,
      taskId,
      mode,
      lifecycle: facts.lifecycle,
      facts,
      winner: lastRun?.attemptId ?? null,
      runDir: paths.root,
      // QA-041: carry the typed deadline reason on the result so daemon/Control
      // API/CLI never falsely attribute a maxSeconds deadline to the user.
      ...(facts.lifecycle === "cancelled" && convAbortReason
        ? { cancelReason: convAbortReason }
        : {}),
      summary: converged
        ? `converged in ${attempt} attempt(s)`
        : `${facts.lifecycle} after ${attempt} attempt(s)`,
      candidates: lastRun
        ? [
            {
              attemptId: lastRun.attemptId,
              harnessId: lastRun.harnessId,
              status: facts.lifecycle,
            },
          ]
        : [],
      reviewVerified: actualReviewVerified,
    };
  }

  /** Bind private route/session preparation to the planner-attempt owner. */
  private plannerAttemptDeps(): PlannerAttemptDeps {
    return {
      billingKnowledge: (input, harnessId) => this.routeBillingKnowledge(input, harnessId),
      inactivityTimeoutMs: (repoRoot) => harnessInactivityTimeoutMs(this.config(repoRoot)),
      quotaEventSink: this.deps.quotaEventSink,
      prepare: async (args) => {
        const { input, contract, taskId, runId, log, store, paths, routed, attemptId } = args;
        const adapter = routed.adapter;
        const knobs = this.routeSpecKnobs(routed, contract, undefined, input.effort);
        const effectiveWeb = this.discloseWebUpgrade(log, routed, knobs.webPolicy, attemptId);
        const sessionFields = await this.sessionSpecFields(
          input,
          adapter.id,
          knobs.model,
          log,
          routed.authRouteEstimate,
          routed.quotaAdmission,
        );
        const laneContinuity = args.laneRun
          ? await this.resolveContinuity(
              input,
              adapter.id,
              sessionFields.credential_profile?.profile_id ?? input.credentialProfileId ?? null,
              sessionFields.resume_session_id !== null,
              sessionFields,
              store,
              paths,
              this.execRootOf(input),
              log,
            )
          : null;
        const spec = HarnessRunSpec.parse({
          session_id: newId("ses"),
          intent: args.intent,
          prompt: laneContinuity?.pointerLine
            ? `${args.promptBody}\n\n${laneContinuity.pointerLine}`
            : args.promptBody,
          cwd: this.execRootOf(input),
          access: "readonly",
          attachments: input.attachments ?? [],
          ...sessionFields,
          ...this.harnessSpecKnobs(contract, knobs, args.intent),
          env_inheritance: envInheritance(this.config(input.repoRoot)),
          env:
            (args.laneRun
              ? this.laneHomeEnvFor(
                  input,
                  adapter.id,
                  sessionFields.credential_profile?.profile_id ?? input.credentialProfileId ?? null,
                )
              : null) ?? args.fallbackHome,
        });
        const plannerAbort = new AbortController();
        spec.extra["abortSignal"] = input.signal
          ? AbortSignal.any([input.signal, plannerAbort.signal])
          : plannerAbort.signal;
        const planInteraction = this.interactionChannelFor(
          input,
          log,
          runId,
          taskId,
          attemptId,
          adapter.id,
          routed.supportsInteractive,
        );
        if (planInteraction) spec.extra["interactionChannel"] = planInteraction;
        const planWorkMode = this.applyWorkEnvelope(
          spec,
          this.workReportEnvelopeFor(routed, contract, Boolean(planInteraction)),
        );
        return {
          knobs,
          effectiveWeb,
          spec,
          plannerAbort,
          planInteraction,
          planWorkMode,
        };
      },
    };
  }

  /** One read-only planner spawn shared by solo fallback, Council drafts, and merge. */
  async runPlannerAttempt(args: PlannerAttemptArgs): Promise<PlannerAttemptOutcome> {
    return executePlannerAttempt(this.plannerAttemptDeps(), args);
  }
  private async runPlan(
    input: RunInput,
    announce: (a: AnnouncedRunContext) => void,
  ): Promise<OrchestratorResult> {
    const taskId = input.taskId ?? newId("task");
    const runId = input.runId ?? newId("run");
    // Plan runs get the same immutable contract truth as every other mode;
    // contract validation runs BEFORE the run is announced (see runRace).
    const contract = this.buildContract(input, taskId, "plan");
    const quotaSnapshots = this.quotaSnapshotPreflight();
    const { store, paths, log, ledger } = beginAnnouncedRun(
      {
        input,
        contract,
        quotaSnapshots,
        store: this.artifactStore(input),
        authority: this.deps.delegationBudgetAuthority,
        runId,
        taskId,
        mode: "plan",
        phase: "plan",
        prompt: input.prompt,
      },
      announce,
    );
    store.writeYaml(join(paths.contextDir, "task.yaml"), contract);
    log.emit("task.contract.created", { task_contract_hash: hashJson(contract) });

    // W3.3: ONE resolved read-only context — the routing point-probe and every
    // planner spawn consume the SAME scoped env (see routeContext.ts).
    // A thread PLAN turn is a chat turn (INV-034): plan candidates are distinct
    // harnesses run sequentially. Doctor, model inventory, and spawn share each
    // lane's durable HOME; the disposable context remains the non-thread fallback.
    const laneRun = Boolean(input.threadId);
    const roHome = resolveReadOnlyRouteContext(
      this.execRootOf(input),
      laneRun
        ? (id) => this.laneHomeEnvFor(input, id, input.credentialProfileId ?? null)
        : undefined,
    );
    let adapters: RoutedAdapter[];
    try {
      adapters = await this.resolveCandidateAdapters(
        { ...input, n: undefined },
        "plan",
        ledger,
        log,
        roHome,
        runId,
      );
    } catch (err) {
      roHome.dispose();
      const message = safeErrorMessage(err);
      writeRoutingFailureTerminal(store, paths, log, {
        runId,
        modeLabel: "plan",
        message,
        err,
      });
      return {
        spendUsd: ledger.spend(),
        runId,
        taskId,
        mode: "plan",
        lifecycle: "failed",
        facts: makeOutcomeFacts("failed", { reason: "harness_failed" }),
        winner: null,
        runDir: paths.root,
        summary: message,
        candidates: [],
      };
    }
    // Lazy ContextPack: planners get the compact scope atlas (read-only modes only).
    let contextSection = "";
    try {
      contextSection = await this.lazyContextSection(input, contract, store, paths, log);
    } catch (err) {
      roHome.dispose();
      const message = safeErrorMessage(err);
      store.writeText(
        join(paths.contextDir, "context_error.md"),
        `# Context Error\n\n${message}\n`,
      );
      writeFailure(store, paths, {
        phase: "context",
        category: "project",
        safeMessage: message,
        runDir: paths.root,
      });
      store.writeText(
        join(paths.finalDir, "summary.md"),
        `# Run ${runId} (plan)\n\n- Lifecycle: failed\n- Phase: context\n\n${message}\n`,
      );
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      log.emit("run.failed", {
        lifecycle: "failed",
        facts: makeOutcomeFacts("failed", { reason: "harness_failed" }),
        reason: "harness_failed",
        phase: "context",
        error: message,
        failure_ref: "final/failure.yaml",
      });
      return {
        spendUsd: ledger.spend(),
        runId,
        taskId,
        mode: "plan",
        lifecycle: "failed",
        facts: makeOutcomeFacts("failed", { reason: "harness_failed" }),
        winner: null,
        runDir: paths.root,
        summary: `context failed: ${message}`,
        candidates: [],
      };
    }

    // Council strategy (INV-031): N members draft in parallel, the primary
    // merges them into ONE plan + one question set. It owns roHome disposal.
    if (input.council) {
      return runCouncilPlan(this.planRunDeps(), {
        input,
        contract,
        taskId,
        runId,
        store,
        paths,
        log,
        ledger,
        adapters,
        roHome,
        contextSection,
        laneRun,
        estimateUsdFloor: this.estimateUsdFloor(input.repoRoot),
      });
    }

    const plans: { id: string; text: string }[] = [];
    let fallbackFrom: string | null = null;
    const planAttempts: {
      attemptId: string;
      harnessId: string;
      status: "success" | "failed" | "blocked";
      outcomeClass?: AttemptOutcomeClass;
      error: string | null;
    }[] = [];
    const attemptTelemetries: {
      attemptId: string;
      harnessId: string;
      telemetry: AttemptTelemetry;
    }[] = [];
    // QA-050: the ledger's typed denial when a planner slot was refused
    // pre-spawn, so the terminal is a budget failure (not "all planners failed").
    let planBudgetDenial: BudgetDenial | null = null;
    try {
      for (const [idx, routed] of adapters.entries()) {
        if (input.signal?.aborted) break;
        const attemptId = `p${String(idx + 1).padStart(2, "0")}`;
        const outcome = await this.runPlannerAttempt({
          input,
          contract,
          taskId,
          runId,
          log,
          store,
          paths,
          ledger,
          routed,
          attemptId,
          laneRun,
          fallbackHome: roHome.env,
          promptBody: planPrompt(input.prompt) + contextSection,
          intent: "plan",
          reservationEstimateUsd: this.reservationEstimateUsd(input),
        });
        if (outcome.budgetDenied) {
          // QA-050: retain the denied planner slot before breaking so the
          // terminal names the refused route and does not read "all planners
          // failed"; capture the typed denial for the budget classifier.
          planBudgetDenial ??= outcome.budgetDenial ?? null;
          planAttempts.push({
            attemptId,
            harnessId: outcome.harnessId,
            status: outcome.status,
            outcomeClass: outcome.outcomeClass,
            error: outcome.error,
          });
          break;
        }
        if (outcome.telemetry)
          attemptTelemetries.push({
            attemptId,
            harnessId: outcome.harnessId,
            telemetry: outcome.telemetry,
          });
        planAttempts.push({
          attemptId,
          harnessId: outcome.harnessId,
          status: outcome.status,
          outcomeClass: outcome.outcomeClass,
          error: outcome.error,
        });
        if (outcome.status !== "success") {
          const next = adapters[idx + 1];
          if (next && !input.signal?.aborted) {
            fallbackFrom = outcome.harnessId;
            log.emit("route.fallback.started", {
              from_harness: outcome.harnessId,
              to_harness: next.adapter.id,
              attempt_id: attemptId,
              reason: "planner_failed",
            });
          } else if (!input.signal?.aborted && (fallbackFrom || next === undefined)) {
            log.emit("route.fallback.exhausted", {
              harness_id: outcome.harnessId,
              attempt_id: attemptId,
              reason: "planner_failed",
            });
          }
          continue;
        }
        const text = outcome.text ?? "(no output)";
        plans.push({ id: outcome.harnessId, text });
        store.writeText(
          join(paths.root, "plans", `${outcome.harnessId}.md`),
          redactSecrets(text) + "\n",
        );
        // Solo planning (D31): the FIRST successful planner is the plan; later
        // pool members are a sequential fallback chain (ask parity), not
        // parallel co-authors. Council re-enables the multi-draft round.
        if (fallbackFrom) {
          log.emit("route.fallback.completed", {
            harness_id: outcome.harnessId,
            attempt_id: attemptId,
            status: "success",
            reason: "planner_failed",
          });
        }
        break;
      }
    } finally {
      // Planners done (or threw) — reclaim scoped scratch/API-route state.
      roHome.dispose();
    }

    if (input.signal?.aborted) {
      return cancelledResult(
        log,
        runId,
        taskId,
        "plan",
        paths.root,
        planAttempts.map((p) => ({
          attemptId: p.attemptId,
          harnessId: p.harnessId,
          status: p.status,
        })),
        () =>
          this.writeRunTelemetry(
            store,
            paths,
            contract,
            runId,
            taskId,
            "plan",
            attemptTelemetries,
            null,
          ),
        ledger.spend(),
        input.signal,
        store,
      );
    }

    if (plans.length === 0) {
      return writePlanHarnessFailure(
        this.planRunDeps(),
        {
          contract,
          taskId,
          runId,
          store,
          paths,
          log,
          ledger,
          planAttempts,
          attemptTelemetries,
          budgetDenial: planBudgetDenial,
        },
        "all planners failed",
      );
    }

    if (input.signal?.aborted) {
      return cancelledResult(
        log,
        runId,
        taskId,
        "plan",
        paths.root,
        planAttempts.map((p) => ({
          attemptId: p.attemptId,
          harnessId: p.harnessId,
          status: p.status,
        })),
        () =>
          this.writeRunTelemetry(
            store,
            paths,
            contract,
            runId,
            taskId,
            "plan",
            attemptTelemetries,
            null,
          ),
        ledger.spend(),
        input.signal,
        store,
      );
    }

    return finalizePlanRun(this.planRunDeps(), {
      input,
      contract,
      taskId,
      runId,
      store,
      paths,
      log,
      ledger,
      plans,
      planAttempts,
      attemptTelemetries,
      council: null,
    });
  }

  /** Bind the few orchestrator methods planRun.ts needs (the rest of its
   * collaborators are module-level imports). Kept as a factory so each call
   * gets correctly-bound `this` without leaking the whole orchestrator. */
  private planRunDeps(): PlanRunDeps {
    return {
      runPlannerAttempt: (a) => this.runPlannerAttempt(a),
      writeRunTelemetry: (store, paths, contract, runId, taskId, mode, attempts, finalAttemptId) =>
        this.writeRunTelemetry(
          store,
          paths,
          contract,
          runId,
          taskId,
          mode,
          attempts,
          finalAttemptId,
        ),
      execRootOf: (input) => this.execRootOf(input),
      planPrompt,
    };
  }

  /** ask: one selected harness answers read-only questions; no patch/apply controls. */
  private async runAsk(
    input: RunInput,
    announce: (a: AnnouncedRunContext) => void,
  ): Promise<OrchestratorResult> {
    return this.runReadOnlyReport(
      input,
      {
        mode: "ask",
        deepScan: false,
        intent: "explain",
        title: "Answer",
        artifactName: "answer.md",
        defaultPrompt: "Answer the user's question.",
      },
      announce,
    );
  }

  /** ask --deep-scan: bounded multi-scout research sweep with synthesis
   * (the old `audit --swarm` / `explore`). */
  private async runDeepScan(
    input: RunInput,
    announce: (a: AnnouncedRunContext) => void,
  ): Promise<OrchestratorResult> {
    return this.runReadOnlyReport(
      input,
      {
        mode: "ask",
        deepScan: true,
        intent: "audit",
        title: "Deep scan synthesis",
        artifactName: "report.md",
        defaultPrompt:
          "Explore this repository and synthesize evidence-cited findings, omissions, and follow-up questions.",
      },
      announce,
    );
  }

  private quotaSnapshotPreflight(): QuotaSnapshot[] {
    return [...(this.deps.quotaSnapshots?.() ?? [])].map((snapshot) =>
      QuotaSnapshotSchema.parse(snapshot),
    );
  }

  private routeBillingKnowledge(input: RunInput, harnessId: string): "metered" | "unknown" {
    // A selected profile's credential_kind decides billing (round-18 #2).
    const profileRoute = this.credentials.profileAuthRoute(input, harnessId);
    if (profileRoute) return profileRoute === "api_key" ? "metered" : "unknown";
    // Deps-closure site: no selected route exists yet, so the RESOLVED
    // preference (per-run > per-harness config > global) speaks — never the
    // raw run input (#121).
    const mode = authModeForPreference(
      this.authPreferenceForHarness(input.repoRoot, harnessId, input.authPreference),
    );
    if (mode) return mode === "api_key" ? "metered" : "unknown";
    return loadHarnessMetrics(globalConfigDir())[harnessId]?.last_auth_mode === "api_key"
      ? "metered"
      : "unknown";
  }

  /**
   * #27 / D-6: build the engine-side deps closure for the deep-scan bounded
   * synthesis reducer (packages/orchestrator/src/deepScanReducer.ts owns the
   * spawn/stream/settle machinery). The closure keeps the private
   * route/session/knob machinery HERE and hands the module only finished public
   * types (a `HarnessRunSpec`, cost evidence, a disposable home).
   */
  private deepScanReducerDeps(
    input: RunInput,
    contract: ActiveTaskContract,
    log: EventLog,
  ): DeepScanReducerDeps {
    return {
      newReadOnlyHome: () => resolveReadOnlyRouteContext(this.execRootOf(input)),
      costEvidence: (harnessId, attemptId) =>
        // The reducer admits under a finite estimate floor (mirror of the n>1
        // scout reserve) so a subscription route is not refused for lacking a
        // cash quote.
        attemptCostEvidence(
          harnessId,
          attemptId,
          this.estimateUsdFloor(input.repoRoot),
          this.routeBillingKnowledge(input, harnessId),
        ),
      buildSpec: async (routed, homeEnv, prompt, attemptId) => {
        const knobs = this.routeSpecKnobs(routed, contract, undefined, input.effort);
        const effectiveWeb = this.discloseWebUpgrade(log, routed, knobs.webPolicy, attemptId);
        const sessionFields = await this.sessionSpecFields(
          input,
          routed.adapter.id,
          knobs.model,
          log,
          routed.authRouteEstimate,
          routed.quotaAdmission,
        );
        const spec = HarnessRunSpec.parse({
          session_id: newId("ses"),
          intent: "synthesize",
          prompt,
          cwd: this.execRootOf(input),
          access: "readonly",
          attachments: [],
          auth_preference: sessionFields.auth_preference,
          credential_profile: sessionFields.credential_profile,
          // A FRESH session — the reducer never resumes a scout's conversation.
          resume_session_id: null,
          ...this.harnessSpecKnobs(contract, knobs, "synthesize"),
          env_inheritance: envInheritance(this.config(input.repoRoot)),
          env: homeEnv,
        });
        // D-16: compile the WorkReport transport onto the reducer spec (the
        // reducer is non-interactive) so its output is unwrapped + finalized
        // through the shared attempt contract, not a fourth deliverable predicate.
        const workReportMode = this.applyWorkEnvelope(
          spec,
          this.workReportEnvelopeFor(routed, contract, false),
        );
        return {
          spec,
          webPolicy: knobs.webPolicy,
          effectiveWeb,
          model: knobs.model,
          workReportMode,
        };
      },
      hardTimeoutMs: reviewerTimeoutMs(this.config(input.repoRoot)),
      inactivityTimeoutMs: harnessInactivityTimeoutMs(this.config(input.repoRoot)),
      webRequired: contract.external_context.web_required,
      quotaEventSink: this.deps.quotaEventSink,
    };
  }

  private async runReadOnlyReport(
    input: RunInput,
    opts: {
      mode: "ask";
      deepScan: boolean;
      intent: "explain" | "audit";
      title: string;
      artifactName: string;
      defaultPrompt: string;
      contractIntent?: string;
    },
    announce: (a: AnnouncedRunContext) => void,
  ): Promise<OrchestratorResult> {
    const taskId = input.taskId ?? newId("task");
    const runId = input.runId ?? newId("run");
    const prompt = input.prompt || opts.defaultPrompt;
    // Contract validation BEFORE the run is announced (see runRace). The
    // recorded user intent is the CALLER's goal.
    const contract = this.buildContract(
      { ...input, prompt: opts.contractIntent ?? prompt },
      taskId,
      opts.mode,
    );
    const quotaSnapshots = this.quotaSnapshotPreflight();
    const { store, paths, log, ledger } = beginAnnouncedRun(
      {
        input,
        contract,
        quotaSnapshots,
        store: this.artifactStore(input),
        authority: this.deps.delegationBudgetAuthority,
        runId,
        taskId,
        mode: opts.mode,
        phase: "report",
        prompt,
      },
      announce,
    );
    store.writeYaml(join(paths.contextDir, "task.yaml"), contract);
    log.emit("task.contract.created", { task_contract_hash: hashJson(contract) });

    // The ask/deep-scan report stays bare (its scouts read the tree themselves);
    // no lazy ContextPack section is attached here.
    const contextSection = "";

    const externalContextPolicy = contract.external_context.policy;
    const width = opts.deepScan
      ? Math.min(Math.max(input.n ?? 4, 1), 8)
      : externalContextPolicy === "off"
        ? 1
        : Math.min(Math.max(input.n ?? 2, 1), 3);
    // W3.3: ONE resolved read-only context — the routing point-probe and every
    // read-only attempt spawn consume the SAME scoped env (see routeContext.ts).
    // A thread ASK turn is a chat turn: its native session is recorded per lane
    // and the next lane turn resumes it (INV-034). Its doctor/model/spawn path
    // shares that lane HOME; deep-scan and one-shot asks keep the disposable one.
    const laneRun = Boolean(input.threadId) && opts.mode === "ask" && !opts.deepScan;
    const roHome = resolveReadOnlyRouteContext(
      this.execRootOf(input),
      laneRun
        ? (id) => this.laneHomeEnvFor(input, id, input.credentialProfileId ?? null)
        : undefined,
    );
    let adapters: RoutedAdapter[];
    try {
      adapters = await this.resolveCandidateAdapters(
        { ...input, prompt, n: width },
        opts.intent,
        ledger,
        log,
        roHome,
        runId,
        // Deep-scan repeats a surviving harness to reach scout width; a dropped
        // lane must not clamp coverage (QA-043 clamp is best-of-only).
        opts.deepScan === true,
      );
      if (!opts.deepScan) {
        const seen = new Set<string>();
        adapters = adapters.filter((routed) => {
          if (seen.has(routed.adapter.id)) return false;
          seen.add(routed.adapter.id);
          return true;
        });
      }
    } catch (err) {
      roHome.dispose();
      const message = safeErrorMessage(err);
      writeRoutingFailureTerminal(store, paths, log, {
        runId,
        modeLabel: opts.mode,
        message,
        err,
      });
      return {
        runId,
        taskId,
        mode: opts.mode,
        lifecycle: "failed",
        facts: makeOutcomeFacts("failed", { reason: "harness_failed" }),
        winner: null,
        runDir: paths.root,
        summary: message,
        candidates: [],
      };
    }
    interface ReadonlyAttempt {
      attemptId: string;
      harnessId: string;
      status: "success" | "failed" | "blocked";
      report: string;
      error: string | null;
      telemetry: AttemptTelemetry;
      /** QA-019: this scout was refused BEFORE spawn by the budget gate — it
       * belongs in the denominator/omissions but never ran the harness, so the
       * all-denied terminal still routes through the QA-050 budget classifier. */
      budgetDenied?: boolean;
      /** D-16 r8: scout ran out of context — a failed omission, never reducer
       * input; ALL-interrupted terminalizes interrupted. */
      interrupted?: boolean;
      /** A5: the typed refusal (exhausted credential pool / spent window) this
       * attempt died on, so the chain terminal can speak it machine-readably. */
      declaredFailure?: ReturnType<typeof declaredFailure>;
    }
    const attempts: ReadonlyAttempt[] = [];
    const attemptTelemetries: {
      attemptId: string;
      harnessId: string;
      telemetry: AttemptTelemetry;
    }[] = [];
    let fallbackOpen = false;
    let budgetStopped = false;
    // QA-050: keep the ledger's TYPED denial (not just a boolean) so the
    // terminal names the budget sub-code, the refused route/slot, and budget
    // remediation instead of a harness auth/setup template. First denial wins —
    // it is the decisive pre-spawn refusal.
    let budgetDenial: BudgetDenial | null = null;
    // in a swarm the same harness appears in several slots; resuming the
    // ONE native session id from all of them races the vendor's session store
    // (and is semantically wrong — N explorers continuing one conversation).
    // Grant resume to the first slot of each harness only; the rest run fresh.
    const resumeGranted = new Set<string>();

    // QA-019 disclosure: a scout the budget gate refused before spawn is
    // recorded as a failed attempt with a placeholder telemetry and a
    // budget_denied marker. It enters the denominator (honest 1/2), omissions,
    // and telemetry.yaml, and the marker lets the all-denied terminal still
    // route through the QA-050 budget classifier (never harness_error).
    const recordBudgetDeniedScout = (
      harnessId: string,
      attemptId: string,
      reason: string,
    ): void => {
      const telemetry = createAttemptTelemetry(
        contract.external_context.policy,
        contract.external_context.web_required,
        contract.external_context.effective_mode,
      );
      const error = `budget denied before spawn: ${reason}`;
      setAttemptOutcome(telemetry, {
        deliverablePresent: false,
        gatesPassed: null,
        harnessErrored: false,
        webRequiredUnsatisfied: false,
      });
      attempts.push({
        attemptId,
        harnessId,
        status: "failed",
        report: "",
        error,
        telemetry,
        budgetDenied: true,
      });
      attemptTelemetries.push({ attemptId, harnessId, telemetry });
      if (opts.deepScan) {
        store.writeText(
          join(paths.findingsDir, `${attemptId}-budget-denied.md`),
          `# Explorer ${attemptId} not started\n\n${error}\n`,
        );
      }
    };

    const runReadonlyAttempt = async (
      routed: RoutedAdapter,
      idx: number,
      modelOverride?: string,
      // D-16d: a one-shot continuation re-run injects its checkpoint packet
      // pointer here; the attempt runs a FRESH session (resume is never granted
      // to a same-adapter follow-up slot) and is tagged `-cont`.
      continuationPointer?: string,
      // D-16d: fired exactly once AFTER the budget lease is granted and BEFORE the
      // attempt streams — the continuation caller emits run.continuation here so
      // the disclosure never precedes (or outlives) a denied lease. The result
      // carries the denial reason so a refusal discloses run.continuation.denied.
      onLaunch?: () => void,
    ): Promise<{ status: "launched" } | { status: "budget_denied"; reason: string }> => {
      const adapter = routed.adapter;
      const attemptId = continuationPointer
        ? `a${String(idx + 1).padStart(2, "0")}-cont`
        : modelOverride
          ? `a${String(idx + 1).padStart(2, "0")}-fb`
          : `a${String(idx + 1).padStart(2, "0")}`;
      const budgetSignalState = { quotaPressureDisclosed: false };
      const lease = ledger.reserve({
        taskId,
        attemptId,
        intent: opts.intent,
        harnessId: adapter.id,
        // QA-019: an n>1 deep-scan scout admits under a FINITE estimate floor
        // (mirror of the candidate loop): the first top-level scout reserves
        // without a floor; later scouts and every real Delegate child pass the
        // repo floor because they overlap an existing family unit.
        cost: attemptCostEvidence(
          adapter.id,
          attemptId,
          this.reservationEstimateUsd(input, opts.deepScan && idx > 0),
          this.routeBillingKnowledge(input, adapter.id),
        ),
      });
      if (!lease.granted) {
        log.emit("budget.lease.created", {
          granted: false,
          reason: lease.reason,
          denied: lease.denied,
          attempt_id: attemptId,
          harness_id: adapter.id,
        });
        budgetStopped = true;
        budgetDenial ??= {
          code: lease.denied ?? "hard_cap",
          reason: lease.reason ?? "budget lease denied",
          harnessId: adapter.id,
          attemptId,
        };
        // QA-019 disclosure: a still-denied deep-scan scout must not vanish from
        // the denominator. Record a placeholder failed attempt with a
        // budget_denied marker so the explore-findings map counts it (1/2, not
        // 1/1), omissions and telemetry record the denial, and the all-denied
        // terminal still routes through the QA-050 budget classifier. The
        // sequential ask/audit path has no denominator — a denial there stays a
        // pure budget stop (no phantom failed attempt), preserving its terminal.
        if (opts.deepScan) {
          recordBudgetDeniedScout(adapter.id, attemptId, lease.reason ?? "budget lease denied");
        }
        return { status: "budget_denied", reason: lease.reason ?? "budget lease denied" };
      }
      // As with planners, the granted lease owns profile/continuity/spec
      // preparation. Contain a pre-stream rejection as this attempt's failure;
      // parallel siblings can then finish before the shared HOME is disposed.
      const preparation = await (async () => {
        // Lease granted: the attempt is now committed to run — disclose the launch.
        onLaunch?.();
        const knobs = this.routeSpecKnobs(routed, contract, modelOverride, input.effort);
        const effectiveWeb = this.discloseWebUpgrade(log, routed, knobs.webPolicy, attemptId);
        const explorerPrompt =
          (opts.deepScan
            ? `${prompt}\n\nExplorer ${idx + 1}/${adapters.length}: focus on a distinct slice. Emit evidence-cited findings, explicit unknowns/omissions, and follow-up questions. Do not edit files.`
            : prompt) + contextSection;
        const sessionFields = await this.sessionSpecFields(
          input,
          adapter.id,
          knobs.model,
          log,
          routed.authRouteEstimate,
          routed.quotaAdmission,
        );
        const grantResume =
          sessionFields.resume_session_id !== null && !resumeGranted.has(adapter.id);
        if (grantResume) resumeGranted.add(adapter.id);
        // Continuity (INV-137): a thread ASK turn is a chat turn — hydrate a lane
        // switch/gap with a packet and disclose it. Gated on laneRun (deep-scan
        // scouts are excluded from laneRun); native resume is available only when
        // this slot was granted the lane's recorded session.
        const laneContinuity = laneRun
          ? await this.resolveContinuity(
              input,
              adapter.id,
              sessionFields.credential_profile?.profile_id ?? input.credentialProfileId ?? null,
              grantResume,
              sessionFields,
              store,
              paths,
              this.execRootOf(input),
              log,
            )
          : null;
        // D-16d: the continuation packet pointer rides after the lane pointer so
        // the fresh session is re-grounded in the exhausted attempt's work.
        const promptWithPointers = [
          explorerPrompt,
          laneContinuity?.pointerLine,
          continuationPointer,
        ]
          .filter((p): p is string => Boolean(p))
          .join("\n\n");
        const spec = HarnessRunSpec.parse({
          session_id: newId("ses"),
          intent: opts.intent,
          prompt: promptWithPointers,
          cwd: this.execRootOf(input),
          access: "readonly",
          // ASK/EXPLORE/AUDIT read-only runs must forward the user's attachments —
          // a live "describe this image" turn sent an image that was being dropped here, so
          // the model honestly reported it saw nothing (the v0.13 attachment bug).
          attachments: input.attachments ?? [],
          auth_preference: sessionFields.auth_preference,
          credential_profile: sessionFields.credential_profile,
          resume_session_id: grantResume ? sessionFields.resume_session_id : null,
          ...this.harnessSpecKnobs(contract, knobs, opts.intent),
          env_inheritance: envInheritance(this.config(input.repoRoot)),
          // A thread lane turn spawns in its DURABLE per-lane home so the native
          // session it records is reachable for resume next turn; everything else
          // uses the disposable route-context home.
          env:
            (laneRun
              ? this.laneHomeEnvFor(
                  input,
                  adapter.id,
                  sessionFields.credential_profile?.profile_id ?? input.credentialProfileId ?? null,
                )
              : null) ?? roHome.env,
        });
        const reportAbort = new AbortController();
        spec.extra["abortSignal"] = input.signal
          ? AbortSignal.any([input.signal, reportAbort.signal])
          : reportAbort.signal;
        const reportInteraction = this.interactionChannelFor(
          input,
          log,
          runId,
          taskId,
          attemptId,
          adapter.id,
          routed.supportsInteractive,
        );
        if (reportInteraction) spec.extra["interactionChannel"] = reportInteraction;
        // D-16: compile the WorkReport envelope for the read-only lane.
        const readonlyWorkEnvelope = this.workReportEnvelopeFor(
          routed,
          contract,
          Boolean(reportInteraction),
        );
        const readonlyWorkMode: WorkReportEnvelopeMode = this.applyWorkEnvelope(
          spec,
          readonlyWorkEnvelope,
        );
        const attemptEventsPath = join(paths.attemptsDir, attemptId, "events.jsonl");
        const answer = new AnswerAssembly();
        const telemetry = createAttemptTelemetry(
          knobs.webPolicy,
          contract.external_context.web_required,
          effectiveWeb,
          [],
          // Requested-model capture so ask/audit route receipts detect a silent
          // model downgrade (typed model_mismatch), not just agent runs.
          knobs.model,
        );
        return {
          knobs,
          spec,
          reportAbort,
          reportInteraction,
          readonlyWorkMode,
          attemptEventsPath,
          answer,
          telemetry,
        };
      })().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      if (!preparation.ok) {
        const message = `read-only attempt setup failed: ${safeErrorMessage(preparation.error)}`;
        AC.settleGrantedAttemptLease({
          ledger,
          leaseId: lease.lease?.lease_id ?? "",
          attemptId,
          harnessId: adapter.id,
          costUsd: 0,
          costEstimated: false,
          preStreamFailureSource: "readonly-pre-stream",
        });
        const telemetry = createAttemptTelemetry(
          contract.external_context.policy,
          contract.external_context.web_required,
          contract.external_context.effective_mode,
        );
        setAttemptOutcome(telemetry, {
          deliverablePresent: false,
          gatesPassed: null,
          harnessErrored: true,
          webRequiredUnsatisfied: false,
        });
        const preDeclared = declaredFailure(preparation.error);
        attempts.push({
          attemptId,
          harnessId: adapter.id,
          status: "failed",
          report: "",
          error: message,
          telemetry,
          ...(preDeclared.code ? { declaredFailure: preDeclared } : {}), // typed pre-spawn refusal
        });
        attemptTelemetries.push({ attemptId, harnessId: adapter.id, telemetry });
        if (opts.deepScan) {
          store.writeText(
            join(paths.findingsDir, `${attemptId}-error.md`),
            `# Explorer ${attemptId} failed\n\n${message}\n`,
          );
        }
        return { status: "launched" };
      }
      const {
        knobs,
        spec: preparedSpec,
        reportAbort,
        reportInteraction,
        readonlyWorkMode,
        attemptEventsPath,
        telemetry,
      } = preparation.value;
      let { answer } = preparation.value;
      let spec = preparedSpec;
      const retryPolicy = transientRetryPolicy(this.config(input.repoRoot));
      let activeSessionId = spec.session_id;
      const onAbort = () => {
        void adapter.cancel?.(activeSessionId)?.catch(() => {});
      };
      if (input.signal) {
        if (input.signal.aborted) onAbort();
        else input.signal.addEventListener("abort", onAbort, { once: true });
      }
      let cost = 0;
      let costEstimated = false;
      let harnessError: string | null = null;
      let poolExhausted: Error | null = null; // A5: typed pool-exhausted refusal
      try {
        const triedProfiles = new Set<string>(); // W5.4 failover: each profile at most once
        for (let nativeTry = 0; !input.signal?.aborted; nativeTry += 1) {
          // A3 per-try isolation (candidate-lane parity): neither a failed try's
          // output nor its progress markers leak into the next try's evidence.
          if (nativeTry > 0) {
            answer = new AnswerAssembly();
            telemetry.outputMarkers = newAttemptOutputMarkers();
          }
          const runSpec =
            nativeTry === 0
              ? spec
              : HarnessRunSpec.parse({
                  ...spec,
                  session_id: newId("ses"),
                  resume_session_id: null,
                  extra: { ...spec.extra },
                });
          activeSessionId = runSpec.session_id;
          const transientStart = telemetry.transientFailures.length;
          const rateLimitStart = telemetry.rateLimits.length;
          log.emit("harness.started", {
            harness_id: adapter.id,
            attempt_id: attemptId,
            external_context_policy: knobs.webPolicy,
            ...(modelOverride ? { fallback_model: modelOverride } : {}),
            ...(nativeTry > 0 ? { retry: nativeTry } : {}),
            ...(knobs.ignored.length > 0 ? { ignored_settings: knobs.ignored } : {}),
          });
          try {
            const watchedReport = withInactivityWatchdog(runModelGovernedRoute(routed, runSpec), {
              timeoutMs: harnessInactivityTimeoutMs(this.config(input.repoRoot)),
              countsAsProgress: countsAsAgentProgress,
              onTimeout: () => {
                reportAbort.abort();
                void adapter.cancel?.(activeSessionId)?.catch(() => {});
              },
              isSuspended: () => (reportInteraction?.pendingCount?.() ?? 0) > 0,
              suspensionVersion: () => reportInteraction?.suspensionVersion?.() ?? 0,
            });
            for await (const ev of watchedReport) {
              if (input.signal?.aborted) break;
              const safeEv = redactHarnessEvent(ev);
              safeInvoke(input.onHarnessEvent, safeEv);
              // A thread ASK turn IS a chat turn now (INV-034): its native
              // session lives in the DURABLE per-lane home, so record it for the
              // next lane turn's resume. The read-only fallback chain is
              // sequential (never the parallel deep-scan swarm, which is
              // excluded from `laneRun`), so recordSession's upsert keeps the
              // latest lane session without a race.
              if (laneRun) observeNativeSessionEvent(input, adapter.id, safeEv);
              observeAuthSwitch(log, adapter.id, attemptId, safeEv);
              log.emit("harness.event", harnessEventPayload(adapter.id, attemptId, safeEv));
              appendLine(attemptEventsPath, JSON.stringify(safeEv));
              observeAttemptTelemetry(telemetry, safeEv);
              emitPlanProgress((t, p) => log.emit(t, p), adapter.id, attemptId, safeEv);
              // read-only routes burn quota too (the orchestrate PLANNER is
              // the loudest) — same single owner as the agent loop.
              observeBudgetSignals(ledger, log, adapter.id, attemptId, safeEv, budgetSignalState);
              this.deps.quotaEventSink?.(adapter.id, safeEv);
              const spend = observeReadonlySpend(
                safeEv,
                (t, p) => log.emit(t, p),
                adapter.id,
                attemptId,
              );
              cost += spend.costUsd;
              costEstimated ||= spend.estimated;
              // A TYPED final message wins verbatim over joined narration.
              answer.observe(safeEv);
              if (safeEv.type === "error")
                harnessError = safeEv.error
                  ? redactSecrets(safeEv.error)
                  : "harness emitted an error";
            }
          } catch (err) {
            harnessError = safeErrorMessage(err);
            // #31: classify the throw (watchdog timeout vs process crash) as typed.
            telemetry.transientFailures.push(
              classifyAdapterThrow({ errorName: err instanceof Error ? err.name : null }),
            );
          }

          const newTransients = telemetry.transientFailures.slice(transientStart);
          const transient = newTransients.at(-1) ?? null;
          const sawRetryable = newTransients.some((f) => f.retryable);
          const sawTypedLimit = telemetry.rateLimits.length > rateLimitStart;
          const reportSoFar = answer.text();
          // W5.4 + A2 reactive failover, READ-ONLY lane (same contract as the
          // candidate lane: typed limit or structural pre-progress death).
          if (harnessError && !input.signal?.aborted) {
            const rotated = await rotateSpecOnTypedLimit({
              spec,
              harnessId: adapter.id,
              attemptId,
              policy: this.credentials.profilePolicy(input.repoRoot, adapter.id),
              registry: this.config(input.repoRoot)?.global.credential_profiles ?? [],
              snapshots: this.deps.quotaSnapshots?.() ?? [],
              probeReadyProfiles: () =>
                this.credentials.readyProfileIdsForRotation(
                  input,
                  adapter.id,
                  spec.credential_profile ?? null,
                  triedProfiles,
                  spec.model_hint ?? null,
                ),
              ...this.credentials.rotationObservations(adapter, spec, newTransients),
              triedProfiles,
              markers: telemetry.outputMarkers,
              sawTypedLimit,
              sawRetryable,
              attemptErrored: harnessError !== null,
              // Same policy owner as the candidate lane: an errored try's
              // narration is not a report; the transient gate keeps reportSoFar.
              deliverableEmpty: acceptedTryOutput(answer, harnessError !== null).length === 0,
              lastLimit: telemetry.rateLimits.at(-1) ?? null,
              emit: (type, payload) => log.emit(type, payload),
              newSessionId: () => newId("ses"),
              defaultRouteWasVendorNative: routed.authRouteEstimate === "local_session",
              // D-U6: an explicit pin never rotates; pool-selected rows do.
              pinned: input.credentialProfileId != null,
            });
            // A5 ordering: same as the candidate lane — terminalize typed
            // before the transient gate burns same-profile retries. The pool
            // refusal APPENDS to the original harness error (candidate-lane
            // parity: errors.push) instead of erasing the true failure.
            if (rotated && "poolExhausted" in rotated) {
              poolExhausted = rotated.poolExhausted;
              harnessError = harnessError
                ? `${harnessError}; ${safeErrorMessage(poolExhausted)}`
                : safeErrorMessage(poolExhausted);
              break;
            }
            if (rotated) {
              // INV-137: the rotated row's session must land in ITS OWN lane
              // home — never the previous row's lane store.
              spec = rotatedSpecInLaneHome(
                spec,
                rotated,
                (id) => this.laneHomeEnvFor(input, adapter.id, id),
                input.credentialProfileId ?? null,
              );
              harnessError = null;
              continue;
            }
          }
          if (
            !harnessError ||
            !sawRetryable ||
            reportSoFar.length > 0 ||
            nativeTry >= retryPolicy.maxRetries ||
            input.signal?.aborted
          )
            break;

          const delayMs = emitTransientRetryPlan(
            (t, p) => log.emit(t, p),
            adapter.id,
            attemptId,
            transient,
            nativeTry,
            retryPolicy,
          );
          harnessError = null;
          await sleep(delayMs);
        }
      } finally {
        input.signal?.removeEventListener("abort", onAbort);
        AC.settleGrantedAttemptLease({
          ledger,
          leaseId: lease.lease?.lease_id ?? "",
          attemptId,
          harnessId: adapter.id,
          costUsd: cost,
          costEstimated,
          authMode: telemetry.authMode,
          usageCost: telemetry.usageCost,
          preStreamFailureSource: "readonly-pre-stream",
        });
      }
      if (harnessError && !poolExhausted) {
        emitTransientExhausted(
          (t, p) => log.emit(t, p),
          adapter.id,
          attemptId,
          telemetry,
          retryPolicy.maxRetries,
        );
      }
      attemptTelemetries.push({ attemptId, harnessId: adapter.id, telemetry });
      // D-16: the deliverable is the report. A3: an errored attempt with no
      // typed final contributes no report material (acceptedTryOutput).
      const roUnwrapped = unwrapWorkReportEnvelope(
        acceptedTryOutput(answer, harnessError !== null),
        readonlyWorkMode,
        { sideToolReport: telemetry.sideToolWorkReport ?? undefined },
      );
      // Trim symmetrically with the plan path: a whitespace-only answer is not
      // a delivered report (the final-artifact wrapper heading would otherwise
      // make it read as present content by construction).
      const report = redactSecrets(roUnwrapped.deliverable).trim();
      const unrecovered = unrecoveredToolErrors(telemetry);
      const webBlocked = webUnsatisfied(telemetry);
      const reportPresent = report.length > 0;
      if (!harnessError && webBlocked) {
        harnessError = webEvidenceFailure(telemetry.web);
      }
      harnessError ??= unrecoveredToolErrorFailure(unrecovered, reportPresent);
      const roFinalized = finalizeAttempt({
        deliverableEvidence: reportPresent,
        harnessErrored: harnessError !== null && !webBlocked,
        workReport: roUnwrapped.workReport,
        workReportSource: roUnwrapped.source,
        workReportViolation: roUnwrapped.contractViolation,
        contextTerminalExhausted: telemetry.contextExhausted,
      });
      // A broken WorkReport contract is a hard failure ONLY when the finalizer
      // ranked it so — a concurrent terminal context exhaustion outranks it
      // (interrupted, not a contract failure). Let the finalizer own precedence.
      if (!harnessError && roFinalized.outcomeClass === "contract_failure") {
        harnessError = `work_report contract: ${roUnwrapped.contractViolation}`;
      }
      setAttemptOutcome(telemetry, {
        deliverablePresent: roFinalized.deliverablePresent,
        gatesPassed: null,
        harnessErrored: harnessError !== null && !webBlocked,
        webRequiredUnsatisfied: webBlocked,
        workState: roFinalized.workState,
        // A read-only attempt that completed CLEANLY with an honestly empty
        // answer is a success with deliverable_present=false ("(no output)"),
        // never a fake contract failure — the trim above must not convert a
        // phantom deliverable into a phantom harness failure. Only the clean
        // finalizer class qualifies: contract failures, vetoes, and context
        // interruptions keep the strict deliverable requirement.
        emptyDeliverableAllowed: roFinalized.outcomeClass === "clean",
      });
      if (harnessError) {
        log.emit("harness.completed", {
          harness_id: adapter.id,
          attempt_id: attemptId,
          status: webBlocked ? "blocked" : "failed",
          error: harnessError,
          ...telemetrySummary(telemetry),
        });
        attempts.push({
          attemptId,
          harnessId: adapter.id,
          status: webBlocked ? "blocked" : "failed",
          report,
          error: harnessError,
          telemetry,
          ...(poolExhausted ? { declaredFailure: declaredFailure(poolExhausted) } : {}),
        });
        if (opts.deepScan) {
          store.writeText(
            join(paths.findingsDir, `${attemptId}-error.md`),
            `# Explorer ${attemptId} failed\n\n${harnessError}\n`,
          );
        }
        return { status: "launched" };
      }
      // D-16 r8: an interrupted scout is a FAILED omission, never reducer input;
      // the sequential ask/audit winner folds at its own terminal (stays success).
      const scoutInterrupted = opts.deepScan && roFinalized.outcomeClass === "interrupted";
      log.emit("harness.completed", {
        harness_id: adapter.id,
        attempt_id: attemptId,
        status: scoutInterrupted ? "interrupted" : "success",
        ...telemetrySummary(telemetry),
      });
      attempts.push({
        attemptId,
        harnessId: adapter.id,
        status: scoutInterrupted ? "failed" : "success",
        report: report || "(no output)",
        error: scoutInterrupted ? "context capacity exhausted before the scout completed" : null,
        telemetry,
        ...(scoutInterrupted ? { interrupted: true } : {}),
      });
      if (opts.deepScan) {
        const warningNote = toolWarnings(telemetry).length
          ? `\n\n> Tool warnings: ${toolWarnings(telemetry)
              .map((e) => `${e.tool}: ${e.summary}`)
              .join("; ")}\n`
          : "";
        const scoutTag = scoutInterrupted
          ? " interrupted (context capacity exhausted)"
          : ` (${adapter.id})`;
        store.writeText(
          join(paths.findingsDir, `${attemptId}${scoutInterrupted ? "-interrupted" : ""}.md`),
          `# Explorer ${attemptId}${scoutTag}\n\n${report || "(no output)"}${warningNote}\n`,
        );
      }
      return { status: "launched" };
    };

    try {
      if (opts.deepScan) {
        // Explorer swarm runs in parallel (bounded), mirroring parallel
        // candidates. The swarm has no continuation lane, so the launched/denied
        // return is unused here.
        await runBounded(
          adapters,
          Math.min(adapters.length, MAX_PARALLEL_CANDIDATES),
          async (routed, idx) => {
            await runReadonlyAttempt(routed, idx);
          },
        );
      } else {
        // ask/audit: sequential fallback chain — first success wins; a blocked
        // attempt opens a fallback arc to the next eligible harness.
        let continuationCount = 0; // D-16d: one-shot budget across the chain
        for (const [idx, routed] of adapters.entries()) {
          if (input.signal?.aborted) break;
          await runReadonlyAttempt(routed, idx);
          let last = attempts[attempts.length - 1];
          // D-16d one-shot continuation: an ELIGIBLE terminal context exhaustion
          // (repeated_refill, no completed report) gets ONE fresh-session re-run,
          // re-grounded by a mechanical checkpoint packet. On completion the
          // exhausted attempt is superseded so the continuation wins the terminal.
          if (last?.status === "success" && continuationCount === 0 && !budgetStopped) {
            const decision = decideContinuation({
              contextExhausted: last.telemetry.contextExhausted,
              contextExhaustedCause: last.telemetry.contextExhaustedCause,
              workStateCompleted: last.telemetry.outcome?.workState?.state === "completed",
              continuationCount,
              runKind: "read_only",
            });
            if (decision.eligible) {
              const exhausted = last;
              const packet = buildContinuationPacket(
                synthesizeContinuationRequest({
                  harness: exhausted.harnessId,
                  profileId: input.credentialProfileId ?? null,
                  priorPrompt: prompt,
                  priorOutput: exhausted.report,
                }),
              );
              // The continuation lease is reserved INSIDE runReadonlyAttempt; emit
              // run.continuation via onLaunch (fires only AFTER the grant, before the
              // stream) so a denied lease never leaves a false "launched" disclosure
              // nor consumes the one-shot. A refusal emits run.continuation.denied.
              const outcome = await runReadonlyAttempt(
                routed,
                idx,
                undefined,
                packet.pointerLine ?? undefined,
                () => {
                  continuationCount += 1;
                  log.emit("run.continuation", {
                    from_attempt: exhausted.attemptId,
                    cause: last.telemetry.contextExhaustedCause,
                    continuation_count: continuationCount,
                    packet_turns: packet.continuity.disclosure.packetTurns,
                  });
                },
              );
              if (outcome.status === "budget_denied") {
                log.emit("run.continuation.denied", {
                  from_attempt: exhausted.attemptId,
                  cause: last.telemetry.contextExhaustedCause,
                  reason: outcome.reason,
                });
              } else {
                const cont = attempts[attempts.length - 1];
                if (cont && cont !== exhausted && cont.status === "success") {
                  exhausted.status = "failed";
                  exhausted.error =
                    exhausted.error ?? "superseded by one-shot continuation (context exhausted)";
                  last = cont;
                }
              }
            }
          }
          // Per-harness fallback_model: one same-harness retry on FAILURE (not
          // policy blocks) before falling through to the next harness.
          const fallbackModel = routed.settings?.fallbackModel;
          const firstModel =
            contract.routing_models[routed.adapter.id] ?? routed.settings?.defaultModel ?? null;
          if (
            last &&
            last.status === "failed" &&
            fallbackModel &&
            fallbackModel !== firstModel &&
            !budgetStopped &&
            !input.signal?.aborted
          ) {
            log.emit("route.fallback.started", {
              from_harness: last.harnessId,
              to_harness: last.harnessId,
              attempt_id: last.attemptId,
              reason: "fallback_model",
              fallback_model: fallbackModel,
            });
            await runReadonlyAttempt(routed, idx, fallbackModel);
            last = attempts[attempts.length - 1];
            if (last?.status === "success") {
              log.emit("route.fallback.completed", {
                harness_id: last.harnessId,
                attempt_id: last.attemptId,
                status: "success",
                reason: "fallback_model",
              });
            } else {
              log.emit("route.fallback.exhausted", {
                harness_id: last?.harnessId ?? routed.adapter.id,
                attempt_id: last?.attemptId ?? null,
                reason: "fallback_model",
              });
            }
          }
          if (!last) continue; // budget-denied slot
          if (last.status === "success") {
            if (fallbackOpen) {
              log.emit("route.fallback.completed", {
                harness_id: last.harnessId,
                attempt_id: last.attemptId,
                status: "success",
              });
              fallbackOpen = false;
            }
            break;
          }
          const hasNext = idx < adapters.length - 1 && !budgetStopped;
          if (last.status === "blocked" && hasNext) {
            log.emit("route.fallback.started", {
              from_harness: last.harnessId,
              to_harness: adapters[idx + 1]?.adapter.id ?? null,
              attempt_id: last.attemptId,
              reason: "web_evidence_unsatisfied",
              error: last.error,
            });
            fallbackOpen = true;
            continue;
          }
          // Terminal failure (non-web failure, or no remaining fallback).
          break;
        }
      }
    } finally {
      // All read-only attempts done (or threw) — reclaim scoped scratch and
      // injected API-route state. Vendor-owned native credentials were not copied.
      roHome.dispose();
    }

    const candidateSummaries = attempts.map((a) => ({
      attemptId: a.attemptId,
      harnessId: a.harnessId,
      status: a.status,
    }));
    const cancelledTerminal = () =>
      cancelledResult(
        log,
        runId,
        taskId,
        opts.mode,
        paths.root,
        candidateSummaries,
        () =>
          this.writeRunTelemetry(
            store,
            paths,
            contract,
            runId,
            taskId,
            opts.mode,
            attemptTelemetries,
            null,
          ),
        ledger.spend(),
        input.signal,
        store,
      );
    if (input.signal?.aborted) return cancelledTerminal();

    const succeededReadonly = attempts.filter((a) => a.status === "success");
    if (!opts.deepScan && succeededReadonly.length === 0) {
      const last = attempts[attempts.length - 1];
      const webBlocked = attempts.some((a) => a.status === "blocked");
      // QA-050: a budget refusal is a BUDGET failure, not a harness one — route
      // it through the shared classifier so phase/category/code/route and the
      // remediation are budget-typed (never auth/setup) across every mode.
      const budgetMapping =
        budgetStopped && !webBlocked
          ? classifyBudgetFailure({ denial: budgetDenial, terminal: ledger.terminal() })
          : null;
      const singleError =
        budgetMapping?.safeMessage ??
        last?.error ??
        (budgetStopped ? "budget exhausted before any attempt" : "harness failed");
      if (fallbackOpen || webBlocked) {
        log.emit("route.fallback.exhausted", {
          harness_id: last?.harnessId ?? null,
          attempt_id: last?.attemptId ?? null,
          reason: "web_evidence_unsatisfied",
          error: singleError,
        });
        fallbackOpen = false;
      }
      const partialReport = [...attempts].reverse().find((a) => a.report)?.report ?? "";
      if (partialReport) {
        store.writeText(
          join(paths.finalDir, opts.artifactName),
          `# ${opts.title}\n\n> Unverified partial output. The run is ${webBlocked ? "blocked" : "failed"} because a required/attempted tool failed.\n\n${partialReport}\n`,
        );
        log.emit("output.ready", {
          kind: opts.mode === "ask" ? "answer" : "report",
          path: `final/${opts.artifactName}`,
          state: "diagnostic",
        });
      }
      this.writeRunTelemetry(
        store,
        paths,
        contract,
        runId,
        taskId,
        opts.mode,
        attemptTelemetries,
        null,
      );
      store.writeText(
        join(paths.contextDir, "context_error.md"),
        `# ${budgetMapping ? "Budget Denied" : "Harness Error"}\n\n${singleError}\n`,
      );
      const roEventRefs = attempts.map((a) => `attempts/${a.attemptId}/events.jsonl`);
      if (budgetMapping) {
        writeFailure(
          store,
          paths,
          budgetFailureRecord(budgetMapping, { eventRefs: roEventRefs, runDir: paths.root }),
        );
      } else {
        // #31: classify the harness cause across the read-only attempts so auth
        // guidance appears only on a real auth failure.
        const roCategory = dominantHarnessFailureCategory(
          attemptTelemetries.flatMap((a) => a.telemetry.transientFailures),
        );
        // A5: the terminal already speaks with the LAST attempt's message; its
        // typed refusal rides along machine-readably instead of reducing to it.
        const roDeclared = webBlocked ? undefined : last?.declaredFailure;
        writeFailure(store, paths, {
          phase: "harness",
          category: webBlocked ? "policy" : (roDeclared?.category ?? "harness_error"),
          code: roDeclared?.code ?? null,
          harnessId: last?.harnessId,
          attemptId: last?.attemptId,
          safeMessage: singleError,
          eventRefs: roEventRefs,
          runDir: paths.root,
          resetsAt: roDeclared?.resetsAt ?? null,
          nextActions: harnessFailureNextActions(roCategory),
        });
      }
      // QA-036: re-check the DELIVERABLE through the shared finalizer helper —
      // a blocked Ask that produced NO answer can no longer read as a succeeded
      // "Needs review" run (exit 0); it is an honest failure (exit 1).
      const roTerminal = readOnlyNoSuccessTerminal({
        webBlocked,
        hasDeliverable: partialReport.trim().length > 0,
        budgetStopped,
        attemptsCount: attempts.length,
      });
      const terminalFacts = makeOutcomeFacts(roTerminal.lifecycle, {
        ...(roTerminal.review ? { review: roTerminal.review } : {}),
        reason: roTerminal.reason,
      });
      const terminalHarnessId = budgetMapping?.harnessId ?? last?.harnessId;
      store.writeText(
        join(paths.finalDir, "summary.md"),
        `# Run ${runId} (${opts.mode})\n\n- Harness: ${terminalHarnessId ?? "none"}\n- Lifecycle: ${terminalFacts.lifecycle}${terminalFacts.reason ? ` (${terminalFacts.reason})` : ""}\n\n${singleError}\n`,
      );
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      if (terminalFacts.lifecycle === "succeeded") {
        log.emit("run.blocked", {
          lifecycle: terminalFacts.lifecycle,
          facts: terminalFacts,
          harness_id: terminalHarnessId,
          error: singleError,
          failure_ref: "final/failure.yaml",
        });
      } else {
        log.emit("run.failed", {
          lifecycle: terminalFacts.lifecycle,
          facts: terminalFacts,
          reason: terminalFacts.reason,
          phase: budgetMapping?.phase,
          harness_id: terminalHarnessId,
          error: singleError,
          failure_ref: "final/failure.yaml",
        });
      }
      return {
        spendUsd: ledger.spend(),
        runId,
        taskId,
        mode: opts.mode,
        lifecycle: terminalFacts.lifecycle,
        facts: terminalFacts,
        winner: null,
        runDir: paths.root,
        summary: singleError,
        candidates: attempts.map((a) => ({
          attemptId: a.attemptId,
          harnessId: a.harnessId,
          status: a.status,
        })),
      };
    }
    const succeeded = succeededReadonly;
    if (opts.deepScan && succeeded.length === 0) {
      const blocked = attempts.some((a) => a.status === "blocked");
      // QA-050/QA-019: an all-denied scan (finite-zero, or every scout refused
      // before spawn) is a BUDGET failure, not harness_error — route it through
      // the shared classifier. Only a pure-denial scan (no scout actually errored
      // in the harness) qualifies, so a real explorer failure is never masked.
      const scanBudgetMapping =
        budgetStopped && !blocked && attempts.every((a) => a.budgetDenied === true)
          ? classifyBudgetFailure({ denial: budgetDenial, terminal: ledger.terminal() })
          : null;
      // D-16 r8: ALL scouts out of context → the aggregate is interrupted.
      const allInterrupted = attempts.length > 0 && attempts.every((a) => a.interrupted === true);
      const scanFailFacts = allInterrupted
        ? makeOutcomeFacts("interrupted", { reason: "context_capacity_exhausted" })
        : makeOutcomeFacts("failed", {
            reason: scanBudgetMapping ? scanBudgetMapping.reason : "harness_failed",
          });
      const message = scanBudgetMapping
        ? scanBudgetMapping.safeMessage
        : attempts.map((a) => `${a.attemptId}/${a.harnessId}: ${a.error ?? "failed"}`).join("\n");
      this.writeRunTelemetry(
        store,
        paths,
        contract,
        runId,
        taskId,
        opts.mode,
        attemptTelemetries,
        null,
      );
      if (scanBudgetMapping) {
        writeFailure(
          store,
          paths,
          budgetFailureRecord(scanBudgetMapping, {
            eventRefs: attempts.map((a) => `attempts/${a.attemptId}/events.jsonl`),
            runDir: paths.root,
          }),
        );
      } else {
        // #31: classify the scout failures; keep the scan-specific width hint but
        // drop the unconditional auth line unless the cause was a real auth failure.
        const scanCategory = dominantHarnessFailureCategory(
          attemptTelemetries.flatMap((a) => a.telemetry.transientFailures),
        );
        writeFailure(store, paths, {
          phase: "harness",
          category: blocked ? "policy" : "harness_error",
          safeMessage: message || "all explorers failed",
          eventRefs: attempts.map((a) => `attempts/${a.attemptId}/events.jsonl`),
          runDir: paths.root,
          nextActions: [
            ...harnessFailureNextActions(scanCategory).filter((a) => !a.startsWith("Retry")),
            "Reduce explore width",
            "Retry after setup",
          ],
        });
      }
      // QA-036: with ZERO successful explorers there is no synthesizable
      // deliverable, so a blocked scan can no longer read as a succeeded
      // "needs review" run (exit 0). An empty scan is a failure whether the
      // explorers were blocked or errored.
      store.writeText(
        join(paths.finalDir, "summary.md"),
        `# Run ${runId} (${opts.mode})\n\n- Lifecycle: ${scanFailFacts.lifecycle}${scanFailFacts.reason ? ` (${scanFailFacts.reason})` : ""}\n\n${message}\n`,
      );
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      log.emit("run.failed", {
        lifecycle: scanFailFacts.lifecycle,
        facts: scanFailFacts,
        reason: scanFailFacts.reason,
        phase: scanBudgetMapping ? scanBudgetMapping.phase : "harness",
        error: message,
        failure_ref: "final/failure.yaml",
      });
      return {
        spendUsd: ledger.spend(),
        runId,
        taskId,
        mode: opts.mode,
        lifecycle: scanFailFacts.lifecycle,
        facts: scanFailFacts,
        winner: null,
        runDir: paths.root,
        summary: message,
        candidates: attempts.map((a) => ({
          attemptId: a.attemptId,
          harnessId: a.harnessId,
          status: a.status,
        })),
      };
    }
    const unsuccessful = attempts.filter((a) => a.status !== "success");
    // #27 / D-6: a multi-scout deep scan runs ONE bounded synthesis reducer over
    // the raw scout reports so the final artifact is a real merge, not a
    // concatenation. A single report (width-1) needs no merge; a failed/denied
    // reducer degrades to an HONEST raw scout bundle, never a fake synthesis. The
    // whole decision + reducer spawn lives in deepScanReducer.ts (its owner).
    let deepScanSynthesis: DeepScanSynthesis | null = null;
    let reducedReport: string | null = null;
    if (opts.deepScan) {
      ({ deepScanSynthesis, reducedReport } = await resolveDeepScanSynthesis(
        this.deepScanReducerDeps(input, contract, log),
        {
          succeeded,
          adapters,
          budgetStopped,
          aborted: Boolean(input.signal?.aborted),
          taskId,
          goal: prompt,
          findingsDir: paths.findingsDir,
          ledger,
          log,
          paths,
          signal: input.signal,
          onHarnessEvent: input.onHarnessEvent,
          attemptTelemetries,
        },
      ));
    }
    // INV-116: a cancel that landed WHILE the bounded reducer ran (scouts done,
    // synthesis in flight) is a cancelled terminal — never a laundered success.
    if (input.signal?.aborted) return cancelledTerminal();
    const report = !opts.deepScan
      ? (succeeded[0]?.report ?? "(no output)")
      : reducedReport !== null
        ? reducedReport
        : rawScoutBundle({ succeeded, unsuccessful, status: deepScanSynthesis });
    store.writeText(join(paths.finalDir, opts.artifactName), `# ${opts.title}\n\n${report}\n`);
    // ask is the only read-only strategy that can carry a structured-output
    // contract (the boundary refuses the rest); validate the FINAL aggregate
    // (the reduced synthesis, or the honest bundle for a degraded scan) — never
    // the first scout's raw report — and never the titled artifact wrapper.
    if (opts.mode === "ask" && contract.output_schema) {
      finalizeStructuredOutput({
        store,
        finalDir: paths.finalDir,
        log,
        schema: contract.output_schema,
        answerText: opts.deepScan ? report : (succeeded[0]?.report ?? ""),
      });
    }
    this.writeRunTelemetry(
      store,
      paths,
      contract,
      runId,
      taskId,
      opts.mode,
      attemptTelemetries,
      opts.deepScan ? null : (succeeded[0]?.attemptId ?? null),
      deepScanSynthesis,
    );
    log.emit("output.ready", {
      kind: opts.deepScan ? "report" : "answer",
      path: `final/${opts.artifactName}`,
    });
    if (opts.deepScan) {
      store.writeYaml(join(paths.finalDir, "explore-findings.yaml"), {
        mode: "explore",
        width,
        attempts: attempts.map((a) => ({
          attempt_id: a.attemptId,
          harness_id: a.harnessId,
          status: a.status,
          error: a.error,
          telemetry: telemetrySummary(a.telemetry),
        })),
        // Omissions account for EVERY unsuccessful explorer, including blocked ones.
        omissions: unsuccessful.map((a) => ({
          attempt_id: a.attemptId,
          harness_id: a.harnessId,
          status: a.status,
          error: a.error,
        })),
        read_only: true,
      });
      store.writeText(
        join(paths.finalDir, "omissions.md"),
        `# Omissions\n\n${unsuccessful.map((a) => `- ${a.attemptId} / ${a.harnessId} (${a.status}): ${a.error}`).join("\n") || "- None recorded by the runner. Synthesis claims still require evidence checks."}\n`,
      );
    }
    // A read-only report (ask / deep-scan) has no live-tree work; the only
    // non-clean terminal is an aggregate paid-budget stop.
    let terminalFacts: RunOutcomeFacts = makeOutcomeFacts("succeeded");
    const reportBudgetTerminal = ledger.terminal();
    if (reportBudgetTerminal) {
      terminalFacts = makeOutcomeFacts("failed", { reason: reportBudgetTerminal });
    } else if (!opts.deepScan) {
      // D-16: fold the winning read-only attempt's work_state into the terminal.
      // A terminal context exhaustion with no completed report ⇒ interrupted;
      // a needs_input/incomplete report ⇒ a succeeded run whose work_state
      // vetoes applyability and a clean exit (INV-116). answer.md was already
      // persisted from the unwrapped OUTPUT.
      const winnerTelemetry = succeeded[0]?.telemetry;
      const winnerWorkState = winnerTelemetry?.outcome?.workState;
      if (winnerTelemetry?.contextExhausted && winnerWorkState?.state !== "completed") {
        terminalFacts = makeOutcomeFacts("interrupted", { reason: "context_capacity_exhausted" });
      } else if (
        winnerWorkState?.state === "needs_input" ||
        winnerWorkState?.state === "incomplete"
      ) {
        terminalFacts = makeOutcomeFacts("succeeded", {
          reason: winnerWorkState.state === "needs_input" ? "input_required" : "work_incomplete",
          work_state: winnerWorkState,
        });
      } else if (winnerWorkState) {
        terminalFacts = makeOutcomeFacts("succeeded", { work_state: winnerWorkState });
      }
    }
    const harnessLabel = attempts
      .map((a) => `${a.attemptId}:${a.harnessId}:${a.status}`)
      .join(", ");
    store.writeText(
      join(paths.finalDir, "summary.md"),
      `# Run ${runId} (${opts.mode})\n\n- Harnesses: ${harnessLabel}\n- Lifecycle: ${terminalFacts.lifecycle}${terminalFacts.reason ? ` (${terminalFacts.reason})` : ""}\n\n${report}\n`,
    );
    const reportProducerAttemptId =
      opts.deepScan &&
      deepScanSynthesis?.status === "succeeded" &&
      deepScanSynthesis.reducer_attempt_id
        ? deepScanSynthesis.reducer_attempt_id
        : (succeeded[0]?.attemptId ?? "a01");
    store.writeYaml(join(paths.finalDir, "work_product.yaml"), {
      id: newId("wp"),
      kind: "report",
      source_task_id: taskId,
      producer_attempt_id: reportProducerAttemptId,
      files: Object.fromEntries([[opts.artifactName, join(paths.finalDir, opts.artifactName)]]),
      meta: {
        harnesses: attempts.map((a) => a.harnessId),
        mode: opts.mode,
        intent: opts.intent,
        read_only: true,
      },
    });
    log.emit("work_product.emitted", { kind: "report", winner: reportProducerAttemptId });
    const workVetoed =
      terminalFacts.work_state?.state === "needs_input" ||
      terminalFacts.work_state?.state === "incomplete";
    if (terminalFacts.lifecycle !== "succeeded") {
      writeFailure(store, paths, {
        phase: "executor",
        category:
          terminalFacts.reason === "context_capacity_exhausted" ? "harness_error" : "budget",
        safeMessage: `read-only report ended ${terminalFacts.lifecycle}${terminalFacts.reason ? ` (${terminalFacts.reason.replaceAll("_", " ")})` : ""}`,
        runDir: paths.root,
        nextActions:
          terminalFacts.reason === "context_capacity_exhausted"
            ? ["Inspect the partial report", "Re-run with a narrower scope"]
            : ["Inspect the report artifacts", "Adjust the budget and retry"],
      });
      log.emit("run.failed", {
        lifecycle: terminalFacts.lifecycle,
        facts: terminalFacts,
        reason: terminalFacts.reason,
        phase: "executor",
        failure_ref: "final/failure.yaml",
      });
    } else if (workVetoed) {
      // D-16: a succeeded lifecycle whose work_state vetoes is a needs-me
      // terminal — run.blocked (not run.completed); the outcome-aware exit
      // projection returns non-zero from the same facts.
      log.emit("run.blocked", {
        lifecycle: terminalFacts.lifecycle,
        facts: terminalFacts,
        reason: terminalFacts.reason,
      });
    } else {
      log.emit("run.completed", {
        lifecycle: terminalFacts.lifecycle,
        facts: terminalFacts,
        reason: terminalFacts.reason,
      });
    }

    return {
      spendUsd: ledger.spend(),
      runId,
      taskId,
      mode: opts.mode,
      lifecycle: terminalFacts.lifecycle,
      facts: terminalFacts,
      winner: null,
      runDir: paths.root,
      summary: redactSecrets(report).slice(0, 400),
      candidates: candidateSummaries,
    };
  }
}
