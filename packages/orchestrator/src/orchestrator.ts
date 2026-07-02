import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AccessProfile,
  Attachment,
  AttemptTelemetryRecord,
  ConformanceReport,
  ControlReviewerPanelEntry,
  EffortHint,
  ExternalContextPolicy,
  GateResult,
  HarnessEvent,
  Intent,
  InteractionAnswerSet,
  InteractionRequest,
  ModeKind,
  Portfolio,
  ProtectedPathApproval,
  ProjectConfig,
  ReviewFinding,
  RunEvent,
  RunStatus,
  TaskContract,
  ProviderFamily,
  AuthPreference,
  ToolKind,
  WebPolicySupport,
  WorkspaceEnvelope,
} from "@claudexor/schema";
import {
  DEFAULT_ORCHESTRATE_TOOL_BELT,
  HarnessRunSpec,
  OrchestrateContract as OrchestrateContractSchema,
  type OrchestrateContract as OrchestrateContractT,
  type OrchestrateAutonomy,
  OrchestratePlan as OrchestratePlanSchema,
  type OrchestratePlan as OrchestratePlanT,
  type OrchestratePlanCall as OrchestratePlanCallT,
  type OrchestratePlanProgress as OrchestratePlanProgressT,
  type OrchestrateStepStatus,
  toolRisk,
  DecisionRecord as DecisionRecordSchema,
  FinalVerifyRecord,
  WorkProduct as WorkProductSchema,
  FallbackReason as FallbackReasonSchema,
  RouteFallbackPayload as RouteFallbackPayloadSchema,
  SessionReboundLineage as SessionReboundLineageSchema,
  SpecPack as SpecPackZ,
  ModeKind as ModeKindSchema,
  ReviewFinding as ReviewFindingSchema,
  RunTelemetry as RunTelemetrySchema,
  SCHEMA_VERSION,
  TaskContract as TaskContractSchema,
  isBlocking,
} from "@claudexor/schema";
import { loadConfig, trustConfigPath } from "@claudexor/config";
import { specPackToTaskContract } from "@claudexor/interview";
import type { AdapterRegistry, HarnessAdapter, InteractionChannel } from "@claudexor/core";
import { HarnessUnavailableError, summarizeDiffPaths as diffStats, validateModel, withInactivityWatchdog } from "@claudexor/core";
import { assertRouteModelsAllowed } from "./modelGovernance.js";
import {
  type AnnouncedRunContext,
  cancelledResult,
  failTerminally,
  guardAnnouncedRun,
  writeFailure,
} from "./runTerminals.js";
import { resolveExplicitReviewerPanel } from "./reviewerPanel.js";
import { buildOrchestrateBrainPrompt } from "./orchestrateBrain.js";
import { finalVerifyPatch } from "./finalVerifier.js";
import { interactionChannelFor } from "./interaction.js";
import { ArtifactStore } from "@claudexor/artifact-store";
import { EventLog } from "@claudexor/event-log";
import {
  assertMandatoryContext,
  buildContextPack,
  matchAny,
  preflightEvidence,
  writeEvidencePacket,
} from "@claudexor/context";
import {
  WorkspaceManager,
  applyPatchProtected,
  branchDelete,
  ensureGitRepository,
  snapshotTree,
  worktreeAdd,
  worktreeRemove,
} from "@claudexor/workspace";
import { deliver, validateApplyGate } from "@claudexor/delivery";
import { HarnessGateway } from "@claudexor/gateway";
import {
  type GateSpec,
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
  BudgetLedger,
  type RouterCandidate,
  observationFromEvent,
  promptFingerprint,
  selectHarness,
} from "@claudexor/budget";
import {
  classifyRisk,
  DEFAULT_REQUIRE_HUMAN_PATHS,
  requireHuman,
  reviewDepthForRisk,
} from "@claudexor/policy";
import {
  appendLine,
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
  portfolio?: Portfolio;
  maxUsd?: number | null;
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
  /** Files/images attached to this turn, resolved to scoped on-disk paths. */
  attachments?: Attachment[];
  /**
   * Opt this run into the agent-driven browser (Playwright MCP). Honored only
   * for browser-capable harnesses when web policy is not `off`; the orchestrator
   * resolves it to a per-harness `HarnessRunSpec.browser`.
   */
  browser?: boolean;
  mode?: ModeKind;
  contextMode?: "off" | "auto";
  harnesses?: string[];
  primaryHarness?: string;
  portfolio?: Portfolio;
  n?: number;
  baseRef?: string;
  attempts?: number | null;
  /** agent flag: iterate until the convergence predicate is clean (no fixed cap). */
  untilClean?: boolean;
  /** audit flag: bounded read-only research swarm (the old `explore` mode). */
  swarm?: boolean;
  /** agent flag: create-from-scratch intent (the old `create` mode). */
  create?: boolean;
  synthesis?: SynthesisMode;
  /** Explicit deterministic gate commands from caller-provided run configuration. */
  tests?: string[];
  /** Typed per-run approval for changing auto-protected gate/test paths. */
  protectedPathApprovals?: ProtectedPathApproval[];
  /** Hard per-run spend cap (USD); overrides deps.maxUsd when set. */
  maxUsd?: number | null;
  /** Orchestrate executor: cap on plan tool calls (D9). */
  maxToolCalls?: number | null;
  /** Access profile; e.g. `full` for autonomous terminal tasks (agent and in-place convergence). */
  access?: AccessProfile;
  /** External/web context policy. Separate from shell/network sandboxing. */
  web?: ExternalContextPolicy;
  externalContextPolicy?: ExternalContextPolicy;
  /**
   * Scalar model convenience: expands to the RESOLVED PRIMARY harness only
   * (never the pool). Rejected when no primary is resolvable (D2/INV-103).
   * Cleared during input resolution — routing reads `models`.
   */
  model?: string;
  /** Harness-scoped model map (harness id → model id). Specific beats general:
   * an entry wins over the scalar `model` and the per-harness settings default. */
  models?: Record<string, string>;
  /** Optional reasoning-effort hint forwarded to harnesses that support it. */
  effort?: EffortHint;
  /** Frozen SpecPack provenance when a run is bound to a hard-locked spec. */
  specId?: string;
  specHash?: string;
  specPath?: string;
  /** Pre-assigned ids so a caller (daemon/control-api) knows them before the run starts. */
  runId?: string;
  taskId?: string;
  /** Thread this run is a turn of (A2 chat/session-first); recorded in events. */
  threadId?: string;
  /** Preferred auth route for harness attempts (subscription/api_key/auto). */
  authPreference?: "subscription" | "api_key" | "auto";
  /**
   * Native CLI session ids to resume, keyed by harness id (the thread's vendor
   * session cache). A routed harness with an entry continues its own native
   * conversation (`codex exec resume` / `claude --resume`) instead of starting fresh.
   */
  resumeSessions?: Record<string, string>;
  /** Called when a harness emits its native session id (recorded for future resume). */
  onSessionObserved?: (
    harnessId: string,
    nativeSessionId: string,
    observedModel?: string | null,
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
   * How much the orchestrate brain may act without confirmation
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
  status: RunStatus;
  winner: string | null;
  runDir: string;
  summary: string;
  candidates: { attemptId: string; harnessId: string; status: string }[];
  decisionPath?: string;
  reviewVerified?: boolean;
  /** Settled ledger spend for this run (USD); null when no ledger tracked it.
   * Consumer: the orchestrate executor's aggregate budget across sub-runs. */
  spendUsd?: number | null;
}

interface CandidateRun {
  attemptId: string;
  harnessId: string;
  label: string;
  diff: string;
  /** Concatenated assistant message text — the answer when the turn changed no
   * files (a pure question-answer move on an agent thread). */
  answerText?: string;
  /** Filesystem tree reviewers must inspect for this candidate. */
  reviewCwd?: string;
  /** The envelope's base sha — the FinalVerifier's verify-tree anchor. */
  baseSha?: string;
  gates: GateResult[];
  cost: number;
  errored: boolean;
  /** True when any of `cost` is token-estimated (not natively reported). */
  costEstimated: boolean;
  /** Redacted runtime error summaries (harness errors + unrecovered tool errors). */
  errors: string[];
  telemetry: AttemptTelemetry;
  /**
   * Set when the attempt died BEFORE the harness stream produced any work
   * (e.g. workspace envelope creation failed). Such corpses carry no
   * reviewable evidence and must never reach review/synthesis/arbitration.
   */
  infraPhase?: "workspace" | "harness";
}

interface ToolErrorRecord {
  tool: string;
  kind: ToolKind;
  target: string | null;
  summary: string;
  toolUseId: string | null;
  /** True when a later successful result of the same tool exists in the same attempt. */
  recovered: boolean;
}

type AttemptOutcomeStatus = "success" | "success_with_warnings" | "blocked" | "failed";

interface AttemptOutcomeState {
  deliverablePresent: boolean;
  gatesPassed: boolean | null;
  harnessErrored: boolean;
  webRequiredUnsatisfied: boolean;
  toolWarningsCount: number;
  status: AttemptOutcomeStatus;
}

interface WebEvidenceState {
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

interface AttemptTelemetry {
  toolErrors: ToolErrorRecord[];
  /** tool_result events without a status field: never silently treated as ok. */
  statuslessResults: number;
  /** Native lines/events the adapter reported as dropped/unrecognized. */
  droppedEvents: number;
  web: WebEvidenceState;
  /** Model identity the harness stream actually reported (route evidence). */
  observedModel: string | null;
  /** Adapter-declared transient failures seen during this attempt. */
  transientFailures: {
    kind: NonNullable<HarnessEvent["transient"]>["kind"];
    retryDelayMs: number | null;
  }[];
  /** Contract/outcome truth for this attempt, produced by the orchestrator. */
  outcome: AttemptOutcomeState | null;
}

interface TransientRetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

/** User-level per-harness defaults (from the global config) applied at route time. */
interface HarnessRouteSettings {
  defaultModel: string | null;
  effort: EffortHint | null;
  web: ExternalContextPolicy | null;
  maxUsd: number | null;
  maxTurns: number | null;
  maxRounds: number | null;
  toolsAllow: string[];
  toolsDeny: string[];
  fallbackModel: string | null;
}

/** A routed candidate adapter plus its manifest capabilities and user settings. */
interface RoutedAdapter {
  adapter: HarnessAdapter;
  webSupport: WebPolicySupport;
  providerFamily: ProviderFamily;
  supportsMaxTurns: boolean;
  supportsToolLists: boolean;
  supportsBrowser: boolean;
  /** Declared effort ladder (empty = effort is not a tunable surface; a
   * requested effort is then DISCLOSED as ignored, never silently dropped). */
  effortLevels: readonly EffortHint[];
  /** Manifest model truth source (used when the adapter has no live models()). */
  knownModels: readonly string[];
  /** Manifest `interactive` capability: only such routes are OFFERED an
   * InteractionChannel (A2 gate). */
  supportsInteractive: boolean;
  settings: HarnessRouteSettings | null;
}

const LABELS = "ABCDEFGHIJ".split("");
const NO_PROJECT_ROOT = noProjectRepoRoot();
const REVIEW_EVIDENCE_DIRNAME = ".claudexor-review-evidence";
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

  constructor(private readonly deps: OrchestratorDeps) {
    this.gateway = new HarnessGateway(deps.registry);
  }

  async run(input: RunInput): Promise<OrchestratorResult> {
    const resolved = this.resolveRunInput(input);
    const parsedMode = ModeKindSchema.safeParse(resolved.mode ?? "agent");
    if (!parsedMode.success) {
      throw new Error(`unknown mode: ${String(resolved.mode)}`);
    }
    const mode: ModeKind = parsedMode.data;
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
    // model probes and never fails a run that would not use it (T2#12).
    // Whole-strategy terminal net (T3.1#2): once a strategy ANNOUNCES its
    // run, any escaped throw still stamps failure.yaml + summary + run.failed
    // instead of orphaning events.jsonl.
    return guardAnnouncedRun(resolved.signal, (announce) => {
      switch (mode) {
        case "ask":
          return this.runAsk(resolved, announce);
        case "audit":
          // `--swarm` selects the bounded read-only research swarm (old `explore`).
          return resolved.swarm ? this.runExplore(resolved, announce) : this.runAudit(resolved, announce);
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
          // orchestrateDepth>0 and must NOT itself orchestrate (no infinite brain
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
    const specs: ReviewerSpec[] = [];
    const seen = new Set<string>();
    const harnessSettings = this.config(cwd)?.global.harnesses ?? {};
    const reviewHome = new WorkspaceManager(cwd).readOnlyHomeEnv();
    try {
      for (const adapter of this.deps.registry.values()) {
        let m: Awaited<ReturnType<HarnessAdapter["discover"]>> | null = null;
        try {
          m = await adapter.discover();
        } catch {
          continue;
        }
        if (!m || m.kind === "fake" || seen.has(m.provider_family)) continue;
        // Per-harness settings gate reviewers before doctor/model probes: a disabled
        // harness must not spend auth/API-key readiness checks.
        if (harnessSettings[adapter.id]?.enabled === false) continue;
        const authPreference = this.authPreferenceForHarness(cwd, adapter.id, runAuthPreference);
        let report: ConformanceReport | null = null;
        try {
          report = await adapter.doctor({ cwd, env: reviewHome.env, authPreference });
        } catch {
          continue;
        }
        if (report.status !== "ok") continue; // reviewer eligibility needs scoped doctor-OK.
        if (!report.enabled_intents.includes("review")) continue;
        if (!m.capabilities.review || !m.access_profiles_supported.includes("readonly")) continue;
        // Explicit per-family override first, then the user's per-harness
        // default model: an explicit model request makes the route provable
        // (accepted_model_arg) on CLIs that never echo their model.
        const requestedModel =
          this.deps.reviewerModels?.[m.provider_family] ??
          harnessSettings[adapter.id]?.default_model ??
          null;
        // STRICT (D3): the auto panel applies the SAME model truth gate as the
        // explicit panel — a doomed reviewer model is refused here, never
        // forwarded to die as an opaque native error mid-review.
        if (requestedModel) {
          const check = validateModel(
            requestedModel,
            typeof adapter.models === "function"
              ? (await adapter.models({ cwd, env: reviewHome.env, authPreference })).map((x) => x.id)
              : m.capabilities.known_models,
            typeof adapter.models === "function" ? "api" : "manifest",
          );
          if (check.status !== "ok") {
            throw new HarnessUnavailableError(
              `auto-selected reviewer harness '${adapter.id}' refused model '${requestedModel}': ${check.message}; ` +
                `fix the reviewer model override or harnesses.${adapter.id}.default_model, or run \`claudexor models --harness ${adapter.id}\``,
            );
          }
        }
        seen.add(m.provider_family);
        specs.push({
          adapter,
          providerFamily: m.provider_family,
          requestedModel,
          requestedEffort: this.deps.reviewerEfforts?.[m.provider_family] ?? null,
          authPreference,
        });
        if (specs.length >= 2) break;
      }
    } finally {
      reviewHome.dispose();
    }
    return specs;
  }

  /**
   * Resolve reviewers INSIDE a strategy, after run-dir creation: an explicit
   * panel whose harness/model/effort fails validation ends the run through
   * the routing-failure artifact path (failure.yaml + summary + run.failed
   * naming the refusal) BEFORE any candidate spends money — never a bare
   * pre-announce throw with no artifacts (T2#12 artifact clause).
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
        `# Run ${runId} (${mode})\n\n- Status: failed\n- Phase: review preflight\n\n${message}\n`,
      );
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      log.emit("run.failed", {
        status: "failed",
        phase: "review_preflight",
        error: message,
        failure_ref: "final/failure.yaml",
      });
      return {
        failed: {
          runId,
          taskId,
          mode,
          status: "failed",
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
   * Resolve the per-harness browser-tool wiring for a run spec. Returns null
   * (no browser) unless: the run opted in (`input.browser`), the harness has the
   * `browser_tool` capability, AND web policy is not `off` (the browser is live
   * egress and must ride `external_context_policy`). Screenshots/PDFs are written
   * into the run's artifact tree so they surface in the Canvas gallery. Headed by
   * default so the user can watch; `cdp_endpoint` is filled by the headed-Chromium
   * launcher (7B) for the shared, mirrored window.
   */
  private browserSpecFor(
    input: RunInput | undefined,
    routed: RoutedAdapter,
    webPolicy: ExternalContextPolicy,
    access: AccessProfile,
    paths: ReturnType<ArtifactStore["runPaths"]>,
  ): { output_dir: string; headless: boolean } | null {
    if (!input?.browser || !routed.supportsBrowser || webPolicy === "off") return null;
    // The browser MCP drives a real Chromium (subprocess + live network). Codex's
    // workspace-write sandbox cancels the navigation (live-verified across
    // network_access / approval_policy / external-CDP variants) — only full access
    // lets it through. Require full access rather than silently inject a browser
    // whose first navigation will fail. The composer discloses this when the user
    // arms the tool; a non-full run drops the browser honestly (no broken tool).
    // headless:false -> a real headed window is the live view (Anton's chosen
    // mirror); output_dir captures navigation snapshots into the run tree.
    if (access !== "full" && access !== "external_sandbox_full") return null;
    return { output_dir: join(paths.root, "browser"), headless: false };
  }

  /**
   * Session fields for a route's run spec: auth route preference + native
   * resume id (A2). Preference precedence: explicit per-run > per-harness
   * config > global routing config > auto.
   */
  /** The tree the harness reads/operates in: the thread worktree for an isolated
   * thread, else the project. Config/artifacts/contract stay anchored to repoRoot. */
  /** Per-candidate reservation floor (DD-27) from user config. */
  private estimateUsdFloor(repoRoot: string): number {
    return this.config(repoRoot)?.global.budget.estimate_usd_floor ?? 0.05;
  }

  private execRootOf(input: RunInput): string {
    return input.executionRoot ?? input.repoRoot;
  }

  private sessionSpecFields(
    input: RunInput,
    harnessId: string,
  ): { auth_preference: "subscription" | "api_key" | "auto"; resume_session_id: string | null } {
    const cfg = this.config(input.repoRoot)?.global;
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
      resume_session_id: input.resumeSessions?.[harnessId] ?? null,
    };
  }

  /** Record a harness-emitted native session id for future thread resume (observer never fails the run). */
  private observeNativeSession(
    input: RunInput | undefined,
    harnessId: string,
    ev: HarnessEvent,
  ): void {
    if (!input?.onSessionObserved || ev.type !== "started") return;
    const nid = ev.payload?.["native_session_id"];
    if (typeof nid === "string" && nid.length > 0) {
      try {
        input.onSessionObserved(harnessId, nid, ev.observed_model ?? null);
      } catch {
        /* observer errors must never fail the run */
      }
    }
  }

  /**
   * Lift an adapter's auth-route override marker into the typed
   * `route.fallback.auth_switched` run event (validated payload). An explicit
   * subscription/api_key preference that could not be honored is never silent;
   * neither is an `auto` choice that selects a smoke-proven paid route over an
   * available native route.
   */
  private observeAuthSwitch(
    log: EventLog | undefined,
    harnessId: string,
    attemptId: string,
    ev: HarnessEvent,
  ): void {
    if (!log || ev.type !== "message" || ev.payload?.["auth_switched"] !== true) return;
    // Most auth_switched markers mean the preferred auth route was unavailable,
    // so the default reason is `auth_unavailable`. Adapters may override with a
    // more specific typed reason, e.g. `readiness_preferred` when auto selects a
    // smoke-proven route for reliability/cost transparency.
    const overrideReason = FallbackReasonSchema.safeParse(ev.payload?.["reason"]);
    try {
      log.emit(
        "route.fallback.auth_switched",
        RouteFallbackPayloadSchema.parse({
          from_harness: harnessId,
          to_harness: harnessId,
          from_auth_mode: ev.payload?.["from_auth_mode"],
          to_auth_mode: ev.payload?.["to_auth_mode"],
          reason: overrideReason.success ? overrideReason.data : "auth_unavailable",
          attempt_id: attemptId,
        }) as unknown as Record<string, unknown>,
      );
    } catch {
      /* a malformed marker must not fail the run */
    }
  }

  /**
   * Resolve candidate adapters: explicit `--harness`, else available real harnesses, then
   * **capability-gate** to those that can actually produce work for `intent` (e.g. a
   * raw-API reviewer with `implement: false` is dropped from an implement race), and
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
    const policy = cfg?.global.routing.default_policy;
    const harnesses =
      input.harnesses ??
      (configuredPool && configuredPool.length > 0
        ? configuredPool
        : policy === "primary" && cfg?.global.routing.primary_harness
          ? [cfg.global.routing.primary_harness]
          : undefined);
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
    // D2/INV-103: model choice is harness-scoped end-to-end. The scalar
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
      portfolio:
        input.portfolio ??
        this.deps.portfolio ??
        cfg?.project.budget?.portfolio ??
        cfg?.global.default_portfolio ??
        "subscription-first",
      web,
      externalContextPolicy: web,
    };
  }

  private async resolveCandidateAdapters(
    input: RunInput,
    intent: Intent,
    ledger?: BudgetLedger,
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
    const policy = input.web ?? input.externalContextPolicy ?? "auto";
    // Vision is a capability: a run carrying an image attachment must route to a
    // harness that can actually deliver it (image_input != "none"). Routing an
    // image to cursor/opencode (image_input="none") silently drops it and the
    // model honestly reports it saw nothing — the schema's attachment contract
    // (attachment.ts) promises the opposite. Gate the pool below, mirroring web.
    const needsVision = (input.attachments ?? []).some((a) => a.kind === "image");
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
      const status = statusById.get(id);
      const manifest = status?.manifest ?? null;
      if (!status || !manifest) {
        dropped.push(`${id} (unavailable)`);
        continue;
      }
      // Doctor status is the readiness truth: auto-pools take only doctor-OK
      // routes, and explicitly selecting an UNAVAILABLE harness fails loudly
      // with the doctor's reasons. A DEGRADED harness (e.g. key present but
      // unproven by isolated smoke) is admitted only by explicit user
      // selection — degraded means usable-with-caveats, and the caveats are
      // visible in doctor output and run events.
      if (status.status === "unavailable") {
        const why = `${id} is unavailable${status.reasons.length ? `: ${status.reasons.join("; ")}` : ""}`;
        if (explicitPool) throw new HarnessUnavailableError(why);
        dropped.push(why);
        continue;
      }
      if (status.status !== "ok" && !explicitPool) {
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
      // Mirror buildContract: the trust-config default decides write-mode access
      // when the run does not request a profile explicitly.
      const requiredAccess = readOnlyIntent
        ? "readonly"
        : (input.access ?? this.config(input.repoRoot).trust.access_default);
      const accessSupported =
        !requiredAccess || manifest.access_profiles_supported.includes(requiredAccess);
      const webSupport = manifest.capabilities.web_policy;
      // The PER-ROUTE policy is what this harness will actually execute: a
      // per-harness `web` default upgrades a run-level `auto` (routeSpecKnobs
      // applies the same rule when building the spec), so the capability gate
      // must judge that effective policy — not admit a route whose configured
      // default it could never honor.
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
      // Vision gate: an image-bearing run only routes to vision-capable harnesses.
      // Exclude blind ones from auto-pools; fail loud if the user explicitly chose one.
      if (needsVision && manifest.capability_profile.image_input === "none") {
        const why = `${id} cannot accept image attachments (manifest image_input=none); choose a vision-capable harness (claude/codex/raw-api) or remove the image attachment`;
        if (explicitPool) throw new HarnessUnavailableError(why);
        dropped.push(why);
        continue;
      }
      const reason = status.reasons.length > 0 ? `: ${status.reasons.join("; ")}` : "";
      if (status.enabledIntents.includes(intent) && accessSupported) {
        pool.push({
          adapter,
          webSupport,
          providerFamily: manifest.provider_family,
          supportsMaxTurns: manifest.capabilities.max_turns,
          supportsToolLists: manifest.capabilities.tool_lists,
          supportsBrowser: manifest.capabilities.browser_tool,
          effortLevels: manifest.capabilities.effort_levels,
          knownModels: manifest.capabilities.known_models,
          supportsInteractive: manifest.capabilities.interactive,
          settings: cfgEntry
            ? {
                defaultModel: cfgEntry.default_model,
                effort: cfgEntry.effort,
                web: cfgEntry.web === "auto" ? null : cfgEntry.web,
                maxUsd: cfgEntry.max_usd,
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
    const ordered = this.orderPool(pool, input, statusById, ledger);
    const n = input.n ?? ordered.length;
    const out: RoutedAdapter[] = [];
    for (let i = 0; i < n; i++) out.push(ordered[i % ordered.length] as RoutedAdapter);
    // Strict pre-run model gate (D3/INV-104) — see modelGovernance.ts.
    await assertRouteModelsAllowed(out, input.models, this.execRootOf(input));
    return out;
  }

  /**
   * Order the eligible pool by portfolio routing utility (budget router): an
   * explicit user pool keeps the user's order; an explicit primary harness is
   * always pinned first. Cross-family diversity is encouraged for later slots.
   */
  private orderPool(
    pool: RoutedAdapter[],
    input: RunInput,
    statusById: Map<string, { manifest?: { auth_modes?: string[] } | null }>,
    ledger?: BudgetLedger,
  ): RoutedAdapter[] {
    let ordered = pool;
    const explicitPool = Boolean(input.harnesses && input.harnesses.length > 0);
    if (!explicitPool && pool.length > 1) {
      const routeLedger = ledger ?? new BudgetLedger();
      const portfolio = input.portfolio ?? this.deps.portfolio ?? "subscription-first";
      const byId = new Map(pool.map((r) => [r.adapter.id, r]));
      const remaining: RouterCandidate[] = pool.map((r) => {
        const authModes = statusById.get(r.adapter.id)?.manifest?.auth_modes ?? [];
        return {
          harnessId: r.adapter.id,
          providerFamily: r.providerFamily,
          available: true,
          authMode: authModes.includes("local_session")
            ? "local_session"
            : authModes.includes("api_key")
              ? "api_key"
              : "unknown",
        };
      });
      const ranked: RoutedAdapter[] = [];
      while (remaining.length > 0) {
        const best = selectHarness(remaining, {
          portfolio,
          ledger: routeLedger,
          diversityAgainst: ranked.map((r) => r.providerFamily),
        });
        if (!best) break; // cooldowns/zero-utility: keep residual pool order
        const idx = remaining.findIndex((c) => c.harnessId === best.harnessId);
        remaining.splice(idx, 1);
        const routed = byId.get(best.harnessId);
        if (routed) ranked.push(routed);
      }
      for (const c of remaining) {
        const routed = byId.get(c.harnessId);
        if (routed) ranked.push(routed);
      }
      ordered = ranked;
    }
    if (input.primaryHarness) {
      const primary = ordered.find((r) => r.adapter.id === input.primaryHarness);
      if (primary) ordered = [primary, ...ordered.filter((r) => r !== primary)];
    }
    return ordered;
  }

  /**
   * Lazy ContextPack (Q13): built ONLY for the read-only report modes
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
    // SF6: the versioned project config drives the context pack — mandatory files
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
   * Ledger a routed harness reserves from: harnesses with a configured
   * `max_usd` get a child sub-ledger (spend rolls up to the run cap), so one
   * harness exhausting its own budget cannot drain the whole run.
   */
  private harnessLedger(
    map: Map<string, BudgetLedger>,
    parent: BudgetLedger,
    routed: RoutedAdapter,
  ): BudgetLedger {
    const cap = routed.settings?.maxUsd;
    if (!cap || cap <= 0) return parent;
    let child = map.get(routed.adapter.id);
    if (!child) {
      child = parent.child({ maxUsd: cap });
      map.set(routed.adapter.id, child);
    }
    return child;
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

  /** Resolved child-env composition mode (mirror_native|clean) from global config. */
  private envInheritance(repoRoot: string): "mirror_native" | "clean" {
    return this.config(repoRoot).global.routing.env_inheritance;
  }

  private transientRetryPolicy(repoRoot: string): TransientRetryPolicy {
    const cfg = this.config(repoRoot).global.runtime.transient_retry;
    return {
      maxRetries: cfg.max_retries,
      initialDelayMs: cfg.initial_delay_ms,
      maxDelayMs: cfg.max_delay_ms,
    };
  }

  private reviewerTimeoutMs(repoRoot: string): number {
    return this.config(repoRoot).global.runtime.reviewer_timeout_ms;
  }

  private harnessInactivityTimeoutMs(repoRoot: string): number {
    return this.config(repoRoot).global.runtime.harness_inactivity_timeout_ms;
  }

  private buildContract(input: RunInput, taskId: string, mode: ModeKind): TaskContract {
    const resolvedCfg = this.config(input.repoRoot);
    const cfg = resolvedCfg.project;
    const readOnlyMode =
      mode === "ask" || mode === "plan" || mode === "audit" || mode === "orchestrate";
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
      throw new Error(
        `access profile 'full' requires allow_full_access: true in the user-level trust file for this repo ` +
          `(${trustConfigPath(input.repoRoot)}); enable it with \`claudexor trust --allow-full-access\` — refusing to run unsandboxed`,
      );
    }
    const externalContextPolicy = input.web ?? input.externalContextPolicy ?? "auto";
    // A frozen SpecPack's CONTENT reaches the contract (success criteria,
    // non-goals, forbidden approaches, tradeoffs, task graph) — previously only
    // its metadata did, leaving the arbitration acceptance axis permanently
    // empty and the interview pipeline dead in production.
    let specFields: Partial<TaskContract> = {};
    let specTestCommands: string[] = [];
    if (input.specPath) {
      try {
        const spec = SpecPackZ.parse(JSON.parse(readFileSync(input.specPath, "utf8")));
        // Tamper fence (T3.2#7, INV-081): the frozen spec's recorded hash must
        // match what we just read — a spec.json edited AFTER freeze would
        // otherwise silently rewrite success criteria/tests/protected paths
        // while the contract records the stale hash as provenance.
        if (input.specHash && hashJson(spec) !== input.specHash) {
          throw new Error(
            `frozen SpecPack hash mismatch (expected ${input.specHash}, got ${hashJson(spec)}); the spec was modified after freeze — re-freeze it or drop --spec`,
          );
        }
        const fromSpec = specPackToTaskContract(spec, {
          repoRoot: input.repoRoot,
          mode,
          baseRef: input.baseRef,
          maxUsd: input.maxUsd,
        });
        specFields = {
          success_criteria: fromSpec.success_criteria,
          non_goals: fromSpec.non_goals,
          forbidden_approaches: fromSpec.forbidden_approaches,
          decided_tradeoffs: fromSpec.decided_tradeoffs,
          task_graph: fromSpec.task_graph,
          constraints: fromSpec.constraints,
        };
        specTestCommands = fromSpec.tests.commands.map((test) => test.command);
      } catch (err) {
        // An unreadable/unfrozen spec must fail the run loudly, never silently
        // degrade into an unspecced contract.
        throw new Error(
          `failed to resolve frozen SpecPack at ${input.specPath}: ${safeErrorMessage(err)}`,
        );
      }
    }
    // Deterministic gate commands come from the frozen SpecPack, explicit run
    // input, then versioned project config. Without these, gateSpecs is empty
    // and convergence is review-only; with them, convergence is test-driven.
    const seenCommands = new Set<string>();
    const commands = [...specTestCommands, ...(input.tests ?? []), ...(cfg?.tests?.commands ?? [])]
      .map((c) => c.trim())
      .filter(Boolean)
      .filter((command) => {
        if (seenCommands.has(command)) return false;
        seenCommands.add(command);
        return true;
      })
      .map((command, i) => {
        assertNoSecretLikeTokens(`gate command ${i + 1}`, command);
        return { id: `gate-${i + 1}`, command, required: true };
      });
    const protectedPaths = [...new Set(specFields.constraints?.protected_paths ?? [])];
    const autoProtectedPaths = [...new Set(gateProtectedPaths(commands.map((c) => c.command)))];
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
      spec:
        input.specId || input.specHash || input.specPath
          ? {
              id: input.specId,
              hash: input.specHash,
              path: input.specPath,
            }
          : undefined,
      ...specFields,
      constraints: {
        protected_paths: protectedPaths,
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
        portfolio:
          input.portfolio ?? this.deps.portfolio ?? cfg?.budget?.portfolio ?? "subscription-first",
        // Run cap precedence: explicit run input > surface deps > the user's
        // configured global per-run default. ($/day caps were removed; the budget
        // priority is respecting harness-reported subscription/OAuth quota — SF3.)
        max_usd:
          input.maxUsd ?? this.deps.maxUsd ?? resolvedCfg.global.budget.max_usd_per_run ?? null,
      },
      // The resolved harness-scoped model map (scalar already expanded to the
      // primary by resolveRunInput). The contract is what route spec building
      // reads — there is no run-global model (D2/INV-103).
      routing_models: input.models ?? {},
    });
  }

  private gateSpecs(contract: TaskContract): GateSpec[] {
    return contract.tests.commands.map((c) => ({
      id: c.id,
      command: c.command,
      required: c.required,
    }));
  }

  private testsEvidence(contract: TaskContract, gates?: GateResult[]): string {
    const specs = this.gateSpecs(contract);
    if (gates === undefined) {
      if (specs.length === 0) return "(no test commands configured)";
      return [
        "Configured test commands (not run yet):",
        ...specs.map(
          (spec) => `- ${spec.id}${spec.required === false ? " (optional)" : ""}: ${spec.command}`,
        ),
      ].join("\n");
    }
    if (gates.length === 0) {
      if (specs.length === 0) return "(no test commands configured)";
      return [
        "Configured test commands did not produce gate results before this review:",
        ...specs.map(
          (spec) => `- ${spec.id}${spec.required === false ? " (optional)" : ""}: ${spec.command}`,
        ),
      ].join("\n");
    }
    const required = gates.filter((gate) => gate.required);
    const requiredPassed = required.filter((gate) => gate.status === "passed").length;
    const lines = [
      `Gate results: required ${requiredPassed}/${required.length} passed; total ${gates.length}.`,
    ];
    const appendTail = (label: string, text: string | null): void => {
      if (!text) return;
      lines.push(`  ${label}: |`);
      for (const line of text.split(/\r?\n/)) lines.push(`    ${line}`);
    };
    for (const gate of gates) {
      lines.push(
        `- ${gate.id}${gate.required === false ? " (optional)" : ""}: ${gate.status}; exit=${gate.exit_code ?? "null"}; duration_ms=${gate.duration_ms}`,
      );
      lines.push(`  command: ${gate.command}`);
      if (gate.output_truncated) lines.push("  output_truncated: true");
      appendTail("stdout_tail", gate.stdout_tail);
      appendTail("stderr_tail", gate.stderr_tail);
    }
    return lines.join("\n");
  }

  private writeTestsEvidence(
    evidenceDir: string,
    contract: TaskContract,
    gates?: GateResult[],
  ): void {
    writeText(join(evidenceDir, "TESTS.txt"), this.testsEvidence(contract, gates).trim() + "\n");
  }

  /**
   * Per-harness settings applied to one route's run spec (model/effort/web
   * defaults, max_turns, tool lists). Knobs the manifest does not support are
   * RETURNED as ignored reasons (disclosed by the caller), never silently sent.
   */
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
    if (s?.maxTurns) {
      if (routed.supportsMaxTurns) maxTurns = s.maxTurns;
      else
        ignored.push(
          `max_turns=${s.maxTurns} (manifest capabilities.max_turns=false for ${routed.adapter.id})`,
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
    // Harness-scoped model resolution (D2/INV-103): explicit per-attempt
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

  /** Run one candidate inside an already-created envelope. Never creates/disposes the envelope. */
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
  ): Promise<CandidateRun> {
    const adapter = routed.adapter;
    const knobs = this.routeSpecKnobs(
      routed,
      contract,
      modelHint,
      effortHint,
    );
    // In-place envelopes mutate the live tree under the user's native environment
    // (no scoped HOME), so the vendor's own session store is reachable: the turn
    // RESUMES the native CLI session (real continuity, like the read-only paths).
    // Isolated envelopes (race candidates) get a fresh scoped home where that
    // session id cannot exist — they run fresh, with a typed session.rebound
    // disclosure, never a deterministic session-not-found failure.
    const inPlaceEnvelope = envelope.worktree_path === envelope.repo_root;
    const sessionFields = runInput ? this.sessionSpecFields(runInput, adapter.id) : undefined;
    const spec = HarnessRunSpec.parse({
      session_id: newId("ses"),
      intent,
      prompt: promptWithProtectedPathConstraint(
        prompt,
        contract.constraints.protected_paths,
        contract.constraints.auto_protected_paths,
        contract.constraints.protected_path_approvals,
      ),
      attachments: runInput?.attachments ?? [],
      browser: this.browserSpecFor(runInput, routed, knobs.webPolicy, access, paths),
      cwd: envelope.worktree_path,
      access,
      external_context_policy: knobs.webPolicy,
      tool_permission_policy: {
        web: knobs.webPolicy,
        allow: [...new Set([...contract.tool_permission_policy.allow, ...knobs.toolsAllow])],
        deny: [...new Set([...contract.tool_permission_policy.deny, ...knobs.toolsDeny])],
      },
      model_hint: knobs.model,
      effort_hint: knobs.effort,
      max_turns: knobs.maxTurns,
      max_usd: routed.settings?.maxUsd ?? null,
      env_inheritance: this.envInheritance(contract.repo.root),
      ...(sessionFields ? { auth_preference: sessionFields.auth_preference } : {}),
      ...(inPlaceEnvelope && sessionFields?.resume_session_id
        ? { resume_session_id: sessionFields.resume_session_id }
        : {}),
      // Scoped harness home only for isolated envelopes; in-place runs use the
      // native environment so the resumed vendor session is actually reachable.
      ...(inPlaceEnvelope ? {} : { env: wsm.envFor(envelope) }),
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
    // Per-attempt abort controller: the inactivity watchdog aborts THIS
    // attempt's stream (killing the process group through the existing abort
    // plumbing) without touching the run-level cancel signal, so a timeout
    // and a user cancel stay distinguishable (T3.1#1).
    const attemptAbort = new AbortController();
    spec.extra["abortSignal"] = signal ? AbortSignal.any([signal, attemptAbort.signal]) : attemptAbort.signal;
    if (interaction) spec.extra["interactionChannel"] = interaction;
    const inactivityMs = this.harnessInactivityTimeoutMs(contract.repo.root);

    let cost = 0;
    let costEstimated = false;
    let harnessErrored = false;
    const errors: string[] = [];
    const messageParts: string[] = [];
    const retryPolicy = this.transientRetryPolicy(contract.repo.root);
    const telemetry = createAttemptTelemetry(
      knobs.webPolicy,
      contract.external_context.web_required ||
        knobs.webPolicy === "cached" ||
        knobs.webPolicy === "live",
      effectiveWebMode ?? knobs.webPolicy,
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
        const runSpec =
          nativeTry === 0
            ? spec
            : HarnessRunSpec.parse({ ...spec, session_id: newId("ses"), extra: { ...spec.extra } });
        activeSessionId = runSpec.session_id;
        const transientStart = telemetry.transientFailures.length;
        try {
          const watched = withInactivityWatchdog(adapter.run(runSpec), {
            timeoutMs: inactivityMs,
            onTimeout: () => {
              attemptAbort.abort();
              void adapter.cancel?.(activeSessionId)?.catch(() => {});
            },
          });
          for await (const ev of watched) {
            if (signal?.aborted) break;
            const safeEv = redactHarnessEvent(ev);
            safeInvoke(onHarnessEvent, safeEv);
            // In-place turns run in the live tree under the native environment, so
            // the session they emit IS reachable for the next turn: record it. An
            // ISOLATED envelope-born session lives in the scoped home that dispose()
            // deletes, so observing it would poison the thread resume map with
            // unreachable ids — skip it there.
            if (inPlaceEnvelope) this.observeNativeSession(runInput, adapter.id, safeEv);
            this.observeAuthSwitch(log, adapter.id, attemptId, safeEv);
            observeAttemptTelemetry(telemetry, safeEv);
            if (safeEv.type === "usage" && safeEv.usage?.cost_usd) {
              cost += safeEv.usage.cost_usd;
              if (safeEv.usage.estimated) costEstimated = true;
              log?.emit("budget.observation", {
                harness_id: adapter.id,
                attempt_id: attemptId,
                kind: "spend",
                usd: safeEv.usage.cost_usd,
                estimated: safeEv.usage.estimated === true,
              });
              // Mid-flight cap enforcement: the guard raises this attempt's hold
              // to the streamed cost; a hard tier aborts NOW instead of letting a
              // streaming candidate overshoot max_usd until settlement.
              if (budgetGuard?.(cost)) {
                harnessErrored = true;
                errors.push("budget hard cap reached mid-attempt; stream aborted");
                log?.emit("budget.observation", {
                  harness_id: adapter.id,
                  attempt_id: attemptId,
                  kind: "cooldown",
                  detail: "hard cap mid-flight abort",
                });
                void adapter.cancel?.(runSpec.session_id)?.catch(() => {});
                break;
              }
            }
            if (safeEv.type === "error") {
              harnessErrored = true;
              errors.push(redactSecrets(safeEv.error ?? safeEv.text ?? "harness emitted error"));
            }
            // Capture assistant prose so an answer-only turn (no file changes) still
            // has an honest output artifact instead of an empty "succeeded".
            if (
              safeEv.type === "message" &&
              safeEv.text &&
              safeEv.payload?.["auth_switched"] !== true
            ) {
              pushUniqueText(messageParts, safeEv.text);
            }
            // Observe budget/quota signals (rate-limit -> cooldown) so the router/loop can react.
            const obs = observationFromEvent(adapter.id, safeEv);
            if (obs) ledger.observe(obs);
          }
        } catch (err) {
          // A throwing adapter must not lose the cost already streamed: record the
          // error here and let the caller settle the REAL accumulated spend.
          harnessErrored = true;
          errors.push(safeErrorMessage(err));
        }

        const transient = telemetry.transientFailures.at(-1) ?? null;
        const sawTransient = telemetry.transientFailures.length > transientStart;
        const currentDiff = await wsm.diff(envelope);
        const currentAnswer = messageParts.join("\n").trim();
        const deliverableEmpty = currentDiff.trim().length === 0 && currentAnswer.length === 0;
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
    const unrecovered = unrecoveredToolErrors(telemetry);
    if (webUnsatisfied(telemetry)) {
      errors.push(
        `web evidence unsatisfied: ${telemetry.web.errorSummary ?? (telemetry.web.attempted ? "web tool failed without verified recovery" : "web evidence required but never attempted")}`,
      );
    }

    const diff = await wsm.diff(envelope);
    const answerText = messageParts.join("\n").trim() || undefined;
    const deliverablePresent = diff.trim().length > 0 || Boolean(answerText);
    // Cancelled attempts skip gates entirely (T3.1#8): the operator asked to
    // stop NOW; running a 600s-per-gate suite after the abort delays the ack
    // and burns compute on a result nobody will adopt. Diff/attempt.yaml
    // still land, so partial work stays inspectable.
    const gateSignalAborted = signal?.aborted === true;
    if (!gateSignalAborted) {
      log?.emit("gate.started", { attempt_id: attemptId, gates: this.gateSpecs(contract).length });
    }
    const gates = gateSignalAborted
      ? []
      : await runGates(this.gateSpecs(contract), {
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
    assertNoSecretLikeTokens("candidate patch diff", diff);
    store.writeText(join(attemptDir, "patch.diff"), diff);
    store.writeYaml(join(attemptDir, "attempt.yaml"), {
      attempt_id: attemptId,
      harness_id: adapter.id,
      cost_usd: cost,
      errored,
      errors: errors.slice(0, 5),
      ...telemetrySummary(telemetry),
      outcome: telemetry.outcome,
      gates: gates.map((g) => ({ id: g.id, status: g.status })),
      branch: envelope.branch_name,
    });
    return {
      attemptId,
      harnessId: adapter.id,
      label,
      diff,
      answerText,
      reviewCwd: envelope.worktree_path,
      baseSha: envelope.base_sha ?? undefined,
      gates,
      cost,
      errored,
      costEstimated,
      errors: errors.slice(0, 8),
      telemetry,
    };
  }

  private toEvidence(
    run: CandidateRun,
    contract: TaskContract,
    findings: ReviewFinding[],
    finalReviewClean: boolean,
    reviewVerified = false,
  ): CandidateEvidence {
    const passed = gatesPassed(run.gates) && !run.errored;
    // Honest acceptance evidence: 0/0 when the contract has no success criteria
    // (no spec). The old code fabricated a 1/1 ("AC-implicit") cover, which made
    // arbitration report a vacuous "acceptance=100%" that just restated gates.
    const acTotal = contract.success_criteria.length;
    const acCovered =
      passed && contract.success_criteria.length > 0
        ? contract.success_criteria.map((c) => c.id)
        : [];
    // Treat a harness error as a failed required gate so it cannot win arbitration.
    const gates = run.errored
      ? [
          ...run.gates,
          {
            id: "harness",
            command: "harness",
            exit_code: 1,
            status: "failed" as const,
            duration_ms: 0,
            required: true,
            stdout_tail: null,
            stderr_tail: null,
            output_truncated: false,
          },
        ]
      : run.gates;
    return {
      attemptId: run.attemptId,
      label: run.label,
      gates,
      acceptanceCovered: acCovered,
      acceptanceTotal: acTotal,
      findings,
      // Counted from the EVIDENCE gates (including the injected harness-failure
      // gate), so an errored candidate scores 0/1 — never a vacuous 0/0.
      testsPassed: gates.filter((g) => g.status === "passed").length,
      testsTotal: gates.length,
      finalReviewClean,
      reviewVerified,
      toolWarningsCount:
        run.telemetry.outcome?.toolWarningsCount ?? toolWarnings(run.telemetry).length,
      diffSize: run.diff.split("\n").length,
      diffBytes: Buffer.byteLength(run.diff, "utf8"),
      costUsd: run.cost,
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
   * initialized in place (`.gitignore` seeded with `.claudexor/`, `git init`,
   * deterministic baseline commit) and the action is announced via a
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
        `# Run ${runId} (${mode})\n\n- Status: failed\n- Phase: workspace\n\n${message}\n`,
      );
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      log.emit("run.failed", {
        status: "failed",
        phase: "workspace",
        error: message,
        failure_ref: "final/failure.yaml",
      });
      return message;
    }
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
    // The execution root is the tree the harness mutates: the project itself for
    // in-place threads/ordinary runs, or the thread's persistent worktree for an
    // isolated thread. Config/artifacts/contract stay anchored to repoRoot. Both
    // the WorkspaceManager and the git boundary resolve against this SINGLE root.
    const execRoot = this.execRootOf(input);
    const wsm = new WorkspaceManager(execRoot);

    safeInvoke(input.onRunStart, { runId, taskId, runDir: paths.root });
    log.emit("run.created", { mode, prompt: redactSecrets(input.prompt) });
    announce?.({ log, store, paths, runId, taskId, mode, phase: "race" });
    const ledger = new BudgetLedger({ maxUsd: contract.budget.max_usd ?? null });
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
        status: "failed",
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

    // ContextPack is LAZY (Q13): agent/race candidates explore the live tree
    // themselves inside their envelopes; only the read-only report modes
    // (explore/plan/readonly_audit) build and attach the compact atlas.

    const reviewDir = join(paths.root, "review-evidence");
    writeEvidencePacket(reviewDir, {
      userIntent: redactSecrets(input.prompt),
      diff: "(per-candidate diffs are supplied to reviewers individually)\n",
      tests: this.testsEvidence(contract),
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
        `# Run ${runId} (${mode})\n\n- Status: failed\n- Phase: routing\n\n${message}\n`,
      );
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      log.emit("run.failed", {
        status: "failed",
        phase: "routing",
        error: message,
        failure_ref: "final/failure.yaml",
      });
      return {
        runId,
        taskId,
        mode,
        status: "failed",
        winner: null,
        runDir: paths.root,
        summary: message,
        candidates: [],
      };
    }
    const reviewersOutcome = await this.resolveReviewersWithArtifacts(input, log, store, paths, runId, taskId, mode);
    if ("failed" in reviewersOutcome) return reviewersOutcome.failed;
    const reviewers = reviewersOutcome.reviewers;
    const reviewVerified = this.routeVerified(reviewers);
    const harnessLedgers = new Map<string, BudgetLedger>();

    const reviewEnvelopes: WorkspaceEnvelope[] = [];
    const disposeReviewEnvelopes = async () => {
      const envelopes = reviewEnvelopes.splice(0);
      for (const env of envelopes) await wsm.dispose(env);
    };
    const candidateAccess = contract.access.effective_profile;

    // Budget leases are reserved UPFRONT for every candidate; denied slots are
    // never spawned. Granted candidates run in PARALLEL (bounded, isolated
    // envelopes) — all run to completion and review picks the winner.
    interface CandidateSlot {
      routed: RoutedAdapter;
      attemptId: string;
      label: string;
      leaseId: string;
    }
    let budgetStopped = false;
    let softWarned = false;
    // The USER-requested race width, before any budget trimming.
    const requestedSingleCandidate = adapters.length === 1;
    const slots: CandidateSlot[] = [];
    for (let i = 0; i < adapters.length; i++) {
      const routed = adapters[i] as RoutedAdapter;
      const attemptId = `a${String(i + 1).padStart(2, "0")}`;
      // Per-harness max_usd runs through a child ledger that rolls up to the run cap.
      const lease = this.harnessLedger(harnessLedgers, ledger, routed).reserve({
        taskId,
        attemptId,
        intent: this.candidateIntent(input),
        harnessId: routed.adapter.id,
        // DD-27 wave guard: every slot AFTER the first holds the estimate
        // floor at reservation, so concurrent candidates are visible to the
        // breaker BEFORE any usage streams and a parallel wave cannot blow
        // past the cap between settlements. The first slot holds nothing —
        // a cap smaller than the floor must still run ONE candidate and stop
        // on real usage, never zero.
        ...(i > 0 ? { estimateUsd: this.estimateUsdFloor(input.repoRoot) } : {}),
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
    const slotLedger = (slot: CandidateSlot) =>
      this.harnessLedger(harnessLedgers, ledger, slot.routed);
    const runSlot = async (slot: CandidateSlot, slotIdx: number): Promise<void> => {
      if (input.signal?.aborted) {
        slotLedger(slot).cancel(slot.leaseId);
        return;
      }
      // Leases are granted upfront (before spend exists); a worker still
      // re-checks the circuit breaker so queued slots beyond the parallel wave
      // do not start after earlier candidates already blew the hard cap.
      if (budgetStopped || slotLedger(slot).tier() === "hard") {
        slotLedger(slot).cancel(slot.leaseId);
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
      // SF2 soft + downgrade breaker (before the hard cap): soft = a one-time
      // warning; downgrade = run this attempt on the per-harness fallback_model
      // (cheaper) instead of hard-killing — gives fallback_model a real job.
      const breakerTier = slotLedger(slot).tier();
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
          // A single-candidate turn (agent n=1) on an in-place/isolated thread
          // runs directly in the execution tree so the next turn sees its work
          // and the native session resumes. Race candidates (n>1) always stay in
          // isolated envelopes; the winner is auto-adopted into the tree after.
          // REQUESTED width decides (T2#6): a budget-degraded race whose wave
          // guard trimmed it to one slot still runs enveloped + adoption —
          // never a silent switch to direct live-tree mutation.
          inPlace: input.inPlace === true && requestedSingleCandidate,
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
          this.interactionChannelFor(input, log, runId, taskId, slot.attemptId, adapter.id, slot.routed.supportsInteractive),
          (streamedUsd) => {
            const lg = slotLedger(slot);
            lg.updateHold(slot.leaseId, streamedUsd);
            if (lg.tier() !== "hard") return false;
            budgetStopped = true;
            return true;
          },
          input,
        );
        slotLedger(slot).settle(slot.leaseId, run.cost);
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
        // are absorbed inside runCandidateInEnvelope with their real cost.
        slotLedger(slot).settle(slot.leaseId, 0);
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
          cost_usd: 0,
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
      return cancelledResult(log, runId, taskId, mode, paths.root, cancelledCandidates(), () =>
        this.writeRunTelemetry(
          store,
          paths,
          contract,
          runId,
          taskId,
          mode,
          runs.map((r) => ({ attemptId: r.attemptId, harnessId: r.harnessId, telemetry: r.telemetry })),
          null,
        ),
      );
    }

    if (runs.length === 0) {
      const status: RunStatus = budgetStopped ? "exhausted" : "failed";
      const why = budgetStopped
        ? "budget exhausted before any candidate run"
        : "no candidates produced";
      store.writeYaml(join(paths.arbitrationDir, "decision.yaml"), {
        winner: null,
        status,
        outcome: "blocked",
        why_winner: why,
        evidence_facts: ["no candidates were produced"],
        apply_recommendation: "continue",
        budget_summary: { spend_usd: ledger.spend(), estimated: false },
      });
      store.writeText(
        join(paths.finalDir, "summary.md"),
        `# Run ${runId} (${mode})\n\n- Status: ${status}\n- Phase: budget\n\n${why}\n`,
      );
      writeFailure(store, paths, {
        phase: "budget",
        category: status === "exhausted" ? "budget" : "internal",
        safeMessage: why,
        runDir: paths.root,
      });
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      log.emit("run.failed", {
        status,
        phase: "budget",
        error: why,
        failure_ref: "final/failure.yaml",
      });
      return {
        runId,
        taskId,
        mode,
        status,
        winner: null,
        runDir: paths.root,
        summary: why,
        candidates: [],
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
      const status: RunStatus = "failed";
      store.writeYaml(join(paths.arbitrationDir, "decision.yaml"), {
        winner: null,
        status,
        outcome: "blocked",
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
        `# Run ${runId} (${mode})\n\n- Status: ${status}\n- Phase: ${phase}\n\n${rootCause}\n`,
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
        status,
        phase,
        error: rootCause,
        failure_ref: "final/failure.yaml",
      });
      return {
        runId,
        taskId,
        mode,
        status,
        winner: null,
        runDir: paths.root,
        summary: rootCause,
        candidates: runs.map((r) => ({
          attemptId: r.attemptId,
          harnessId: r.harnessId,
          status: "red",
        })),
      };
    }

    log.emit("review.started", { reviewers: reviewers.length, review_verified: reviewVerified });
    let evidences: CandidateEvidence[];
    try {
      // №25: reviewRuns internally SKIPS the paid reviewer call for empty-diff
      // candidates ("привет" in agent mode no longer burns two reviewers on
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
      // never as an escaped throw that orphans the run dir (#5).
      return failTerminally(log, store, paths, runId, taskId, mode, "review", err);
    } finally {
      // Review preflight failures must not leak candidate worktrees.
      await disposeReviewEnvelopes();
    }
    if (input.signal?.aborted) {
      return cancelledResult(log, runId, taskId, mode, paths.root, cancelledCandidates(), () =>
        this.writeRunTelemetry(
          store,
          paths,
          contract,
          runId,
          taskId,
          mode,
          runs.map((r) => ({ attemptId: r.attemptId, harnessId: r.harnessId, telemetry: r.telemetry })),
          null,
        ),
      );
    }

    // Synthesis: if worthwhile, run a synthesizer as a NEW, re-checked candidate.
    const synth = decideSynthesis(evidences, input.synthesis ?? "auto");
    store.writeYaml(join(paths.arbitrationDir, "synthesis.yaml"), synth);
    log.emit("synthesis.started", { synthesize: synth.synthesize, reason: synth.reason });
    if (synth.synthesize && !budgetStopped) {
      const synthRouted = adapters[0] as RoutedAdapter;
      // Per-harness child ledger (T3#10): synthesis spend counts against the
      // synthesizer harness's own cap, not only the run cap.
      const synthLedger = this.harnessLedger(harnessLedgers, ledger, synthRouted);
      const lease = synthLedger.reserve({
        taskId,
        attemptId: "synth",
        intent: "synthesize",
        harnessId: synthRouted.adapter.id,
      });
      if (lease.granted) {
        let envelope: WorkspaceEnvelope | undefined;
        try {
          const plan = buildSynthesisPlan(evidences);
          const sourceDiffs = workingRuns
            .map((r) => `### ${r.label} (${r.attemptId})\n${r.diff}`)
            .join("\n\n");
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
          const synthPrompt = `${plan.instructions}\n\nFindings to fix:\n${plan.fixFindings.map((f) => `- ${f}`).join("\n") || "(none)"}\n\nCandidate diffs:\n${sourceDiffs}`;
          const run = await this.runCandidateInEnvelope(
            synthRouted,
            envelope,
            "synth",
            "Synthesis",
            contract,
            synthPrompt,
            store,
            paths,
            wsm,
            synthLedger,
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
            this.interactionChannelFor(input, log, runId, taskId, "synth", synthAdapter.id, synthRouted.supportsInteractive),
            undefined,
            input,
          );
          synthLedger.settle(lease.lease?.lease_id ?? "", run.cost);
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
              return cancelledResult(log, runId, taskId, mode, paths.root, cancelledCandidates(), () =>
                this.writeRunTelemetry(
                  store,
                  paths,
                  contract,
                  runId,
                  taskId,
                  mode,
                  runs.map((r) => ({ attemptId: r.attemptId, harnessId: r.harnessId, telemetry: r.telemetry })),
                  null,
                ),
              );
            }
          } finally {
            await disposeReviewEnvelopes();
          }
          runs.push(run);
          workingRuns.push(run);
        } catch (err) {
          synthLedger.settle(lease.lease?.lease_id ?? "", 0);
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
      return cancelledResult(log, runId, taskId, mode, paths.root, cancelledCandidates(), () =>
        this.writeRunTelemetry(
          store,
          paths,
          contract,
          runId,
          taskId,
          mode,
          runs.map((r) => ({ attemptId: r.attemptId, harnessId: r.harnessId, telemetry: r.telemetry })),
          null,
        ),
      );
    }

    let result: ReturnType<typeof arbitrate>;
    try {
      result = arbitrate(evidences, {
        spendUsd: ledger.spend(),
        estimatedSpend: runs.some((r) => r.costEstimated),
      });
    } catch (err) {
      // Arbitration throws end terminally with artifacts, never as an orphan (#5).
      return failTerminally(log, store, paths, runId, taskId, mode, "arbitration", err);
    }
    log.emit("arbitration.completed", {
      winner: result.decision.winner,
      status: result.decision.status,
    });

    // Winner can only be a candidate that actually produced work; corpses are
    // excluded from arbitration upstream and from the fallback here.
    const winnerRun =
      workingRuns.find((r) => r.attemptId === result.decision.winner) ?? workingRuns[0];
    // A reviewer escalation to a human is a BLOCKED terminal, not a silent risk note.
    const needsHuman = evidences.some((e) =>
      e.findings.some((f) => f.severity === "NEEDS_HUMAN" && isBlocking(f)),
    );
    // Run-level review_verified is the WINNER's verification (T2#8): an
    // empty-diff loser's unverified route must not drag the shipped result's
    // flag false. No winner -> fall back to the all-candidates view.
    const actualReviewVerified = winnerRun
      ? (evidences.find((e) => e.attemptId === winnerRun.attemptId)?.reviewVerified ?? false)
      : evidences.length > 0 && evidences.every((e) => e.reviewVerified);
    let status: RunStatus =
      needsHuman && result.decision.status !== "success" ? "blocked" : result.decision.status;

    // FinalVerifier (D12/INV-115): an otherwise-adoptable winner with a patch
    // must ALSO apply cleanly onto a fresh tree at its own base and pass the
    // deterministic gates there, BEFORE adoption/apply eligibility. A failure
    // BLOCKS the run with a typed reason instead of shipping it.
    let finalVerify: FinalVerifyRecord | null = null;
    let finalVerifyFailed = false;
    if (
      winnerRun &&
      winnerRun.diff.trim().length > 0 &&
      (status === "success" || status === "ungated") &&
      !input.signal?.aborted
    ) {
      finalVerify = await finalVerifyPatch(execRoot, winnerRun, this.gateSpecs(contract), log);
      finalVerifyFailed =
        finalVerify.attempted &&
        (finalVerify.applied_cleanly === false || finalVerify.gates_passed === false);
      if (finalVerifyFailed) status = "blocked";
    }

    store.writeYaml(join(paths.arbitrationDir, "decision.yaml"), {
      ...result.decision,
      review_verified: actualReviewVerified,
      final_verify: finalVerify,
    });
    store.writeYaml(join(paths.arbitrationDir, "pairwise.yaml"), result.pairwise);
    const decisionPath = join(paths.arbitrationDir, "decision.yaml");
    if (winnerRun) {
      assertNoSecretLikeTokens("final patch diff", winnerRun.diff);
      const patchSha256 = sha256(winnerRun.diff);
      store.writeText(join(paths.finalDir, "patch.diff"), winnerRun.diff);
      const wstats = diffStats(winnerRun.diff);
      const hasDiff = winnerRun.diff.trim().length > 0;
      const winnerEvidence = evidences.find((e) => e.attemptId === winnerRun.attemptId);
      const blockers = winnerEvidence
        ? winnerEvidence.findings.filter((f) => isBlocking(f)).length
        : 0;
      // An empty-diff winner that produced prose is an ANSWER (the chat shows it
      // and the honest result_kind is "answer", not a misleading "patch").
      const winnerAnswer = winnerRun.answerText?.trim() ?? "";
      const resultKind = hasDiff ? "patch" : winnerAnswer.length > 0 ? "answer" : "none";
      if (!hasDiff && winnerAnswer.length > 0) {
        store.writeText(join(paths.finalDir, "answer.md"), winnerAnswer + "\n");
      }
      // Р8: a single-candidate in-place turn already mutated the live tree (its
      // diff IS the live change). A race (n>1) ran candidates in isolated
      // envelopes, so the winner's patch must be ADOPTED into the live tree for
      // the next turn to see it. Blockers / non-success stop adoption; a failed
      // apply (the user edited the tree mid-race) is disclosed, never lost.
      // A clean terminal to adopt is success OR ungated (review passed but no
      // test gates were configured to certify it) — never blocked/failed/no_op.
      // Adoption is HONEST: `adopted` reflects whether the live in-place tree was
      // actually mutated, DECOUPLED from a clean review. A single-candidate
      // in-place turn edits the live tree directly — so it is "applied" even when
      // review is blocked (applyState = applied_review_blocked + Revert offered).
      // A race (n>1) ran candidates in isolated envelopes; its winner mutates the
      // live tree only when we apply it, which we gate on a clean terminal.
      const adoptable = status === "success" || status === "ungated";
      let adopted: boolean | null = null;
      let applyState: "not_applied" | "applied" | "applied_review_blocked" | "reverted" =
        "not_applied";
      let postTurnSha: string | null = null;
      if (input.inPlace === true && hasDiff) {
        if (requestedSingleCandidate) {
          // Already live: the candidate ran in-place and wrote the tree itself.
          adopted = true;
          applyState = adoptable ? "applied" : "applied_review_blocked";
          // Fence taken right after the candidate finished (pre-review), so user
          // edits made during review/arbitration are not folded into the target.
          postTurnSha = earlyPostTurnSha;
        } else if (adoptable) {
          // Protected path (T3.2#3): --check first, restore on 3way failure —
          // adopted:false MUST mean the live tree is byte-identical (INV-114);
          // a failed restore is disclosed as tree_mutated, never hidden.
          const applied = await applyPatchProtected(execRoot, winnerRun.diff);
          if (applied.ok) {
            adopted = true;
            applyState = "applied";
            log.emit("work_product.adopted", {
              applied: true,
              patch_sha256: patchSha256,
              winner: winnerRun.attemptId,
            });
            // Race winner: snapshot immediately after applying (minimal window).
            try {
              postTurnSha = await snapshotTree(execRoot);
            } catch {
              postTurnSha = null;
            }
          } else {
            adopted = false;
            applyState = "not_applied";
            log.emit("work_product.adopted", {
              applied: false,
              patch_sha256: patchSha256,
              detail: redactSecrets(applied.detail ?? "apply failed"),
              tree_mutated: applied.treeMutated,
            });
          }
        }
      }
      store.writeYaml(join(paths.finalDir, "work_product.yaml"), {
        id: newId("wp"),
        kind: input.create === true ? "new_repo" : "patch",
        source_task_id: taskId,
        producer_attempt_id: winnerRun.attemptId,
        meta: {
          harness_id: winnerRun.harnessId,
          synthesis: synth,
          mode,
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
        },
      });
      store.writeText(
        join(paths.finalDir, "summary.md"),
        renderSummary(
          runId,
          mode,
          { ...result.decision, status },
          evidences,
          synth.reason,
          actualReviewVerified,
        ),
      );
      // A non-success run's summary/patch is diagnostic context, not an applyable green output.
      log.emit("output.ready", {
        kind: "summary",
        path: "final/summary.md",
        ...(status === "success" ? {} : { state: "diagnostic" }),
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
      result.decision.status === "success"
        ? result.decision.winner
        : (winnerRun?.attemptId ?? null),
    );

    const honestTerminal =
      status === "no_op" || status === "ungated" || status === "review_not_run";
    if (finalVerifyFailed) {
      writeFailure(store, paths, {
        phase: "verification",
        category: finalVerify?.applied_cleanly === false ? "apply_conflict" : "gates",
        safeMessage: `final verify failed: ${finalVerify?.reason ?? (finalVerify?.gates_passed === false ? "deterministic gates failed on the fresh verify tree" : "unknown")}`,
        runDir: paths.root,
        nextActions: [
          "Inspect arbitration/decision.yaml (final_verify)",
          "Re-run after fixing the base conflict or the failing gates",
        ],
      });
    } else if (status !== "success" && !honestTerminal) {
      writeFailure(store, paths, {
        phase: needsHuman ? "review" : "arbitration",
        category: needsHuman
          ? "policy"
          : winnerRun?.errored
            ? "harness_error"
            : status === "exhausted"
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
          `# Run ${runId} (${mode})\n\n- Status: ${status}\n- Phase: arbitration\n\n${result.decision.why_winner}\n`,
        );
        log.emit("output.ready", {
          kind: "summary",
          path: "final/summary.md",
          state: "diagnostic",
        });
      }
    }

    log.emit("work_product.emitted", { winner: result.decision.winner });
    if (status === "success" || honestTerminal) {
      log.emit("run.completed", { status, outcome: result.decision.outcome });
    } else if (status === "blocked") {
      log.emit("run.blocked", { status, phase: "review", failure_ref: "final/failure.yaml" });
    } else {
      log.emit("run.failed", { status, phase: "arbitration", failure_ref: "final/failure.yaml" });
    }

    return {
      runId,
      taskId,
      mode,
      status,
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
      tool_warnings_total: records.reduce((sum, r) => sum + r.outcome.tool_warnings_count, 0),
      generated_at: nowIso(),
    });
    store.writeYaml(join(paths.finalDir, "telemetry.yaml"), telemetry);
  }

  /** Review a set of runs and return their evidence (with finalReviewClean + review_verified caveat). */
  /**
   * Deterministic policy findings from the typed diff (no LLM, no regex over
   * prose): protected-path changes and critical-risk diffs escalate NEEDS_HUMAN;
   * a high-risk diff without a cross-family panel escalates as well. Each
   * finding cites the matched files as evidence (BIBLE: evidence beats summaries).
   */
  private policyFindings(
    run: CandidateRun,
    reviewVerified: boolean,
    protectedPaths: string[] = [],
    autoProtectedPaths: string[] = [],
    protectedPathApprovals: ProtectedPathApproval[] = [],
  ): {
    findings: ReviewFinding[];
    risk: { level: string; reasons: string[]; changedFiles: number };
  } {
    const stats = diffStats(run.diff);
    const approvalPatterns = protectedPathApprovals.map((approval) => approval.path);
    const unapprovedExistingAutoProtectedPaths = stats.existingPaths.filter(
      (path) => !matchAny(path, approvalPatterns),
    );
    const specProtectedOnly = requireHuman(stats.existingPaths, protectedPaths);
    const autoProtectedOnly = requireHuman(
      unapprovedExistingAutoProtectedPaths,
      autoProtectedPaths,
    );
    const protectedOnly = {
      required: specProtectedOnly.required || autoProtectedOnly.required,
      reasons: [...new Set([...specProtectedOnly.reasons, ...autoProtectedOnly.reasons])],
      matchedPaths: [
        ...new Set([...specProtectedOnly.matchedPaths, ...autoProtectedOnly.matchedPaths]),
      ],
    };
    const risk = classifyRisk({
      changedPaths: stats.paths,
      additions: stats.additions,
      deletions: stats.deletions,
      protectedPaths: protectedOnly.matchedPaths,
    });
    const findings: ReviewFinding[] = [];
    const reviewer = {
      harness_id: "policy",
      requested_model: null,
      requested_effort: null,
      observed_model: null,
      route_proof_status: "verified" as const,
    };
    const evidenceFor = (reasons: string[]) => ({
      files: stats.paths
        .filter((p) => reasons.some((r) => r.includes(p)))
        .map((path) => ({ path, lines: null })),
    });
    // Structured matched-path evidence (never reconstructed from prose).
    const evidenceFromPaths = (paths: string[]) => ({
      files: paths.map((path) => ({ path, lines: null })),
    });
    const reportedRisk = protectedOnly.required
      ? {
          level: "critical" as const,
          reasons: [...new Set([...risk.reasons, ...protectedOnly.reasons])],
          matchedPaths: [...new Set([...risk.matchedPaths, ...protectedOnly.matchedPaths])],
        }
      : risk;
    if (protectedOnly.required) {
      findings.push(
        ReviewFindingSchema.parse({
          id: newId("find"),
          severity: "BLOCK",
          category: "test_gap",
          claim: `candidate changed protected path(s): ${protectedOnly.matchedPaths.join(", ")}`,
          evidence: evidenceFromPaths(protectedOnly.matchedPaths),
          reviewer,
          status: "accepted",
        }),
      );
    }
    // Contract protected_paths escalate the human gate only for tampering with
    // existing protected files. Creating a new test/package file for create or
    // test-authoring flows is not tamper by itself; built-in critical paths still
    // apply to all changed paths.
    const builtInHumanPaths = [...new Set([...stats.paths, ...stats.existingPaths])];
    const builtInHuman = requireHuman(builtInHumanPaths, DEFAULT_REQUIRE_HUMAN_PATHS);
    const human = {
      required: builtInHuman.required || protectedOnly.required,
      reasons: [...new Set([...builtInHuman.reasons, ...protectedOnly.reasons])],
      matchedPaths: [...new Set([...builtInHuman.matchedPaths, ...protectedOnly.matchedPaths])],
    };
    if (human.required) {
      findings.push(
        ReviewFindingSchema.parse({
          id: newId("find"),
          severity: "NEEDS_HUMAN",
          category: "security",
          claim: `protected-path change requires human approval: ${human.reasons.join("; ")}`,
          evidence: evidenceFromPaths(human.matchedPaths),
          reviewer,
          status: "accepted",
        }),
      );
    }
    const depth = reviewDepthForRisk(reportedRisk.level as never);
    if (depth.humanApproval) {
      findings.push(
        ReviewFindingSchema.parse({
          id: newId("find"),
          severity: "NEEDS_HUMAN",
          category: "security",
          claim: `critical-risk diff requires human approval: ${reportedRisk.reasons.join("; ")}`,
          evidence:
            reportedRisk.matchedPaths.length > 0
              ? evidenceFromPaths(reportedRisk.matchedPaths)
              : evidenceFor(reportedRisk.reasons),
          reviewer,
          status: "accepted",
        }),
      );
    } else if (depth.crossFamily && !reviewVerified) {
      findings.push(
        ReviewFindingSchema.parse({
          id: newId("find"),
          severity: "NEEDS_HUMAN",
          category: "architecture",
          claim: `high-risk diff requires a cross-family review panel (>=2 provider families), which is not available: ${reportedRisk.reasons.join("; ")}`,
          evidence:
            reportedRisk.matchedPaths.length > 0
              ? evidenceFromPaths(reportedRisk.matchedPaths)
              : evidenceFor(reportedRisk.reasons),
          reviewer,
          status: "accepted",
        }),
      );
    }
    return {
      findings,
      risk: {
        level: reportedRisk.level,
        reasons: reportedRisk.reasons,
        changedFiles: stats.paths.length,
      },
    };
  }

  /**
   * SINGLE funnel for every reviewer-panel invocation: run it inside a per-review
   * scoped harness HOME (B10/§6) so reviewer children (codex session rollouts,
   * claude config) never write native state into the operator's real ~/.codex /
   * ~/.claude. The codex route-proof transcript is read from this same scoped
   * CODEX_HOME, so cross-family verification (B9) is unaffected. Every call site
   * MUST go through here so the scoping cannot drift. Disposed once the panel
   * settles (resolve OR reject).
   */
  private reviewScoped(
    input: Omit<Parameters<typeof reviewCandidate>[0], "env">,
  ): ReturnType<typeof reviewCandidate> {
    const reviewHome = new WorkspaceManager(input.cwd).readOnlyHomeEnv();
    return reviewCandidate({
      ...input,
      reviewerTimeoutMs: input.reviewerTimeoutMs ?? this.reviewerTimeoutMs(input.cwd),
      transientRetryPolicy: input.transientRetryPolicy ?? this.transientRetryPolicy(input.cwd),
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
        this.writeTestsEvidence(candidateEvidenceDir, contract, run.gates);
        // №25: a candidate that changed NO files has nothing to review — never
        // spend a reviewer panel on "(empty diff)" ("привет" in agent mode used to
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
                reviewerTimeoutMs: this.reviewerTimeoutMs(contract.repo.root),
                envInheritance: this.envInheritance(cwd),
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
              };
        if (reviewLease?.granted) {
          ledger?.settle(reviewLease.lease?.lease_id ?? "", result.reviewSpendUsd ?? 0);
          if ((result.reviewSpendUsd ?? 0) > 0) {
            log.emit("budget.observation", {
              harness_id: "review-panel",
              attempt_id: run.attemptId,
              kind: "spend",
              usd: result.reviewSpendUsd,
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
        const policy = this.policyFindings(
          run,
          candidateReviewVerified,
          contract.constraints.protected_paths,
          contract.constraints.auto_protected_paths,
          contract.constraints.protected_path_approvals,
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
          this.toEvidence(run, contract, allFindings, reviewClean, candidateReviewVerified),
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

  private prepareReviewEvidenceDir(sourceDir: string, candidateCwd: string): string {
    const targetDir = join(candidateCwd, REVIEW_EVIDENCE_DIRNAME);
    if (sourceDir === targetDir) {
      return this.requireReviewEvidence(targetDir);
    }
    if (!existsSync(sourceDir)) {
      throw new Error(`review evidence preflight failed for ${sourceDir}: source packet missing`);
    }
    try {
      rmSync(targetDir, { recursive: true, force: true });
      cpSync(sourceDir, targetDir, { recursive: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`review evidence copy into candidate tree failed: ${message}`);
    }
    return this.requireReviewEvidence(targetDir);
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
    candidateEvidenceDir: string,
    candidateCwd: string,
  ): Record<string, string> | null {
    if (candidateEvidenceDir === join(candidateCwd, REVIEW_EVIDENCE_DIRNAME)) {
      try {
        rmSync(candidateEvidenceDir, { recursive: true, force: true });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          review_evidence_cleanup: "failed",
          candidate_evidence_dir: candidateEvidenceDir,
          error: redactSecrets(detail),
        };
      }
    }
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
    // The execution root is the tree the harness mutates (thread worktree for an
    // isolated thread, else the project). The WorkspaceManager AND the git
    // boundary must resolve against the SAME root — the race path does so via the
    // local `execRoot`; this path previously ensured the boundary on repoRoot,
    // which for an isolated thread is the project, not the mutated worktree.
    const execRoot = this.execRootOf(input);
    const wsm = new WorkspaceManager(execRoot);
    const readiness = new ReadinessLedger();
    const ledger = new BudgetLedger({ maxUsd: contract.budget.max_usd ?? null });
    store.writeYaml(join(paths.contextDir, "task.yaml"), contract);
    safeInvoke(input.onRunStart, { runId, taskId, runDir: paths.root });
    log.emit("run.created", { mode, prompt: redactSecrets(input.prompt) });
    announce?.({ log, store, paths, runId, taskId, mode, phase: "convergence" });

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
          runId,
          taskId,
          mode,
          status: "failed",
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
      tests: this.testsEvidence(contract),
    });
    const reviewersOutcome = await this.resolveReviewersWithArtifacts(input, log, store, paths, runId, taskId, mode);
    if ("failed" in reviewersOutcome) return reviewersOutcome.failed;
    const reviewers = reviewersOutcome.reviewers;
    const reviewVerified = this.routeVerified(reviewers);

    // One envelope carried forward across attempts so the harness can repair its own work.
    let adapterPool: RoutedAdapter[];
    try {
      adapterPool = await this.resolveCandidateAdapters(
        { ...input, n: undefined },
        this.candidateIntent(input),
      );
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
        `# Run ${runId} (${mode})\n\n- Status: failed\n- Phase: routing\n\n${message}\n`,
      );
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      log.emit("run.failed", {
        status: "failed",
        phase: "routing",
        error: message,
        failure_ref: "final/failure.yaml",
      });
      return {
        runId,
        taskId,
        mode,
        status: "failed",
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
        `# Run ${runId} (${mode})\n\n- Status: failed\n- Phase: review preflight\n\n${message}\n`,
      );
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      log.emit("run.failed", {
        status: "failed",
        phase: "review",
        error: message,
        failure_ref: "final/failure.yaml",
      });
      return {
        runId,
        taskId,
        mode,
        status: "failed",
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
    const harnessLedgers = new Map<string, BudgetLedger>();
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
        // previous attempt (tool/web errors), not only the review findings —
        // otherwise the harness repairs blind.
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

        // Per-harness max_usd runs through a child ledger that rolls up to the run cap.
        const lease = this.harnessLedger(harnessLedgers, ledger, routed).reserve({
          taskId,
          attemptId,
          intent: "repair",
          harnessId: adapter.id,
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
            this.interactionChannelFor(input, log, runId, taskId, attemptId, adapter.id, routed.supportsInteractive),
            (streamedUsd) => {
              const lg = this.harnessLedger(harnessLedgers, ledger, routed);
              lg.updateHold(lease.lease?.lease_id ?? "", streamedUsd);
              return lg.tier() === "hard";
            },
            input,
          );
          this.harnessLedger(harnessLedgers, ledger, routed).settle(
            lease.lease?.lease_id ?? "",
            run.cost,
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
          this.harnessLedger(harnessLedgers, ledger, routed).settle(lease.lease?.lease_id ?? "", 0);
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
        // run TERMINALLY with artifacts instead of orphaning the run dir (#5).
        let conv: ReturnType<typeof evaluateConvergence>;
        try {
          conv = await (async () => {
            const candidateReviewCwd = run.reviewCwd ?? input.repoRoot;
            const candidateReviewEvidenceDir = this.prepareReviewEvidenceDir(
              reviewDir,
              candidateReviewCwd,
            );
            try {
              this.writeTestsEvidence(candidateReviewEvidenceDir, contract, run.gates);
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
                      envInheritance: this.envInheritance(input.repoRoot),
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
                    };
              if (reviewLease?.granted) {
                ledger.settle(reviewLease.lease?.lease_id ?? "", reviewResult.reviewSpendUsd ?? 0);
                if ((reviewResult.reviewSpendUsd ?? 0) > 0) {
                  log.emit("budget.observation", {
                    harness_id: "review-panel",
                    attempt_id: attemptId,
                    kind: "spend",
                    usd: reviewResult.reviewSpendUsd,
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
              const policy = this.policyFindings(
                run,
                actualReviewVerified,
                contract.constraints.protected_paths,
                contract.constraints.auto_protected_paths,
                contract.constraints.protected_path_approvals,
              );
              const allFindings = [...policy.findings, ...revalidated];
              lastFindings = allFindings;
              store.writeYaml(join(paths.reviewsDir, `${attemptId}.yaml`), {
                attempt_id: attemptId,
                review_verified: actualReviewVerified,
                cross_family_healthy: reviewResult.crossFamilyHealthy,
                cross_family_verified: reviewResult.crossFamilyVerified,
                healthy_providers: reviewResult.healthyProviders,
                verified_providers: reviewResult.distinctProviders,
                reviewer_requests: reviewResult.reviewerRequests,
                risk: policy.risk,
                findings: allFindings,
                route_proofs: reviewResult.routeProofs,
              });
              const inconclusive = allFindings.some(
                (f) =>
                  f.severity === "INSUFFICIENT_EVIDENCE" || f.status === "insufficient_evidence",
              );
              const finalReviewClean =
                reviewResult.crossFamilyHealthy &&
                reviewResult.crossFamilyVerified &&
                !inconclusive &&
                !allFindings.some((f) => isBlocking(f));
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
          return failTerminally(log, store, paths, runId, taskId, mode, "review", err);
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
            adapterIdx = (adapterIdx + 1) % adapterPool.length;
            routed = adapterPool[adapterIdx] as RoutedAdapter;
            adapter = routed.adapter;
            log.emit("route.fallback.started", {
              from_harness: lastRun?.harnessId ?? null,
              to_harness: adapter.id,
              reason: "stall",
            });
          } else {
            break; // tried every available harness on this failure and still stuck -> stop
          }
        }
      }
    } finally {
      if (envelope) await wsm.dispose(envelope);
    }

    let status: RunStatus = input.signal?.aborted
      ? "cancelled"
      : converged
        ? "success"
        : stuckNoProgress
          ? "stuck_no_progress"
          : exhausted
            ? "exhausted"
            : "not_converged";
    let decision: ReturnType<typeof arbitrate>["decision"] | null = null;
    if (lastRun) {
      const arb = arbitrate(
        [
          this.toEvidence(
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
      if (converged && decision.status !== "not_converged") {
        status = decision.status;
      } else if (status === "not_converged" && decision.status !== "success") {
        status = decision.status;
      }
    }
    // A reviewer escalation to a human is a BLOCKED terminal, not a silent risk note.
    const needsHuman = lastFindings.some((f) => f.severity === "NEEDS_HUMAN" && isBlocking(f));
    if (needsHuman && status !== "success" && status !== "cancelled") status = "blocked";
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
      const convAdoptable = status === "success" || status === "ungated";
      const convAdopted: boolean | null = input.inPlace === true && convHasDiff ? true : null;
      const convApplyState: "not_applied" | "applied" | "applied_review_blocked" | "reverted" =
        convAdopted === true
          ? convAdoptable
            ? "applied"
            : "applied_review_blocked"
          : "not_applied";
      store.writeYaml(join(paths.finalDir, "work_product.yaml"), {
        id: newId("wp"),
        kind: "patch",
        source_task_id: taskId,
        producer_attempt_id: lastRun.attemptId,
        meta: {
          harness_id: lastRun.harnessId,
          mode,
          attempts: attempt,
          status,
          review_verified: actualReviewVerified,
          patch_sha256: patchSha256,
          adopted: convAdopted,
          apply_state: convApplyState,
          pre_turn_sha: convAdopted === true ? preTurnSha : null,
          post_turn_sha: convAdopted === true ? lastPostTurnSha : null,
        },
      });
      store.writeText(
        join(paths.finalDir, "summary.md"),
        `# Run ${runId} (${mode})\n\n- Status: ${status}\n- Attempts: ${attempt}\n- Winner: ${lastRun.attemptId}\n- Review verified (cross-family): ${actualReviewVerified}\n- Apply recommendation: ${decision?.apply_recommendation ?? "inspect"}${stuckNoProgressReason ? `\n- No-progress reason: ${stuckNoProgressReason}` : ""}\n`,
      );
      // Lifecycle invariant (all modes): output.ready precedes the terminal
      // event so a client that applied the terminal event has the output.
      log.emit("output.ready", {
        kind: "summary",
        path: "final/summary.md",
        ...(status === "success" ? {} : { state: "diagnostic" }),
      });
    }

    if (!converged) {
      writeFailure(store, paths, {
        phase: "convergence",
        category:
          status === "exhausted"
            ? "budget"
            : status === "cancelled"
              ? "cancelled"
              : status === "blocked"
                ? "policy"
                : "internal",
        safeMessage:
          status === "blocked"
            ? `review escalated to a human decision after ${attempt} attempt(s)`
            : status === "stuck_no_progress"
              ? (stuckNoProgressReason ?? `stuck_no_progress after ${attempt} attempt(s)`)
              : `${status} after ${attempt} attempt(s)${lastDiffStable ? "" : " (diff changed after review; review is stale)"}`,
        harnessId: lastRun?.harnessId,
        attemptId: lastRun?.attemptId,
        runDir: paths.root,
        nextActions:
          status === "cancelled"
            ? ["Retry if cancellation was accidental"]
            : status === "blocked"
              ? [
                  "Open the review queue",
                  "Decide the NEEDS_HUMAN findings",
                  "Re-run after the decision",
                ]
              : status === "stuck_no_progress"
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
          `# Run ${runId} (${mode})\n\n- Status: ${status}\n- Attempts: ${attempt}\n`,
        );
        log.emit("output.ready", {
          kind: "summary",
          path: "final/summary.md",
          state: "diagnostic",
        });
      }
    }

    log.emit("work_product.emitted", { winner: lastRun?.attemptId ?? null });
    const completed =
      converged || status === "no_op" || status === "ungated" || status === "review_not_run";
    if (completed) {
      log.emit("run.completed", { status, attempts: attempt });
    } else if (status === "blocked") {
      log.emit("run.blocked", {
        status,
        attempts: attempt,
        phase: "review",
        failure_ref: "final/failure.yaml",
      });
    } else {
      log.emit("run.failed", {
        status,
        attempts: attempt,
        phase: "convergence",
        failure_ref: "final/failure.yaml",
      });
    }
    return {
      runId,
      taskId,
      mode,
      status,
      winner: lastRun?.attemptId ?? null,
      runDir: paths.root,
      summary: converged
        ? `converged in ${attempt} attempt(s)`
        : `${status} after ${attempt} attempt(s)`,
      candidates: lastRun
        ? [{ attemptId: lastRun.attemptId, harnessId: lastRun.harnessId, status }]
        : [],
      reviewVerified: actualReviewVerified,
    };
  }

  /** plan mode: multi-harness planning -> aggregate -> (optional) plan review -> SpecPack. Read-only. */
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
      `4. Open questions — anything ambiguous that needs a decision before implementation.`,
      `Keep it concise. Reference real paths you found. Do NOT paste large code blocks; describe the change instead.`,
    ].join("\n");
  }

  /**
   * Relay cross-share (G/Q4): the prior planners' plans, injected into a later
   * planner's prompt so the harnesses CONVERGE on an aligned plan instead of
   * each planning in isolation. `runPlan` already iterates planners sequentially,
   * so each leg after the first sees what the earlier ones proposed and is asked
   * to reconcile/extend them (not blindly repeat).
   */
  private relayPriorPlansSection(plans: { id: string; text: string }[]): string {
    if (plans.length === 0) return "";
    const blocks = plans
      .map((p) => `### Plan already proposed by ${p.id}\n${p.text.slice(0, 4000)}`)
      .join("\n\n");
    return `\n\n---\nOTHER HARNESSES HAVE ALREADY PROPOSED PLANS FOR THIS SAME TASK (below). Read them, then produce YOUR plan: build on what is solid, RECONCILE the differences, and EXPLICITLY call out where you disagree and why. Do not blindly repeat them — converge toward one aligned plan.\n\n${blocks}\n---\n`;
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
    announce?.({ log, store, paths, runId, taskId, mode: "plan", phase: "plan" });

    store.writeYaml(join(paths.contextDir, "task.yaml"), contract);
    log.emit("task.contract.created", { task_contract_hash: hashJson(contract) });

    const ledger = new BudgetLedger({ maxUsd: contract.budget.max_usd ?? null });
    const reviewersOutcome = await this.resolveReviewersWithArtifacts(input, log, store, paths, runId, taskId, "plan");
    if ("failed" in reviewersOutcome) return reviewersOutcome.failed;
    const reviewers = reviewersOutcome.reviewers;

    let adapters: RoutedAdapter[];
    try {
      adapters = await this.resolveCandidateAdapters({ ...input, n: undefined }, "plan");
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
        `# Run ${runId} (plan)\n\n- Status: failed\n- Phase: routing\n\n${message}\n`,
      );
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      log.emit("run.failed", {
        status: "failed",
        phase: "routing",
        error: message,
        failure_ref: "final/failure.yaml",
      });
      return {
        runId,
        taskId,
        mode: "plan",
        status: "failed",
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
        `# Run ${runId} (plan)\n\n- Status: failed\n- Phase: context\n\n${message}\n`,
      );
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      log.emit("run.failed", {
        status: "failed",
        phase: "context",
        error: message,
        failure_ref: "final/failure.yaml",
      });
      return {
        runId,
        taskId,
        mode: "plan",
        status: "failed",
        winner: null,
        runDir: paths.root,
        summary: `context failed: ${message}`,
        candidates: [],
      };
    }

    const plans: { id: string; text: string }[] = [];
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
    // B10: scope the planners' HOME/config dirs so claude-code plan files (and any
    // native session state) stay inside the run's scoped home, never the
    // operator's real ~/.claude/plans. Disposed after the planners finish.
    const roHome = new WorkspaceManager(this.execRootOf(input)).readOnlyHomeEnv();
    try {
      for (const [idx, routed] of adapters.entries()) {
        if (input.signal?.aborted) break;
        const adapter = routed.adapter;
        const attemptId = `p${String(idx + 1).padStart(2, "0")}`;
        const lease = ledger.reserve({ taskId, attemptId, intent: "plan", harnessId: adapter.id });
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
          prompt:
            this.planPrompt(input.prompt) + contextSection + this.relayPriorPlansSection(plans),
          cwd: this.execRootOf(input),
          access: "readonly",
          // Planners must SEE any image/file the user attached (e.g. "plan a fix for
          // what's in this screenshot"), not just agent/race runs.
          attachments: input.attachments ?? [],
          ...this.sessionSpecFields(input, adapter.id),
          external_context_policy: knobs.webPolicy,
          tool_permission_policy: {
            web: knobs.webPolicy,
            allow: [...new Set([...contract.tool_permission_policy.allow, ...knobs.toolsAllow])],
            deny: [...new Set([...contract.tool_permission_policy.deny, ...knobs.toolsDeny])],
          },
          model_hint: knobs.model,
          effort_hint: knobs.effort,
          max_turns: knobs.maxTurns,
          env_inheritance: this.envInheritance(input.repoRoot),
          env: roHome.env,
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
        const parts: string[] = [];
        const telemetry = createAttemptTelemetry(
          knobs.webPolicy,
          contract.external_context.web_required ||
            knobs.webPolicy === "cached" ||
            knobs.webPolicy === "live",
          effectiveWeb,
        );
        const onAbort = () => {
          void adapter.cancel?.(spec.session_id)?.catch(() => {});
        };
        if (input.signal) {
          if (input.signal.aborted) onAbort();
          else input.signal.addEventListener("abort", onAbort, { once: true });
        }
        let cost = 0;
        let harnessError: string | null = null;
        try {
          log.emit("harness.started", {
            harness_id: adapter.id,
            attempt_id: attemptId,
            external_context_policy: knobs.webPolicy,
            ...(knobs.ignored.length > 0 ? { ignored_settings: knobs.ignored } : {}),
          });
          if (!input.signal?.aborted) {
            const watchedPlan = withInactivityWatchdog(adapter.run(spec), {
              timeoutMs: this.harnessInactivityTimeoutMs(input.repoRoot),
              onTimeout: () => {
                plannerAbort.abort();
                void adapter.cancel?.(spec.session_id)?.catch(() => {});
              },
            });
            for await (const ev of watchedPlan) {
              if (input.signal?.aborted) break;
              const safeEv = redactHarnessEvent(ev);
              safeInvoke(input.onHarnessEvent, safeEv);
              // NOT observed for resume: this read-only/plan attempt runs in a
              // DISPOSABLE roHome (disposed below), so its native session id is
              // unreachable afterwards. Recording it would poison the thread resume
              // map with dead ids — the read-side mirror of the agent path's
              // `if (inPlaceEnvelope)` guard. Codex-review-confirmed.
              this.observeAuthSwitch(log, adapter.id, attemptId, safeEv);
              log.emit("harness.event", harnessEventPayload(adapter.id, attemptId, safeEv));
              appendLine(attemptEventsPath, JSON.stringify(safeEv));
              observeAttemptTelemetry(telemetry, safeEv);
              if (safeEv.type === "usage" && safeEv.usage?.cost_usd) {
                cost += safeEv.usage.cost_usd;
                log.emit("budget.observation", {
                  harness_id: adapter.id,
                  attempt_id: attemptId,
                  kind: "spend",
                  usd: safeEv.usage.cost_usd,
                  estimated: safeEv.usage.estimated === true,
                });
              }
              if (
                safeEv.type === "message" &&
                safeEv.text &&
                safeEv.payload?.["auth_switched"] !== true
              ) {
                pushUniqueText(parts, safeEv.text);
              }
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
          ledger.settle(lease.lease?.lease_id ?? "", cost);
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
          continue;
        }
        const text = parts.join("\n").trim() || "(no output)";
        log.emit("harness.completed", {
          harness_id: adapter.id,
          attempt_id: attemptId,
          status: "success",
          ...telemetrySummary(telemetry),
        });
        planAttempts.push({ attemptId, harnessId: adapter.id, status: "success", error: null });
        plans.push({ id: adapter.id, text });
        store.writeText(join(paths.root, "plans", `${adapter.id}.md`), redactSecrets(text) + "\n");
      }
    } finally {
      // Planners done (or threw) — always reclaim the scoped home (it may hold seeded creds).
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
        () => this.writeRunTelemetry(store, paths, contract, runId, taskId, "plan", attemptTelemetries, null),
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
        `# Run ${runId} (plan)\n\n- Status: ${blocked ? "blocked" : "failed"}\n\n${message}\n`,
      );
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      if (blocked)
        log.emit("run.blocked", {
          status: "blocked",
          phase: "harness",
          error: message,
          failure_ref: "final/failure.yaml",
        });
      else
        log.emit("run.failed", {
          status: "failed",
          phase: "harness",
          error: message,
          failure_ref: "final/failure.yaml",
        });
      return {
        runId,
        taskId,
        mode: "plan",
        status: blocked ? "blocked" : "failed",
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

    let ambiguities: ReviewFinding[] = [];
    let reviewFindings: ReviewFinding[] = [];
    if (reviewers.length > 0 && plans.length > 0) {
      const reviewDir = join(paths.root, "review-evidence");
      const planEvidence = plans.map((p) => `## Plan from ${p.id}\n${p.text}`).join("\n\n");
      const planReviewDiff = "(plan review — no code diff)\n";
      writeEvidencePacket(reviewDir, {
        userIntent: redactSecrets(input.prompt),
        planAccepted: planEvidence,
        diff: planReviewDiff,
        tests: this.testsEvidence(contract),
      });
      // Reserve BEFORE spending: a hard budget tier must stop the paid plan
      // review from starting, not account for it after the fact.
      const lease = ledger.reserve({
        taskId,
        attemptId: "plan-review",
        intent: "review",
        harnessId: "review-panel",
      });
      if (lease.granted) {
        const res = await this.reviewScoped({
          candidateLabel: "Plan",
          diff: planReviewDiff,
          evidenceDir: reviewDir,
          artifactsDir: join(paths.reviewsDir, "plan-reviewers"),
          cwd: this.execRootOf(input),
          reviewers,
          envInheritance: this.envInheritance(input.repoRoot),
          signal: input.signal,
          onReviewerEvent: (event) => log.emit(event.type, { ...event }),
        });
        reviewFindings = await revalidateFindings(res.findings, {
          candidateRoot: this.execRootOf(input),
          evidenceDir: reviewDir,
        });
        ambiguities = reviewFindings.filter(
          (f) => f.category === "spec_gap" || f.severity === "NEEDS_HUMAN",
        );
        store.writeYaml(join(paths.reviewsDir, "plan-review.yaml"), {
          findings: reviewFindings,
          route_proofs: res.routeProofs,
          reviewer_requests: res.reviewerRequests,
        });
        ledger.settle(lease.lease?.lease_id ?? "", res.reviewSpendUsd ?? 0);
        if ((res.reviewSpendUsd ?? 0) > 0) {
          log.emit("budget.observation", {
            harness_id: "review-panel",
            kind: "spend",
            usd: res.reviewSpendUsd,
            estimated: res.reviewSpendEstimated,
          });
        }
      } else {
        log.emit("budget.lease.created", {
          granted: false,
          reason: lease.reason,
          attempt_id: "plan-review",
          harness_id: "review-panel",
        });
      }
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
        () => this.writeRunTelemetry(store, paths, contract, runId, taskId, "plan", attemptTelemetries, null),
      );
    }

    const failedPlanners = planAttempts.filter((p) => p.status !== "success");
    // ALL review findings are shown (severity-marked), so a BLOCK like "the
    // requested feature is not delivered" is visible on the plan itself — not
    // silently filtered down to spec_gap/NEEDS_HUMAN the way v0.9 hid it.
    const blockingFindings = reviewFindings.filter((f) => isBlocking(f));
    const sevMark: Record<string, string> = {
      BLOCK: "🔴 BLOCK",
      FIX_FIRST: "🟠 FIX_FIRST",
      NEEDS_HUMAN: "🟠 NEEDS_HUMAN",
    };
    const planDoc = [
      `# Plan`,
      "",
      `## Goal`,
      redactSecrets(input.prompt),
      "",
      `## Plan${plans.length > 1 ? "s" : ""} (${plans.length}/${planAttempts.length} planner${planAttempts.length === 1 ? "" : "s"})`,
      ...plans.map((p) => `\n### Plan — ${p.id}\n${redactSecrets(p.text)}`),
      ...(reviewFindings.length > 0
        ? [
            "",
            "## Review findings",
            ...reviewFindings.map(
              (f) => `- ${sevMark[f.severity] ?? f.severity}: ${redactSecrets(f.claim)}`,
            ),
          ]
        : []),
      ...(ambiguities.length > 0
        ? ["", "## Open questions", ...ambiguities.map((a) => `- ${redactSecrets(a.claim)}`)]
        : []),
      ...(failedPlanners.length > 0
        ? [
            "",
            "## Planner omissions",
            ...failedPlanners.map(
              (p) => `- ${p.attemptId} / ${p.harnessId} ${p.status}: ${p.error}`,
            ),
          ]
        : []),
      "",
    ].join("\n");
    store.writeText(join(paths.finalDir, "plan.md"), planDoc + "\n");
    // A plan is a delivered work product (a report), even with risks — parity
    // with the other read-only modes (removes the "only successful mode with no
    // work_product" anomaly). result_kind=plan tells surfaces NO files changed.
    store.writeYaml(join(paths.finalDir, "work_product.yaml"), {
      id: newId("wp"),
      kind: "report",
      source_task_id: taskId,
      producer_attempt_id: planAttempts.find((p) => p.status === "success")?.attemptId ?? null,
      meta: {
        mode: "plan",
        result_kind: "plan",
        planners: plans.length,
        diffstat: { files: 0, additions: 0, deletions: 0 },
        blockers: blockingFindings.length,
        adopted: null,
      },
    });
    // Canonical summary artifact (parity with every other mode's final/ layout).
    store.writeText(
      join(paths.finalDir, "summary.md"),
      `# Run ${runId} (plan)\n\n- Status: success (plan only — no files changed)\n- Planners: ${plans.length}/${planAttempts.length} succeeded\n- Plan: final/plan.md\n- Review blockers: ${blockingFindings.length}\n- Open questions: ${ambiguities.length}\n${failedPlanners.length > 0 ? `- Omissions: ${failedPlanners.map((p) => `${p.harnessId} ${p.status}`).join(", ")}\n` : ""}`,
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
    log.emit("run.completed", { status: "success" });

    return {
      runId,
      taskId,
      mode: "plan",
      status: "success",
      winner: null,
      runDir: paths.root,
      summary: `Plan from ${plans.length} planner(s); ${blockingFindings.length} blocker(s), ${ambiguities.length} open question(s).`,
      candidates: planAttempts.map((p) => ({
        attemptId: p.attemptId,
        harnessId: p.harnessId,
        status: p.status,
      })),
    };
  }

  /** ask: one selected harness answers read-only questions; no patch/apply controls. */
  private async runAsk(input: RunInput, announce?: (a: AnnouncedRunContext) => void): Promise<OrchestratorResult> {
    return this.runReadOnlyReport(input, {
      mode: "ask",
      swarm: false,
      intent: "explain",
      title: "Answer",
      artifactName: "answer.md",
      defaultPrompt: "Answer the user's question.",
    }, announce);
  }

  /** audit --swarm: bounded read-only research swarm (the old `explore` mode). */
  private async runExplore(input: RunInput, announce?: (a: AnnouncedRunContext) => void): Promise<OrchestratorResult> {
    return this.runReadOnlyReport(input, {
      mode: "audit",
      swarm: true,
      intent: "audit",
      title: "Explore synthesis",
      artifactName: "explore.md",
      defaultPrompt:
        "Explore this repository and synthesize evidence-cited findings, omissions, and follow-up questions.",
    }, announce);
  }

  /** audit: single read-only audit/map report. */
  private async runAudit(input: RunInput, announce?: (a: AnnouncedRunContext) => void): Promise<OrchestratorResult> {
    return this.runReadOnlyReport(input, {
      mode: "audit",
      swarm: false,
      intent: "audit",
      title: "Audit report",
      artifactName: "report.md",
      defaultPrompt: "audit this repository",
    }, announce);
  }

  /**
   * orchestrate: the autonomous brain (A3). NOT a privileged harness — the brain
   * is routed like reviewers (doctor-ok + `orchestrate` capability + headroom)
   * and runs READ-ONLY. With default `suggest` autonomy its work product is a
   * typed orchestration plan over the 6-tool belt (start_run / race / status /
   * answer_question / apply / review); execution happens as subsequent thread
   * turns. Degradation contract: any 1 harness works (single-route plan); 2+
   * harnesses unlock cross-family race/review in the plan space.
   */
  private async runOrchestrate(input: RunInput, announce?: (a: AnnouncedRunContext) => void): Promise<OrchestratorResult> {
    // "Doctor-verified" must mean status ok — degraded key-present routes are
    // excluded from the pool the brain plans over (readiness honesty).
    const pool = await this.gateway.doctorOkReal({ cwd: input.repoRoot }, "orchestrate");
    const crossFamily = pool.length >= 2;
    const goal = input.prompt || "Plan the next move for this repository.";
    // The typed orchestration contract is a REAL persisted artifact (producer
    // here, consumers: the brain prompt below + the plan validator).
    // Autonomy is producer-supplied (control-api/CLI -> daemon -> RunInput);
    // the executor below is its consumer. Default `suggest` (plan-only) preserves
    // the read-only contract when no autonomy is requested.
    const autonomy: OrchestrateAutonomy = input.autonomy ?? "suggest";
    const orchestrateContract = OrchestrateContractSchema.parse({
      thread_id: input.threadId ?? newId("th"),
      goal,
      budget: { max_usd: input.maxUsd ?? null, max_tool_calls: input.maxToolCalls ?? null },
      autonomy,
    });
    const brainPrompt = buildOrchestrateBrainPrompt(goal, pool, crossFamily, orchestrateContract);
    return this.runReadOnlyReport(
      // The executed pool is pinned to the PLANNED pool (no double doctor
      // resolution drift between the prompt's claims and the actual route).
      // The brain must NOT resume or overwrite the thread's conversational
      // session — it speaks its own tool-belt framing, not the user's chat.
      {
        ...input,
        resumeSessions: undefined,
        onSessionObserved: undefined,
        harnesses: input.harnesses ?? (pool.length > 0 ? pool : undefined),
        prompt: brainPrompt,
      },
      {
        mode: "orchestrate",
        swarm: false,
        intent: "orchestrate",
        title: "Orchestration plan",
        artifactName: "orchestration.md",
        defaultPrompt: brainPrompt,
        contractIntent: goal,
        orchestrateContract,
      },
      announce,
    );
  }

  private async runReadOnlyReport(
    input: RunInput,
    opts: {
      mode: "ask" | "audit" | "orchestrate";
      swarm: boolean;
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
    // prompt (orchestrate wraps the goal in a brain prompt).
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
    announce?.({ log, store, paths, runId, taskId, mode: opts.mode, phase: "report" });

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
          `# Run ${runId} (${opts.mode})\n\n- Status: failed\n- Phase: context\n\n${message}\n`,
        );
        log.emit("output.ready", {
          kind: "summary",
          path: "final/summary.md",
          state: "diagnostic",
        });
        log.emit("run.failed", {
          status: "failed",
          phase: "context",
          error: message,
          failure_ref: "final/failure.yaml",
        });
        return {
          runId,
          taskId,
          mode: opts.mode,
          status: "failed",
          winner: null,
          runDir: paths.root,
          summary: `context failed: ${message}`,
          candidates: [],
        };
      }
    }

    const externalContextPolicy = contract.external_context.policy;
    const width = opts.swarm
      ? Math.min(Math.max(input.n ?? 4, 1), 8)
      : externalContextPolicy === "off"
        ? 1
        : Math.min(Math.max(input.n ?? 2, 1), 3);
    let adapters: RoutedAdapter[];
    try {
      adapters = await this.resolveCandidateAdapters({ ...input, prompt, n: width }, opts.intent);
      if (!opts.swarm) {
        const seen = new Set<string>();
        adapters = adapters.filter((routed) => {
          if (seen.has(routed.adapter.id)) return false;
          seen.add(routed.adapter.id);
          return true;
        });
      }
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
        `# Run ${runId} (${opts.mode})\n\n- Status: failed\n- Phase: routing\n\n${message}\n`,
      );
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      log.emit("run.failed", {
        status: "failed",
        phase: "routing",
        error: message,
        failure_ref: "final/failure.yaml",
      });
      return {
        runId,
        taskId,
        mode: opts.mode,
        status: "failed",
        winner: null,
        runDir: paths.root,
        summary: message,
        candidates: [],
      };
    }
    const ledger = new BudgetLedger({ maxUsd: contract.budget.max_usd ?? null });
    // B10: read-only routes still spawn harness processes that write native
    // state (plan files, session rollouts). Scope their HOME/config dirs so they
    // cannot escape into the operator's real ~/.claude, ~/.codex, etc. — the
    // adapters seed auth into these scoped dirs (§6). Disposed at run end.
    const roHome = new WorkspaceManager(this.execRootOf(input)).readOnlyHomeEnv();
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
    // №15: in a swarm the same harness appears in several slots; resuming the
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
      const lease = ledger.reserve({
        taskId,
        attemptId,
        intent: opts.intent,
        harnessId: adapter.id,
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
        (opts.swarm
          ? `${prompt}\n\nExplorer ${idx + 1}/${adapters.length}: focus on a distinct slice. Emit evidence-cited findings, explicit unknowns/omissions, and follow-up questions. Do not edit files.`
          : prompt) + contextSection;
      const sessionFields = this.sessionSpecFields(input, adapter.id);
      const grantResume =
        sessionFields.resume_session_id !== null && !resumeGranted.has(adapter.id);
      if (grantResume) resumeGranted.add(adapter.id);
      const spec = HarnessRunSpec.parse({
        session_id: newId("ses"),
        intent: opts.intent,
        prompt: explorerPrompt,
        cwd: this.execRootOf(input),
        access: "readonly",
        // ASK/EXPLORE/AUDIT read-only runs must forward the user's attachments —
        // "что видишь на картинке?" sent an image that was being dropped here, so
        // the model honestly reported it saw nothing (the v0.13 attachment bug).
        attachments: input.attachments ?? [],
        auth_preference: sessionFields.auth_preference,
        resume_session_id: grantResume ? sessionFields.resume_session_id : null,
        external_context_policy: knobs.webPolicy,
        tool_permission_policy: {
          web: knobs.webPolicy,
          allow: [...new Set([...contract.tool_permission_policy.allow, ...knobs.toolsAllow])],
          deny: [...new Set([...contract.tool_permission_policy.deny, ...knobs.toolsDeny])],
        },
        model_hint: knobs.model,
        effort_hint: knobs.effort,
        max_turns: knobs.maxTurns,
        env_inheritance: this.envInheritance(input.repoRoot),
        env: roHome.env,
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
      const parts: string[] = [];
      const telemetry = createAttemptTelemetry(
        knobs.webPolicy,
        contract.external_context.web_required ||
          knobs.webPolicy === "cached" ||
          knobs.webPolicy === "live",
        effectiveWeb,
      );
      const retryPolicy = this.transientRetryPolicy(input.repoRoot);
      let activeSessionId = spec.session_id;
      const onAbort = () => {
        void adapter.cancel?.(activeSessionId)?.catch(() => {});
      };
      if (input.signal) {
        if (input.signal.aborted) onAbort();
        else input.signal.addEventListener("abort", onAbort, { once: true });
      }
      let cost = 0;
      let harnessError: string | null = null;
      try {
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
              timeoutMs: this.harnessInactivityTimeoutMs(input.repoRoot),
              onTimeout: () => {
                reportAbort.abort();
                void adapter.cancel?.(activeSessionId)?.catch(() => {});
              },
            });
            for await (const ev of watchedReport) {
              if (input.signal?.aborted) break;
              const safeEv = redactHarnessEvent(ev);
              safeInvoke(input.onHarnessEvent, safeEv);
              // NOT observed for resume: this read-only/plan attempt runs in a
              // DISPOSABLE roHome (disposed below), so its native session id is
              // unreachable afterwards. Recording it would poison the thread resume
              // map with dead ids — the read-side mirror of the agent path's
              // `if (inPlaceEnvelope)` guard. Codex-review-confirmed.
              this.observeAuthSwitch(log, adapter.id, attemptId, safeEv);
              log.emit("harness.event", harnessEventPayload(adapter.id, attemptId, safeEv));
              appendLine(attemptEventsPath, JSON.stringify(safeEv));
              observeAttemptTelemetry(telemetry, safeEv);
              if (safeEv.type === "usage" && safeEv.usage?.cost_usd) {
                cost += safeEv.usage.cost_usd;
                log.emit("budget.observation", {
                  harness_id: adapter.id,
                  attempt_id: attemptId,
                  kind: "spend",
                  usd: safeEv.usage.cost_usd,
                  estimated: safeEv.usage.estimated === true,
                });
              }
              if (
                safeEv.type === "message" &&
                safeEv.text &&
                safeEv.payload?.["auth_switched"] !== true
              ) {
                pushUniqueText(parts, safeEv.text);
              }
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
          const reportSoFar = parts.join("\n").trim();
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
        ledger.settle(lease.lease?.lease_id ?? "", cost);
      }
      if (harnessError && telemetry.transientFailures.length > 0) {
        log.emit("route.transient.exhausted", {
          harness_id: adapter.id,
          attempt_id: attemptId,
          retries: retryPolicy.maxRetries,
        });
      }
      attemptTelemetries.push({ attemptId, harnessId: adapter.id, telemetry });
      const report = redactSecrets(parts.join("\n").trim());
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
        if (opts.swarm) {
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
      if (opts.swarm) {
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
      if (opts.swarm) {
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
      // All read-only attempts done (or threw) — reclaim the scoped harness home
      // (it contained every native write for this run and may hold seeded creds).
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
        () => this.writeRunTelemetry(store, paths, contract, runId, taskId, opts.mode, attemptTelemetries, null),
      );
    }

    const succeededReadonly = attempts.filter((a) => a.status === "success");
    if (!opts.swarm && succeededReadonly.length === 0) {
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
      const terminal = webBlocked
        ? "blocked"
        : budgetStopped && attempts.length === 0
          ? "exhausted"
          : "failed";
      store.writeText(
        join(paths.finalDir, "summary.md"),
        `# Run ${runId} (${opts.mode})\n\n- Harness: ${last?.harnessId ?? "none"}\n- Status: ${terminal}\n\n${singleError}\n`,
      );
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      if (terminal === "blocked") {
        log.emit("run.blocked", {
          status: terminal,
          harness_id: last?.harnessId,
          error: singleError,
          failure_ref: "final/failure.yaml",
        });
      } else {
        log.emit("run.failed", {
          status: terminal,
          harness_id: last?.harnessId,
          error: singleError,
          failure_ref: "final/failure.yaml",
        });
      }
      return {
        runId,
        taskId,
        mode: opts.mode,
        status: terminal,
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
    if (opts.swarm && succeeded.length === 0) {
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
        `# Run ${runId} (${opts.mode})\n\n- Status: ${blocked ? "blocked" : "failed"}\n\n${message}\n`,
      );
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      if (blocked)
        log.emit("run.blocked", {
          status: "blocked",
          phase: "harness",
          error: message,
          failure_ref: "final/failure.yaml",
        });
      else
        log.emit("run.failed", {
          status: "failed",
          phase: "harness",
          error: message,
          failure_ref: "final/failure.yaml",
        });
      return {
        runId,
        taskId,
        mode: opts.mode,
        status: blocked ? "blocked" : "failed",
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
    const report = opts.swarm
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
    // orchestrate: the brain's plan is a TYPED artifact, not just prose. Extract
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
      opts.swarm ? null : (succeeded[0]?.attemptId ?? null),
    );
    log.emit("output.ready", {
      kind: opts.mode === "ask" ? "answer" : "report",
      path: `final/${opts.artifactName}`,
    });
    if (opts.swarm) {
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
    let terminal: RunStatus = "success";
    // D5: orchestrate's contract output IS the typed plan. If the brain failed to
    // produce a valid one, the run is NOT a clean success — disclose it honestly
    // (the markdown plan stays as a diagnostic artifact) rather than reporting
    // success alongside an orchestration_parse_error.md.
    if (opts.mode === "orchestrate" && !orchestratePlan) terminal = "not_converged";
    if (opts.mode === "orchestrate" && autonomy !== "suggest" && orchestratePlan) {
      // Thread the GENERATED runId onto input so the executor's answer_question
      // step keys the interaction registry by this orchestrate run's id (callers
      // often invoke run() without a preassigned runId).
      const exec = await this.executeOrchestratePlan(
        { ...input, runId },
        orchestratePlan,
        autonomy,
        opts.orchestrateContract ?? null,
        store,
        paths,
        log,
      );
      terminal = exec.terminal;
      typedPlanNote += `\n- Executor (${autonomy}): ${exec.note}`;
    }
    const harnessLabel = attempts
      .map((a) => `${a.attemptId}:${a.harnessId}:${a.status}`)
      .join(", ");
    store.writeText(
      join(paths.finalDir, "summary.md"),
      `# Run ${runId} (${opts.mode})\n\n- Harnesses: ${harnessLabel}\n- Status: ${terminal}${typedPlanNote}\n\n${report}\n`,
    );
    store.writeYaml(join(paths.finalDir, "work_product.yaml"), {
      id: newId("wp"),
      kind: "report",
      source_task_id: taskId,
      producer_attempt_id: succeeded[0]?.attemptId ?? "a01",
      files: { [opts.artifactName]: join(paths.finalDir, opts.artifactName) },
      meta: {
        harnesses: attempts.map((a) => a.harnessId),
        mode: opts.mode,
        intent: opts.intent,
        read_only: true,
      },
    });
    log.emit("work_product.emitted", { kind: "report", winner: succeeded[0]?.attemptId ?? null });
    if (terminal === "blocked") {
      writeFailure(store, paths, {
        phase: "executor",
        category: "policy",
        safeMessage:
          "orchestrate executor stopped at a risky step (apply) under auto_safe; awaiting a human decision",
        runDir: paths.root,
        nextActions: [
          "Review the proposed apply",
          "Approve via the run decision endpoint",
          "Re-run with auto_full to apply automatically",
        ],
      });
      log.emit("run.blocked", {
        status: terminal,
        phase: "executor",
        failure_ref: "final/failure.yaml",
      });
    } else if (terminal === "failed") {
      writeFailure(store, paths, {
        phase: "executor",
        category: "internal",
        safeMessage:
          "orchestrate executor failed: a safe step errored fatally (see final/orchestration_progress.yaml)",
        runDir: paths.root,
        nextActions: [
          "Inspect final/orchestration_progress.yaml",
          "Open the failed sub-run",
          "Re-run after the cause is fixed",
        ],
      });
      log.emit("run.failed", {
        status: terminal,
        phase: "executor",
        failure_ref: "final/failure.yaml",
      });
    } else if (terminal === "not_converged") {
      // Orchestrate's typed-plan contract failed (the brain produced no valid
      // plan): a failure-shaped terminal with artifacts, never run.completed —
      // jobs.json and events.jsonl must agree the run did not converge (T3.1#3).
      writeFailure(store, paths, {
        phase: "plan",
        category: "harness_error",
        safeMessage:
          "orchestrate brain produced no valid typed plan (see final/orchestration_parse_error.md); the markdown report is diagnostic only",
        runDir: paths.root,
        nextActions: [
          "Inspect final/orchestration_parse_error.md",
          "Re-run orchestrate",
          "Check the brain harness doctor status",
        ],
      });
      log.emit("run.failed", {
        status: terminal,
        phase: "plan",
        failure_ref: "final/failure.yaml",
      });
    } else if (terminal === "cancelled") {
      // Cancel is failure-shaped (parity with every other mode's cancel
      // terminal): tailers waiting for run.completed-as-success must not
      // mistake an operator abort for a clean report.
      log.emit("run.failed", { status: terminal });
    } else {
      log.emit("run.completed", { status: terminal });
    }

    return {
      runId,
      taskId,
      mode: opts.mode,
      status: terminal,
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
   * Execute a typed orchestration plan under auto_safe / auto_full. Runs the
   * tool_calls IN ORDER, classifying each via toolRisk (FAIL-CLOSED). Persists
   * final/orchestration_progress.yaml and emits progress events. Returns the
   * executor's terminal status (success / blocked / failed) and a short note.
   *
   * SAFETY INVARIANTS (see CLAUDEXOR doctrine):
   *  1. A SAFE step NEVER mutates the live tree: start_run/race run as isolated
   *     ENVELOPE sub-runs (inPlace=false, asserted), review/status/answer are reads.
   *  2. Risk is fail-closed (toolRisk): any unknown/undeclared tool is risky.
   *  3. auto_safe STOPS at the first risky step (apply) without executing it; the
   *     run ends `blocked` awaiting a human decision.
   *  4. answer_question / status / review are read-only w.r.t. the tree.
   */
  private async executeOrchestratePlan(
    input: RunInput,
    plan: OrchestratePlanT,
    autonomy: OrchestrateAutonomy,
    contract: OrchestrateContractT | null,
    store: ArtifactStore,
    paths: ReturnType<ArtifactStore["runPaths"]>,
    log: EventLog,
  ): Promise<{ terminal: RunStatus; note: string }> {
    const maxToolCalls = contract?.budget.max_tool_calls ?? null;
    const steps: OrchestratePlanProgressT["steps"] = plan.tool_calls.map((call, index) => ({
      index,
      tool: call.tool,
      risk: toolRisk(call.tool),
      status: "pending" as OrchestrateStepStatus,
      run_id: null,
      detail: null,
    }));
    let stoppedReason: string | null = null;
    let terminal: RunStatus = "success";
    const persist = (): void => {
      const progress: OrchestratePlanProgressT = { steps, autonomy, stopped_reason: stoppedReason };
      store.writeYaml(join(paths.finalDir, "orchestration_progress.yaml"), progress);
    };
    persist();
    log.emit("output.ready", { kind: "report", path: "final/orchestration_progress.yaml" });

    let executed = 0;
    // Aggregate budget (D9): sub-runs share ONE cap. Each sequential sub-run
    // gets the REMAINING headroom (cap minus settled spend of prior steps) —
    // never the full cap again per step (the N-times-overspend bug).
    let aggregateSpentUsd = 0;
    for (let i = 0; i < plan.tool_calls.length; i++) {
      const call = plan.tool_calls[i]!;
      const step = steps[i]!;
      // Honor input.signal abort: stop, mark remaining steps skipped.
      if (input.signal?.aborted) {
        step.status = "skipped";
        step.detail = "run cancelled before this step";
        stoppedReason = "cancelled";
        terminal = "cancelled";
        persist();
        break;
      }
      // Aggregate USD cap: stop before a step that has no headroom left.
      if (input.maxUsd !== null && input.maxUsd !== undefined && aggregateSpentUsd >= input.maxUsd) {
        step.status = "skipped";
        step.detail = `aggregate budget exhausted (${aggregateSpentUsd.toFixed(2)} of ${input.maxUsd} USD spent)`;
        stoppedReason = `aggregate budget exhausted after ${executed} step(s)`;
        terminal = "exhausted";
        persist();
        break;
      }
      // Honor the budget cap on tool calls (count attempted executions).
      if (maxToolCalls !== null && executed >= maxToolCalls) {
        step.status = "skipped";
        step.detail = `budget max_tool_calls=${maxToolCalls} reached`;
        stoppedReason = `budget max_tool_calls=${maxToolCalls} reached`;
        persist();
        continue;
      }
      const risk = toolRisk(call.tool);
      // RISKY step (apply, or any fail-closed-risky tool).
      if (risk === "risky") {
        if (autonomy === "auto_safe") {
          // STOP: do not execute the risky step; block awaiting a human decision.
          step.status = "blocked";
          step.detail = "risky step requires human approval (auto_safe)";
          stoppedReason = `blocked at risky step #${i} (${call.tool}) under auto_safe`;
          terminal = "blocked";
          log.emit("orchestrate.step.blocked", { index: i, tool: call.tool, autonomy });
          persist();
          break;
        }
        // auto_full: execute the risky step (apply) via the single gate.
        step.status = "running";
        persist();
        executed++;
        try {
          const r = await this.executeApplyStep(
            input,
            call as Extract<OrchestratePlanCallT, { tool: "apply" }>,
          );
          step.status = r.ok ? "done" : "failed";
          step.run_id = r.runId;
          step.detail = r.detail;
          log.emit("orchestrate.step.done", {
            index: i,
            tool: call.tool,
            ok: r.ok,
            run_id: r.runId,
          });
          if (!r.ok) {
            terminal = "failed";
            stoppedReason = `apply step #${i} failed: ${r.detail}`;
            persist();
            break;
          }
        } catch (err) {
          step.status = "failed";
          step.detail = safeErrorMessage(err);
          terminal = "failed";
          stoppedReason = `apply step #${i} threw: ${safeErrorMessage(err)}`;
          persist();
          break;
        }
        persist();
        continue;
      }
      // SAFE step: execute as an isolated sub-run / pure read.
      step.status = "running";
      persist();
      executed++;
      try {
        const remainingUsd =
          input.maxUsd === null || input.maxUsd === undefined
            ? null
            : Math.max(0, input.maxUsd - aggregateSpentUsd);
        const r = await this.executeSafeStep(input, call, log, store, paths, remainingUsd);
        aggregateSpentUsd += r.spendUsd ?? 0;
        step.status = r.status;
        step.run_id = r.runId;
        step.detail = r.detail;
        log.emit("orchestrate.step.done", {
          index: i,
          tool: call.tool,
          status: r.status,
          run_id: r.runId,
        });
        if (r.status === "failed") {
          terminal = "failed";
          stoppedReason = `safe step #${i} (${call.tool}) errored: ${r.detail}`;
          persist();
          break;
        }
      } catch (err) {
        step.status = "failed";
        step.detail = safeErrorMessage(err);
        terminal = "failed";
        stoppedReason = `safe step #${i} (${call.tool}) threw: ${safeErrorMessage(err)}`;
        persist();
        break;
      }
      persist();
    }
    persist();
    const done = steps.filter((s) => s.status === "done").length;
    const note =
      terminal === "blocked"
        ? `blocked at a risky step (${done}/${steps.length} safe steps done)`
        : terminal === "failed"
          ? `failed (${done}/${steps.length} steps done; ${stoppedReason ?? "see progress"})`
          : terminal === "cancelled"
            ? `cancelled (${done}/${steps.length} steps done)`
            : `all ${done}/${steps.length} steps done`;
    return { terminal, note };
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
    remainingUsd: number | null,
  ): Promise<{ status: OrchestrateStepStatus; runId: string | null; detail: string | null; spendUsd?: number | null }> {
    switch (call.tool) {
      case "start_run":
      case "race": {
        // Force an isolated envelope sub-run: inPlace MUST be false, no thread
        // binding, no in-place execution root, no nested autonomy. A sub-run
        // inherits orchestrateDepth+1 (recursion guard) and may NOT orchestrate.
        const subInput: RunInput = {
          repoRoot: input.repoRoot,
          prompt: call.prompt,
          mode: call.tool === "start_run" ? call.mode : "agent",
          n: call.tool === "race" ? call.n : undefined,
          harnesses: call.tool === "start_run" && call.harness ? [call.harness] : undefined,
          portfolio: input.portfolio,
          // Aggregate budget (D9): the sub-run gets only the REMAINING headroom.
          maxUsd: remainingUsd,
          web: input.web,
          externalContextPolicy: input.externalContextPolicy,
          signal: input.signal,
          // SAFETY: isolated envelope, never the live in-place thread tree.
          inPlace: false,
          threadId: undefined,
          executionRoot: undefined,
          autonomy: undefined,
          resumeSessions: undefined,
          onSessionObserved: undefined,
          orchestrateDepth: (input.orchestrateDepth ?? 0) + 1,
        };
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
          status: res.status === "failed" || res.status === "cancelled" ? "failed" : "done",
          runId: res.runId,
          spendUsd: res.spendUsd ?? null,
          detail: `${call.tool} sub-run ${res.runId} -> ${res.status}`,
        };
      }
      case "status": {
        // Pure read of the referenced run's decision/work_product artifacts.
        const read = this.readRunStatus(input.repoRoot, call.run_id);
        return {
          status: read ? "done" : "skipped",
          runId: call.run_id,
          detail: read ?? `run ${call.run_id} has no readable status artifacts`,
        };
      }
      case "review": {
        // Read-only review over the referenced run's recorded patch diff. The
        // step ACTUALLY runs the reviewer panel (evidence beats summaries — a
        // "done" review must mean a review happened), persists its artifacts, and
        // reports the real outcome; eligibility alone is never reported as done.
        const diff = this.readRunPatch(input.repoRoot, call.run_id);
        if (diff === null)
          return {
            status: "skipped",
            runId: call.run_id,
            detail: `run ${call.run_id} has no patch.diff to review`,
          };
        const reviewers = await this.resolveReviewers(input.repoRoot, input.authPreference);
        if (reviewers.length === 0)
          return {
            status: "skipped",
            runId: call.run_id,
            detail: "no doctor-OK reviewers available",
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
          envInheritance: this.envInheritance(input.repoRoot),
          signal: input.signal,
          onReviewerEvent: (event) => log.emit(event.type, { ...event }),
        });
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
          runId: call.run_id,
          detail: `reviewed ${call.run_id}: ${result.distinctProviders.length} family(ies), ${revalidated.length} finding(s), ${blockers} blocker(s)`,
        };
      }
      case "answer_question": {
        // Deliver typed answers to a referenced pending interaction (read-only
        // w.r.t. the tree). The daemon owns the live registry; without an
        // injected service this context cannot reach it, so SKIP honestly.
        //
        // INVARIANT: safe sub-runs are NON-interactive (subInput above omits
        // onInteraction, so a start_run/race sub-run never raises an interaction
        // and nothing registers under its run id). The only pending interactions
        // therefore belong to THIS orchestrate run, so `input.runId` is the
        // correct registry key. If sub-runs are ever made interactive, the
        // answer_question plan call MUST carry the target sub-run id and pass it
        // here instead of input.runId (the registry is keyed by runId+interactionId).
        if (!input.answerInteraction) {
          return {
            status: "skipped",
            runId: null,
            detail: "no live interaction surface in this context",
          };
        }
        const delivered = await input.answerInteraction(input.runId ?? "", call.interaction_id, {
          interaction_id: call.interaction_id,
          answers: call.answers.map((a) => ({
            question_id: a.question_id,
            selected_labels: a.selected_labels,
            free_text: a.free_text,
          })),
        });
        return {
          status: delivered ? "done" : "skipped",
          runId: null,
          detail: delivered
            ? `delivered answers to ${call.interaction_id}`
            : `interaction ${call.interaction_id} not found / already resolved`,
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

  /**
   * Execute a RISKY `apply` step (auto_full only) through the SINGLE existing
   * apply gate (`validateApplyGate`) + `deliver` — the same path
   * accept_clean_patch uses. Reads the referenced run's patch + work_product +
   * decision artifacts; refuses unless the gate passes.
   */
  private async executeApplyStep(
    input: RunInput,
    call: Extract<OrchestratePlanCallT, { tool: "apply" }>,
  ): Promise<{ ok: boolean; runId: string; detail: string }> {
    const store = new ArtifactStore(input.repoRoot);
    const sub = store.runPaths(call.run_id);
    const patchPath = join(sub.finalDir, "patch.diff");
    const patchText = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : null;
    if (patchText === null)
      return {
        ok: false,
        runId: call.run_id,
        detail: `run ${call.run_id} has no patch.diff to apply`,
      };
    if (containsSecretLikeToken(patchText))
      return {
        ok: false,
        runId: call.run_id,
        detail: "patch contains a secret-like token; refusing apply",
      };
    const decision = store.readYaml(join(sub.arbitrationDir, "decision.yaml"));
    const workProduct = store.readYaml(join(sub.finalDir, "work_product.yaml"));
    const parsedDecision = decision ? DecisionRecordSchema.safeParse(decision) : null;
    const parsedWp = workProduct ? WorkProductSchema.safeParse(workProduct) : null;
    // The referenced run's recorded original project IS this orchestrate run's
    // repoRoot (sub-runs were spawned against it); the gate re-verifies identity.
    const gateError = validateApplyGate({
      // Artifact-only path (we read the referenced run's decision/work_product
      // from disk, not a live daemon job): pass state=null and let the gate's
      // decision.status check be the terminal-state guard. Hardcoding "succeeded"
      // would silently bypass that check if it were ever relaxed.
      state: null,
      decision: parsedDecision?.success ? parsedDecision.data : null,
      workProduct: parsedWp?.success ? parsedWp.data : null,
      patch: patchText,
      originalRepoRoot: input.repoRoot,
      targetRepoRoot: input.repoRoot,
      operatorDecision: null,
    });
    if (gateError)
      return { ok: false, runId: call.run_id, detail: `apply gate refused: ${gateError}` };
    const delivered = await deliver(input.repoRoot, patchText, { mode: call.mode });
    return {
      ok: delivered.applied,
      runId: call.run_id,
      detail: delivered.applied
        ? `applied (${call.mode})`
        : `deliver failed: ${delivered.detail ?? "unknown"}`,
    };
  }

  /** Pure read: a referenced run's decision/work_product status, or null. */
  private readRunStatus(repoRoot: string, runId: string): string | null {
    const store = new ArtifactStore(repoRoot);
    const sub = store.runPaths(runId);
    const decision = store.readYaml<{ status?: string; outcome?: string }>(
      join(sub.arbitrationDir, "decision.yaml"),
    );
    const wp = store.readYaml<{ kind?: string; meta?: Record<string, unknown> }>(
      join(sub.finalDir, "work_product.yaml"),
    );
    if (!decision && !wp) return null;
    const parts: string[] = [];
    if (decision?.status) parts.push(`decision=${decision.status}`);
    if (wp?.meta?.["result_kind"]) parts.push(`result_kind=${String(wp.meta["result_kind"])}`);
    if (wp?.meta?.["apply_state"]) parts.push(`apply_state=${String(wp.meta["apply_state"])}`);
    return parts.length > 0 ? parts.join(", ") : `run ${runId}: artifacts present`;
  }

  /** Pure read: a referenced run's recorded patch diff, or null. */
  private readRunPatch(repoRoot: string, runId: string): string | null {
    const store = new ArtifactStore(repoRoot);
    const sub = store.runPaths(runId);
    const path = join(sub.finalDir, "patch.diff");
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }
}

/**
 * Extract + validate the brain's typed plan from its markdown report (the
 * fenced ```json block the orchestrate prompt requires). Structured-output
 * parsing, not governance: validity is decided by the OrchestratePlan schema.
 */
function extractOrchestratePlan(report: string): { plan: OrchestratePlanT | null; error: string } {
  const fence = /```json\s*\n([\s\S]*?)\n```/g;
  let lastBlock: string | null = null;
  for (const match of report.matchAll(fence)) lastBlock = match[1] ?? null;
  if (!lastBlock) return { plan: null, error: "no fenced json block found in the brain report" };
  try {
    const parsed = OrchestratePlanSchema.safeParse(JSON.parse(lastBlock));
    if (!parsed.success)
      return {
        plan: null,
        error: `plan block failed schema validation: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      };
    return { plan: parsed.data, error: "" };
  } catch (err) {
    return { plan: null, error: `plan block is not valid JSON: ${safeErrorMessage(err)}` };
  }
}


function createAttemptTelemetry(
  policy: ExternalContextPolicy,
  webRequired: boolean,
  effectiveMode: ExternalContextPolicy = policy,
): AttemptTelemetry {
  return {
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
    transientFailures: [],
    outcome: null,
  };
}

function transientRetryDelayMs(
  nativeDelayMs: number | null,
  policy: TransientRetryPolicy,
  retryIndex: number,
): number {
  const fallback = policy.initialDelayMs * 2 ** retryIndex;
  const delay = nativeDelayMs ?? fallback;
  return Math.min(delay, policy.maxDelayMs);
}

function gateProtectedPaths(commands: string[]): string[] {
  if (commands.length === 0) return [];
  const paths = new Set([
    "package.json",
    "**/package.json",
    "test/**",
    "tests/**",
    "__tests__/**",
    "**/*.test.*",
    "**/*.spec.*",
  ]);
  for (const command of commands) {
    for (const raw of command.split(/\s+/)) {
      const token = raw.trim().replace(/^['"]|['"]$/g, "");
      if (
        !token ||
        token.startsWith("-") ||
        token.includes("=") ||
        token.includes("://") ||
        token.startsWith("/")
      )
        continue;
      if (!token.includes("/") && !token.includes(".")) continue;
      const clean = token.replace(/^[./]+/, "").replace(/[),;]+$/g, "");
      if (!clean || clean === "package.json") continue;
      const testish =
        clean.startsWith("test/") ||
        clean.startsWith("tests/") ||
        clean.startsWith("__tests__/") ||
        clean.includes(".test.") ||
        clean.includes(".spec.");
      if (testish) paths.add(clean.endsWith("/") ? `${clean}**` : clean);
    }
  }
  return [...paths];
}

function promptWithProtectedPathConstraint(
  prompt: string,
  protectedPaths: string[],
  autoProtectedPaths: string[] = [],
  approvals: ProtectedPathApproval[] = [],
): string {
  if (protectedPaths.length === 0 && autoProtectedPaths.length === 0) return prompt;
  const specLines = protectedPaths.length
    ? [
        "",
        "Engine constraint: do not edit spec/config protected paths unless the frozen task contract explicitly asks for it. Protected paths:",
        ...protectedPaths.slice(0, 20).map((p) => `- ${p}`),
      ]
    : [];
  const approvalLines = approvals.length
    ? [
        "",
        "Approved auto-protected gate/test path changes for this run:",
        ...approvals.slice(0, 20).map((a) => `- ${a.path}${a.reason ? ` (${a.reason})` : ""}`),
      ]
    : [];
  const autoLines = autoProtectedPaths.length
    ? [
        "",
        "Engine constraint: do not edit auto-protected gate/test paths, test commands, or package test scripts unless the user explicitly asked to change tests. Auto-protected paths:",
        ...autoProtectedPaths.slice(0, 20).map((p) => `- ${p}`),
        ...approvalLines,
      ]
    : [];
  return [
    prompt,
    ...specLines,
    ...autoLines,
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Observe a normalized harness event into the attempt telemetry. Governance is
 * fully typed: only the `tool` ToolRef on tool_call/tool_result/file_change
 * events and the run-loop drop counters are consulted — never payload string
 * matching or tool-name heuristics.
 */
function observeAttemptTelemetry(t: AttemptTelemetry, ev: HarnessEvent): void {
  // Route evidence: remember the model identity the stream itself disclosed.
  if (ev.observed_model && !t.observedModel) t.observedModel = ev.observed_model;
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
  // attempt (T2#10 keying fix: `bash echo done` must NOT launder an earlier
  // `bash npm test` failure — the name alone proved nothing).
  for (const err of t.toolErrors) {
    if (!err.recovered && err.tool === tool.name && err.target === (tool.target ?? null)) {
      err.recovered = true;
    }
  }
  if (tool.kind === "web") {
    t.web.attempted = true;
    t.web.satisfied = true;
    t.web.failed = false;
    t.web.tool = tool.name;
    t.web.target = tool.target ?? t.web.target;
  }
}

const TELEMETRY_TOOL_ERRORS_MAX = 20;

function unrecoveredToolErrors(t: AttemptTelemetry): ToolErrorRecord[] {
  return t.toolErrors.filter((e) => !e.recovered);
}

function toolWarnings(t: AttemptTelemetry): ToolErrorRecord[] {
  // Non-web tool errors are warnings once the attempt produced its contracted
  // deliverable. Web evidence has separate hard-gate semantics below.
  return unrecoveredToolErrors(t).filter((e) => e.kind !== "web");
}

function setAttemptOutcome(
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
function telemetrySummary(t: AttemptTelemetry): Record<string, unknown> {
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

function attemptTelemetryRecord(
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

function aggregateRunWebEvidence(
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
function webUnsatisfied(t: AttemptTelemetry): boolean {
  if (t.web.satisfied) return false;
  if (t.web.required) return true;
  return t.web.attempted && t.web.failed;
}

function assertNoSecretLikeTokens(label: string, text: string): void {
  if (containsSecretLikeToken(text)) {
    throw new Error(`${label} contains secret-like token; refusing to persist artifact`);
  }
}

function safeErrorMessage(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err));
}

function redactHarnessEvent(ev: HarnessEvent): HarnessEvent {
  try {
    return JSON.parse(redactSecrets(JSON.stringify(ev))) as HarnessEvent;
  } catch {
    return {
      ...ev,
      text: ev.text ? redactSecrets(ev.text) : undefined,
      error: ev.error ? redactSecrets(ev.error) : undefined,
      payload: ev.payload ? { redacted: true } : undefined,
    };
  }
}

function harnessEventPayload(
  harnessId: string,
  attemptId: string,
  ev: HarnessEvent,
): Record<string, unknown> {
  const safe = redactHarnessEvent(ev);
  const title =
    safe.error ??
    safe.text ??
    (safe.usage
      ? `usage: ${safe.usage.input_tokens ?? 0} in / ${safe.usage.output_tokens ?? 0} out`
      : safe.type);
  return {
    harness_id: harnessId,
    attempt_id: attemptId,
    session_id: safe.session_id,
    type: safe.type,
    title: String(title).slice(0, 500),
    text: safe.text,
    error: safe.error,
    usage: safe.usage,
    observed_model: safe.observed_model,
    tool: safe.tool,
    interaction: safe.interaction,
    payload: safe.payload,
  };
}

/**
 * Deduplicate the known "final result repeats the last streamed message" shape
 * (adjacent only). Legitimately repeated earlier messages are preserved — a
 * whole-array dedupe would silently merge real output.
 */
function pushUniqueText(parts: string[], text: string): void {
  const normalized = text.trim();
  if (!normalized) return;
  const last = parts[parts.length - 1]?.trim();
  if (last === normalized) return;
  parts.push(normalized);
}

function formatFindings(findings: ReviewFinding[]): string {
  if (findings.length === 0) return "(no findings recorded)";
  return findings
    .map(
      (f) =>
        `- [${f.severity}/${f.status}] ${f.claim}` +
        (f.evidence.files.length > 0
          ? ` (${f.evidence.files.map((x) => x.path).join(", ")})`
          : "") +
        (f.proposed_fix ? ` -> fix: ${f.proposed_fix}` : ""),
    )
    .join("\n");
}

function renderSummary(
  runId: string,
  mode: ModeKind,
  decision: {
    winner: string | null;
    status: string;
    outcome?: string;
    why_winner: string;
    apply_recommendation: string;
  },
  evidences: CandidateEvidence[],
  synthReason: string,
  reviewVerified: boolean,
): string {
  return (
    [
      `# Run ${runId} (${mode})`,
      "",
      `- Status: ${decision.status}`,
      `- Outcome: ${decision.outcome ?? "unknown"}`,
      `- Winner: ${decision.winner ?? "none"}`,
      `- Apply: ${decision.apply_recommendation}`,
      `- Review verified (cross-family): ${reviewVerified}`,
      `- Synthesis: ${synthReason}`,
      "",
      "## Candidates",
      ...evidences.map(
        (e) =>
          `- ${e.label} (${e.attemptId}): gates ${e.testsPassed}/${e.testsTotal}, blockers ${e.findings.filter((f) => isBlocking(f)).length}, cleanReview ${e.finalReviewClean}`,
      ),
      "",
      "## Why winner",
      decision.why_winner,
    ].join("\n") + "\n"
  );
}
