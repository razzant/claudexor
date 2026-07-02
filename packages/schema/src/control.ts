import { z } from "zod";
import {
  AccessProfile,
  AuthPreference,
  ContentHash,
  ExternalContextPolicy,
  Id,
  ModeKind,
  NonBlankString,
  OutputReadyState,
  ProviderFamily,
} from "./primitives.js";
import { Portfolio } from "./budget.js";
import {
  AdapterStatus,
  ConformanceCheck,
  EffortHint,
  HarnessManifest,
  HarnessModel,
  InteractionQuestion,
} from "./harness.js";
import { DecisionRecord } from "./decision.js";
import { WorkProduct } from "./workproduct.js";
import { ReviewFinding } from "./review.js";
import { ThreadState, ThreadTurnKind, WorkspaceMode } from "./thread.js";
import { OrchestrateAutonomy, OrchestratePlanProgress } from "./orchestrate.js";
import { AttachmentInput } from "./attachment.js";
import { ProtectedPathApproval } from "./task.js";

/** Project context depth. The "deep" tier never shipped a distinct behavior
 * (v0.15 triage): auto is the only mode; off exists solely on projections of
 * no-project runs. */
export const RunScopeContext = z.enum(["auto"]);
export type RunScopeContext = z.infer<typeof RunScopeContext>;

export const RunScope = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("project"),
      root: z.string(),
      context: RunScopeContext.default("auto"),
    })
    .strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);
export type RunScope = z.infer<typeof RunScope>;

export const RunExecution = z
  .object({
    isolation: z.enum(["envelope", "live"]).default("envelope"),
  })
  .strict();
export type RunExecution = z.infer<typeof RunExecution>;

export const ControlReviewerPanelEntry = z
  .object({
    /** Explicit reviewer harness id. Repeated harness ids are allowed so one
     * native provider can review through multiple requested models. */
    harness: NonBlankString,
    /** Optional per-reviewer model hint, passed to that harness only. */
    model: NonBlankString.optional(),
    /** Optional per-reviewer effort hint, passed to that harness only. */
    effort: EffortHint.optional(),
  })
  .strict();
export type ControlReviewerPanelEntry = z.infer<typeof ControlReviewerPanelEntry>;

export const ControlRunStartRequest = z
  .object({
    prompt: z.string().default(""),
    /** Inbound files/images for this turn; the daemon resolves each to a scoped
     *  on-disk Attachment before the run spec is built. */
    attachments: z.array(AttachmentInput).optional(),
    mode: ModeKind.default("agent"),
    scope: RunScope.default({ kind: "none" }),
    execution: RunExecution.default({ isolation: "envelope" }),
    harnesses: z.array(NonBlankString).optional(),
    primaryHarness: NonBlankString.optional(),
    portfolio: Portfolio.optional(),
    /** Scalar model convenience: expands to the RESOLVED PRIMARY harness only
     * (never the pool). With a multi-harness pool and no primary it is
     * rejected — use `models` instead (D2/INV-103). */
    model: NonBlankString.optional(),
    /** Harness-scoped model map (harness id → model id). Specific beats
     * general: an entry here wins over the scalar `model` and over the
     * per-harness settings default. */
    models: z.record(NonBlankString, NonBlankString).optional(),
    effort: EffortHint.optional(),
    reviewerModels: z.record(ProviderFamily, NonBlankString).optional(),
    reviewerEfforts: z.record(ProviderFamily, EffortHint).optional(),
    n: z.number().int().positive().optional(),
    attempts: z.number().int().positive().nullable().optional(),
    /** agent flag: iterate until the convergence predicate is clean (no fixed cap). */
    untilClean: z.boolean().optional(),
    /** audit flag: bounded read-only research swarm (the old `explore`). */
    swarm: z.boolean().optional(),
    /** agent flag: create-from-scratch intent (the old `create` mode). */
    create: z.boolean().optional(),
    /** Best-of-N synthesis policy. `auto` (default) only synthesizes a 3rd
     * candidate when n>=3 and candidates genuinely complement; `always`/`never`
     * force it. Threaded to the orchestrator's decideSynthesis. */
    synthesis: z.enum(["auto", "always", "never"]).optional(),
    maxUsd: z.number().nonnegative().nullable().optional(),
    /** Requested access profile. Effective access is derived by the engine and never client-supplied. */
    access: AccessProfile.optional(),
    web: ExternalContextPolicy.optional(),
    externalContextPolicy: ExternalContextPolicy.optional(),
    /** Opt this run into the agent-driven browser (Playwright MCP). Honored only
     *  for browser-capable harnesses when web policy is not `off`. */
    browser: z.boolean().optional(),
    tests: z.array(NonBlankString).optional(),
    /** Typed per-run approval for changing auto-protected gate/test paths. This
     * does not bypass built-in critical/security path human gates. */
    protectedPathApprovals: z.array(ProtectedPathApproval).optional(),
    specPath: NonBlankString.optional(),
    specId: z.string().optional(),
    specHash: ContentHash.optional(),
    /** Thread/session linkage (A2): a run is a turn inside a thread. */
    threadId: Id.optional(),
    /** Pre-created turn to bind this run to (single-writer: control-api creates
     * the turn, the daemon runner binds the started run id to it). */
    turnId: Id.optional(),
    parentRunId: Id.optional(),
    /** When set, this turn implements an approved plan: the engine prefixes the
     * parent plan run's final/plan.md into the prompt (mode is forced to agent). */
    planRunId: Id.optional(),
    /** Explicit reviewer panel. When present it overrides the legacy
     * per-provider-family reviewerModels/reviewerEfforts maps and preserves
     * duplicate harness entries for multi-model same-provider reviews. */
    reviewerPanel: z.array(ControlReviewerPanelEntry).min(1).optional(),
    /** Per-run auth route override (subscription/api_key/auto). */
    authPreference: AuthPreference.optional(),
    /** How much the orchestrate brain may act without confirmation
     * (suggest/auto_safe/auto_full). Only meaningful for mode=orchestrate;
     * consumed by the executor in runOrchestrate. */
    autonomy: OrchestrateAutonomy.optional(),
  })
  .strict();
