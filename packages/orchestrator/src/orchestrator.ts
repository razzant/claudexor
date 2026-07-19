import { existsSync, readFileSync } from "node:fs";
import {
  observeNativeSessionEvent,
  preflightCredentialProfile,
  preflightDefaultSubject,
  resolveCredentialProfile,
  resumeSessionForProfile,
  rotateSpecOnTypedLimit,
  selectedProfileAvailability,
  type ProfilePolicy,
} from "./credential-profiles.js";
import { writeRunTelemetryArtifact } from "./runTelemetryWriter.js";
import {
  buildFileBackedSynthesisInput,
  materializeWinnerOutputs,
  stageFileBackedContext,
  writeCandidateAttemptArtifacts,
} from "./candidateOutputs.js";
import { processAttemptUsage } from "./attemptUsage.js";
import { type CandidateRun, toCandidateEvidence } from "./candidateEvidence.js";
import { capabilityIntents } from "@claudexor/gateway";
import { policyFindings } from "./policyFindings.js";

import { join } from "node:path";
import type {
  AccessProfile,
  Attachment,
  ControlReviewerPanelEntry,
  EffortHint,
  KnownModelEntry,
  ExternalContextPolicy,
  HarnessEvent,
  Intent,
  InteractionAnswerSet,
  InteractionRequest,
  ModeKind,
  PaidBudget,
  QuotaSnapshot,
  RoutingGoal,
  ProtectedPathApproval,
  ProjectConfig,
  RequestRequirementResolution,
  ReviewFinding,
  RunEvent,
  RunLifecycle,
  RunOutcomeFacts,
  TaskContract,
  TestCommandInvocation,
  ProviderFamily,
  AuthPreference,
  CredentialProfile,
  ImplementationTransport,
  RawGitPatchEnvelope,
  WebPolicySupport,
  WorkspaceEnvelope,
} from "@claudexor/schema";
import { PlanQuestionsArtifact, derivePlanReadiness } from "@claudexor/schema";
import { extractPlanQuestions } from "./planQuestions.js";
import {
  HarnessRunSpec,
  OrchestrateContract as OrchestrateContractSchema,
  type OrchestrateContract as OrchestrateContractT,
  type OrchestrateAutonomy,
  type OrchestratePlan as OrchestratePlanT,
  type OrchestratePlanCall as OrchestratePlanCallT,
  DecisionRecord as DecisionRecordSchema,
  FinalVerifyRecord,
  WorkProduct as WorkProductSchema,
  SessionReboundLineage as SessionReboundLineageSchema,
  ModeKind as ModeKindSchema,
  SCHEMA_VERSION,
  TRUST_FULL_ACCESS_CODE,
  FrozenTaskContractArtifact as TaskContractSchema,
  isBlocking,
  makeOutcomeFacts,
  orchestratePlanJsonSchema,
  normalizeUserOutputSchema,
  strictifyOutputSchema,
  estimateEffectiveAuthRoute,
} from "@claudexor/schema";
import { globalConfigDir, loadConfig, trustConfigPath } from "@claudexor/config";
import type { AdapterRegistry, HarnessAdapter, InteractionChannel } from "@claudexor/core";
import {
  AnswerAssembly,
  HarnessUnavailableError,
  summarizeDiffPaths as diffStats,
  withInactivityWatchdog,
} from "@claudexor/core";
import { assertRouteModelsAllowed } from "./modelGovernance.js";
import { RequestRequirementsResolver } from "./requestRequirements.js";
import {
  type AnnouncedRunContext,
  cancelledResult,
  failTerminally,
  guardAnnouncedRun,
  writeFailure,
} from "./runTerminals.js";
import { assertOutputSchemaCompiles, finalizeStructuredOutput } from "./structuredOutput.js";
import {
  transientRetryDelayMs,
  promptWithProtectedPathConstraint,
  sleep,
  redactHarnessEvent,
  harnessEventPayload,
  formatFindings,
  renderSummary,
  readRunPatch,
  observeBudgetSignals,
  rotateOnStall,
  recordCleanAttemptMetrics,
  buildEnvelopeSubInput,
  deliverPlanAnswer,
  envInheritance,
  transientRetryPolicy,
  reviewerTimeoutMs,
  harnessInactivityTimeoutMs,
  observeAuthSwitch,
  deliveryRefusalFailure,
  writeRaceDeliveryDecision,
} from "./runSupport.js";
import {
  candidateStatusInRouteContext,
  resolveReadOnlyRouteContext,
  type ResolvedRouteContext,
} from "./routeContext.js";
import { resolveAutoReviewerPanel, resolveExplicitReviewerPanel } from "./reviewerPanel.js";
import { buildOrchestratePlannerPrompt, extractOrchestratePlan } from "./orchestratePlanner.js";
import { orchestrateFailureFor, readRunStatus } from "./outcomeReducer.js";
import {
  executeOrchestratePlan,
  type OrchestrateApplyStepResult,
  type OrchestrateSafeStepResult,
} from "./orchestrateExecutor.js";
import { runDiffReview, type DiffReviewInput, type DiffReviewResult } from "./diffReview.js";
import {
  type AttemptTelemetry,
  type ToolErrorRecord,
  createAttemptTelemetry,
  observeAttemptTelemetry,
  setAttemptOutcome,
  telemetrySummary,
  toolWarnings,
  unrecoveredToolErrors,
  webUnsatisfied,
} from "./attemptTelemetry.js";
import { interactionChannelFor } from "./interaction.js";
import {
  gateSpecsFromContract,
  renderTestsEvidence,
  resolveContractGates,
} from "./contract-gates.js";
import { ArtifactStore, type RunPaths } from "@claudexor/artifact-store";
import { EventLog } from "@claudexor/event-log";
import {
  assertMandatoryContext,
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
  ensureGitRepository,
  consumeRawPatchEnvelope,
  snapshotTree,
} from "@claudexor/workspace";
import {
  blockedDecisionOverride,
  finalVerifyBlocks,
  finalVerifyPatch,
  validateApplyGate,
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
  type RouterCandidate,
  loadHarnessMetrics,
  promptFingerprint,
  unknownCostSettlement,
  rankHarnesses,
  reviewUsageCostSettlement,
} from "@claudexor/budget";
import {
  readTextSafe,
  appendLine,
  assertNoInlineSecretValues,
  containsSecretLikeToken,
  hashJson,
  newId,
  noProjectRepoRoot,
  nowIso,
  redactSecrets,
  safeInvoke,
  sha256,
  userConfigDir,
  writeText,
} from "@claudexor/util";

export interface OrchestratorDeps {
  registry: AdapterRegistry;
  reviewers?: ReviewerSpec[];
  paidBudget?: PaidBudget;
  routingGoal?: RoutingGoal;
  /** Durable global quota projection, injected by the daemon boundary. */
  quotaSnapshots?: () => readonly QuotaSnapshot[];
  /** Persist typed live quota/cooldown events into that same projection. */
  quotaEventSink?: (harnessId: string, event: HarnessEvent) => void;
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
  synthesis?: SynthesisMode;
  /** Explicit typed-argv deterministic gates from caller-provided run configuration. */
  tests?: TestCommandInvocation[];
  /** Typed per-run approval for changing auto-protected gate/test paths. */
  protectedPathApprovals?: ProtectedPathApproval[];
  paidBudget?: PaidBudget;
  budgetLedger?: BudgetLedger;
  /** Orchestrate executor: cap on plan tool calls. */
  maxToolCalls?: number | null;
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
  /** In-process sink for every RunEvent (mirrors events.jsonl) for live observers. */
  onEvent?: (event: RunEvent) => void;
  /** In-process sink for the full per-harness event stream (richer than RunEvent). */
  onHarnessEvent?: (event: HarnessEvent) => void;
  /** Called once when the run id/dir are known, before any harness work begins. */
  onRunStart?: (info: { runId: string; taskId: string; runDir: string }) => void;
  /**
   * Interactive answer surface (waiting_on_user). When a harness raises a
   * question, the orchestrator emits `interaction.requested`, calls this
   * handler, and blocks ONLY that attempt's tool until answers arrive or the
   * timeout elapses (then a benign decline lets the model continue with
   * assumptions). When absent, runs are non-interactive end to end.
   */
  onInteraction?: (ctx: PendingInteractionContext) => Promise<InteractionAnswerSet | null>;
  /** Wait budget for one interactive answer (default 900000 ms = 15 min). */
  interactionTimeoutMs?: number;
  /** Cancellation: aborts the run and cancels in-flight harness work. */
  signal?: AbortSignal;
  /**
   * Run the convergence loop against the live `repoRoot` directly (no git worktree).
   * For external stateful harness environments where runtime state, not a patch,
   * is the deliverable. Only honored by convergence modes.
   */
  inPlace?: boolean;
  /**
   * Per-run globs no candidate may touch at all (create/modify/delete) —
   * stricter than protected paths, which gate only tampering with existing
   * files. Envelope/isolated runs only: the engine's post-diff policy gate is
   * the authoritative enforcement (violation → blocking finding → blocked,
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
  /**
   * How much the orchestrate planner may act without confirmation
   * (suggest/auto_safe/auto_full). Honored ONLY by mode=orchestrate; the
   * executor over the typed plan classifies each tool_call via toolRisk and
   * runs safe steps as isolated sub-runs / reads, blocking risky steps under
   * auto_safe. Defaults to `suggest` (plan-only) when unset.
   */
  autonomy?: OrchestrateAutonomy;
  /**
   * Recursion-depth guard for orchestrate. The executor spawns sub-runs via
   * `this.run`; a sub-run must NOT itself orchestrate (orchestrate-within-
   * orchestrate throws). The top-level orchestrate run is depth 0; sub-runs it
   * spawns inherit depth+1 and are forbidden from mode=orchestrate.
   */
  orchestrateDepth?: number;
  /**
   * Optional live answer-delivery service for the executor's `answer_question`
   * step (the daemon owns the InteractionRegistry; the engine does not). When
   * absent, an answer_question step is honestly SKIPPED (no live interaction
   * surface in this context) rather than silently claimed done. Read-only
   * w.r.t. the tree. Returns true when the answer was delivered.
   */
  answerInteraction?: (
    runId: string,
    interactionId: string,
    answers: InteractionAnswerSet,
  ) => Promise<boolean>;
}

/** Context handed to RunInput.onInteraction for one pending question. */
export interface PendingInteractionContext {
  runId: string;
  taskId: string;
  attemptId: string;
  harnessId: string;
  request: InteractionRequest;
  requestedAt: string;
  timeoutAt: string;
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
interface RoutedAdapter {
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
  /** Declared effort ladder (empty = effort is not a tunable surface; a
   * requested effort is then DISCLOSED as ignored, never silently dropped). */
  effortLevels: readonly EffortHint[];
  /** Manifest model truth source (used when the adapter has no live models()). */
  knownModels: readonly KnownModelEntry[];
  /** Pre-spawn credential-route estimate (INV-061 projection of preference x
   * doctor source readiness); null = undecidable, model gates stay fail-closed. */
  authRouteEstimate: "local_session" | "api_key" | null;
  /** Manifest `interactive` capability: only such routes are OFFERED an
   * InteractionChannel (gate). */
  supportsInteractive: boolean;
  /** Manifest `json_schema_output`: only such routes receive
   * HarnessRunSpec.output_schema (gate); others keep fenced-JSON parsing. */
  supportsJsonSchemaOutput: boolean;
  implementationTransport: ImplementationTransport;
  settings: HarnessRouteSettings | null;
}
const LABELS = "ABCDEFGHIJ".split("");
const NO_PROJECT_ROOT = noProjectRepoRoot();
/** Concurrency cap for parallel candidates/explorers (locked decision: min(n, 4)). */
const MAX_PARALLEL_CANDIDATES = 4;
/** Default wait for one interactive answer before a benign decline. */
const DEFAULT_INTERACTION_TIMEOUT_MS = 900_000;

/**
 * SAFETY INVARIANT 1 (asserted, not convention): a sub-run spawned by the
 * orchestrate executor for a SAFE step (start_run/race) MUST run as an isolated
 * ENVELOPE — never a live in-place turn on a thread. Throws loudly if a caller
 * ever constructs a safe sub-run that could mutate the live tree.
 */
function assertEnvelopeSubRun(sub: RunInput): void {
  if (sub.inPlace === true) {
    throw new Error(
      "orchestrate safe sub-run must be an isolated envelope (inPlace must be false), refusing live-tree mutation",
    );
  }
  if (sub.threadId !== undefined || sub.executionRoot !== undefined) {
    throw new Error(
      "orchestrate safe sub-run must not bind a thread or in-place execution root (isolation envelope only)",
    );
  }
}

/** Changed paths and +/- line counts parsed from a unified git diff. */

/** Run `work` over `items` with bounded concurrency, preserving item order via index. */
async function runBounded<T>(
  items: T[],
  limit: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const concurrency = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      await work(items[idx] as T, idx);
    }
  });
  await Promise.all(workers);
}

