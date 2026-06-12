import { z } from "zod";
import {
  AccessProfile,
  AuthPreference,
  ContentHash,
  ExternalContextPolicy,
  Id,
  ModeKind,
  OutputReadyState,
  ProviderFamily,
} from "./primitives.js";
import { AuthMode, Portfolio } from "./budget.js";
import { FallbackMode } from "./config.js";
import { AdapterStatus, ConformanceCheck, EffortHint, HarnessManifest, InteractionQuestion } from "./harness.js";
import { DecisionRecord } from "./decision.js";
import { WorkProduct } from "./workproduct.js";
import { ReviewFinding } from "./review.js";
import { ThreadState, ThreadTurnKind } from "./thread.js";

export const RunScopeContext = z.enum(["auto", "deep"]);
export type RunScopeContext = z.infer<typeof RunScopeContext>;

export const RunScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), root: z.string(), context: RunScopeContext.default("auto") }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);
export type RunScope = z.infer<typeof RunScope>;

export const RunExecution = z
  .object({
    isolation: z.enum(["envelope", "live"]).default("envelope"),
  })
  .strict();
export type RunExecution = z.infer<typeof RunExecution>;

export const ControlRunStartRequest = z
  .object({
    prompt: z.string().default(""),
    mode: ModeKind.default("agent"),
    scope: RunScope.default({ kind: "none" }),
    execution: RunExecution.default({ isolation: "envelope" }),
    harnesses: z.array(z.string()).optional(),
    primaryHarness: z.string().optional(),
    portfolio: Portfolio.optional(),
    model: z.string().optional(),
    effort: EffortHint.optional(),
    reviewerModels: z.record(z.string(), z.string()).optional(),
    reviewerEfforts: z.record(ProviderFamily, EffortHint).optional(),
    n: z.number().int().positive().optional(),
    attempts: z.number().int().positive().nullable().optional(),
    /** agent flag: iterate until the convergence predicate is clean (no fixed cap). */
    untilClean: z.boolean().optional(),
    /** audit flag: bounded read-only research swarm (the old `explore`). */
    swarm: z.boolean().optional(),
    /** agent flag: create-from-scratch intent (the old `create` mode). */
    create: z.boolean().optional(),
    maxUsd: z.number().nonnegative().nullable().optional(),
    /** Requested access profile. Effective access is derived by the engine and never client-supplied. */
    access: AccessProfile.optional(),
    web: ExternalContextPolicy.optional(),
    externalContextPolicy: ExternalContextPolicy.optional(),
    tests: z.array(z.string()).optional(),
    envProfile: z.string().optional(),
    specPath: z.string().optional(),
    specId: z.string().optional(),
    specHash: ContentHash.optional(),
    /** Thread/session linkage (A2): a run is a turn inside a thread. */
    threadId: Id.optional(),
    parentRunId: Id.optional(),
    sessionId: Id.optional(),
    /** Re-host the thread onto the routed harness (serialize + session.rebound). */
    rehost: z.boolean().optional(),
    /** Per-run auth route override (subscription/api_key/auto). */
    authPreference: AuthPreference.optional(),
  })
  .strict();
export type ControlRunStartRequest = z.infer<typeof ControlRunStartRequest>;

export const ControlHarnessSetupAction = z.enum(["install_guide", "install", "login", "doctor"]);
export type ControlHarnessSetupAction = z.infer<typeof ControlHarnessSetupAction>;
export const ControlHarnessSetupHarness = z.enum(["codex", "claude", "cursor", "opencode", "raw"]);
export type ControlHarnessSetupHarness = z.infer<typeof ControlHarnessSetupHarness>;

export const ControlHarnessSetupRequest = z.object({
  harness: ControlHarnessSetupHarness,
  action: ControlHarnessSetupAction.default("login"),
}).strict();
export type ControlHarnessSetupRequest = z.infer<typeof ControlHarnessSetupRequest>;

export const ControlHarnessSetupResponse = z.object({
  harness: ControlHarnessSetupHarness,
  action: ControlHarnessSetupAction,
  status: z.enum(["prepared", "not_supported"]),
  command: z.string().nullable().default(null),
  guideUrl: z.string().url().nullable().default(null),
  logPath: z.string().nullable().default(null),
  message: z.string(),
});
export type ControlHarnessSetupResponse = z.infer<typeof ControlHarnessSetupResponse>;

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
    kind: z.enum(["status", "log", "end"]),
    state: ControlSetupJobState.optional(),
    message: z.string(),
  })
  .strict();
export type ControlSetupJobEvent = z.infer<typeof ControlSetupJobEvent>;

export const ControlSetupJobListResponse = z.object({
  jobs: z.array(ControlSetupJob),
});
export type ControlSetupJobListResponse = z.infer<typeof ControlSetupJobListResponse>;

export const ControlSetupJobConfirmRequest = z.object({
  confirmed: z.boolean().default(true),
}).strict();
export type ControlSetupJobConfirmRequest = z.infer<typeof ControlSetupJobConfirmRequest>;

export const ControlSpecQuestionsRequest = z
  .object({
    prompt: z.string(),
    scope: z.object({ kind: z.literal("project"), root: z.string() }).strict(),
    harnesses: z.array(z.string()).optional(),
  })
  .strict();
export type ControlSpecQuestionsRequest = z.infer<typeof ControlSpecQuestionsRequest>;