export type ControlRunStartRequest = z.infer<typeof ControlRunStartRequest>;

/** Harness ids that have a managed setup flow (shared by the async setup-jobs path). */
export const ControlHarnessSetupHarness = z.enum(["codex", "claude", "cursor", "opencode", "raw"]);
export type ControlHarnessSetupHarness = z.infer<typeof ControlHarnessSetupHarness>;

export const ControlSetupJobAction = z.enum(["install", "login", "doctor", "store_key"]);
export type ControlSetupJobAction = z.infer<typeof ControlSetupJobAction>;

export const ControlSetupJobState = z.enum([
  "queued",
  "running",
  "waiting_for_input",
  "succeeded",
  "failed",
  "cancelled",
  "not_supported",
]);
export type ControlSetupJobState = z.infer<typeof ControlSetupJobState>;

export const ControlSetupJobCreateRequest = z
  .object({
    harness: ControlHarnessSetupHarness,
    action: ControlSetupJobAction,
  })
  .strict();
export type ControlSetupJobCreateRequest = z.infer<typeof ControlSetupJobCreateRequest>;

export const ControlSetupJob = z
  .object({
    jobId: Id,
    harness: ControlHarnessSetupHarness,
    action: ControlSetupJobAction,
    state: ControlSetupJobState,
    command: z.string().nullable().default(null),
    guideUrl: z.string().url().nullable().default(null),
    logPath: z.string().nullable().default(null),
    message: z.string(),
    riskFlags: z.array(z.string()).default([]),
    requiresConfirmation: z.boolean().default(false),
    createdAt: z.string(),
    startedAt: z.string().nullable().default(null),
    firstOutputAt: z.string().nullable().default(null),
    lastOutputAt: z.string().nullable().default(null),
    finishedAt: z.string().nullable().default(null),
    retryCount: z.number().int().nonnegative().default(0),
  })
  .strict();
export type ControlSetupJob = z.infer<typeof ControlSetupJob>;

export const ControlSetupJobEvent = z
  .object({
    jobId: Id,
    seq: z.number().int().nonnegative(),
    time: z.string(),
    /** Only "status" is ever produced (v0.15 triage: the log/end kinds had no
     * producer; SSE stream end is a transport frame, not a payload kind). */
    kind: z.enum(["status"]),
    state: ControlSetupJobState.optional(),
    message: z.string(),
  })
  .strict();
export type ControlSetupJobEvent = z.infer<typeof ControlSetupJobEvent>;

export const ControlSetupJobListResponse = z.object({
  jobs: z.array(ControlSetupJob),
});
export type ControlSetupJobListResponse = z.infer<typeof ControlSetupJobListResponse>;

export const ControlSetupJobConfirmRequest = z
  .object({
    confirmed: z.boolean().default(true),
  })
  .strict();
export type ControlSetupJobConfirmRequest = z.infer<typeof ControlSetupJobConfirmRequest>;

export const ControlSpecQuestionsRequest = z
  .object({
    prompt: z.string(),
    scope: z
      .object({
        kind: z.literal("project"),
        root: z.string(),
        context: RunScopeContext.default("auto"),
      })
      .strict(),
    harnesses: z.array(NonBlankString).optional(),
    /** Already-answered decisions from prior tiers; carried so each round goes
     *  DEEPER instead of re-asking (multi-tier adaptive interview). */
    priorDecisions: z.array(z.object({ question: z.string(), answer: z.string() })).optional(),
  })
  .strict();