export class Orchestrator {
  private readonly gateway: HarnessGateway;
  private readonly requestRequirements = new RequestRequirementsResolver();
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
    const resolved = this.resolveRunInput(input);
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
    // INV-023 at the ENGINE boundary too: maxToolCalls caps the orchestrate
    // executor's plan steps — on any other mode it would be a silent no-op
    // knob. The CLI and control API validate this already; a direct embedder
    // must get the same loud refusal, not quiet acceptance.
    if (
      resolved.maxToolCalls !== undefined &&
      resolved.maxToolCalls !== null &&
      mode !== "orchestrate"
    ) {
      throw new Error(
        `maxToolCalls caps the orchestrate EXECUTOR's plan steps and only applies to mode=orchestrate (got mode=${mode}); drop the knob or switch modes`,
      );
    }
    // denyPaths is enforced by the post-diff policy gate BEFORE delivery, which
    // only exists on envelope/isolated runs — an in-place run mutates the live
    // tree directly, so the gate could not contain a violation. Refuse loudly
    // rather than accept a knob the engine cannot honor (INV-023).
    if ((resolved.denyPaths?.length ?? 0) > 0 && resolved.inPlace === true) {
      throw new Error(
        "denyPaths requires an isolated/envelope run: the post-diff policy gate blocks a violating patch before delivery, which an in-place run cannot guarantee; drop --deny-path or run isolated",
      );
    }
    // outputSchema constrains the run's final ANSWER. It is honored exactly
    // where a final answer is delivered (agent race incl. synthesis, and ask);
    // every other strategy refuses loudly rather than carrying a contract the
    // engine would not validate (INV-023). The schema itself is normalized for
    // the native structured-output routes here at the boundary — unsupported
    // shapes ($ref, non-object root) are a typed refusal, not a mid-run 400.
    if (resolved.outputSchema !== undefined && resolved.outputSchema !== null) {
      if (mode !== "agent" && mode !== "ask") {
        throw new Error(
          `outputSchema constrains the final answer and applies to agent/ask runs (got mode=${mode}); drop the schema or switch modes`,
        );
      }
      if (resolved.untilClean || (resolved.attempts !== undefined && resolved.attempts !== null)) {
        throw new Error(
          "outputSchema is not supported with convergence flags (--until-clean/--attempts): convergence delivers a gated patch, not a structured answer; drop the schema or the convergence flags",
        );
      }
      // Shape-refuse unsupported schemas, then PROVE it compiles under the same
      // ajv the engine validator uses — a malformed schema is a preflight
      // refusal here (before any run dir), never a mid-run validator crash. The
      // contract keeps the ORIGINAL (conformance authority); strictify is a
      // transport-only transform applied per-lane in harnessSpecKnobs.
      resolved.outputSchema = normalizeUserOutputSchema(resolved.outputSchema);
      assertOutputSchemaCompiles(resolved.outputSchema);
    }
    // P1: a versioned `mandatory_files` contract is enforced UNIFORMLY here, for
    // every mode, so the same repo state can't pass `run`/`ask` while failing
    // `audit`. No-op when the list is empty (the default) or for no-project runs.
    if (resolved.repoRoot !== NO_PROJECT_ROOT) {
      assertMandatoryContext(
        resolved.repoRoot,
        this.projectConfig(resolved.repoRoot).context.mandatory_files,
      );
    }
    // Reviewer panels are validated only inside the strategies that actually
    // review (race/convergence under agent, and plan) — AFTER run-dir
    // creation, so a doomed explicit panel yields typed failure ARTIFACTS
    // (failure.yaml naming the refusal) instead of a bare pre-run throw.
    // ask/audit never spawn reviewers, so a panel there never spends doctor/
    // model probes and never fails a run that would not use it.
    // Whole-strategy terminal net: once a strategy ANNOUNCES its
    // run, any escaped throw still stamps failure.yaml + summary + run.failed
    // instead of orphaning events.jsonl.
    return guardAnnouncedRun(resolved.signal, (announce) => {
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
        case "orchestrate":
          // Recursion guard: a sub-run spawned by the orchestrate executor carries
          // orchestrateDepth>0 and must NOT itself orchestrate (no infinite planner
          // recursion). Fail loudly rather than silently degrade.
          if ((resolved.orchestrateDepth ?? 0) > 0) {
            throw new Error(
              "orchestrate-within-orchestrate is forbidden: a sub-run spawned by the orchestrate executor cannot itself orchestrate",
            );
          }
          return this.runOrchestrate(resolved, announce);
      }
    });
  }

  private async resolveReviewers(
    cwd: string,
    runAuthPreference?: AuthPreference,
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
      },
      {
        reviewerModels: this.deps.reviewerModels,
        reviewerEfforts: this.deps.reviewerEfforts,
      },
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
      return { reviewers: await this.resolveReviewers(input.repoRoot, input.authPreference) };
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
    const explicit = (v?: AuthPreference): "subscription" | "api_key" | undefined =>
      v && v !== "auto" ? v : undefined;
    return (
      explicit(runAuthPreference) ??
      explicit(cfg?.harnesses?.[harnessId]?.auth_preference) ??
      explicit(cfg?.routing?.auth_preference) ??
      "auto"
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

  private execRootOf(input: RunInput): string {
    return input.executionRoot ?? input.repoRoot;
  }

  private sessionSpecFields(
    input: RunInput,
    harnessId: string,
    log?: EventLog,
  ): Pick<HarnessRunSpec, "auth_preference" | "resume_session_id" | "credential_profile"> {
    const cfg = this.config(input.repoRoot)?.global;
    const profile = this.preflightProfile(input, harnessId, log);
    const explicit = (
      v?: "subscription" | "api_key" | "auto",
    ): "subscription" | "api_key" | undefined => (v && v !== "auto" ? v : undefined);
    return {
      // "auto" at ANY level falls through (thread turns send the thread default
      // "auto" as a per-run value; it must not shadow a configured preference).
      auth_preference:
        explicit(input.authPreference) ??
        explicit(cfg?.harnesses?.[harnessId]?.auth_preference) ??
        explicit(cfg?.routing?.auth_preference) ??
        "auto",
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
  private laneHomeEnvFor(input: RunInput, harnessId: string): Record<string, string> | null {
    if (!input.threadId) return null;
    return new WorkspaceManager(input.repoRoot).laneHomeEnv(
      input.threadId,
      harnessId,
      input.credentialProfileId ?? null,
    ).env;
  }

  private resolveCredentialProfile(input: RunInput, harnessId: string): CredentialProfile | null {
    if (!input.credentialProfileId) return null;
    const registry = this.config(input.repoRoot)?.global.credential_profiles ?? [];
    return resolveCredentialProfile(registry, input.credentialProfileId, harnessId);
  }

  /** The typed effective auth route for a SELECTED credential profile
   * (round-18 #2): adapters execute strictly by credential_kind, so routing,
   * billing classification, model truth, and quota lookup must share this
   * one fact — never the default store's sources or a previous default-route
   * metric. null = no profile selected or it does not resolve here. */
  private profileAuthRoute(input: RunInput, harnessId: string): "local_session" | "api_key" | null {
    try {
      const profile = this.resolveCredentialProfile(input, harnessId);
      if (!profile) return null;
      return profile.credential_kind === "api_key" ? "api_key" : "local_session";
    } catch {
      return null;
    }
  }

  private profilePolicy(repoRoot: string, harnessId: string): ProfilePolicy {
    const policy = this.config(repoRoot)?.global.harnesses?.[harnessId]?.profile_policy;
    return policy ?? { limit_action: "fail", rotation_eligible: [], headroom_threshold: 0.9 };
  }

  private preflightProfile(input: RunInput, harnessId: string, log?: EventLog) {
    const profile = this.resolveCredentialProfile(input, harnessId);
    const policy = this.profilePolicy(input.repoRoot, harnessId);
    const registry = this.config(input.repoRoot)?.global.credential_profiles ?? [];
    const snapshots = this.deps.quotaSnapshots?.() ?? [];
    const emit: Parameters<typeof preflightCredentialProfile>[0]["emit"] = (type, payload) =>
      log?.emit(type, payload);
    if (!profile) {
      // Unpinned runs (INV-135 auto-balance): under `rotate`, a fresh
      // default-subject headroom breach starts on the next eligible
      // subscription profile instead; `fail`/`ask` change nothing.
      return preflightDefaultSubject({ harnessId, policy, registry, snapshots, emit });
    }
    return preflightCredentialProfile({ profile, harnessId, policy, registry, snapshots, emit });
  }

  /**
   * Lift an adapter's auth-route override marker into the typed
   * `route.fallback.auth_switched` run event (validated payload). An explicit
   * subscription/api_key preference that could not be honored is never silent;
   * neither is an `auto` choice that selects a smoke-proven paid route over an
   * available native route.
   */
  /**
   * Resolve candidate adapters: explicit `--harness`, else available real harnesses, then
   * **capability-gate** to those that can actually produce work for `intent` (e.g. a
   * a planner-only adapter with `implement: false` is dropped from an implement race), and
   * expand to n. Fails loudly if nothing can perform the intent.
   */
  private resolveRunInput(input: RunInput): RunInput {
    if (
      input.contextMode === "off" &&
      !(input.mode === "ask" && input.repoRoot === NO_PROJECT_ROOT)
    ) {
      throw new Error("contextMode 'off' is only supported for Ask without a repoRoot");
    }
    const cfg = this.config(input.repoRoot);
    const configuredPool = cfg?.global.routing.eligible_harnesses;
    const harnesses =
      input.harnesses ?? (configuredPool && configuredPool.length > 0 ? configuredPool : undefined);
    const primaryHarness = input.primaryHarness ?? cfg?.global.routing.primary_harness ?? undefined;
    if (
      primaryHarness &&
      harnesses &&
      harnesses.length > 0 &&
      !harnesses.includes(primaryHarness)
    ) {
      throw new Error(
        `primary harness '${primaryHarness}' is not in the eligible harness pool (${harnesses.join(", ")})`,
      );
    }
    if (input.web && input.externalContextPolicy && input.web !== input.externalContextPolicy) {
      throw new Error(
        `contradictory web policy: web='${input.web}' vs externalContextPolicy='${input.externalContextPolicy}' (pass one, or equal values)`,
      );
    }
    const web = input.web ?? input.externalContextPolicy ?? "auto";
    // INV-103: model choice is harness-scoped end-to-end. The scalar
    // `model` is a convenience that expands to the RESOLVED PRIMARY only —
    // never the whole pool (the old global fallback poisoned every pool
    // member with one vendor's model id). Specific beats general: an explicit
    // per-harness map entry wins over the scalar.
    //
    // Map KEYS fail loudly (INV-021): a typo'd harness id ("claud") must
    // never silently no-op into "the run used defaults and nothing said why".
    const knownHarnessIds = new Set(this.deps.registry.keys());
    for (const key of Object.keys(input.models ?? {})) {
      if (!knownHarnessIds.has(key)) {
        throw new Error(
          `models map names unknown harness '${key}' (registered: ${[...knownHarnessIds].sort().join(", ")}); ` +
            `run \`claudexor harness list --all\``,
        );
      }
    }
    const models: Record<string, string> = { ...input.models };
    if (input.model) {
      const scalarTarget =
        primaryHarness ?? (harnesses && harnesses.length === 1 ? harnesses[0] : undefined);
      if (!scalarTarget) {
        throw new Error(
          `a scalar model ('${input.model}') is ambiguous without a primary harness: ` +
            `the pool is ${harnesses && harnesses.length > 0 ? `[${harnesses.join(", ")}]` : "auto-resolved"} — ` +
            `set a primary harness, pass exactly one --harness, or use a harness-scoped model map`,
        );
      }
      models[scalarTarget] ??= input.model;
    }
    return {
      ...input,
      harnesses,
      primaryHarness,
      model: undefined,
      models,
      routingGoal:
        input.routingGoal ??
        this.deps.routingGoal ??
        cfg?.project.budget?.routing_goal ??
        cfg?.global.routing.goal ??
        "auto",
      web,
      externalContextPolicy: web,
    };
  }

  private async resolveCandidateAdapters(
    input: RunInput,
    intent: Intent,
    ledger?: BudgetLedger,
    routeContext?: ResolvedRouteContext,
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
        // Auto-pools take only doctor-OK harnesses (BIBLE §2: doctor decides
        // readiness; a key string or degraded route is visible but not routable).
        ids = statuses
          .filter(
            (s) =>
              s.manifest?.kind !== "fake" && s.status === "ok" && s.enabledIntents.includes(intent),
          )
          .map((s) => s.id);
        if (ids.length === 0) {
          throw new HarnessUnavailableError(
            "no doctor-ok harness for this mode; install/login codex/claude/cursor/opencode (see `claudexor doctor`), or pass --harness explicitly",
          );
        }
      }
    }
    const policy = input.web ?? input.externalContextPolicy ?? "auto";
    const pool: RoutedAdapter[] = [];
    const dropped: string[] = [];
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
        dropped.push(`${id} (not registered)`);
        continue;
      }
      // Per-harness settings: a user-disabled harness never routes. Explicit
      // selection of a disabled harness fails loudly before any doctor/model
      // probe instead of silently running or spending readiness checks.
      const cfgEntry = harnessSettings[id];
      if (cfgEntry && cfgEntry.enabled === false) {
        const why = `${id} is disabled in settings (harnesses.${id}.enabled=false)`;
        if (explicitPool) throw new HarnessUnavailableError(why);
        dropped.push(why);
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
        dropped.push(`${id} (unavailable)`);
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
      const profileVerdict = await selectedProfileAvailability({
        registry: this.config(input.repoRoot)?.global.credential_profiles ?? [],
        profileId: input.credentialProfileId,
        harnessId: id,
        probe: profileAdapter?.probeCredentialProfile?.bind(profileAdapter),
      });
      if (profileVerdict !== null) {
        if (profileVerdict === "available") {
          profileAdmitted = true;
          // A valid profile restores manifest intent truth when the default store failed.
          if (status.status !== "ok") {
            status = {
              ...status,
              status: "degraded",
              enabledIntents: capabilityIntents(manifest.capabilities),
            };
            statusById.set(id, status);
          }
        } else {
          const why = `${id} credential profile is not ready: ${profileVerdict}`;
          if (explicitPool) throw new HarnessUnavailableError(why);
          dropped.push(why);
          continue;
        }
      }
      if (status.status === "unavailable" && !profileAdmitted) {
        const why = `${id} is unavailable${status.reasons.length ? `: ${status.reasons.join("; ")}` : ""}`;
        if (explicitPool) throw new HarnessUnavailableError(why);
        dropped.push(why);
        continue;
      }
      if (status.status !== "ok" && !explicitPool && !profileAdmitted) {
        dropped.push(
          `${id} is ${status.status}${status.reasons.length ? `: ${status.reasons.join("; ")}` : ""}`,
        );
        continue;
      }
      const readOnlyIntent =
        intent === "plan" ||
        intent === "spec" ||
        intent === "explain" ||
        intent === "audit" ||
        intent === "orchestrate";
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
      const routeWebRequired = routePolicy === "cached" || routePolicy === "live";
      // Web policy is a capability: `off` needs an enforceable off state and a
      // web-required run needs a route that can produce web evidence.
      // `none` (no web at ALL) trivially satisfies `off`; `uncontrolled` (web
      // exists but no switch) satisfies neither. A harness that cannot honor
      // the policy is excluded — or, when the user explicitly selected it, the
      // run fails loudly instead of silently downgrading.
      const webIncompatible =
        (routePolicy === "off" && webSupport === "uncontrolled") ||
        (routeWebRequired && (webSupport === "none" || webSupport === "uncontrolled"));
      if (webIncompatible) {
        const why = `${id} cannot enforce web policy '${routePolicy}' (manifest web_policy=${webSupport}); choose a web-capable/enforceable harness or change --web to a compatible policy`;
        if (explicitPool) throw new HarnessUnavailableError(why);
        dropped.push(why);
        continue;
      }
      const attachmentRefusal = this.requestRequirements.attachmentRefusal(
        id,
        input.attachments ?? [],
        manifest.capability_profile.attachment_inputs,
      );
      if (attachmentRefusal) {
        if (explicitPool) throw new HarnessUnavailableError(attachmentRefusal);
        dropped.push(attachmentRefusal);
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
            webPolicy: routePolicy,
            access: requiredAccess,
          }),
          denyRequirement: this.requestRequirements.resolveDenyPaths(
            id,
            (input.denyPaths?.length ?? 0) > 0,
          ),
          effortLevels: manifest.capabilities.effort_levels,
          knownModels: manifest.capabilities.known_models,
          // A selected profile's credential_kind IS the route (round-18 #2);
          // the default store's sources apply only to profile-less runs.
          authRouteEstimate:
            this.profileAuthRoute(input, id) ??
            estimateEffectiveAuthRoute(
              this.authPreferenceForHarness(input.repoRoot, id, input.authPreference),
              status.authSources,
            ),
          supportsInteractive: manifest.capabilities.interactive,
          supportsJsonSchemaOutput: manifest.capabilities.json_schema_output,
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
      } else
        dropped.push(
          `${id} (${accessSupported ? `cannot ${intent}${reason}` : `cannot enforce ${requiredAccess}`})`,
        );
    }
    if (pool.length === 0) {
      throw new HarnessUnavailableError(
        `no harness can perform '${intent}' for this mode${dropped.length ? ` (skipped: ${dropped.join(", ")})` : ""}`,
      );
    }
    const ordered = this.orderPool(pool, input, intent, statusById, ledger);
    if (ordered.length === 0) {
      throw new HarnessUnavailableError(
        `no harness remains eligible for '${intent}' after budget and quota routing`,
      );
    }
    const n = input.n ?? ordered.length;
    const out: RoutedAdapter[] = [];
    for (let i = 0; i < n; i++) out.push(ordered[i % ordered.length] as RoutedAdapter);
    this.requestRequirements.requireEffectiveBrowser(
      input.browser === true,
      out.map((lane) => lane.browserRequirement),
    );
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
    await assertRouteModelsAllowed(out, input.models, this.execRootOf(input));
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
    statusById: Map<string, { manifest?: { auth_modes?: string[] } | null }>,
    ledger?: BudgetLedger,
  ): RoutedAdapter[] {
    let ordered = pool;
    if (pool.length > 0) {
      const routeLedger = ledger ?? new BudgetLedger();
      const config = this.config(input.repoRoot).global;
      const goal = input.routingGoal ?? this.deps.routingGoal ?? config.routing.goal;
      const byId = new Map(pool.map((r) => [r.adapter.id, r]));
      // Settled cost is evidence for economy routing, never a provider quality prior.
      const metrics = loadHarnessMetrics(globalConfigDir());
      const remaining: RouterCandidate[] = pool.map((r) => {
        const authModes = statusById.get(r.adapter.id)?.manifest?.auth_modes ?? [];
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
        // A selected profile's credential_kind decides the route outright
        // (round-18 #2): an api_key profile must never inherit a
        // subscription classification from the default store's metric.
        const authMode =
          this.profileAuthRoute(input, r.adapter.id) ??
          (input.authPreference === "api_key"
            ? ("api_key" as const)
            : input.authPreference === "subscription"
              ? ("local_session" as const)
              : (metric?.last_auth_mode ?? guessedAuthMode));
        // The quota subject this candidate would actually run as (release
        // wave round-16 #2): the resolved profile id, or null for the engine
        // default — so profile A's cooldown never excludes profile B or the
        // default. A profile that does not resolve for this harness routes
        // as unknown (undefined) and stays conservatively any-subject.
        let credentialSubjectId: string | null | undefined;
        try {
          credentialSubjectId =
            this.resolveCredentialProfile(input, r.adapter.id)?.profile_id ?? null;
        } catch {
          credentialSubjectId = undefined;
        }
        return {
          harnessId: r.adapter.id,
          available: true,
          model:
            input.models?.[r.adapter.id] ??
            config.harnesses[r.adapter.id]?.default_model ??
            undefined,
          effort: input.effort ?? config.harnesses[r.adapter.id]?.effort ?? undefined,
          billingKnowledge: authMode === "api_key" ? "metered" : "unknown",
          incrementalCostUsd: authMode === "api_key" ? (metric?.avg_cost_usd ?? null) : null,
          credentialRoute:
            authMode === "api_key"
              ? "managed_api_key"
              : authMode === "local_session"
                ? "vendor_native"
                : undefined,
          credentialSubjectId,
        };
      });
      const ranked = rankHarnesses(remaining, {
        goal,
        paidFallback: config.routing.paid_fallback,
        intent,
        qualityTiers: config.routing.quality_tiers,
        ledger: routeLedger,
      })
        .map((candidate) => byId.get(candidate.harnessId))
        .filter((candidate): candidate is RoutedAdapter => Boolean(candidate));
      ordered = ranked;
    }
    if (input.primaryHarness) {
      const primary = ordered.find((r) => r.adapter.id === input.primaryHarness);
      if (primary) ordered = [primary, ...ordered.filter((r) => r !== primary)];
    }
    return ordered;
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
    contract: TaskContract,
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

  private buildContract(input: RunInput, taskId: string, mode: ModeKind): TaskContract {
    const resolvedCfg = this.config(input.repoRoot);
    const cfg = resolvedCfg.project;
    const readOnlyMode = mode === "ask" || mode === "plan" || mode === "orchestrate";
    const requestedAccess =
      input.access ?? (readOnlyMode ? "readonly" : resolvedCfg.trust.access_default);
    // Effective access is COMPUTED by the engine, never echoed from a client:
    // read-only modes clamp to readonly regardless of the request.
    const effectiveAccess: AccessProfile = readOnlyMode ? "readonly" : requestedAccess;
    // TrustConfig is USER-LEVEL only (versioned repo config must never
    // self-grant sensitive powers): unsandboxed full access requires an
    // explicit allow in ~/.claudexor trust settings — loud error, no downgrade.
    // The gate applies to the EFFECTIVE profile: a read-only run clamped to
    // readonly never runs unsandboxed and needs no trust allow.
    if (effectiveAccess === "full" && !resolvedCfg.trust.allow_full_access) {
      // Typed refusal: the `code` rides the daemon job record onto the thread
      // turn (TurnEnqueueError.code), so surfaces key remedies on the CODE —
      // never on substring-matching this human message.
      throw Object.assign(
        new Error(
          `access profile 'full' requires allow_full_access: true in the user-level trust file for this repo ` +
            `(${trustConfigPath(input.repoRoot)}); enable it with \`claudexor trust --allow-full-access\` — refusing to run unsandboxed`,
        ),
        // Refusal semantics are born at the throw (W24): the one-time grant is
        // a 403, and the daemon persists this status onto the job record.
        { code: TRUST_FULL_ACCESS_CODE, status: 403 },
      );
    }
    const externalContextPolicy = input.web ?? input.externalContextPolicy ?? "auto";
    // Deterministic gate commands come from explicit run input, then versioned
    // project config. Without these, gateSpecs is empty and convergence is
    // review-only; with them, convergence is test-driven.
    const resolvedGates = resolveContractGates({
      repoRoot: input.repoRoot,
      effectiveAccess,
      config: cfg,
      trustGrants: resolvedCfg.trust.test_command_grants,
      operatorCommands: input.tests ?? [],
      projectCommands: cfg.tests?.commands ?? [],
    });
    const commands = resolvedGates.commands;
    const protectedPaths: string[] = [];
    const autoProtectedPaths = resolvedGates.autoProtectedPaths;
    const protectedPathApprovals = [
      ...new Map(
        [...(input.protectedPathApprovals ?? [])].map((approval) => [approval.path, approval]),
      ).values(),
    ];
    return TaskContractSchema.parse({
      schema_version: SCHEMA_VERSION,
      task_id: taskId,
      created_at: nowIso(),
      repo: { root: input.repoRoot, base_ref: input.baseRef ?? "HEAD", dirty_policy: "snapshot" },
      mode: { kind: mode },
      user_intent: { raw: redactSecrets(input.prompt) },
      // Redacted for symmetry with user_intent.raw — a no-op on fenced input
      // (the inline-secret fence already blocked any secret-like value at every
      // ingress incl. this engine boundary), so task-producing lanes read back
      // the real instructions via harnessSpecKnobs().
      instructions:
        input.instructions === undefined ? undefined : redactSecrets(input.instructions),
      // Already normalized/strictified at the engine boundary (run() refuses
      // unsupported shapes before any run dir exists).
      output_schema: input.outputSchema ?? null,
      auth_preference: input.authPreference ?? "auto",
      credential_profile_id: input.credentialProfileId ?? null,
      max_turns: input.maxTurns ?? null,
      constraints: {
        protected_paths: protectedPaths,
        deny_paths: [...new Set(input.denyPaths ?? [])],
        auto_protected_paths: autoProtectedPaths,
        protected_path_approvals: protectedPathApprovals,
      },
      tests: { commands },
      access: {
        requested_profile: requestedAccess,
        effective_profile: effectiveAccess,
      },
      external_context: {
        policy: externalContextPolicy,
        web_required: externalContextPolicy === "cached" || externalContextPolicy === "live",
        // Per-route upgrades (e.g. claude cached->live) are disclosed in events
        // and telemetry.yaml; the immutable contract records the requested policy.
        effective_mode: externalContextPolicy,
      },
      // Harness-native tool names are adapter knowledge; the neutral contract
      // carries only the policy plus user-configured allow/deny lists (wired
      // from per-harness settings).
      tool_permission_policy: {
        web: externalContextPolicy,
        allow: [],
        deny: [],
      },
      budget: {
        routing_goal:
          input.routingGoal ?? this.deps.routingGoal ?? cfg?.budget?.routing_goal ?? "auto",
        paid_budget: this.resolvePaidBudget(input.paidBudget, resolvedCfg),
      },
      // The resolved harness-scoped model map (scalar already expanded to the
      // primary by resolveRunInput). The contract is what route spec building
      // reads — there is no run-global model (INV-103).
      routing_models: input.models ?? {},
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
  private harnessSpecKnobs(
    contract: TaskContract,
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
      // synthesis (its answer can become the final one); the orchestrate
      // planner owns its own plan schema instead (set at its spec site). The
      // adapter gets the vendor-STRICT transport form; the engine validator
      // keeps the ORIGINAL contract as the conformance authority.
      ...(intent !== "orchestrate" && contract.output_schema
        ? { output_schema: strictifyOutputSchema(contract.output_schema) }
        : {}),
    };
  }

  private routeSpecKnobs(
    routed: RoutedAdapter,
    contract: TaskContract,
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
    // Effort disclosure (INV-105): a requested effort on a harness with no
    // declared ladder is DISCLOSED as ignored, never silently dropped.
    let effort = effortHint ?? s?.effort ?? null;
    if (effort && routed.effortLevels.length === 0) {
      ignored.push(
        `effort=${effort} (manifest capabilities.effort_levels is empty for ${routed.adapter.id})`,
      );
      effort = null;
    }
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

  private async runCandidateInEnvelope(
    routed: RoutedAdapter,
    envelope: WorkspaceEnvelope,
    attemptId: string,
    label: string,
    contract: TaskContract,
    prompt: string,
    store: ArtifactStore,
    paths: ReturnType<ArtifactStore["runPaths"]>,
    wsm: WorkspaceManager,
    ledger: BudgetLedger,
    access: AccessProfile = "workspace_write",
    onHarnessEvent?: (event: HarnessEvent) => void,
    signal?: AbortSignal,
    modelHint?: string,
    effortHint?: EffortHint,
    intent: Intent = "implement",
    log?: EventLog,
    effectiveWebMode?: ExternalContextPolicy,
    interaction?: InteractionChannel,
    budgetGuard?: (streamedUsd: number) => boolean,
    runInput?: RunInput,
    streamDeltas = false,
    fileBackedContext?: string,
  ): Promise<CandidateRun> {
    const adapter = routed.adapter;
    const knobs = this.routeSpecKnobs(routed, contract, modelHint, effortHint);
    // Isolated scoped-home sessions are never retained after disposal.
    const inPlaceEnvelope = envelope.worktree_path === envelope.repo_root;
    const rawContextPacket = await rawContextForEnvelope(routed.implementationTransport, envelope);
    const sessionFields = runInput ? this.sessionSpecFields(runInput, adapter.id, log) : undefined;
    let spec = HarnessRunSpec.parse({
      session_id: newId("ses"),
      intent,
      prompt: promptWithProtectedPathConstraint(
        prompt,
        contract.constraints.protected_paths,
        contract.constraints.auto_protected_paths,
        contract.constraints.protected_path_approvals,
      ),
      attachments: runInput?.attachments ?? [],
      browser: this.requestRequirements.browserSpec(
        routed.browserRequirement,
        join(paths.root, "browser"),
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
      // Scoped harness home only for isolated envelopes; in-place runs use the
      // native environment so the resumed vendor session is actually reachable.
      ...(inPlaceEnvelope ? {} : { env: wsm.envFor(envelope) }),
      raw_context_packet: rawContextPacket,
      stream_deltas: streamDeltas,
    });
    if (!inPlaceEnvelope && runInput?.threadId && sessionFields?.resume_session_id) {
      log?.emit(
        "session.rebound",
        SessionReboundLineageSchema.parse({
          thread_id: runInput.threadId,
          harness_id: adapter.id,
          from_native_session_id: sessionFields.resume_session_id,
          to_session_id: null,
          summary:
            "isolated envelope turn runs fresh: the native session is not portable into a scoped harness home; continuity rides on the thread prompt + repo state",
          reason: "not_portable",
        }) as unknown as Record<string, unknown>,
      );
    }
    if (interaction) spec.extra["interactionChannel"] = interaction;
    const inactivityMs = harnessInactivityTimeoutMs(this.config(contract.repo.root));

    const attemptStartedMs = Date.now();
    const budgetSignalState = { quotaPressureDisclosed: false };
    const triedProfiles = new Set<string>(); // W5.4 failover: each profile at most once
    let cost = 0;
    let costEstimated = false;
    let harnessErrored = false;
    // W-C4 delta flood budget (per attempt): counts forwarded delta chunks.
    let deltaCount = 0;
    let deltaCutoffDisclosed = false;
    const errors: string[] = [];
    const answer = new AnswerAssembly();
    const retryPolicy = transientRetryPolicy(this.config(contract.repo.root));
    const telemetry = createAttemptTelemetry(
      knobs.webPolicy,
      contract.external_context.web_required ||
        knobs.webPolicy === "cached" ||
        knobs.webPolicy === "live",
      effectiveWebMode ?? knobs.webPolicy,
      [routed.browserRequirement, routed.denyRequirement],
      knobs.model,
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
          const watched = withInactivityWatchdog(adapter.run(runSpec), {
            timeoutMs: inactivityMs,
            onTimeout: () => {
              attemptAbort.abort();
              void adapter.cancel?.(activeSessionId)?.catch(() => {});
            },
            // Waiting on the USER (pending interaction) is legitimate
            // silence — the interaction channel enforces its own wait budget.
            isSuspended: () => (interaction?.pendingCount?.() ?? 0) > 0,
          });
          for await (const ev of watched) {
            if (signal?.aborted) break;
            rawPatch = captureRawPatchEnvelope(rawContextPacket !== null, rawPatch, ev);
            if (ev.type === "patch_produced") continue;
            const safeEv = redactHarnessEvent(ev);
            // W-C4 flood guard (review sol #10): a per-character delta stream
            // would otherwise persist/SSE one journal event PER CHUNK without
            // bound. Delta messages are DISPLAY-only (the complete message
            // still follows and carries the authoritative text), so past a
            // per-attempt budget we DROP further deltas and disclose the
            // cutoff ONCE — the final answer is unaffected.
            if (safeEv.type === "message" && safeEv.payload?.["delta"] === true) {
              deltaCount += 1;
              if (deltaCount > Orchestrator.MAX_DELTAS_PER_ATTEMPT) {
                if (!deltaCutoffDisclosed) {
                  deltaCutoffDisclosed = true;
                  log?.emit("harness.event", {
                    harness_id: adapter.id,
                    attempt_id: attemptId,
                    type: "status",
                    title: `live delta stream capped at ${Orchestrator.MAX_DELTAS_PER_ATTEMPT} chunks; the complete message still lands`,
                  });
                }
                continue; // drop this delta; never journal past the budget
              }
            }
            safeInvoke(onHarnessEvent, safeEv);
            // In-place turns run in the live tree under the native environment, so
            // the session they emit IS reachable for the next turn: record it. An
            // ISOLATED envelope-born session lives in the scoped home that dispose()
            // deletes, so observing it would poison the thread resume map with
            // unreachable ids — skip it there.
            if (inPlaceEnvelope) observeNativeSessionEvent(runInput, adapter.id, safeEv);
            observeAuthSwitch(log, adapter.id, attemptId, safeEv);
            observeAttemptTelemetry(telemetry, safeEv);
            // Live plan checklist: forward the adapter's typed plan
            // progress as a run event (LAST WINS; the UI renders the latest).
            if (safeEv.plan_progress) {
              log?.emit("plan.progress", {
                attempt_id: attemptId,
                harness_id: adapter.id,
                items: safeEv.plan_progress.items,
              });
            }
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
          // error here and let the caller settle the REAL accumulated spend.
          harnessErrored = true;
          errors.push(safeErrorMessage(err));
        } finally {
          clearFileBackedContext();
        }

        const transient = telemetry.transientFailures.at(-1) ?? null;
        const sawTransient = telemetry.transientFailures.length > transientStart;
        const sawTypedLimit = telemetry.rateLimits.length > rateLimitStart;
        const currentDiff = await wsm.diff(envelope);
        const currentAnswer = answer.text();
        const deliverableEmpty = currentDiff.trim().length === 0 && currentAnswer.length === 0;
        // W5.4 failover: a typed-limit hit rebuilds the spec on a NEW vendor
        // session under the next profile with provenance (vendor_limit_rejected).
        if (harnessErrored && runInput && !signal?.aborted) {
          const rotated = rotateSpecOnTypedLimit({
            spec,
            harnessId: adapter.id,
            attemptId,
            policy: this.profilePolicy(contract.repo.root, adapter.id),
            registry: this.config(contract.repo.root)?.global.credential_profiles ?? [],
            snapshots: this.deps.quotaSnapshots?.() ?? [],
            triedProfiles,
            sawTypedLimit,
            deliverableEmpty,
            lastLimit: telemetry.rateLimits.at(-1) ?? null,
            emit: (type, payload) => log?.emit(type, payload),
            newSessionId: () => newId("ses"),
            defaultRouteWasVendorNative: routed.authRouteEstimate === "local_session",
          });
          if (rotated) {
            spec = rotated;
            errors.length = 0;
            harnessErrored = false;
            continue;
          }
        }
        if (
          !harnessErrored ||
          !sawTransient ||
          !deliverableEmpty ||
          nativeTry >= retryPolicy.maxRetries ||
          signal?.aborted
        )
          break;

        const nextTry = nativeTry + 1;
        const delayMs = transientRetryDelayMs(
          transient?.retryDelayMs ?? null,
          retryPolicy,
          nativeTry,
        );
        log?.emit("route.transient.detected", {
          harness_id: adapter.id,
          attempt_id: attemptId,
          kind: transient?.kind ?? "unknown",
          native_try: nativeTry + 1,
        });
        log?.emit("route.transient.retry_scheduled", {
          harness_id: adapter.id,
          attempt_id: attemptId,
          retry: nextTry,
          delay_ms: delayMs,
        });
        errors.length = 0;
        harnessErrored = false;
        await sleep(delayMs);
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    if (harnessErrored && telemetry.transientFailures.length > 0) {
      log?.emit("route.transient.exhausted", {
        harness_id: adapter.id,
        attempt_id: attemptId,
        retries: retryPolicy.maxRetries,
      });
    }
    const attemptStreamEndedMs = Date.now();
    if (webUnsatisfied(telemetry)) {
      errors.push(
        `web evidence unsatisfied: ${telemetry.web.errorSummary ?? (telemetry.web.attempted ? "web tool failed without verified recovery" : "web evidence required but never attempted")}`,
      );
    }

    const diff = await wsm.diff(envelope);
    const answerText = answer.text() || undefined;
    const deliverablePresent = diff.trim().length > 0 || Boolean(answerText);
    // Cancelled attempts skip gates entirely: the operator asked to
    // stop NOW; running a 600s-per-gate suite after the abort delays the ack
    // and burns compute on a result nobody will adopt. Diff/attempt.yaml
    // still land, so partial work stays inspectable.
    const gateSignalAborted = signal?.aborted === true;
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
    const errored = harnessErrored || webBlocked;
    setAttemptOutcome(telemetry, {
      deliverablePresent,
      gatesPassed: gates.length > 0 ? gatesPassed(gates) : null,
      harnessErrored,
      webRequiredUnsatisfied: webBlocked,
    });

    const attemptDir = join(paths.attemptsDir, attemptId);
    try {
      assertNoSecretLikeTokens("candidate patch diff", diff);
    } catch (err) {
      // The stream already settled real spend; a post-stream assertion throw
      // must carry it so the slot catch settles the TRUE cost, not 0.
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { costUsd: cost });
    }
    recordCleanAttemptMetrics(globalConfigDir(), adapter.id, {
      costUsd: cost,
      streamMs: attemptStreamEndedMs - attemptStartedMs,
      errored,
      aborted: signal?.aborted === true,
      authMode: telemetry.authMode,
    });
    const producedFiles = writeCandidateAttemptArtifacts({
      store,
      attemptDir,
      worktreePath: envelope.worktree_path,
      diff,
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
        gates: gates.map((g) => ({ id: g.id, status: g.status })),
        branch: envelope.branch_name,
      },
    });
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
   * Guarantee a git boundary for write-mode runs. Non-git project folders are
   * initialized in place (`git init`, deterministic baseline commit) without
   * creating or editing `.gitignore`, and the action is announced via a
   * `project.git.initialized` event. Returns the failure message when the
   * boundary cannot be established (the terminal failure events are already
   * emitted); null on success.
   */
  private async ensureWriteModeGitBoundary(
    repoRoot: string,
    log: EventLog,
    store: ArtifactStore,
    paths: ReturnType<ArtifactStore["runPaths"]>,
    runId: string,
    mode: ModeKind,
  ): Promise<string | null> {
    if (repoRoot === NO_PROJECT_ROOT) return null;
    try {
      const result = await ensureGitRepository(repoRoot);
      if (result.initialized || result.baselineCommitted) {
        log.emit("project.git.initialized", {
          repo_root: repoRoot,
          initialized: result.initialized,
          baseline_committed: result.baselineCommitted,
          gitignore_seeded: result.gitignoreSeeded,
          head_sha: result.headSha,
        });
      }
      return null;
    } catch (err) {
      const message = safeErrorMessage(err);
      writeFailure(store, paths, {
        phase: "workspace",
        category: "project",
        safeMessage: message,
        runDir: paths.root,
        nextActions: [
          "Check the project folder permissions",
          "Initialize git manually (git init)",
          "Retry the run",
        ],
      });
      store.writeText(
        join(paths.finalDir, "summary.md"),
        `# Run ${runId} (${mode})\n\n- Lifecycle: failed\n- Phase: workspace\n\n${message}\n`,
      );
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      log.emit("run.failed", {
        lifecycle: "failed",
        facts: makeOutcomeFacts("failed", { reason: "harness_failed" }),
        reason: "harness_failed",
        phase: "workspace",
        error: message,
        failure_ref: "final/failure.yaml",
      });
      return message;
    }
  }

  /**
   * Freeze-on-implement delivery (D17/D27): verify the frozen plan's hash and
   * materialize it as context/PLAN.md in the run artifact tree — OUTSIDE every
   * worktree, so it can never dirty a diff — then point the prompt at the
   * absolute path. A mismatched or unreadable plan fails LOUDLY before any
   * harness spawns (the tamper fence; retry replays planRef verbatim, so a
   * retried implement can never silently run without its plan).
   */
  private withPlanBrief(
    input: RunInput,
    store: ArtifactStore,
    paths: RunPaths,
    log: EventLog,
  ): RunInput {
    if (!input.planRef) return input;
    const text = readTextSafe(input.planRef.path);
    if (!text || !text.trim()) {
      throw new Error(
        `implement plan: the frozen plan at ${input.planRef.path} is missing or unreadable`,
      );
    }
    const digest = sha256(text).replace(/^sha256:/, "");
    if (digest !== input.planRef.sha256) {
      throw new Error(
        `implement plan: plan hash mismatch (expected ${input.planRef.sha256}, got ${digest}) — the plan was modified after freeze; re-run Implement from the plan turn`,
      );
    }
    const briefPath = join(paths.contextDir, "PLAN.md");
    store.writeText(briefPath, text);
    log.emit("plan.brief.materialized", {
      plan_run_id: input.planRef.runId,
      sha256: input.planRef.sha256,
      path: "context/PLAN.md",
    });
    return {
      ...input,
      prompt: `${input.prompt}\n\nThe approved plan is at: ${briefPath} — read it before starting and re-read it as needed.`,
    };
  }

  private async runRace(
    input: RunInput,
    mode: ModeKind,
    announce?: (a: AnnouncedRunContext) => void,
  ): Promise<OrchestratorResult> {
    const taskId = input.taskId ?? newId("task");
    const runId = input.runId ?? newId("run");
    // Contract validation (trust gates, secret scans) runs BEFORE the run is
    // announced: a refused run must fail the request loudly, not 200 a runId
    // and leave an orphaned run dir without a terminal event.
    const contract = this.buildContract(input, taskId, mode);
    const store = this.artifactStore(input);
    const paths = store.createRun(runId);
    const log = new EventLog(paths.eventsPath, runId, taskId, input.onEvent, input.threadId);
    input = this.withPlanBrief(input, store, paths, log);
    // The execution root is the tree the harness mutates: the project itself for
    // in-place threads/ordinary runs, or the thread's persistent worktree for an
    // isolated thread. Config/artifacts/contract stay anchored to repoRoot. Both
    // the WorkspaceManager and the git boundary resolve against this SINGLE root.
    const execRoot = this.execRootOf(input);
    const wsm = new WorkspaceManager(execRoot);

    safeInvoke(input.onRunStart, { runId, taskId, runDir: paths.root });
    log.emit("run.created", { mode, prompt: redactSecrets(input.prompt) });
    const ledger = this.rootLedger(input, contract, log);
    announce?.({
      log,
      store,
      paths,
      runId,
      taskId,
      mode,
      phase: "race",
      spend: () => ledger.spend(),
    });
    store.writeYaml(join(paths.contextDir, "task.yaml"), contract);
    log.emit("task.contract.created", { task_contract_hash: hashJson(contract) });

    // Write modes need a git boundary for worktree isolation and honest diffs.
    // A non-git project folder is initialized automatically (gitignore seed +
    // baseline commit), announced in the timeline — never a refusal, never a
    // silent mutation (user-locked decision, comparator: Codex requires git).
    // For an isolated thread the execution root is already a git worktree, so
    // this is a no-op there; for in-place it ensures the live project is git.
    const gitPreconditionError = await this.ensureWriteModeGitBoundary(
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
        facts: makeOutcomeFacts("failed", { reason: "harness_failed" }),
        winner: null,
        runDir: paths.root,
        summary: gitPreconditionError,
        candidates: [],
      };
    }
    // Pre-turn snapshot of the live tree for in-place runs: the revert restore
    // target (server-owned revertInPlace). A snapshot failure must never fail the
    // run — revert is simply unavailable then.
    let preTurnSha: string | null = null;
    if (input.inPlace === true) {
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
      adapters = await this.resolveCandidateAdapters(input, this.candidateIntent(input), ledger);
    } catch (err) {
      const message = safeErrorMessage(err);
      store.writeText(
        join(paths.contextDir, "context_error.md"),
        `# Routing Error\n\n${message}\n`,
      );
      writeFailure(store, paths, {
        phase: "routing",
        category: "harness_unavailable",
        safeMessage: message,
        runDir: paths.root,
      });
      store.writeText(
        join(paths.finalDir, "summary.md"),
        `# Run ${runId} (${mode})\n\n- Lifecycle: failed\n- Phase: routing\n\n${message}\n`,
      );
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      log.emit("run.failed", {
        lifecycle: "failed",
        facts: makeOutcomeFacts("failed", { reason: "harness_failed" }),
        reason: "harness_failed",
        phase: "routing",
        error: message,
        failure_ref: "final/failure.yaml",
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
          i > 0 ? this.estimateUsdFloor(input.repoRoot) : undefined,
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
            input.inPlace === true &&
            requestedSingleCandidate &&
            slot.routed.implementationTransport !== "git_patch_envelope",
        });
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
          status: run.errored ? "failed" : "success",
          cost_usd: run.cost,
          ...telemetrySummary(run.telemetry),
        });
        runsBySlot[slotIdx] = run;
        reviewEnvelopes.push(envelope);
        envelope = undefined;
      } catch (err) {
        // Envelope creation (or another pre-stream step) failed; stream errors
        // are absorbed inside runCandidateInEnvelope with their real cost. A
        // post-stream throw (e.g. the secret-token assertion) carries its
        // streamed spend on the error — settle the TRUE cost, never launder
        // real spend down to 0.
        const carriedCost =
          typeof (err as { costUsd?: unknown })?.costUsd === "number"
            ? (err as { costUsd: number }).costUsd
            : 0;
        ledger.settle(slot.leaseId, unknownCostSettlement("post-stream-error", carriedCost));
        const message = safeErrorMessage(err);
        // envelope is still undefined when wsm.create() itself threw — that is
        // a workspace-phase infrastructure failure, not a harness error.
        const infraPhase: "workspace" | "harness" =
          envelope === undefined ? "workspace" : "harness";
        log.emit("harness.completed", {
          harness_id: adapter.id,
          attempt_id: slot.attemptId,
          status: "failed",
          error: message,
          phase: infraPhase,
        });
        // Minimal attempt record so failure.yaml's rawDetailRef never dangles.
        store.writeYaml(join(paths.attemptsDir, slot.attemptId, "attempt.yaml"), {
          attempt_id: slot.attemptId,
          harness_id: adapter.id,
          cost_usd: carriedCost,
          errored: true,
          phase: infraPhase,
          errors: [message],
        });
        runsBySlot[slotIdx] = {
          attemptId: slot.attemptId,
          harnessId: adapter.id,
          label: slot.label,
          diff: "",
          gates: [],
          cost: 0,
          errored: true,
          costEstimated: false,
          errors: [message],
          telemetry: createAttemptTelemetry(
            knobs.webPolicy,
            contract.external_context.web_required,
            effectiveWeb,
            [slot.routed.browserRequirement, slot.routed.denyRequirement],
            knobs.model,
          ),
          infraPhase,
        };
      } finally {
        if (envelope) await wsm.dispose(envelope); // no worktree leak even on create/run error
      }
    };
    await runBounded(slots, Math.min(slots.length, MAX_PARALLEL_CANDIDATES), runSlot);
    const runs: CandidateRun[] = runsBySlot.filter((r): r is CandidateRun => r !== undefined);
    const cancelledCandidates = () =>
      runs.map((r) => ({
        attemptId: r.attemptId,
        harnessId: r.harnessId,
        status: gatesPassed(r.gates) && !r.errored ? "green" : "red",
      }));

    // Revert divergence fence for the single-candidate in-place path: the
    // candidate mutated the LIVE tree during execution above, so the post-turn
    // snapshot must be taken NOW — before review/synthesis/arbitration, which can
    // run for a long time during which the user may edit files. Snapshotting after
    // arbitration (as the race-adoption path does) would fold those user edits
    // into the revert target and let a later revert clobber them.
    let earlyPostTurnSha: string | null = null;
    if (input.inPlace === true && requestedSingleCandidate) {
      try {
        earlyPostTurnSha = await snapshotTree(execRoot);
      } catch {
        earlyPostTurnSha = null;
      }
    }

    if (input.signal?.aborted) {
      await disposeReviewEnvelopes();
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
            runs.map((r) => ({
              attemptId: r.attemptId,
              harnessId: r.harnessId,
              telemetry: r.telemetry,
            })),
            null,
          ),
        ledger.spend(),
        input.signal,
        store,
      );
    }

    if (runs.length === 0) {
      const budgetReason = ledger.terminal();
      const facts = makeOutcomeFacts("failed", {
        reason: budgetReason ?? (budgetStopped ? "budget_exhausted" : "harness_failed"),
        noChanges: true,
      });
      const why = budgetStopped
        ? "budget exhausted before any candidate run"
        : "no candidates produced";
      store.writeYaml(join(paths.arbitrationDir, "decision.yaml"), {
        winner: null,
        facts,
        why_winner: why,
        evidence_facts: ["no candidates were produced"],
        apply_recommendation: "continue",
        budget_summary: { spend_usd: ledger.spend(), estimated: false },
      });
      store.writeText(
        join(paths.finalDir, "summary.md"),
        `# Run ${runId} (${mode})\n\n- Lifecycle: ${facts.lifecycle}${facts.reason ? ` (${facts.reason})` : ""}\n- Phase: budget\n\n${why}\n`,
      );
      writeFailure(store, paths, {
        phase: "budget",
        category: isBudgetTerminal(facts.reason) ? "budget" : "internal",
        safeMessage: why,
        runDir: paths.root,
      });
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      log.emit("run.failed", {
        lifecycle: facts.lifecycle,
        facts,
        reason: facts.reason,
        phase: "budget",
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
    const workingRuns = runs.filter((r) => !r.errored || r.diff.length > 0);
    if (workingRuns.length === 0) {
      await disposeReviewEnvelopes();
      const first = runs[0] as CandidateRun;
      const phase = first.infraPhase ?? "harness";
      const rootCause = runs
        .map(
          (r) => `${r.attemptId}/${r.harnessId}: ${r.errors[0] ?? "failed before producing work"}`,
        )
        .join("; ");
      const facts = makeOutcomeFacts("failed", { reason: "harness_failed", noChanges: true });
      store.writeYaml(join(paths.arbitrationDir, "decision.yaml"), {
        winner: null,
        facts,
        why_winner: rootCause,
        evidence_facts: runs.map(
          (r) => `${r.attemptId} produced no work: ${r.errors[0] ?? "unknown"}`,
        ),
        apply_recommendation: "continue",
        budget_summary: { spend_usd: ledger.spend(), estimated: false },
      });
      this.writeRunTelemetry(
        store,
        paths,
        contract,
        runId,
        taskId,
        mode,
        runs.map((r) => ({
          attemptId: r.attemptId,
          harnessId: r.harnessId,
          telemetry: r.telemetry,
        })),
        null,
      );
      store.writeText(
        join(paths.finalDir, "summary.md"),
        `# Run ${runId} (${mode})\n\n- Lifecycle: ${facts.lifecycle}\n- Phase: ${phase}\n\n${rootCause}\n`,
      );
      const existingEventRefs = runs
        .map((r) => `attempts/${r.attemptId}/events.jsonl`)
        .filter((rel) => existsSync(join(paths.root, rel)));
      writeFailure(store, paths, {
        phase,
        category: phase === "workspace" ? "project" : "harness_error",
        harnessId: first.harnessId,
        attemptId: first.attemptId,
        safeMessage: rootCause,
        rawDetailRef: `attempts/${first.attemptId}/attempt.yaml`,
        eventRefs: existingEventRefs,
        runDir: paths.root,
        nextActions:
          phase === "workspace"
            ? ["Check the project folder", "Open diagnostics", "Retry the run"]
            : ["Open diagnostics", "Check harness authentication", "Retry the run"],
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

    log.emit("review.started", { reviewers: reviewers.length, review_verified: reviewVerified });
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
            runs.map((r) => ({
              attemptId: r.attemptId,
              harnessId: r.harnessId,
              telemetry: r.telemetry,
            })),
            null,
          ),
        ledger.spend(),
        input.signal,
        store,
      );
    }

    // Synthesis: if worthwhile, run a synthesizer as a NEW, re-checked candidate.
    const synth = decideSynthesis(evidences, input.synthesis ?? "auto");
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
          undefined,
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
          try {
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
            );
            evidences.push(...synthEvidence);
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
                    runs.map((r) => ({
                      attemptId: r.attemptId,
                      harnessId: r.harnessId,
                      telemetry: r.telemetry,
                    })),
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
          runs.push(run);
          workingRuns.push(run);
        } catch (err) {
          ledger.settle(lease.lease?.lease_id ?? "", unknownCostSettlement("synthesis-error"));
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
            runs.map((r) => ({
              attemptId: r.attemptId,
              harnessId: r.harnessId,
              telemetry: r.telemetry,
            })),
            null,
          ),
        ledger.spend(),
        input.signal,
        store,
      );
    }

    let result: ReturnType<typeof arbitrate>;
    try {
      result = arbitrate(evidences, {
        spendUsd: ledger.spend(),
        estimatedSpend: runs.some((r) => r.costEstimated),
      });
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
    });

    // Winner can only be a candidate that actually produced work; corpses are
    // excluded from arbitration upstream and from the fallback here.
    const winnerRun =
      workingRuns.find((r) => r.attemptId === result.decision.winner) ?? workingRuns[0];
    // A reviewer escalation to a human is a BLOCKED terminal, not a silent risk note.
    const needsHuman = evidences.some((e) =>
      e.findings.some((f) => f.severity === "NEEDS_HUMAN" && isBlocking(f)),
    );
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
        ? blockedDecisionOverride(result.decision.evidence_facts, finalVerify)
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
      assertNoSecretLikeTokens("final patch diff", winnerRun.diff);
      const patchSha256 = sha256(winnerRun.diff);
      store.writeText(join(paths.finalDir, "patch.diff"), winnerRun.diff);
      const wstats = diffStats(winnerRun.diff);
      const hasDiff = winnerRun.diff.trim().length > 0;
      const winnerEvidence = evidences.find((e) => e.attemptId === winnerRun.attemptId);
      const blockers = winnerEvidence
        ? winnerEvidence.findings.filter((f) => isBlocking(f)).length
        : 0;
      // Prose from an empty-diff winner is an answer, never a patch.
      const winnerAnswer = winnerRun.answerText?.trim() ?? "";
      const resultKind = hasDiff ? "patch" : winnerAnswer.length > 0 ? "answer" : "none";
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
      // Only a fully verified, applyable success may auto-adopt; a not-verified
      // or needs-decision terminal remains an inspectable artifact.
      const adoptable =
        facts.lifecycle === "succeeded" && facts.review === "approved" && facts.checks !== "failed";
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
      runs.map((r) => ({ attemptId: r.attemptId, harnessId: r.harnessId, telemetry: r.telemetry })),
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
      writeFailure(store, paths, {
        phase: needsHuman ? "review" : "arbitration",
        category: needsHuman
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
          : result.decision.why_winner,
        rawDetailRef: winnerRun?.errored
          ? `attempts/${winnerRun.attemptId}/attempt.yaml`
          : undefined,
        runDir: paths.root,
        nextActions: needsHuman
          ? [
              "Open the review queue",
              "Decide the NEEDS_HUMAN findings",
              "Re-run after the decision",
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

    log.emit("work_product.emitted", { winner: result.decision.winner });
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
    contract: TaskContract,
    runId: string,
    taskId: string,
    mode: ModeKind,
    attempts: { attemptId: string; harnessId: string; telemetry: AttemptTelemetry }[],
    finalAttemptId: string | null,
  ): void {
    writeRunTelemetryArtifact({
      store,
      finalDir: paths.finalDir,
      contract,
      runId,
      taskId,
      mode,
      attempts,
      finalAttemptId,
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
    contract: TaskContract,
    store: ArtifactStore,
    paths: ReturnType<ArtifactStore["runPaths"]>,
    log: EventLog,
    ledger?: BudgetLedger,
    taskId?: string,
    signal?: AbortSignal,
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
        const reviewLease = hasDiff
          ? ledger?.reserve({
              taskId: taskId ?? "task",
              attemptId: run.attemptId,
              intent: "review",
              harnessId: "review-panel",
              cost: attemptCostEvidence("review-panel", run.attemptId),
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
                reviewValuationUsd: 0,
                reviewUnknownUsd: 0,
              };
        if (reviewLease?.granted) {
          ledger?.settle(
            reviewLease.lease?.lease_id ?? "",
            reviewUsageCostSettlement(
              result.reviewCashUsd,
              result.reviewValuationUsd,
              result.reviewSpendEstimated,
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
    announce?: (a: AnnouncedRunContext) => void,
  ): Promise<OrchestratorResult> {
    const taskId = input.taskId ?? newId("task");
    const runId = input.runId ?? newId("run");
    // Contract validation BEFORE the run is announced (see runRace).
    const contract = this.buildContract(input, taskId, mode);
    const store = this.artifactStore(input);
    const paths = store.createRun(runId);
    const log = new EventLog(paths.eventsPath, runId, taskId, input.onEvent, input.threadId);
    input = this.withPlanBrief(input, store, paths, log);
    // The execution root is the tree the harness mutates (thread worktree for an
    // isolated thread, else the project). The WorkspaceManager AND the git
    // boundary must resolve against the SAME root — the race path does so via the
    // local `execRoot`; this path previously ensured the boundary on repoRoot,
    // which for an isolated thread is the project, not the mutated worktree.
    const execRoot = this.execRootOf(input);
    const wsm = new WorkspaceManager(execRoot);
    const readiness = new ReadinessLedger();
    const ledger = this.rootLedger(input, contract, log);
    store.writeYaml(join(paths.contextDir, "task.yaml"), contract);
    safeInvoke(input.onRunStart, { runId, taskId, runDir: paths.root });
    log.emit("run.created", { mode, prompt: redactSecrets(input.prompt) });
    announce?.({
      log,
      store,
      paths,
      runId,
      taskId,
      mode,
      phase: "convergence",
      spend: () => ledger.spend(),
    });

    // Live (in-place) isolation deliberately tolerates non-git stateful
    // environments; only envelope isolation needs the git boundary.
    if (!input.inPlace) {
      const gitPreconditionError = await this.ensureWriteModeGitBoundary(
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
          facts: makeOutcomeFacts("failed", { reason: "harness_failed" }),
          winner: null,
          runDir: paths.root,
          summary: gitPreconditionError,
          candidates: [],
        };
      }
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
      );
      this.requestRequirements.assertConvergenceWorkspace(input.inPlace === true, adapterPool);
    } catch (err) {
      const message = safeErrorMessage(err);
      store.writeText(
        join(paths.contextDir, "context_error.md"),
        `# Routing Error\n\n${message}\n`,
      );
      writeFailure(store, paths, {
        phase: "routing",
        category: "harness_unavailable",
        safeMessage: message,
        runDir: paths.root,
      });
      store.writeText(
        join(paths.finalDir, "summary.md"),
        `# Run ${runId} (${mode})\n\n- Lifecycle: failed\n- Phase: routing\n\n${message}\n`,
      );
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      log.emit("run.failed", {
        lifecycle: "failed",
        facts: makeOutcomeFacts("failed", { reason: "harness_failed" }),
        reason: "harness_failed",
        phase: "routing",
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
    // Fail fast on a provably unwinnable predicate instead of burning paid
    // rounds: the default convergence predicate requires a clean cross-family
    // review, which needs >=2 healthy reviewer provider families.
    if (contract.convergence.require_final_cross_family_clean_review && !reviewVerified) {
      const message =
        `convergence requires a cross-family clean review (>=2 healthy reviewer provider families); found ${new Set(reviewers.map((r) => r.providerFamily)).size}. ` +
        "Configure reviewers for a second provider family, or run with a convergence predicate that does not require cross-family review.";
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
    const allCooledDown = () => adapterPool.every((a) => ledger.cooldownActive(a.adapter.id));
    const attemptTelemetries: {
      attemptId: string;
      harnessId: string;
      telemetry: AttemptTelemetry;
    }[] = [];
    let lastDiffStable = true;
    let reviewSpendEstimated = false;

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
            : `${input.prompt}\n\nThe previous attempt did not converge. Address these review findings (verify each against the code; fix valid ones, rebut invalid ones with evidence):\n${formatFindings(lastFindings)}${runtimeErrors}`;

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
            undefined,
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
        try {
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
            status: run.errored ? "failed" : "success",
            cost_usd: run.cost,
            ...telemetrySummary(run.telemetry),
          });
        } catch (err) {
          // Envelope/setup failure before the stream; stream errors are absorbed
          // inside runCandidateInEnvelope with their real accumulated cost.
          ledger.settle(lease.lease?.lease_id ?? "", unknownCostSettlement("attempt-error"));
          log.emit("harness.completed", {
            harness_id: adapter.id,
            attempt_id: attemptId,
            status: "failed",
            error: safeErrorMessage(err),
          });
          run = {
            attemptId,
            harnessId: adapter.id,
            label: `Attempt ${attempt}`,
            diff: "",
            gates: [],
            cost: 0,
            errored: true,
            costEstimated: false,
            errors: [safeErrorMessage(err)],
            telemetry: createAttemptTelemetry(
              knobs.webPolicy,
              contract.external_context.web_required,
              effectiveWeb,
              [routed.browserRequirement, routed.denyRequirement],
              knobs.model,
            ),
          };
        }
        lastRun = run;
        attemptTelemetries.push({ attemptId, harnessId: adapter.id, telemetry: run.telemetry });
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
                      cost: attemptCostEvidence("review-panel", attemptId),
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
                      reviewValuationUsd: 0,
                      reviewUnknownUsd: 0,
                    };
              if (reviewLease?.granted) {
                ledger.settle(
                  reviewLease.lease?.lease_id ?? "",
                  reviewUsageCostSettlement(
                    reviewResult.reviewCashUsd,
                    reviewResult.reviewValuationUsd,
                    reviewResult.reviewSpendEstimated,
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
                  if (reviewResult.reviewSpendEstimated === true) reviewSpendEstimated = true;
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
              ledger,
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
    let facts: RunOutcomeFacts = input.signal?.aborted
      ? makeOutcomeFacts("cancelled", { reason: "user_cancelled" })
      : converged
        ? makeOutcomeFacts("succeeded")
        : stuckNoProgress
          ? makeOutcomeFacts("failed", { reason: "stuck_no_progress" })
          : exhausted
            ? makeOutcomeFacts("failed", { reason: "budget_exhausted" })
            : makeOutcomeFacts("failed", { reason: "not_converged" });
    let decision: ReturnType<typeof arbitrate>["decision"] | null = null;
    if (lastRun) {
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
        {
          spendUsd: ledger.spend(),
          estimatedSpend: lastRun.costEstimated || reviewSpendEstimated,
        },
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
          ? blockedDecisionOverride(decision.evidence_facts, convFinalVerify)
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

    // Deliver the converged/last work to final/ so `apply` and `inspect` can use it.
    if (lastRun) {
      assertNoSecretLikeTokens("final patch diff", lastRun.diff);
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
      writeFailure(store, paths, {
        phase: convNeedsDecision ? "review" : "convergence",
        category: isBudgetTerminal(facts.reason)
          ? "budget"
          : facts.lifecycle === "cancelled"
            ? "cancelled"
            : convNeedsDecision
              ? "policy"
              : "internal",
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
            ? ["Retry if cancellation was accidental"]
            : convNeedsDecision
              ? [
                  "Open the review queue",
                  "Decide the NEEDS_HUMAN findings",
                  "Re-run after the decision",
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
      if (!lastRun) {
        store.writeText(
          join(paths.finalDir, "summary.md"),
          `# Run ${runId} (${mode})\n\n- Lifecycle: ${facts.lifecycle}\n- Attempts: ${attempt}\n`,
        );
        log.emit("output.ready", {
          kind: "summary",
          path: "final/summary.md",
          state: "diagnostic",
        });
      }
    }

    log.emit("work_product.emitted", { winner: lastRun?.attemptId ?? null });
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

  /** plan mode: multi-harness planning -> aggregate -> (optional) plan review -> plan. Read-only. */
  /**
   * Wrap the user's goal in an explicit "plan, do not implement" instruction.
   * Without this the raw prompt ("make a racing game") reaches the harness with
   * only a read-only sandbox, so the model tries to BUILD it and dumps code into
   * the plan when writes are blocked — the v0.9 "HTML in the plan" bug. The
   * read-only access still enforces it; this gives the model the right job.
   */
  private planPrompt(goal: string): string {
    return [
      `You are planning, NOT implementing. Explore the repository read-only and produce a plan another agent will execute later. Do not write files or output full implementations.`,
      ``,
      `## Goal`,
      goal,
      ``,
      `## Required output (markdown)`,
      `1. Approach — 2-3 sentences on how you'd solve this.`,
      `2. Steps — a numbered list; each step names the file(s) it touches and what changes.`,
      `3. Risks & edge cases.`,
      `4. End your response with a section titled exactly:`,
      ``,
      `## Open Questions`,
      ``,
      `List every decision the user must make before implementation, one per bullet, in EXACTLY this format:`,
      ``,
      `- [single] <question> :: <option A> :: <option B>`,
      `- [multi] <question> :: <option A> :: <option B>`,
      `- [text] <question that has no good fixed options>`,
      ``,
      `Rules: [single] = pick exactly one; [multi] = pick one or more; [text] = free-form (no "::" options). Ground every option in THIS repository. If nothing is ambiguous, write a single bullet: - (none)`,
      ``,
      `Keep it concise. Reference real paths you found. Do NOT paste large code blocks; describe the change instead.`,
    ].join("\n");
  }

  private async runPlan(
    input: RunInput,
    announce?: (a: AnnouncedRunContext) => void,
  ): Promise<OrchestratorResult> {
    const taskId = input.taskId ?? newId("task");
    const runId = input.runId ?? newId("run");
    // Plan runs get the same immutable contract truth as every other mode;
    // contract validation runs BEFORE the run is announced (see runRace).
    const contract = this.buildContract(input, taskId, "plan");
    const store = this.artifactStore(input);
    const paths = store.createRun(runId);
    const log = new EventLog(paths.eventsPath, runId, taskId, input.onEvent, input.threadId);
    safeInvoke(input.onRunStart, { runId, taskId, runDir: paths.root });
    log.emit("run.created", { mode: "plan", prompt: redactSecrets(input.prompt) });
    const ledger = this.rootLedger(input, contract, log);
    announce?.({
      log,
      store,
      paths,
      runId,
      taskId,
      mode: "plan",
      phase: "plan",
      spend: () => ledger.spend(),
    });

    store.writeYaml(join(paths.contextDir, "task.yaml"), contract);
    log.emit("task.contract.created", { task_contract_hash: hashJson(contract) });

    // W3.3: ONE resolved read-only context — the routing point-probe and every
    // planner spawn consume the SAME scoped env (see routeContext.ts). The
    // probe home stays a disposable throwaway even for a thread lane turn (auth
    // truth is home-independent); only the planner spawn swaps in the durable
    // per-lane home below so its recorded native session survives.
    const roHome = resolveReadOnlyRouteContext(this.execRootOf(input));
    // A thread PLAN turn is a chat turn (INV-034): plan candidates are distinct
    // harnesses run sequentially, so each records its own lane's native session
    // and the next lane turn resumes it via `sessionSpecFields.resume_session_id`.
    const laneRun = Boolean(input.threadId);
    let adapters: RoutedAdapter[];
    try {
      adapters = await this.resolveCandidateAdapters(
        { ...input, n: undefined },
        "plan",
        ledger,
        roHome,
      );
    } catch (err) {
      roHome.dispose();
      const message = safeErrorMessage(err);
      store.writeText(
        join(paths.contextDir, "context_error.md"),
        `# Routing Error\n\n${message}\n`,
      );
      writeFailure(store, paths, {
        phase: "routing",
        category: "harness_unavailable",
        safeMessage: message,
        runDir: paths.root,
      });
      store.writeText(
        join(paths.finalDir, "summary.md"),
        `# Run ${runId} (plan)\n\n- Lifecycle: failed\n- Phase: routing\n\n${message}\n`,
      );
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      log.emit("run.failed", {
        lifecycle: "failed",
        facts: makeOutcomeFacts("failed", { reason: "harness_failed" }),
        reason: "harness_failed",
        phase: "routing",
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

    const plans: { id: string; text: string }[] = [];
    let fallbackFrom: string | null = null;
    const planAttempts: {
      attemptId: string;
      harnessId: string;
      status: "success" | "failed" | "blocked";
      error: string | null;
    }[] = [];
    const attemptTelemetries: {
      attemptId: string;
      harnessId: string;
      telemetry: AttemptTelemetry;
    }[] = [];
    try {
      for (const [idx, routed] of adapters.entries()) {
        if (input.signal?.aborted) break;
        const adapter = routed.adapter;
        const attemptId = `p${String(idx + 1).padStart(2, "0")}`;
        const lease = ledger.reserve({
          taskId,
          attemptId,
          intent: "plan",
          harnessId: adapter.id,
          cost: attemptCostEvidence(
            adapter.id,
            attemptId,
            undefined,
            this.routeBillingKnowledge(input, adapter.id),
          ),
        });
        if (!lease.granted) {
          log.emit("budget.lease.created", {
            granted: false,
            reason: lease.reason,
            attempt_id: attemptId,
            harness_id: adapter.id,
          });
          break;
        }
        const knobs = this.routeSpecKnobs(routed, contract, undefined, input.effort);
        const effectiveWeb = this.discloseWebUpgrade(log, routed, knobs.webPolicy, attemptId);
        const spec = HarnessRunSpec.parse({
          session_id: newId("ses"),
          intent: "plan",
          prompt: this.planPrompt(input.prompt) + contextSection,
          cwd: this.execRootOf(input),
          access: "readonly",
          // Planners must SEE any image/file the user attached (e.g. "plan a fix for
          // what's in this screenshot"), not just agent/race runs.
          attachments: input.attachments ?? [],
          ...this.sessionSpecFields(input, adapter.id, log),
          ...this.harnessSpecKnobs(contract, knobs, "plan"),
          env_inheritance: envInheritance(this.config(input.repoRoot)),
          // A thread plan turn spawns in its DURABLE per-lane home so its native
          // session is reachable for resume next turn (INV-034); a non-thread
          // plan keeps the disposable route-context home.
          env: (laneRun ? this.laneHomeEnvFor(input, adapter.id) : null) ?? roHome.env,
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
        const attemptEventsPath = join(paths.attemptsDir, attemptId, "events.jsonl");
        const answer = new AnswerAssembly();
        const telemetry = createAttemptTelemetry(
          knobs.webPolicy,
          contract.external_context.web_required ||
            knobs.webPolicy === "cached" ||
            knobs.webPolicy === "live",
          effectiveWeb,
          [],
          // Requested-model capture: a plan lane silently downgraded to another
          // model surfaces the mismatch in its route receipt, just like agent.
          knobs.model,
        );
        const onAbort = () => {
          void adapter.cancel?.(spec.session_id)?.catch(() => {});
        };
        if (input.signal) {
          if (input.signal.aborted) onAbort();
          else input.signal.addEventListener("abort", onAbort, { once: true });
        }
        let cost = 0;
        let costEstimated = false;
        let harnessError: string | null = null;
        const budgetSignalState = { quotaPressureDisclosed: false };
        try {
          log.emit("harness.started", {
            harness_id: adapter.id,
            attempt_id: attemptId,
            external_context_policy: knobs.webPolicy,
            ...(knobs.ignored.length > 0 ? { ignored_settings: knobs.ignored } : {}),
          });
          if (!input.signal?.aborted) {
            const watchedPlan = withInactivityWatchdog(adapter.run(spec), {
              timeoutMs: harnessInactivityTimeoutMs(this.config(input.repoRoot)),
              onTimeout: () => {
                plannerAbort.abort();
                void adapter.cancel?.(spec.session_id)?.catch(() => {});
              },
              isSuspended: () => (planInteraction?.pendingCount?.() ?? 0) > 0,
            });
            for await (const ev of watchedPlan) {
              if (input.signal?.aborted) break;
              const safeEv = redactHarnessEvent(ev);
              safeInvoke(input.onHarnessEvent, safeEv);
              // A thread PLAN turn IS a chat turn now (INV-034): its native
              // session lives in the DURABLE per-lane home, so record it for the
              // next lane turn's resume. Plan candidates are distinct harnesses
              // run sequentially, so there is no parallel same-lane race.
              if (laneRun) observeNativeSessionEvent(input, adapter.id, safeEv);
              observeAuthSwitch(log, adapter.id, attemptId, safeEv);
              log.emit("harness.event", harnessEventPayload(adapter.id, attemptId, safeEv));
              appendLine(attemptEventsPath, JSON.stringify(safeEv));
              observeAttemptTelemetry(telemetry, safeEv);
              if (safeEv.plan_progress) {
                log.emit("plan.progress", {
                  attempt_id: attemptId,
                  harness_id: adapter.id,
                  items: safeEv.plan_progress.items,
                });
              }
              // read-only routes burn quota too (the orchestrate PLANNER is
              // the loudest) — same single owner as the agent loop.
              observeBudgetSignals(ledger, log, adapter.id, attemptId, safeEv, budgetSignalState);
              this.deps.quotaEventSink?.(adapter.id, safeEv);
              if (safeEv.type === "usage" && safeEv.usage?.cost_usd) {
                cost += safeEv.usage.cost_usd;
                if (safeEv.usage.estimated) costEstimated = true;
                log.emit("budget.observation", {
                  harness_id: adapter.id,
                  attempt_id: attemptId,
                  kind: "spend",
                  usd: safeEv.usage.cost_usd,
                  estimated: safeEv.usage.estimated === true,
                });
              }
              // A TYPED final message wins verbatim over joined narration.
              answer.observe(safeEv);
              if (safeEv.type === "error")
                harnessError = safeEv.error
                  ? redactSecrets(safeEv.error)
                  : "harness emitted an error";
            }
          }
        } catch (err) {
          harnessError = safeErrorMessage(err);
        } finally {
          input.signal?.removeEventListener("abort", onAbort);
          ledger.settle(
            lease.lease?.lease_id ?? "",
            attemptUsageCostSettlement(
              cost,
              costEstimated,
              attemptId,
              adapter.id,
              telemetry.authMode,
              telemetry.usageCost,
            ),
          );
        }
        attemptTelemetries.push({ attemptId, harnessId: adapter.id, telemetry });
        const unrecovered = unrecoveredToolErrors(telemetry);
        const webBlocked = webUnsatisfied(telemetry);
        if (!harnessError && webBlocked) {
          harnessError = `web evidence unsatisfied: ${telemetry.web.errorSummary ?? (telemetry.web.attempted ? "web tool failed without verified recovery" : "web evidence required but never attempted")}`;
        }
        if (!harnessError && unrecovered.length > 0) {
          const first = unrecovered[0] as ToolErrorRecord;
          harnessError = `${first.tool} failed without recovery: ${first.summary}`;
        }
        if (harnessError) {
          // One failed planner does not abort a multi-harness plan; the run fails
          // only when EVERY planner fails (parity with explore).
          log.emit("harness.completed", {
            harness_id: adapter.id,
            attempt_id: attemptId,
            status: webBlocked ? "blocked" : "failed",
            error: harnessError,
            ...telemetrySummary(telemetry),
          });
          planAttempts.push({
            attemptId,
            harnessId: adapter.id,
            status: webBlocked ? "blocked" : "failed",
            error: harnessError,
          });
          const next = adapters[idx + 1];
          if (next && !input.signal?.aborted) {
            fallbackFrom = adapter.id;
            log.emit("route.fallback.started", {
              from_harness: adapter.id,
              to_harness: next.adapter.id,
              attempt_id: attemptId,
              reason: "planner_failed",
            });
          } else if (fallbackFrom || next === undefined) {
            log.emit("route.fallback.exhausted", {
              harness_id: adapter.id,
              attempt_id: attemptId,
              reason: "planner_failed",
            });
          }
          continue;
        }
        const text = answer.text() || "(no output)";
        log.emit("harness.completed", {
          harness_id: adapter.id,
          attempt_id: attemptId,
          status: "success",
          ...telemetrySummary(telemetry),
        });
        planAttempts.push({ attemptId, harnessId: adapter.id, status: "success", error: null });
        plans.push({ id: adapter.id, text });
        store.writeText(join(paths.root, "plans", `${adapter.id}.md`), redactSecrets(text) + "\n");
        // Solo planning (D31): the FIRST successful planner is the plan; later
        // pool members are a sequential fallback chain (ask parity), not
        // parallel co-authors. Council re-enables the multi-draft round.
        if (fallbackFrom) {
          log.emit("route.fallback.completed", {
            harness_id: adapter.id,
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
      const blocked = planAttempts.some((p) => p.status === "blocked");
      const message =
        planAttempts
          .map((p) => `${p.attemptId}/${p.harnessId}: ${p.error ?? "failed"}`)
          .join("\n") || "all planners failed";
      this.writeRunTelemetry(
        store,
        paths,
        contract,
        runId,
        taskId,
        "plan",
        attemptTelemetries,
        null,
      );
      store.writeText(
        join(paths.contextDir, "context_error.md"),
        `# Harness Error\n\n${message}\n`,
      );
      writeFailure(store, paths, {
        phase: "harness",
        category: blocked ? "policy" : "harness_error",
        safeMessage: message,
        eventRefs: planAttempts.map((p) => `attempts/${p.attemptId}/events.jsonl`),
        runDir: paths.root,
        nextActions: ["Open diagnostics", "Check harness authentication", "Retry after setup"],
      });
      store.writeText(
        join(paths.finalDir, "summary.md"),
        `# Run ${runId} (plan)\n\n- Lifecycle: ${blocked ? "succeeded (needs review)" : "failed"}\n\n${message}\n`,
      );
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      const planFailFacts = blocked
        ? makeOutcomeFacts("succeeded", { review: "blocked", reason: "review_blocked" })
        : makeOutcomeFacts("failed", { reason: "harness_failed" });
      if (blocked)
        log.emit("run.blocked", {
          lifecycle: planFailFacts.lifecycle,
          facts: planFailFacts,
          phase: "harness",
          error: message,
          failure_ref: "final/failure.yaml",
        });
      else
        log.emit("run.failed", {
          lifecycle: planFailFacts.lifecycle,
          facts: planFailFacts,
          reason: planFailFacts.reason,
          phase: "harness",
          error: message,
          failure_ref: "final/failure.yaml",
        });
      return {
        spendUsd: ledger.spend(),
        runId,
        taskId,
        mode: "plan",
        lifecycle: planFailFacts.lifecycle,
        facts: planFailFacts,
        winner: null,
        runDir: paths.root,
        summary: message,
        candidates: planAttempts.map((p) => ({
          attemptId: p.attemptId,
          harnessId: p.harnessId,
          status: p.status,
        })),
      };
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

    const failedPlanners = planAttempts.filter((p) => p.status !== "success");
    const winner = plans[0];
    const winnerAttempt = planAttempts.find((p) => p.status === "success");
    // final/plan.md is the PURE plan body (the winning planner's own text):
    // implement freezes and hashes THIS file, so wrapper prose (goal, planner
    // omissions, statuses) lives in summary.md instead (advisor pass, V6a).
    const planDoc = redactSecrets(winner?.text ?? "(no output)");
    store.writeText(join(paths.finalDir, "plan.md"), planDoc + "\n");
    // Engine-parsed open questions (final/questions.json): the ONE artifact
    // plan readiness derives from. An absent tagged block is DISCLOSED as
    // none_found — never silently equated with "ready".
    const parsedQuestions = extractPlanQuestions(planDoc);
    store.writeJson(join(paths.finalDir, "questions.json"), parsedQuestions);
    // A plan is a delivered work product (a report), even with risks — parity
    // with the other read-only modes. result_kind=plan tells surfaces NO
    // files changed.
    store.writeYaml(join(paths.finalDir, "work_product.yaml"), {
      id: newId("wp"),
      kind: "report",
      source_task_id: taskId,
      producer_attempt_id: winnerAttempt?.attemptId ?? null,
      meta: {
        mode: "plan",
        result_kind: "plan",
        planners: plans.length,
        diffstat: { files: 0, additions: 0, deletions: 0 },
        blockers: 0,
        adopted: null,
      },
    });
    const readiness = derivePlanReadiness(PlanQuestionsArtifact.parse(parsedQuestions));
    store.writeText(
      join(paths.finalDir, "summary.md"),
      [
        `# Run ${runId} (plan)`,
        "",
        `- Lifecycle: succeeded (plan only — no files changed)`,
        `- Planner: ${winnerAttempt?.harnessId ?? "(none)"}`,
        `- Plan: final/plan.md`,
        `- Open questions: ${readiness.questionCount}${parsedQuestions.parse === "none_found" ? " (no tagged block — unverified)" : ""}`,
        `- Goal: ${redactSecrets(input.prompt).slice(0, 400)}`,
        ...(failedPlanners.length > 0
          ? [
              `- Fallback omissions: ${failedPlanners
                .map((p) => `${p.harnessId} ${p.status}`)
                .join(", ")}`,
            ]
          : []),
        "",
      ].join("\n"),
    );
    this.writeRunTelemetry(
      store,
      paths,
      contract,
      runId,
      taskId,
      "plan",
      attemptTelemetries,
      planAttempts.find((p) => p.status === "success")?.attemptId ?? null,
    );
    log.emit("output.ready", { kind: "plan", path: "final/plan.md" });
    log.emit("plan.questions", {
      parse: parsedQuestions.parse,
      question_count: readiness.questionCount,
      readiness: readiness.state,
    });
    const planFacts = makeOutcomeFacts("succeeded", { noChanges: true });
    log.emit("run.completed", { lifecycle: planFacts.lifecycle, facts: planFacts, reason: null });

    return {
      spendUsd: ledger.spend(),
      runId,
      taskId,
      mode: "plan",
      lifecycle: planFacts.lifecycle,
      facts: planFacts,
      winner: null,
      runDir: paths.root,
      summary: `Plan by ${winnerAttempt?.harnessId ?? "(none)"}; ${readiness.questionCount} open question(s)${parsedQuestions.parse === "none_found" ? " (untagged plan — unverified)" : ""}.`,
      candidates: planAttempts.map((p) => ({
        attemptId: p.attemptId,
        harnessId: p.harnessId,
        status: p.status,
      })),
    };
  }

  /** ask: one selected harness answers read-only questions; no patch/apply controls. */
  private async runAsk(
    input: RunInput,
    announce?: (a: AnnouncedRunContext) => void,
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
    announce?: (a: AnnouncedRunContext) => void,
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

  private resolvePaidBudget(
    inputBudget: PaidBudget | undefined,
    cfg: ReturnType<typeof loadConfig>,
  ): PaidBudget {
    return inputBudget ?? this.deps.paidBudget ?? cfg.global.budget.paid_budget_per_run;
  }

  private rootLedger(input: RunInput, contract: TaskContract, log: EventLog): BudgetLedger {
    // A passed-in ledger (orchestrate sub-runs) keeps its OWNER's cash
    // disclosure — the parent run owns the budget, so its event log gets the
    // budget.cash events. A fresh root ledger discloses into THIS run's log:
    // the ledger is the one owner of the cash fact (subscription-entitled
    // work settles to 0 there), and the UI renders `budget.cash` verbatim —
    // never inferring money from route labels (W4.3 sol #15).
    const ledger =
      input.budgetLedger ??
      new BudgetLedger(contract.budget.paid_budget, undefined, {
        onCashSettled: (cashSpendUsd, valuationUsd) =>
          log.emit("budget.cash", {
            cash_spend_usd: cashSpendUsd,
            valuation_usd: valuationUsd,
          }),
      });
    for (const snapshot of this.deps.quotaSnapshots?.() ?? []) {
      ledger.observeQuotaSnapshot(snapshot);
    }
    return ledger;
  }

  private routeBillingKnowledge(input: RunInput, harnessId: string): "metered" | "unknown" {
    // A selected profile's credential_kind decides billing (round-18 #2).
    const profileRoute = this.profileAuthRoute(input, harnessId);
    if (profileRoute) return profileRoute === "api_key" ? "metered" : "unknown";
    if (input.authPreference === "api_key") return "metered";
    if (input.authPreference === "subscription") return "unknown";
    return loadHarnessMetrics(globalConfigDir())[harnessId]?.last_auth_mode === "api_key"
      ? "metered"
      : "unknown";
  }

  private async runOrchestrate(
    input: RunInput,
    announce?: (a: AnnouncedRunContext) => void,
  ): Promise<OrchestratorResult> {
    // "Doctor-verified" must mean status ok — degraded key-present routes are
    // excluded from the pool the planner plans over (readiness honesty).
    const pool = await this.gateway.doctorOkReal({ cwd: input.repoRoot }, "orchestrate");
    const crossFamily = pool.length >= 2;
    const goal = input.prompt || "Plan the next move for this repository.";
    // The typed orchestration contract is a REAL persisted artifact (producer
    // here, consumers: the planner prompt below + the plan validator).
    // Autonomy is producer-supplied (control-api/CLI -> daemon -> RunInput);
    // the executor below is its consumer. Default `suggest` (plan-only) preserves
    // the read-only contract when no autonomy is requested.
    const autonomy: OrchestrateAutonomy = input.autonomy ?? "suggest";
    const paidBudget = this.resolvePaidBudget(input.paidBudget, this.config(input.repoRoot));
    const orchestrateContract = OrchestrateContractSchema.parse({
      thread_id: input.threadId ?? newId("th"),
      goal,
      budget: { paid_budget: paidBudget, max_tool_calls: input.maxToolCalls ?? null },
      autonomy,
    });
    const plannerPrompt = buildOrchestratePlannerPrompt(
      goal,
      pool,
      crossFamily,
      orchestrateContract,
    );
    return this.runReadOnlyReport(
      // The executed pool is pinned to the PLANNED pool (no double doctor
      // resolution drift between the prompt's claims and the actual route).
      // The planner must NOT resume or overwrite the thread's conversational
      // session — it speaks its own tool-belt framing, not the user's chat.
      {
        ...input,
        resumeSessions: undefined,
        onSessionObserved: undefined,
        harnesses: input.harnesses ?? (pool.length > 0 ? pool : undefined),
        prompt: plannerPrompt,
      },
      {
        mode: "orchestrate",
        deepScan: false,
        intent: "orchestrate",
        title: "Orchestration plan",
        artifactName: "orchestration.md",
        defaultPrompt: plannerPrompt,
        contractIntent: goal,
        orchestrateContract,
      },
      announce,
    );
  }

  private async runReadOnlyReport(
    input: RunInput,
    opts: {
      mode: "ask" | "orchestrate";
      deepScan: boolean;
      intent: "explain" | "audit" | "orchestrate";
      title: string;
      artifactName: string;
      defaultPrompt: string;
      contractIntent?: string;
      orchestrateContract?: OrchestrateContractT;
    },
    announce?: (a: AnnouncedRunContext) => void,
  ): Promise<OrchestratorResult> {
    const taskId = input.taskId ?? newId("task");
    const runId = input.runId ?? newId("run");
    const prompt = input.prompt || opts.defaultPrompt;
    // Contract validation BEFORE the run is announced (see runRace). The
    // recorded user intent is the CALLER's goal, not a synthesized wrapper
    // prompt (orchestrate wraps the goal in a planner prompt).
    const contract = this.buildContract(
      { ...input, prompt: opts.contractIntent ?? prompt },
      taskId,
      opts.mode,
    );
    const store = this.artifactStore(input);
    const paths = store.createRun(runId);
    const log = new EventLog(paths.eventsPath, runId, taskId, input.onEvent, input.threadId);
    safeInvoke(input.onRunStart, { runId, taskId, runDir: paths.root });
    log.emit("run.created", { mode: opts.mode, prompt: redactSecrets(prompt) });
    const ledger = this.rootLedger(input, contract, log);
    announce?.({
      log,
      store,
      paths,
      runId,
      taskId,
      mode: opts.mode,
      phase: "report",
      spend: () => ledger.spend(),
    });

    store.writeYaml(join(paths.contextDir, "task.yaml"), contract);
    log.emit("task.contract.created", { task_contract_hash: hashJson(contract) });
    if (opts.orchestrateContract) {
      store.writeYaml(
        join(paths.contextDir, "orchestrate_contract.yaml"),
        opts.orchestrateContract,
      );
    }

    // Lazy ContextPack: explore/audit attach the compact scope atlas; ask stays bare.
    let contextSection = "";
    if (opts.mode !== "ask") {
      try {
        contextSection = await this.lazyContextSection(input, contract, store, paths, log);
      } catch (err) {
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
          `# Run ${runId} (${opts.mode})\n\n- Lifecycle: failed\n- Phase: context\n\n${message}\n`,
        );
        log.emit("output.ready", {
          kind: "summary",
          path: "final/summary.md",
          state: "diagnostic",
        });
        log.emit("run.failed", {
          lifecycle: "failed",
          facts: makeOutcomeFacts("failed", { reason: "harness_failed" }),
          reason: "harness_failed",
          phase: "context",
          error: message,
          failure_ref: "final/failure.yaml",
        });
        return {
          runId,
          taskId,
          mode: opts.mode,
          lifecycle: "failed",
          facts: makeOutcomeFacts("failed", { reason: "harness_failed" }),
          winner: null,
          runDir: paths.root,
          summary: `context failed: ${message}`,
          candidates: [],
        };
      }
    }

    const externalContextPolicy = contract.external_context.policy;
    const width = opts.deepScan
      ? Math.min(Math.max(input.n ?? 4, 1), 8)
      : externalContextPolicy === "off"
        ? 1
        : Math.min(Math.max(input.n ?? 2, 1), 3);
    // W3.3: ONE resolved read-only context — the routing point-probe and every
    // read-only attempt spawn consume the SAME scoped env (see routeContext.ts).
    // The point-probe home is a disposable throwaway even for a thread lane
    // turn: readiness auth truth is home-INDEPENDENT (credentials come from the
    // profile/keychain/default store, never the scoped home), so the probe and
    // the run share the same auth source; only the ACTUAL spawn swaps in the
    // durable per-lane home below so the recorded native session survives.
    const roHome = resolveReadOnlyRouteContext(this.execRootOf(input));
    // A thread ASK turn is a chat turn: its native session is recorded per lane
    // and the next lane turn resumes it (INV-034). Deep-scan (multi-scout
    // research) and orchestrate (tool-belt planner, not the user's chat) are
    // NOT lane chat turns — they keep the disposable home and record nothing.
    const laneRun = Boolean(input.threadId) && opts.mode === "ask" && !opts.deepScan;
    let adapters: RoutedAdapter[];
    try {
      adapters = await this.resolveCandidateAdapters(
        { ...input, prompt, n: width },
        opts.intent,
        ledger,
        roHome,
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
      store.writeText(
        join(paths.contextDir, "context_error.md"),
        `# Routing Error\n\n${message}\n`,
      );
      writeFailure(store, paths, {
        phase: "routing",
        category: "harness_unavailable",
        safeMessage: message,
        runDir: paths.root,
      });
      store.writeText(
        join(paths.finalDir, "summary.md"),
        `# Run ${runId} (${opts.mode})\n\n- Lifecycle: failed\n- Phase: routing\n\n${message}\n`,
      );
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      log.emit("run.failed", {
        lifecycle: "failed",
        facts: makeOutcomeFacts("failed", { reason: "harness_failed" }),
        reason: "harness_failed",
        phase: "routing",
        error: message,
        failure_ref: "final/failure.yaml",
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
    }
    const attempts: ReadonlyAttempt[] = [];
    const attemptTelemetries: {
      attemptId: string;
      harnessId: string;
      telemetry: AttemptTelemetry;
    }[] = [];
    let fallbackOpen = false;
    let budgetStopped = false;
    // in a swarm the same harness appears in several slots; resuming the
    // ONE native session id from all of them races the vendor's session store
    // (and is semantically wrong — N explorers continuing one conversation).
    // Grant resume to the first slot of each harness only; the rest run fresh.
    const resumeGranted = new Set<string>();

    const runReadonlyAttempt = async (
      routed: RoutedAdapter,
      idx: number,
      modelOverride?: string,
    ): Promise<void> => {
      const adapter = routed.adapter;
      const attemptId = modelOverride
        ? `a${String(idx + 1).padStart(2, "0")}-fb`
        : `a${String(idx + 1).padStart(2, "0")}`;
      const budgetSignalState = { quotaPressureDisclosed: false };
      const lease = ledger.reserve({
        taskId,
        attemptId,
        intent: opts.intent,
        harnessId: adapter.id,
        cost: attemptCostEvidence(
          adapter.id,
          attemptId,
          undefined,
          this.routeBillingKnowledge(input, adapter.id),
        ),
      });
      if (!lease.granted) {
        log.emit("budget.lease.created", {
          granted: false,
          reason: lease.reason,
          attempt_id: attemptId,
          harness_id: adapter.id,
        });
        budgetStopped = true;
        return;
      }
      const knobs = this.routeSpecKnobs(routed, contract, modelOverride, input.effort);
      const effectiveWeb = this.discloseWebUpgrade(log, routed, knobs.webPolicy, attemptId);
      const explorerPrompt =
        (opts.deepScan
          ? `${prompt}\n\nExplorer ${idx + 1}/${adapters.length}: focus on a distinct slice. Emit evidence-cited findings, explicit unknowns/omissions, and follow-up questions. Do not edit files.`
          : prompt) + contextSection;
      const sessionFields = this.sessionSpecFields(input, adapter.id, log);
      const grantResume =
        sessionFields.resume_session_id !== null && !resumeGranted.has(adapter.id);
      if (grantResume) resumeGranted.add(adapter.id);
      let spec = HarnessRunSpec.parse({
        session_id: newId("ses"),
        intent: opts.intent,
        prompt: explorerPrompt,
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
        env: (laneRun ? this.laneHomeEnvFor(input, adapter.id) : null) ?? roHome.env,
        // Structured output: the orchestrate PLANNER's deliverable IS the
        // typed plan — constrain schema-capable routes to it. Capability-gated:
        // routes without json_schema_output keep fenced-JSON parsing. ALSO
        // gated off when this spec will ride the INTERACTIVE stream-json
        // transport (an interaction channel will be offered): --json-schema x
        // interactive is an unverified vendor combination — fenced parsing
        // carries those runs until it is live-verified.
        ...(opts.intent === "orchestrate" &&
        routed.supportsJsonSchemaOutput &&
        !(Boolean(input.onInteraction) && routed.supportsInteractive)
          ? { output_schema: orchestratePlanJsonSchema() }
          : {}),
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
      const attemptEventsPath = join(paths.attemptsDir, attemptId, "events.jsonl");
      const answer = new AnswerAssembly();
      const telemetry = createAttemptTelemetry(
        knobs.webPolicy,
        contract.external_context.web_required ||
          knobs.webPolicy === "cached" ||
          knobs.webPolicy === "live",
        effectiveWeb,
        [],
        // Requested-model capture so ask/audit route receipts detect a silent
        // model downgrade (typed model_mismatch), not just agent runs.
        knobs.model,
      );
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
      try {
        const triedProfiles = new Set<string>(); // W5.4 failover: each profile at most once
        for (let nativeTry = 0; !input.signal?.aborted; nativeTry += 1) {
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
            const watchedReport = withInactivityWatchdog(adapter.run(runSpec), {
              timeoutMs: harnessInactivityTimeoutMs(this.config(input.repoRoot)),
              onTimeout: () => {
                reportAbort.abort();
                void adapter.cancel?.(activeSessionId)?.catch(() => {});
              },
              isSuspended: () => (reportInteraction?.pendingCount?.() ?? 0) > 0,
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
              if (safeEv.plan_progress) {
                log.emit("plan.progress", {
                  attempt_id: attemptId,
                  harness_id: adapter.id,
                  items: safeEv.plan_progress.items,
                });
              }
              // read-only routes burn quota too (the orchestrate PLANNER is
              // the loudest) — same single owner as the agent loop.
              observeBudgetSignals(ledger, log, adapter.id, attemptId, safeEv, budgetSignalState);
              this.deps.quotaEventSink?.(adapter.id, safeEv);
              if (safeEv.type === "usage" && safeEv.usage?.cost_usd) {
                cost += safeEv.usage.cost_usd;
                if (safeEv.usage.estimated) costEstimated = true;
                log.emit("budget.observation", {
                  harness_id: adapter.id,
                  attempt_id: attemptId,
                  kind: "spend",
                  usd: safeEv.usage.cost_usd,
                  estimated: safeEv.usage.estimated === true,
                });
              }
              // A TYPED final message wins verbatim over joined narration.
              answer.observe(safeEv);
              if (safeEv.type === "error")
                harnessError = safeEv.error
                  ? redactSecrets(safeEv.error)
                  : "harness emitted an error";
            }
          } catch (err) {
            harnessError = safeErrorMessage(err);
          }

          const transient = telemetry.transientFailures.at(-1) ?? null;
          const sawTransient = telemetry.transientFailures.length > transientStart;
          const sawTypedLimit = telemetry.rateLimits.length > rateLimitStart;
          const reportSoFar = answer.text();
          // W5.4 reactive failover, READ-ONLY lane (same contract as the
          // candidate lane; typed limits only, never plain transients).
          if (harnessError && !input.signal?.aborted) {
            const rotated = rotateSpecOnTypedLimit({
              spec,
              harnessId: adapter.id,
              attemptId,
              policy: this.profilePolicy(input.repoRoot, adapter.id),
              registry: this.config(input.repoRoot)?.global.credential_profiles ?? [],
              snapshots: this.deps.quotaSnapshots?.() ?? [],
              triedProfiles,
              sawTypedLimit,
              deliverableEmpty: reportSoFar.length === 0,
              lastLimit: telemetry.rateLimits.at(-1) ?? null,
              emit: (type, payload) => log.emit(type, payload),
              newSessionId: () => newId("ses"),
              defaultRouteWasVendorNative: routed.authRouteEstimate === "local_session",
            });
            if (rotated) {
              spec = rotated;
              harnessError = null;
              continue;
            }
          }
          if (
            !harnessError ||
            !sawTransient ||
            reportSoFar.length > 0 ||
            nativeTry >= retryPolicy.maxRetries ||
            input.signal?.aborted
          )
            break;

          const nextTry = nativeTry + 1;
          const delayMs = transientRetryDelayMs(
            transient?.retryDelayMs ?? null,
            retryPolicy,
            nativeTry,
          );
          log.emit("route.transient.detected", {
            harness_id: adapter.id,
            attempt_id: attemptId,
            kind: transient?.kind ?? "unknown",
            native_try: nativeTry + 1,
          });
          log.emit("route.transient.retry_scheduled", {
            harness_id: adapter.id,
            attempt_id: attemptId,
            retry: nextTry,
            delay_ms: delayMs,
          });
          harnessError = null;
          await sleep(delayMs);
        }
      } finally {
        input.signal?.removeEventListener("abort", onAbort);
        ledger.settle(
          lease.lease?.lease_id ?? "",
          attemptUsageCostSettlement(
            cost,
            costEstimated,
            attemptId,
            adapter.id,
            telemetry.authMode,
            telemetry.usageCost,
          ),
        );
      }
      if (harnessError && telemetry.transientFailures.length > 0) {
        log.emit("route.transient.exhausted", {
          harness_id: adapter.id,
          attempt_id: attemptId,
          retries: retryPolicy.maxRetries,
        });
      }
      attemptTelemetries.push({ attemptId, harnessId: adapter.id, telemetry });
      const report = redactSecrets(answer.text());
      const unrecovered = unrecoveredToolErrors(telemetry);
      const webBlocked = webUnsatisfied(telemetry);
      const deliverablePresent = report.length > 0;
      if (!harnessError && webBlocked) {
        harnessError = `web evidence unsatisfied: ${telemetry.web.errorSummary ?? (telemetry.web.attempted ? "web tool failed without verified recovery" : "web evidence required but never attempted")}`;
      }
      if (!harnessError && unrecovered.length > 0 && !deliverablePresent) {
        const first = unrecovered[0] as ToolErrorRecord;
        harnessError = `${first.tool} failed without recovery: ${first.summary}`;
      }
      setAttemptOutcome(telemetry, {
        deliverablePresent,
        gatesPassed: null,
        harnessErrored: harnessError !== null && !webBlocked,
        webRequiredUnsatisfied: webBlocked,
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
        });
        if (opts.deepScan) {
          store.writeText(
            join(paths.findingsDir, `${attemptId}-error.md`),
            `# Explorer ${attemptId} failed\n\n${harnessError}\n`,
          );
        }
        return;
      }
      log.emit("harness.completed", {
        harness_id: adapter.id,
        attempt_id: attemptId,
        status: "success",
        ...telemetrySummary(telemetry),
      });
      attempts.push({
        attemptId,
        harnessId: adapter.id,
        status: "success",
        report: report || "(no output)",
        error: null,
        telemetry,
      });
      if (opts.deepScan) {
        const warningNote = toolWarnings(telemetry).length
          ? `\n\n> Tool warnings: ${toolWarnings(telemetry)
              .map((e) => `${e.tool}: ${e.summary}`)
              .join("; ")}\n`
          : "";
        store.writeText(
          join(paths.findingsDir, `${attemptId}.md`),
          `# Explorer ${attemptId} (${adapter.id})\n\n${report || "(no output)"}${warningNote}\n`,
        );
      }
    };

    try {
      if (opts.deepScan) {
        // Explorer swarm runs in parallel (bounded), mirroring parallel candidates.
        await runBounded(
          adapters,
          Math.min(adapters.length, MAX_PARALLEL_CANDIDATES),
          runReadonlyAttempt,
        );
      } else {
        // ask/audit: sequential fallback chain — first success wins; a blocked
        // attempt opens a fallback arc to the next eligible harness.
        for (const [idx, routed] of adapters.entries()) {
          if (input.signal?.aborted) break;
          await runReadonlyAttempt(routed, idx);
          let last = attempts[attempts.length - 1];
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

    if (input.signal?.aborted) {
      return cancelledResult(
        log,
        runId,
        taskId,
        opts.mode,
        paths.root,
        attempts.map((a) => ({
          attemptId: a.attemptId,
          harnessId: a.harnessId,
          status: a.status,
        })),
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
    }

    const succeededReadonly = attempts.filter((a) => a.status === "success");
    if (!opts.deepScan && succeededReadonly.length === 0) {
      const last = attempts[attempts.length - 1];
      const webBlocked = attempts.some((a) => a.status === "blocked");
      const singleError =
        last?.error ?? (budgetStopped ? "budget exhausted before any attempt" : "harness failed");
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
        `# Harness Error\n\n${singleError}\n`,
      );
      writeFailure(store, paths, {
        phase: "harness",
        category: webBlocked ? "policy" : budgetStopped ? "budget" : "harness_error",
        harnessId: last?.harnessId,
        attemptId: last?.attemptId,
        safeMessage: singleError,
        eventRefs: attempts.map((a) => `attempts/${a.attemptId}/events.jsonl`),
        runDir: paths.root,
        nextActions: ["Open diagnostics", "Check harness authentication", "Retry after setup"],
      });
      const terminalFacts = webBlocked
        ? makeOutcomeFacts("succeeded", { review: "blocked", reason: "review_blocked" })
        : budgetStopped && attempts.length === 0
          ? makeOutcomeFacts("failed", { reason: "budget_exhausted" })
          : makeOutcomeFacts("failed", { reason: "harness_failed" });
      store.writeText(
        join(paths.finalDir, "summary.md"),
        `# Run ${runId} (${opts.mode})\n\n- Harness: ${last?.harnessId ?? "none"}\n- Lifecycle: ${terminalFacts.lifecycle}${terminalFacts.reason ? ` (${terminalFacts.reason})` : ""}\n\n${singleError}\n`,
      );
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      if (terminalFacts.lifecycle === "succeeded") {
        log.emit("run.blocked", {
          lifecycle: terminalFacts.lifecycle,
          facts: terminalFacts,
          harness_id: last?.harnessId,
          error: singleError,
          failure_ref: "final/failure.yaml",
        });
      } else {
        log.emit("run.failed", {
          lifecycle: terminalFacts.lifecycle,
          facts: terminalFacts,
          reason: terminalFacts.reason,
          harness_id: last?.harnessId,
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
      const message = attempts
        .map((a) => `${a.attemptId}/${a.harnessId}: ${a.error ?? "failed"}`)
        .join("\n");
      const blocked = attempts.some((a) => a.status === "blocked");
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
      writeFailure(store, paths, {
        phase: "harness",
        category: blocked ? "policy" : "harness_error",
        safeMessage: message || "all explorers failed",
        eventRefs: attempts.map((a) => `attempts/${a.attemptId}/events.jsonl`),
        runDir: paths.root,
        nextActions: [
          "Open diagnostics",
          "Check harness authentication",
          "Reduce explore width",
          "Retry after setup",
        ],
      });
      store.writeText(
        join(paths.finalDir, "summary.md"),
        `# Run ${runId} (${opts.mode})\n\n- Lifecycle: ${blocked ? "succeeded (needs review)" : "failed"}\n\n${message}\n`,
      );
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      const scanFailFacts = blocked
        ? makeOutcomeFacts("succeeded", { review: "blocked", reason: "review_blocked" })
        : makeOutcomeFacts("failed", { reason: "harness_failed" });
      if (blocked)
        log.emit("run.blocked", {
          lifecycle: scanFailFacts.lifecycle,
          facts: scanFailFacts,
          phase: "harness",
          error: message,
          failure_ref: "final/failure.yaml",
        });
      else
        log.emit("run.failed", {
          lifecycle: scanFailFacts.lifecycle,
          facts: scanFailFacts,
          reason: scanFailFacts.reason,
          phase: "harness",
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
    const report = opts.deepScan
      ? [
          `Explorers succeeded: ${succeeded.length}/${attempts.length}.`,
          "",
          "## Synthesis",
          ...succeeded.map((a) => {
            const warnings = toolWarnings(a.telemetry);
            const warningText = warnings.length
              ? `\n\n> Tool warnings: ${warnings.map((e) => `${e.tool}: ${e.summary}`).join("; ")}`
              : "";
            return `\n### ${a.attemptId} / ${a.harnessId}\n\n${a.report}${warningText}`;
          }),
          "",
          "## Omissions / Uncertainty",
          ...(unsuccessful.length
            ? unsuccessful.map((a) => `- ${a.attemptId} / ${a.harnessId} ${a.status}: ${a.error}`)
            : [
                "- No explorer failures recorded. Claims still need evidence review before edit execution.",
              ]),
          "",
          "## Follow-up Questions",
          "- Which findings should become a frozen implementation spec?",
          "- Should web research be allowed for a second Explore pass?",
        ].join("\n")
      : (succeeded[0]?.report ?? "(no output)");
    store.writeText(join(paths.finalDir, opts.artifactName), `# ${opts.title}\n\n${report}\n`);
    // ask is the only read-only strategy that can carry a structured-output
    // contract (the boundary refuses the rest); validate the RAW answer text,
    // not the titled artifact wrapper.
    if (opts.mode === "ask" && contract.output_schema) {
      finalizeStructuredOutput({
        store,
        finalDir: paths.finalDir,
        log,
        schema: contract.output_schema,
        answerText: succeeded[0]?.report ?? "",
      });
    }
    // orchestrate: the planner's plan is a TYPED artifact, not just prose. Extract
    // the required fenced JSON block, validate it against the tool belt, and
    // persist final/orchestration.yaml; a missing/invalid block is disclosed in
    // the summary and events (suggest autonomy: the plan is the work product).
    let typedPlanNote = "";
    let orchestratePlan: OrchestratePlanT | null = null;
    if (opts.mode === "orchestrate") {
      const extracted = extractOrchestratePlan(report);
      if (extracted.plan) {
        orchestratePlan = extracted.plan;
        store.writeYaml(join(paths.finalDir, "orchestration.yaml"), extracted.plan);
        log.emit("output.ready", { kind: "report", path: "final/orchestration.yaml" });
        typedPlanNote = `\n- Typed plan: final/orchestration.yaml (${extracted.plan.tool_calls.length} tool call(s))`;
      } else {
        store.writeText(
          join(paths.finalDir, "orchestration_parse_error.md"),
          `# Typed plan missing\n\n${extracted.error}\n`,
        );
        log.emit("output.ready", {
          kind: "report",
          path: "final/orchestration_parse_error.md",
          state: "diagnostic",
        });
        typedPlanNote = `\n- Typed plan: MISSING (${extracted.error}); the markdown plan above is the only artifact`;
      }
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
    );
    log.emit("output.ready", {
      kind: opts.mode === "ask" ? "answer" : "report",
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
    // orchestrate executor (auto_safe/auto_full): the plan is no longer just a
    // suggestion — run its tool_calls in order, classifying each via toolRisk
    // (fail-closed). SAFE steps run as isolated envelope sub-runs / pure reads;
    // a RISKY step (apply) blocks under auto_safe (awaiting a human decision) and
    // applies through the single existing gate under auto_full. The executor's
    // terminal outcome (success / blocked / failed) becomes the run's terminal.
    const autonomy: OrchestrateAutonomy =
      opts.orchestrateContract?.autonomy ?? input.autonomy ?? "suggest";
    let terminalFacts: RunOutcomeFacts = makeOutcomeFacts("succeeded");
    let orchestrateReadOnly = true;
    let orchestrateReceiptRefs: string[] = [];
    const orchestrateBudgetTerminal = ledger.terminal();
    if (orchestrateBudgetTerminal)
      terminalFacts = makeOutcomeFacts("failed", { reason: orchestrateBudgetTerminal });
    // orchestrate's contract output IS the typed plan. If the planner failed to
    // produce a valid one, the run is NOT a clean success — disclose it honestly
    // (the markdown plan stays as a diagnostic artifact) rather than reporting
    // success alongside an orchestration_parse_error.md.
    if (opts.mode === "orchestrate" && !orchestratePlan)
      terminalFacts = makeOutcomeFacts("failed", { reason: "not_converged" });
    if (opts.mode === "orchestrate" && autonomy !== "suggest" && orchestratePlan) {
      // Thread the GENERATED runId onto input so the executor's answer_question
      // step keys the interaction registry by this orchestrate run's id (callers
      // often invoke run() without a preassigned runId).
      const executionInput = { ...input, runId };
      const exec = await executeOrchestratePlan({
        plan: orchestratePlan,
        autonomy,
        maxToolCalls: opts.orchestrateContract?.budget.max_tool_calls ?? null,
        signal: input.signal,
        store,
        paths,
        log,
        ledger,
        executeSafeStep: (call) =>
          this.executeSafeStep(executionInput, call, log, store, paths, ledger),
        executeApplyStep: (call) => this.executeApplyStep(executionInput, call, log),
      });
      terminalFacts = exec.terminal;
      orchestrateReadOnly = exec.readOnly;
      orchestrateReceiptRefs = exec.receiptRefs;
      typedPlanNote += `\n- Executor (${autonomy}): ${exec.note}`;
    }
    const harnessLabel = attempts
      .map((a) => `${a.attemptId}:${a.harnessId}:${a.status}`)
      .join(", ");
    store.writeText(
      join(paths.finalDir, "summary.md"),
      `# Run ${runId} (${opts.mode})\n\n- Harnesses: ${harnessLabel}\n- Lifecycle: ${terminalFacts.lifecycle}${terminalFacts.reason ? ` (${terminalFacts.reason})` : ""}${typedPlanNote}\n\n${report}\n`,
    );
    store.writeYaml(join(paths.finalDir, "work_product.yaml"), {
      id: newId("wp"),
      kind: "report",
      source_task_id: taskId,
      producer_attempt_id: succeeded[0]?.attemptId ?? "a01",
      files: Object.fromEntries([
        [opts.artifactName, join(paths.finalDir, opts.artifactName)],
        ...orchestrateReceiptRefs.map((ref, index) => [`delivery_receipt_${index + 1}`, ref]),
      ]),
      meta: {
        harnesses: attempts.map((a) => a.harnessId),
        mode: opts.mode,
        intent: opts.intent,
        read_only: orchestrateReadOnly,
      },
    });
    log.emit("work_product.emitted", { kind: "report", winner: succeeded[0]?.attemptId ?? null });
    const orchestrateNeedsDecision =
      terminalFacts.lifecycle === "succeeded" &&
      (terminalFacts.review === "blocked" || terminalFacts.checks === "failed");
    const orchestrateFailure = orchestrateFailureFor(terminalFacts);
    if (orchestrateNeedsDecision) {
      // A needs-decision terminal: a required step blocked awaiting a human
      // (review blocked / checks failed). Fires run.blocked, not run.failed.
      writeFailure(store, paths, {
        phase: "executor",
        category: "policy",
        safeMessage:
          "orchestrate has required work that did not succeed (including skipped, not-verified, missing-review, or risky steps); inspect the typed progress record",
        runDir: paths.root,
        nextActions: [
          "Inspect final/orchestration_progress.yaml",
          "Resolve or retry the blocked step",
        ],
      });
      log.emit("run.blocked", {
        lifecycle: terminalFacts.lifecycle,
        facts: terminalFacts,
        phase: "executor",
        failure_ref: "final/failure.yaml",
      });
    } else if (orchestrateFailure) {
      writeFailure(store, paths, { ...orchestrateFailure, runDir: paths.root });
      log.emit("run.failed", {
        lifecycle: terminalFacts.lifecycle,
        facts: terminalFacts,
        reason: terminalFacts.reason,
        phase: orchestrateFailure.phase,
        failure_ref: "final/failure.yaml",
      });
    } else if (terminalFacts.lifecycle === "cancelled") {
      // Cancel is failure-shaped (parity with every other mode's cancel
      // terminal): tailers waiting for run.completed-as-success must not
      // mistake an operator abort for a clean report.
      log.emit("run.failed", {
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
      candidates: attempts.map((a) => ({
        attemptId: a.attemptId,
        harnessId: a.harnessId,
        status: a.status,
      })),
    };
  }

  /**
   * Run one SAFE plan step. start_run/race spawn ISOLATED ENVELOPE sub-runs
   * (inPlace=false, ASSERTED); review/status/answer_question are pure reads /
   * answer delivery that never mutate the live tree.
   */
  private async executeSafeStep(
    input: RunInput,
    call: OrchestratePlanCallT,
    log: EventLog,
    store: ArtifactStore,
    paths: ReturnType<ArtifactStore["runPaths"]>,
    ledger: BudgetLedger,
  ): Promise<OrchestrateSafeStepResult> {
    switch (call.tool) {
      case "start_run":
      case "race": {
        // Isolated envelope sub-run (construction owned by runSupport);
        // recursion guard via orchestrateDepth+1, may NOT orchestrate.
        const subInput: RunInput = {
          ...buildEnvelopeSubInput(input, call, ledger),
        } as RunInput;
        // SAFETY INVARIANT 1 (asserted, not convention): a safe sub-run is an
        // isolated envelope — never a live in-place turn.
        assertEnvelopeSubRun(subInput);
        log.emit("orchestrate.subrun.started", {
          tool: call.tool,
          mode: subInput.mode,
          n: subInput.n ?? null,
        });
        const res = await this.run(subInput);
        return {
          status: res.lifecycle === "failed" || res.lifecycle === "cancelled" ? "failed" : "done",
          terminalFacts: res.facts,
          terminalSource: "subrun",
          evidenceRefs: [`run:${res.runId}`],
          runId: res.runId,
          spendUsd: res.spendUsd ?? null,
          detail: `${call.tool} sub-run ${res.runId} -> ${res.lifecycle}`,
        };
      }
      case "status": {
        // Pure read of the referenced run's decision/work_product artifacts.
        const read = readRunStatus(input.repoRoot, call.run_id);
        return {
          status: read ? "done" : "skipped",
          terminalFacts: read?.facts ?? null,
          terminalSource: "subrun",
          evidenceRefs: read?.evidenceRefs ?? [],
          runId: call.run_id,
          detail: read?.detail ?? `run ${call.run_id} has no readable status artifacts`,
        };
      }
      case "review": {
        // Read-only review over the referenced run's recorded patch diff. The
        // step ACTUALLY runs the reviewer panel (evidence beats summaries — a
        // "done" review must mean a review happened), persists its artifacts, and
        // reports the real outcome; eligibility alone is never reported as done.
        const diff = readRunPatch(input.repoRoot, call.run_id);
        if (diff === null)
          return {
            status: "skipped",
            terminalFacts: null,
            terminalSource: "review",
            evidenceRefs: [],
            runId: call.run_id,
            detail: `run ${call.run_id} has no patch.diff to review`,
          };
        // Aggregate honesty: reviewer panels spend real money on
        // API-keyed routes and the spend is charged AFTER the fact — with no
        // remaining headroom the review must not start at all.
        if (ledger.terminal() !== null) {
          return {
            status: "skipped",
            terminalFacts: null,
            terminalSource: "review",
            evidenceRefs: [],
            runId: call.run_id,
            detail: "aggregate budget exhausted before the review step",
          };
        }
        const reviewers = await this.resolveReviewers(input.repoRoot, input.authPreference);
        if (reviewers.length === 0)
          return {
            status: "skipped",
            terminalFacts: null,
            terminalSource: "review",
            evidenceRefs: [],
            runId: call.run_id,
            detail: "no doctor-OK reviewers available",
          };
        const reviewLease = ledger.reserve({
          taskId: input.taskId ?? "orchestrate",
          attemptId: `review-${call.run_id}`,
          intent: "review",
          harnessId: "review-panel",
          cost: attemptCostEvidence("review-panel", `review-${call.run_id}`),
        });
        if (!reviewLease.granted)
          return {
            status: "skipped",
            terminalFacts: (() => {
              const t = ledger.terminal();
              return t ? makeOutcomeFacts("failed", { reason: t }) : null;
            })(),
            terminalSource: "review",
            evidenceRefs: [],
            runId: call.run_id,
            detail: reviewLease.reason ?? "root paid budget refused the review step",
          };
        const evidenceDir = join(paths.reviewsDir, `orchestrate-${call.run_id}`, "evidence");
        writeEvidencePacket(evidenceDir, {
          userIntent: redactSecrets(input.prompt),
          planAccepted: `orchestrate review tool requested a read-only review of run ${call.run_id}.`,
          diff,
          tests: input.tests?.join("\n") || "(no test commands configured)",
          decidedTradeoffs:
            "This review is scoped to the referenced run patch and must use typed reviewer artifacts, not summary-only evidence.",
        });
        const result = await this.reviewScoped({
          candidateLabel: `Run ${call.run_id}`,
          diff,
          evidenceDir,
          artifactsDir: join(paths.reviewsDir, `orchestrate-${call.run_id}`),
          cwd: input.repoRoot,
          reviewers,
          envInheritance: envInheritance(this.config(input.repoRoot)),
          signal: input.signal,
          onReviewerEvent: (event) => log.emit(event.type, { ...event }),
        }).catch((error: unknown) => {
          ledger.settle(reviewLease.lease?.lease_id ?? "", unknownCostSettlement("review-error"));
          throw error;
        });
        ledger.settle(
          reviewLease.lease?.lease_id ?? "",
          reviewUsageCostSettlement(
            result.reviewCashUsd,
            result.reviewValuationUsd,
            result.reviewSpendEstimated,
            [`orchestrate:review:${call.run_id}`],
            result.reviewUnknownUsd,
          ),
        );
        const revalidated = await revalidateFindings(result.findings, {
          candidateRoot: input.repoRoot,
          evidenceDir,
        });
        store.writeYaml(join(paths.reviewsDir, `orchestrate-${call.run_id}.yaml`), {
          target_run_id: call.run_id,
          cross_family_healthy: result.crossFamilyHealthy,
          cross_family_verified: result.crossFamilyVerified,
          findings: revalidated,
          route_proofs: result.routeProofs,
        });
        const blockers = revalidated.filter((f) => isBlocking(f)).length;
        return {
          status: "done",
          terminalFacts:
            result.crossFamilyVerified && blockers === 0
              ? makeOutcomeFacts("succeeded", { review: "approved" })
              : makeOutcomeFacts("succeeded", { review: "blocked", reason: "review_blocked" }),
          terminalSource: "review",
          evidenceRefs: [`reviews/orchestrate-${call.run_id}.yaml`],
          runId: call.run_id,
          detail: `reviewed ${call.run_id}: ${result.distinctProviders.length} family(ies), ${revalidated.length} finding(s), ${blockers} blocker(s)`,
          // Reviewer panels can spend real money on API-keyed routes; the
          // aggregate cap must charge it like any other step.
          spendUsd: result.reviewCashUsd,
        };
      }
      case "answer_question": {
        // Delivery + registry-keying rationale owned by runSupport.
        const answer = await deliverPlanAnswer(input, call);
        return {
          ...answer,
          terminalFacts: answer.status === "done" ? makeOutcomeFacts("succeeded") : null,
          terminalSource: "executor",
          evidenceRefs: [],
        };
      }
      default: {
        // FAIL-CLOSED: a risky tool (apply) must never reach the safe executor;
        // the caller routes risky steps to executeApplyStep / the auto_safe block.
        throw new Error(
          `executeSafeStep refused a non-safe tool '${(call as { tool: string }).tool}' (risky tools must not run as safe steps)`,
        );
      }
    }
  }

  /** Execute an auto_full apply through the shared fresh-verification gate. */
  private async executeApplyStep(
    input: RunInput,
    call: Extract<OrchestratePlanCallT, { tool: "apply" }>,
    log: EventLog,
  ): Promise<OrchestrateApplyStepResult> {
    const store = new ArtifactStore(input.repoRoot);
    const sub = store.runPaths(call.run_id);
    const patchPath = join(sub.finalDir, "patch.diff");
    const patchText = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : null;
    if (patchText === null)
      return {
        ok: false,
        runId: call.run_id,
        detail: `run ${call.run_id} has no patch.diff`,
        receipt: null,
      };
    if (containsSecretLikeToken(patchText))
      return {
        ok: false,
        runId: call.run_id,
        detail: "patch contains a secret-like token; refusing apply",
        receipt: null,
      };
    const decision = store.readYaml(join(sub.arbitrationDir, "decision.yaml"));
    const workProduct = store.readYaml(join(sub.finalDir, "work_product.yaml"));
    const taskContract = TaskContractSchema.safeParse(
      store.readYaml(join(sub.contextDir, "task.yaml")),
    );
    const parsedDecision = decision ? DecisionRecordSchema.safeParse(decision) : null;
    const parsedWp = workProduct ? WorkProductSchema.safeParse(workProduct) : null;
    if (!taskContract.success)
      return {
        ok: false,
        runId: call.run_id,
        detail: "fresh verification contract is missing",
        receipt: null,
      };
    const applyGateInput = {
      state: null,
      decision: parsedDecision?.success ? parsedDecision.data : null,
      workProduct: parsedWp?.success ? parsedWp.data : null,
      patch: patchText,
      originalRepoRoot: input.repoRoot,
      targetRepoRoot: input.repoRoot,
      operatorDecision: null,
    };
    const gateError = validateApplyGate(applyGateInput);
    if (gateError)
      return {
        ok: false,
        runId: call.run_id,
        detail: `apply gate refused: ${gateError}`,
        receipt: null,
      };
    const delivered = await verifyAndDeliver(
      input.repoRoot,
      patchText,
      { mode: call.mode },
      gateSpecsFromContract(taskContract.data),
      (finalVerify) => validateApplyGate({ ...applyGateInput, finalVerify }),
      log,
    );
    return {
      ok: delivered.applied,
      runId: call.run_id,
      detail: delivered.applied
        ? `applied (${call.mode})`
        : `deliver failed: ${delivered.detail ?? "unknown"}`,
      receipt: delivered,
    };
  }
}

function assertNoSecretLikeTokens(label: string, text: string): void {
  if (containsSecretLikeToken(text)) {
    throw new Error(`${label} contains secret-like token; refusing to persist artifact`);
  }
}

function safeErrorMessage(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err));
}