export const ControlSpecFreezeRequest = z
  .object({
    prompt: z.string(),
    scope: z.object({ kind: z.literal("project"), root: z.string() }).strict(),
    planDir: z.string().optional(),
    plan: z.string().optional(),
    answers: z.array(z.unknown()).optional(),
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
  context: z.enum(["off", "auto", "deep"]).default("off"),
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
  prompt: z.string().optional(),
  harnesses: z.array(z.string()).optional(),
  primaryHarness: z.string().optional(),
  portfolio: Portfolio.optional(),
  model: z.string().optional(),
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
  nativeQuota: z
    .array(z.object({
      provider: z.string(),
      label: z.string(),
      remaining: z.string().nullable().default(null),
      resetsAt: z.string().nullable().default(null),
      source: z.string(),
    }))
    .default([]),
});
export type ControlBudgetSnapshot = z.infer<typeof ControlBudgetSnapshot>;

export const ControlArtifactInfo = z.object({
  path: z.string(),
  kind: z.enum(["file", "directory"]),
  bytes: z.number().int().nonnegative().optional(),
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
  workProduct: WorkProduct.nullable().default(null),
  reviewFindings: z.array(ReviewFinding).default([]),
  pendingInteractions: z.array(ControlPendingInteraction).default([]),
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
  idempotencyKey: z.string().optional(),
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
  authPreference: AuthPreference.default("auto"),
  primaryHarness: z.string().nullable().default(null),
  portfolio: Portfolio.optional(),
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
  providerFamily: ProviderFamily.default("unknown"),
  nativeSessionId: z.string().nullable().default(null),
  observedModel: z.string().nullable().default(null),
  authMode: AuthMode.default("unknown"),
  state: z.enum(["live", "stale", "rebound"]).default("live"),
  turnCount: z.number().int().nonnegative().default(0),
});
export type ControlSession = z.infer<typeof ControlSession>;

export const ControlThreadTurn = z.object({
  id: Id,
  threadId: Id,
  runId: Id.nullable().default(null),
  parentRunId: Id.nullable().default(null),
  sessionId: Id.nullable().default(null),
  kind: ThreadTurnKind.default("followup"),
  prompt: z.string().default(""),
  state: z.string().optional(),
  createdAt: z.string(),
});
export type ControlThreadTurn = z.infer<typeof ControlThreadTurn>;

export const ControlThreadCreateRequest = z
  .object({
    title: z.string().optional(),
    scope: RunScope.default({ kind: "none" }),
    mode: ModeKind.optional(),
    authPreference: AuthPreference.optional(),
    primaryHarness: z.string().optional(),
  })
  .strict();
export type ControlThreadCreateRequest = z.infer<typeof ControlThreadCreateRequest>;

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
});
export type HarnessStatusDto = z.infer<typeof HarnessStatusDto>;

export const ControlHarnessListResponse = z.object({
  harnesses: z.array(HarnessStatusDto).default([]),
});
export type ControlHarnessListResponse = z.infer<typeof ControlHarnessListResponse>;

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
      defaultModel: z.string().nullable().default(null),
      envInheritance: z.enum(["mirror_native", "clean", "profile_only"]).default("mirror_native"),
      authPreference: AuthPreference.default("auto"),
      fallback: z
        .object({
          onQuotaExhaustion: FallbackMode.default("both"),
          onMoneyExhaustion: FallbackMode.default("both"),
        })
        .default({}),
    })
    .default({}),
  budget: z
    .object({
      maxUsdPerRun: z.number().nullable().default(null),
      maxUsdPerDay: z.number().nullable().default(null),
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
        nativeOptions: z.record(z.string(), z.unknown()).default({}),
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
    defaultModel: z.string().nullable().optional(),
    effort: EffortHint.nullable().optional(),
    maxTurns: z.number().int().positive().nullable().optional(),
    maxRounds: z.number().int().positive().nullable().optional(),
    maxUsd: z.number().nonnegative().nullable().optional(),
    toolsAllow: z.array(z.string()).optional(),
    toolsDeny: z.array(z.string()).optional(),
    fallbackModel: z.string().nullable().optional(),
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
    primaryHarness: z.string().nullable().optional(),
    defaultModel: z.string().nullable().optional(),
    eligibleHarnesses: z.array(z.string()).optional(),
    envInheritance: z.enum(["mirror_native", "clean", "profile_only"]).optional(),
    maxUsdPerRun: z.number().nonnegative().optional(),
    maxUsdPerDay: z.number().nonnegative().optional(),
    clearMaxUsdPerRun: z.boolean().optional(),
    clearMaxUsdPerDay: z.boolean().optional(),
    authPreference: AuthPreference.optional(),
    fallbackOnQuotaExhaustion: FallbackMode.optional(),
    fallbackOnMoneyExhaustion: FallbackMode.optional(),
    harnesses: z.record(z.string(), ControlHarnessSettingsPatch).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.maxUsdPerRun !== undefined && value.clearMaxUsdPerRun === true) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["maxUsdPerRun"], message: "maxUsdPerRun and clearMaxUsdPerRun are mutually exclusive" });
    }
    if (value.maxUsdPerDay !== undefined && value.clearMaxUsdPerDay === true) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["maxUsdPerDay"], message: "maxUsdPerDay and clearMaxUsdPerDay are mutually exclusive" });
    }
  });
export type ControlSettingsUpdateRequest = z.infer<typeof ControlSettingsUpdateRequest>;

export const SecretMetadata = z.object({
  name: z.string(),
  backend: z.enum(["keychain", "file"]),
  present: z.boolean().default(true),
  harnesses: z.array(z.string()).default([]),
  env: z.string().optional(),
  description: z.string().optional(),
});
export type SecretMetadata = z.infer<typeof SecretMetadata>;

export const ControlSecretListResponse = z.object({
  backend: z.enum(["keychain", "file"]),
  secrets: z.array(SecretMetadata).default([]),
});
export type ControlSecretListResponse = z.infer<typeof ControlSecretListResponse>;