export type ControlSpecQuestionsRequest = z.infer<typeof ControlSpecQuestionsRequest>;

export const ControlSpecFreezeRequest = z
  .object({
    prompt: z.string(),
    scope: z
      .object({
        kind: z.literal("project"),
        root: z.string(),
        context: RunScopeContext.default("auto"),
      })
      .strict(),
    planDir: z.string().optional(),
    plan: z.string().optional(),
    answers: z.array(z.unknown()).optional(),
    /** Accumulated prior-tier interview decisions. Folded into the frozen
     *  SpecPack's decided_tradeoffs so a MULTI-TIER spec carries every tier, not
     *  just the last (mirror of ControlSpecQuestionsRequest.priorDecisions). */
    priorDecisions: z.array(z.object({ question: z.string(), answer: z.string() })).optional(),
  })
  .strict();
export type ControlSpecFreezeRequest = z.infer<typeof ControlSpecFreezeRequest>;

export const ControlRunStartInfo = z.object({
  jobId: z.string().optional(),
  runId: z.string(),
  taskId: z.string().optional(),
  runDir: z.string(),
});
export type ControlRunStartInfo = z.infer<typeof ControlRunStartInfo>;

export const ControlRunState = z.enum([
  "queued",
  "running",
  "blocked",
  "succeeded",
  "no_op",
  "ungated",
  "review_not_run",
  "failed",
  "cancelled",
  "interrupted",
  "exhausted",
  "not_converged",
  "stuck_no_progress",
]);
export type ControlRunState = z.infer<typeof ControlRunState>;

export const ControlQueuedRunInfo = z.object({
  jobId: z.string(),
  state: ControlRunState,
  error: z.string().optional(),
});
export type ControlQueuedRunInfo = z.infer<typeof ControlQueuedRunInfo>;

export const RunFailure = z.object({
  phase: z.string().default("unknown"),
  category: z
    .enum([
      "validation",
      "project",
      "auth",
      "harness_unavailable",
      "harness_error",
      "budget",
      "policy",
      "cancelled",
      "internal",
      "unknown",
    ])
    .default("unknown"),
  harnessId: z.string().nullable().default(null),
  attemptId: z.string().nullable().default(null),
  safeMessage: z.string(),
  rawDetailRef: z.string().nullable().default(null),
  logRefs: z.array(z.string()).default([]),
  eventRefs: z.array(z.string()).default([]),
  runDir: z.string().nullable().default(null),
  nextActions: z.array(z.string()).default([]),
});
export type RunFailure = z.infer<typeof RunFailure>;

export const ControlProjectMetadata = z.object({
  kind: z.enum(["project", "none"]).default("none"),
  root: z.string().nullable().default(null),
  projectName: z.string().nullable().default(null),
  context: z.enum(["off", "auto"]).default("off"),
});
export type ControlProjectMetadata = z.infer<typeof ControlProjectMetadata>;

export const ControlWebEvidence = z.object({
  required: z.boolean().default(false),
  /** Requested external-context policy for the run. */
  mode: ExternalContextPolicy.default("auto"),
  /** Mode the selected route actually executed (disclosed upgrades, e.g. claude cached->live). */
  effectiveMode: ExternalContextPolicy.default("auto"),
  attempted: z.boolean().default(false),
  satisfied: z.boolean().default(false),
  status: z.enum(["none", "attempted", "satisfied", "failed", "unverified"]).default("none"),
  tool: z.string().nullable().default(null),
  target: z.string().nullable().default(null),
  errorSummary: z.string().nullable().default(null),
  rawDetailRef: z.string().nullable().default(null),
  /** False when the run predates telemetry.yaml; surfaces must render "telemetry unavailable". */
  available: z.boolean().default(true),
});
export type ControlWebEvidence = z.infer<typeof ControlWebEvidence>;

/**
 * Run-level route evidence projected from telemetry (observed model per
 * attempt). `verified` is true only when an observed model was actually
 * reported by the harness stream — never inferred from the request.
 */
export const ControlRouteInfo = z.object({
  requestedModel: z.string().nullable().default(null),
  observedModel: z.string().nullable().default(null),
  harnessId: z.string().nullable().default(null),
  verified: z.boolean().default(false),
});
export type ControlRouteInfo = z.infer<typeof ControlRouteInfo>;

/**
 * Honest terminal outcome of a run, projected from final/work_product.yaml and
 * the presence of final/answer.md. Answers "what did this turn actually do?" so
 * a chat surface never shows a green "succeeded" next to nothing (the v0.9 plan
 * bug): `kind:"plan"` means a plan was produced and NO files changed; `diffStat`
 * is null unless a patch exists; `adopted` is true when the live in-place tree
 * was actually mutated this turn (decoupled from a clean review — see applyState).
 */
export const RunApplyState = z.enum([
  /** No in-place mutation happened (envelope-only, plan/answer, or nothing produced). */
  "not_applied",
  /** Winner applied to the live tree AND review converged clean. */
  "applied",
  /** Winner applied to the live tree but review is blocked/unconverged — honest
   * "Applied · review blocked"; the Revert affordance is offered. */
  "applied_review_blocked",
  /** A prior in-place application was reverted to its pre-turn snapshot. */
  "reverted",
]);
export type RunApplyState = z.infer<typeof RunApplyState>;

export const ControlRunResult = z.object({
  kind: z.enum(["patch", "answer", "plan", "report", "none"]).default("none"),
  diffStat: z
    .object({
      files: z.number().int().nonnegative(),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
    })
    .nullable()
    .default(null),
  blockers: z.number().int().nonnegative().default(0),
  /** True when the live in-place tree was mutated this turn (regardless of review). */
  adopted: z.boolean().nullable().default(null),
  /** Honest application state (decoupled from clean-terminal). */
  applyState: RunApplyState.default("not_applied"),
  /** Tree SHA before this turn mutated the in-place tree (revert restore target). */
  preTurnSha: z.string().nullable().default(null),
  /** Tree SHA right after this turn's mutation (revert divergence fence: refuse
   * to revert if the working tree has diverged from this since). */
  postTurnSha: z.string().nullable().default(null),
  /** Revert metadata is available (the turn mutated the live tree in place and
   * pre/post-turn snapshots were recorded), so a Revert affordance may be offered.
   * This is NOT a live-safe guarantee: the server re-checks tree divergence at
   * revert time and refuses (fail loud) if the working tree changed since. */
  revertable: z.boolean().default(false),
});
export type ControlRunResult = z.infer<typeof ControlRunResult>;

export const ControlRunSummary = z.object({
  jobId: z.string(),
  runId: z.string(),
  taskId: z.string().optional(),
  state: ControlRunState,
  runDir: z.string().optional(),
  error: z.string().optional(),
  failure: RunFailure.nullable().default(null),
  project: ControlProjectMetadata.default({}),
  mode: ModeKind.optional(),
  /** v0.9 engine strategy on the mode (flags, not modes): race width / repair caps / swarm / create. */
  strategy: z.enum(["race", "attempts", "until_clean", "swarm", "create"]).nullable().optional(),
  prompt: z.string().optional(),
  harnesses: z.array(z.string()).optional(),
  primaryHarness: z.string().optional(),
  portfolio: Portfolio.optional(),
  model: z.string().optional(),
  reviewerPanel: z.array(ControlReviewerPanelEntry).optional(),
  protectedPathApprovals: z.array(ProtectedPathApproval).optional(),
  n: z.number().int().optional(),
  maxUsd: z.number().nullable().optional(),
  spendUsd: z.number().nullable().optional(),
  spendEstimated: z.boolean().optional(),
  access: AccessProfile.optional(),
  requestedAccess: AccessProfile.optional(),
  effectiveAccess: AccessProfile.optional(),
  externalContextPolicy: ExternalContextPolicy.optional(),
  webRequired: z.boolean().optional(),
  webMode: ExternalContextPolicy.optional(),
  webEvidence: ControlWebEvidence.default({}),
  toolPermissionPolicy: z.record(z.string(), z.unknown()).optional(),
  outputReadyState: OutputReadyState.default("pending"),
  /** Non-blocking tool warnings projected from final/telemetry.yaml. */
  toolWarningsTotal: z.number().int().nonnegative().default(0),
  /** Honest terminal outcome (what the turn did): patch/answer/plan/report/none. */
  result: ControlRunResult.default({}),
  /** True while at least one interaction.requested has no answered/timeout. */
  waitingOnUser: z.boolean().default(false),
  /** Route evidence from telemetry; null when no telemetry exists (legacy). */
  route: ControlRouteInfo.nullable().default(null),
  tests: z.array(z.string()).optional(),
  specId: z.string().optional(),
  specHash: ContentHash.optional(),
  createdAt: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
});
export type ControlRunSummary = z.infer<typeof ControlRunSummary>;

export const ControlPrimaryOutput = z.object({
  kind: z.enum(["answer", "report", "plan", "summary", "patch", "diagnostic"]),
  path: z.string(),
  text: z.string().nullable().default(null),
  bytes: z.number().int().nonnegative().optional(),
});
export type ControlPrimaryOutput = z.infer<typeof ControlPrimaryOutput>;

export const ControlTimelineEvent = z.object({
  type: z.string(),
  ts: z.string().optional(),
  harnessId: z.string().nullable().default(null),
  attemptId: z.string().nullable().default(null),
  title: z.string(),
  detail: z.string().nullable().default(null),
  severity: z.enum(["info", "warning", "error"]).default("info"),
  toolName: z.string().nullable().default(null),
  target: z.string().nullable().default(null),
  errorSummary: z.string().nullable().default(null),
  rawRef: z.string().nullable().default(null),
});
export type ControlTimelineEvent = z.infer<typeof ControlTimelineEvent>;

export const ControlBudgetSnapshot = z.object({
  maxUsd: z.number().nullable().default(null),
  spendUsd: z.number().nullable().default(null),
  remainingUsd: z.number().nullable().default(null),
  estimated: z.boolean().default(false),
  source: z.enum(["decision", "events", "settings", "unknown"]).default("unknown"),
});
export type ControlBudgetSnapshot = z.infer<typeof ControlBudgetSnapshot>;

export const ControlArtifactInfo = z.object({
  path: z.string(),
  kind: z.enum(["file", "directory"]),
  bytes: z.number().int().nonnegative().optional(),
  /** Clean MIME type derived from the extension (e.g. `image/png`, `text/plain`,
   *  `application/pdf`); lets a gallery render text vs image vs pdf. Absent for
   *  directories. */
  mime: z.string().optional(),
});
export type ControlArtifactInfo = z.infer<typeof ControlArtifactInfo>;

/** A live interaction awaiting the user's answer (snapshot projection). */
export const ControlPendingInteraction = z.object({
  interactionId: Id,
  runId: Id,
  attemptId: z.string().nullable().default(null),
  harnessId: z.string().nullable().default(null),
  sourceTool: z.string().nullable().default(null),
  questions: z.array(InteractionQuestion).default([]),
  requestedAt: z.string(),
  timeoutAt: z.string().nullable().default(null),
});
export type ControlPendingInteraction = z.infer<typeof ControlPendingInteraction>;

export const ControlInteractionAnswerRequest = z
  .object({
    answers: z
      .array(
        z
          .object({
            questionId: Id,
            selectedLabels: z.array(z.string()).default([]),
            freeText: z.string().nullable().default(null),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type ControlInteractionAnswerRequest = z.infer<typeof ControlInteractionAnswerRequest>;

export const ControlInteractionAnswerResponse = z.object({
  accepted: z.boolean(),
  status: z.enum(["delivered", "not_found", "already_resolved", "rejected"]),
  message: z.string().optional(),
});
export type ControlInteractionAnswerResponse = z.infer<typeof ControlInteractionAnswerResponse>;

export const ControlRunDetail = z.object({
  summary: ControlRunSummary,
  /**
   * Highest event seq included in this snapshot. Clients subscribe to the
   * event stream from this cursor; events with seq <= lastSeq are already
   * reflected in the snapshot (snapshot-then-subscribe, no gaps, no dupes).
   */
  lastSeq: z.number().int().nonnegative().default(0),
  artifacts: z.array(ControlArtifactInfo).default([]),
  primaryOutput: ControlPrimaryOutput.nullable().default(null),
  timeline: z.array(ControlTimelineEvent).default([]),
  budget: ControlBudgetSnapshot.default({}),
  finalSummary: z.string().nullable().default(null),
  decision: DecisionRecord.nullable().default(null),
  /** Persisted operator unblock decision (accept_risk/override), hash-bound; server-owned apply affordance. */
  operatorDecision: z
    .object({ action: z.string(), decidedAt: z.string().nullable().default(null) })
    .nullable()
    .default(null),
  workProduct: WorkProduct.nullable().default(null),
  reviewFindings: z.array(ReviewFinding).default([]),
  pendingInteractions: z.array(ControlPendingInteraction).default([]),
  /** Typed executor progress for an orchestrate run (auto_safe/auto_full);
   * null for non-orchestrate runs or suggest autonomy. Projected from
   * final/orchestration_progress.yaml. */
  orchestrate: OrchestratePlanProgress.nullable().default(null),
  failure: RunFailure.nullable().default(null),
});
export type ControlRunDetail = z.infer<typeof ControlRunDetail>;

export const RunControlTarget = z.object({
  attemptId: z.string().optional(),
  harnessId: z.string().optional(),
  sessionId: z.string().optional(),
  requestId: z.string().optional(),
});
export type RunControlTarget = z.infer<typeof RunControlTarget>;

export const RunControl = z.object({
  kind: z.enum(["cancel", "interrupt"]),
  target: RunControlTarget.default({}),
  reason: z.string().optional(),
});
export type RunControl = z.infer<typeof RunControl>;

export const ControlRunControlRequest = z.object({
  control: RunControl,
});
export type ControlRunControlRequest = z.infer<typeof ControlRunControlRequest>;

export const ControlRunControlResponse = z.object({
  accepted: z.boolean(),
  status: z.enum(["applied", "queued", "rejected", "unsupported"]).default("queued"),
  runId: Id.optional(),
  message: z.string().optional(),
});
export type ControlRunControlResponse = z.infer<typeof ControlRunControlResponse>;

export const ApplyTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("original_project") }).strict(),
  z.object({ kind: z.literal("project"), root: z.string() }).strict(),
]);
export type ApplyTarget = z.infer<typeof ApplyTarget>;

export const ControlApplyCheckRequest = z
  .object({
    target: ApplyTarget.default({ kind: "original_project" }),
  })
  .strict();
export type ControlApplyCheckRequest = z.infer<typeof ControlApplyCheckRequest>;

export const ControlApplyRequest = z
  .object({
    target: ApplyTarget.default({ kind: "original_project" }),
    mode: z.enum(["artifact_only", "apply", "branch", "commit", "pr"]).default("apply"),
    branch: z.string().optional(),
    message: z.string().optional(),
  })
  .strict();
export type ControlApplyRequest = z.infer<typeof ControlApplyRequest>;

/**
 * Operator decision on a NEEDS_HUMAN-blocked run (review_actions). Closes the
 * v0.8 "apply: human_review" dead end: a typed, auditable unblock path instead
 * of a read-only review queue.
 */
export const RunDecisionAction = z.enum([
  "accept_clean_patch",
  "rerun_with_feedback",
  "accept_risk",
  "override_needs_human",
  /** Restore the live in-place tree to this turn's pre-turn snapshot (server-owned;
   * refuses if the tree has diverged from the recorded post-turn state). */
  "revert_run",
]);
export type RunDecisionAction = z.infer<typeof RunDecisionAction>;

export const ControlRunDecisionRequest = z
  .object({
    action: RunDecisionAction,
    /** Findings the decision targets (override/accept_risk). */
    findingIds: z.array(Id).default([]),
    /** Reviewer feedback to seed a rerun turn. */
    feedback: z.string().optional(),
    /** Risk reasons being explicitly accepted (recorded, never silent). */
    acceptedRisks: z.array(z.string()).default([]),
    /** Apply mode + target for accept_clean_patch. */
    applyMode: z.enum(["artifact_only", "apply", "branch", "commit", "pr"]).optional(),
    target: ApplyTarget.optional(),
  })
  .strict();
export type ControlRunDecisionRequest = z.infer<typeof ControlRunDecisionRequest>;

export const ControlRunDecisionResponse = z.object({
  accepted: z.boolean(),
  status: z.enum(["applied", "requeued", "rejected", "unsupported"]),
  /** New run id when the decision re-enqueues a turn (rerun_with_feedback). */
  newRunId: Id.optional(),
  message: z.string().optional(),
});
export type ControlRunDecisionResponse = z.infer<typeof ControlRunDecisionResponse>;

/* ---- Threads / Sessions (A2 chat/session-first; camelCase control projections) ---- */

export const ControlThread = z.object({
  id: Id,
  title: z.string().nullable().default(null),
  repoRoot: z.string().nullable().default(null),
  mode: ModeKind.optional(),
  /** How turns touch files (in-place live tree vs isolated worktree). */
  workspaceMode: WorkspaceMode.default("in_place"),
  authPreference: AuthPreference.default("auto"),
  primaryHarness: z.string().nullable().default(null),
  /** Sticky eligible pool for the thread (empty => engine auto-pools). */
  eligibleHarnesses: z.array(z.string()).default([]),
  state: ThreadState.default("active"),
  runIds: z.array(Id).default([]),
  headRunId: Id.nullable().default(null),
  /** True when the head turn is blocked on a human decision (needs-me inbox). */
  needsHuman: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ControlThread = z.infer<typeof ControlThread>;

export const ControlSession = z.object({
  id: Id,
  threadId: Id,
  harnessId: Id,
  nativeSessionId: z.string().nullable().default(null),
  observedModel: z.string().nullable().default(null),
  state: z.enum(["live", "stale", "rebound"]).default("live"),
});
export type ControlSession = z.infer<typeof ControlSession>;

/**
 * Compact run state embedded on a turn so a chat surface renders the whole
 * conversation from one GET /threads/:id (no N+1 run-detail fetch per turn).
 */
export const ControlTurnRunCard = z.object({
  state: ControlRunState,
  mode: ModeKind.optional(),
  strategy: z.enum(["race", "attempts", "until_clean", "swarm", "create"]).nullable().optional(),
  n: z.number().int().optional(),
  result: ControlRunResult.default({}),
  spendUsd: z.number().nullable().optional(),
  outputReadyState: OutputReadyState.default("pending"),
  waitingOnUser: z.boolean().default(false),
  finishedAt: z.string().nullable().default(null),
});
export type ControlTurnRunCard = z.infer<typeof ControlTurnRunCard>;

export const ControlThreadTurn = z.object({
  id: Id,
  threadId: Id,
  runId: Id.nullable().default(null),
  parentRunId: Id.nullable().default(null),
  /** Set when this turn implements an approved plan from an earlier run. */
  planRunId: Id.nullable().default(null),
  kind: ThreadTurnKind.default("followup"),
  prompt: z.string().default(""),
  /** Embedded run card (outcome/state) so the chat renders without N+1 fetches. */
  run: ControlTurnRunCard.nullable().default(null),
  createdAt: z.string(),
});
export type ControlThreadTurn = z.infer<typeof ControlThreadTurn>;

export const ControlThreadCreateRequest = z
  .object({
    title: z.string().optional(),
    scope: RunScope.default({ kind: "none" }),
    mode: ModeKind.optional(),
    workspace: WorkspaceMode.optional(),
    authPreference: AuthPreference.optional(),
    primaryHarness: NonBlankString.optional(),
    /** Sticky eligible pool for the thread; turns inherit it when unset. */
    eligibleHarnesses: z.array(NonBlankString).optional(),
  })
  .strict();
export type ControlThreadCreateRequest = z.infer<typeof ControlThreadCreateRequest>;

/** Mutate a thread's title, open/closed state, or sticky routing (rename,
 * archive, switch primary/pool). primaryHarness nullable => clear back to auto. */
export const ControlThreadUpdateRequest = z
  .object({
    title: z.string().optional(),
    state: ThreadState.optional(),
    primaryHarness: NonBlankString.nullable().optional(),
    eligibleHarnesses: z.array(NonBlankString).optional(),
  })
  .strict();
export type ControlThreadUpdateRequest = z.infer<typeof ControlThreadUpdateRequest>;

/** Apply an isolated thread's accumulated worktree diff to the project. */
export const ControlThreadApplyRequest = z
  .object({
    mode: z.enum(["apply", "branch", "commit", "pr"]).default("apply"),
    branch: z.string().optional(),
    message: z.string().optional(),
  })
  .strict();
export type ControlThreadApplyRequest = z.infer<typeof ControlThreadApplyRequest>;

export const ControlThreadApplyResponse = z.object({
  applied: z.boolean(),
  status: z.enum([
    "applied",
    "branched",
    "committed",
    "pr_opened",
    "empty",
    "conflict",
    "rejected",
  ]),
  /** True when the project HEAD moved past the thread base since the thread started. */
  headMoved: z.boolean().default(false),
  detail: z.string().nullable().default(null),
});
export type ControlThreadApplyResponse = z.infer<typeof ControlThreadApplyResponse>;

export const ControlThreadListResponse = z.object({
  threads: z.array(ControlThread).default([]),
});
export type ControlThreadListResponse = z.infer<typeof ControlThreadListResponse>;

export const ControlThreadDetail = z.object({
  thread: ControlThread,
  sessions: z.array(ControlSession).default([]),
  turns: z.array(ControlThreadTurn).default([]),
});
export type ControlThreadDetail = z.infer<typeof ControlThreadDetail>;

export const HarnessStatusDto = z.object({
  id: z.string(),
  status: AdapterStatus,
  manifest: HarnessManifest.nullable().optional(),
  enabledIntents: z.array(z.string()).default([]),
  disabledIntents: z.array(z.string()).default([]),
  checks: z.array(ConformanceCheck).default([]),
  reasons: z.array(z.string()).default([]),
  /** The user's configured per-harness default model, if any. */
  configuredModel: z.string().nullable().default(null),
  /** Strict truth-source check of `configuredModel` (D3): null when no model
   * is configured; a rejection carries the actionable message so UIs render
   * the same honesty `claudexor doctor` prints. */
  configuredModelCheck: z
    .object({
      status: z.enum(["ok", "rejected"]),
      message: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
});
export type HarnessStatusDto = z.infer<typeof HarnessStatusDto>;

export const ControlHarnessListResponse = z.object({
  harnesses: z.array(HarnessStatusDto).default([]),
});
export type ControlHarnessListResponse = z.infer<typeof ControlHarnessListResponse>;

/**
 * Models enumerable for one harness. `source` is honest about provenance:
 * "api" when the adapter implemented a real enumeration (raw-api / OpenAI
 * `GET /v1/models`), "manifest" when the list is the manifest's known-good
 * hint set, "none" when the harness has no model truth source at all (the
 * list is then empty and explicit models are refused under strict D3).
 */
export const ControlHarnessModelsResponse = z.object({
  harnessId: z.string(),
  models: z.array(HarnessModel).default([]),
  source: z.enum(["api", "manifest", "none"]),
  /** Freshness note for manifest-sourced lists: the vendor CLI version the
   * known-model hints were last verified against (null for api/none). */
  verifiedAgainst: z.string().nullable().default(null),
});
export type ControlHarnessModelsResponse = z.infer<typeof ControlHarnessModelsResponse>;

export const ControlSettingsSnapshot = z.object({
  sources: z.array(z.string()).default([]),
  defaultPortfolio: Portfolio.default("subscription-first"),
  /** How long a run waits for an interactive answer before a benign decline. */
  interactionTimeoutMs: z.number().int().positive().default(900_000),
  routing: z
    .object({
      defaultPolicy: z.enum(["auto", "primary", "portfolio"]).default("auto"),
      primaryHarness: z.string().nullable().default(null),
      eligibleHarnesses: z.array(z.string()).default([]),
      envInheritance: z.enum(["mirror_native", "clean"]).default("mirror_native"),
      authPreference: AuthPreference.default("auto"),
    })
    .default({}),
  budget: z
    .object({
      maxUsdPerRun: z.number().nullable().default(null),
    })
    .default({}),
  runtime: z
    .object({
      reviewerTimeoutMs: z.number().int().positive().default(600_000),
      transientRetry: z
        .object({
          maxRetries: z.number().int().nonnegative().default(2),
          initialDelayMs: z.number().int().nonnegative().default(1_000),
          maxDelayMs: z.number().int().nonnegative().default(10_000),
        })
        .default({}),
    })
    .default({}),
  harnesses: z
    .record(
      z.string(),
      z.object({
        enabled: z.boolean().default(true),
        defaultModel: z.string().nullable().default(null),
        effort: EffortHint.nullable().default(null),
        maxTurns: z.number().int().positive().nullable().default(null),
        maxRounds: z.number().int().positive().nullable().default(null),
        maxUsd: z.number().nonnegative().nullable().default(null),
        toolsAllow: z.array(z.string()).default([]),
        toolsDeny: z.array(z.string()).default([]),
        fallbackModel: z.string().nullable().default(null),
        web: ExternalContextPolicy.default("auto"),
        authPreference: AuthPreference.default("auto"),
      }),
    )
    .default({}),
});
export type ControlSettingsSnapshot = z.infer<typeof ControlSettingsSnapshot>;

/**
 * Partial per-harness settings patch; absent fields keep their stored value.
 * STRICT: a typoed key must 400, not silently no-op (fail-loudly contract).
 */
export const ControlHarnessSettingsPatch = z
  .object({
    enabled: z.boolean().optional(),
    defaultModel: NonBlankString.nullable().optional(),
    effort: EffortHint.nullable().optional(),
    maxTurns: z.number().int().positive().nullable().optional(),
    maxRounds: z.number().int().positive().nullable().optional(),
    maxUsd: z.number().nonnegative().nullable().optional(),
    toolsAllow: z.array(NonBlankString).optional(),
    toolsDeny: z.array(NonBlankString).optional(),
    fallbackModel: NonBlankString.nullable().optional(),
    web: ExternalContextPolicy.optional(),
    authPreference: AuthPreference.optional(),
  })
  .strict();
export type ControlHarnessSettingsPatch = z.infer<typeof ControlHarnessSettingsPatch>;

export const ControlSettingsUpdateRequest = z
  .object({
    defaultPortfolio: Portfolio.optional(),
    interactionTimeoutMs: z.number().int().positive().optional(),
    routingPolicy: z.enum(["auto", "primary", "portfolio"]).optional(),
    primaryHarness: NonBlankString.nullable().optional(),
    eligibleHarnesses: z.array(NonBlankString).optional(),
    envInheritance: z.enum(["mirror_native", "clean"]).optional(),
    maxUsdPerRun: z.number().nonnegative().optional(),
    clearMaxUsdPerRun: z.boolean().optional(),
    authPreference: AuthPreference.optional(),
    harnesses: z.record(NonBlankString, ControlHarnessSettingsPatch).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.maxUsdPerRun !== undefined && value.clearMaxUsdPerRun === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxUsdPerRun"],
        message: "maxUsdPerRun and clearMaxUsdPerRun are mutually exclusive",
      });
    }
  });
export type ControlSettingsUpdateRequest = z.infer<typeof ControlSettingsUpdateRequest>;

/** Secret list row: exactly what the store's list() can honestly produce
 * (the never-populated harnesses/env/description fields were retired in the
 * v0.15 triage). */
export const SecretMetadata = z.object({
  name: z.string(),
  backend: z.enum(["keychain", "file"]),
  present: z.boolean().default(true),
});
export type SecretMetadata = z.infer<typeof SecretMetadata>;

export const ControlSecretListResponse = z.object({
  backend: z.enum(["keychain", "file"]),
  secrets: z.array(SecretMetadata).default([]),
});
export type ControlSecretListResponse = z.infer<typeof ControlSecretListResponse>;
