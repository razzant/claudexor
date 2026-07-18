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
import { AuthMode, PaidBudget, PaidFallback, QualityTierSet, RoutingGoal } from "./budget.js";
export { ControlQuotaResponse } from "./quota.js";
import { AuthRouteReason, AuthSourceKind } from "./auth.js";
import { EffortHint, HarnessModel, InteractionQuestion } from "./harness.js";
import { ThreadState, ThreadTurnKind, WorkspaceMode } from "./thread.js";
import { OrchestrateAutonomy } from "./orchestrate.js";
import { ResourceAttachmentRef } from "./attachment.js";
import { RequestRequirementResolution } from "./request-requirements.js";
import { ProtectedPathApproval, TestCommandInvocation } from "./task.js";
import { RunScope } from "./control-run-scope.js";
import { HarnessStatusDto } from "./readiness.js";
import { makeControlRunRetrySchemas } from "./control-run-retry.js";

export const RunExecution = z
  .object({
    isolation: z
      .enum(["envelope", "live"])
      .default("envelope")
      .describe(
        "Run isolation: envelope (isolated worktree in the external per-project runtime namespace, the default) or live (the project tree itself).",
      ),
  })
  .strict()
  .describe("Execution isolation settings for a run.");
export type RunExecution = z.infer<typeof RunExecution>;

export const ControlReviewerPanelEntry = z
  .object({
    /** Explicit reviewer harness id. Repeated harness ids are allowed so one
     * native provider can review through multiple requested models. */
    harness: NonBlankString.describe(
      "Explicit reviewer harness id; repeated harness ids are allowed so one provider can review through multiple requested models.",
    ),
    /** Optional per-reviewer model hint, passed to that harness only. */
    model: NonBlankString.optional().describe(
      "Per-reviewer model hint, passed to that harness only.",
    ),
    /** Optional per-reviewer effort hint, passed to that harness only. */
    effort: EffortHint.optional().describe(
      "Per-reviewer effort hint, passed to that harness only.",
    ),
  })
  .strict()
  .describe("One reviewer of an explicit reviewer panel.");
export type ControlReviewerPanelEntry = z.infer<typeof ControlReviewerPanelEntry>;

export const ControlRunStartRequest = z
  .object({
    prompt: z.string().default("").describe("The user's prompt for the run."),
    /** Caller-supplied system-level instructions layered onto every
     * task-producing lane (primary, candidate, planner, explorer,
     * orchestrate-planner) — never reviewers, synthesis, or the auth smoke.
     * Scanned by the inline-secret fence like the prompt (INV-062). */
    instructions: z
      .string()
      .optional()
      .describe(
        "System-level instructions layered onto every task-producing lane; delivered natively (append-system-prompt / developer_instructions) or as a delimited prompt prefix.",
      ),
    /** Immutable daemon resource ids; upload/finalize happens before enqueue. */
    attachments: z
      .array(ResourceAttachmentRef)
      .optional()
      .describe(
        "Immutable daemon resource ids returned by upload finalize; paths and inline bytes are not accepted.",
      ),
    mode: ModeKind.default("agent"),
    scope: RunScope.default({ kind: "none" }),
    execution: RunExecution.default({ isolation: "envelope" }),
    harnesses: z
      .array(NonBlankString)
      .optional()
      .describe("Eligible harness pool for the run; omitted = engine auto-pools."),
    primaryHarness: NonBlankString.optional().describe("Primary harness the run should prefer."),
    routingGoal: RoutingGoal.optional(),
    /** Scalar model convenience: expands to the RESOLVED PRIMARY harness only
     * (never the pool). With a multi-harness pool and no primary it is
     * rejected — use `models` instead (INV-103). */
    model: NonBlankString.optional().describe(
      "Scalar model convenience: expands to the resolved primary harness only (never the pool); rejected with a multi-harness pool and no primary — use models instead.",
    ),
    /** Harness-scoped model map (harness id → model id). Specific beats
     * general: an entry here wins over the scalar `model` and over the
     * per-harness settings default. */
    models: z
      .record(NonBlankString, NonBlankString)
      .optional()
      .describe(
        "Harness-scoped model map (harness id to model id); an entry here wins over the scalar model and over the per-harness settings default.",
      ),
    effort: EffortHint.optional().describe("Requested reasoning effort."),
    reviewerModels: z
      .record(ProviderFamily, NonBlankString)
      .optional()
      .describe(
        "Per-provider-family reviewer model overrides (legacy; reviewerPanel wins when present).",
      ),
    reviewerEfforts: z
      .record(ProviderFamily, EffortHint)
      .optional()
      .describe(
        "Per-provider-family reviewer effort overrides (legacy; reviewerPanel wins when present).",
      ),
    n: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Race width: number of best-of-N candidates."),
    attempts: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe("Cap on convergence attempts; null = engine default."),
    /** agent flag: iterate until the convergence predicate is clean (no fixed cap). */
    untilClean: z
      .boolean()
      .optional()
      .describe("Agent flag: iterate until the convergence predicate is clean (no fixed cap)."),
    /** audit flag: bounded read-only research swarm (the old `explore`). */
    swarm: z.boolean().optional().describe("Audit flag: bounded read-only research swarm."),
    /** agent flag: create-from-scratch intent (the old `create` mode). */
    create: z.boolean().optional().describe("Agent flag: create-from-scratch intent."),
    /** Best-of-N synthesis policy. `auto` (default) only synthesizes a 3rd
     * candidate when n>=3 and candidates genuinely complement; `always`/`never`
     * force it. Threaded to the orchestrator's decideSynthesis. */
    synthesis: z
      .enum(["auto", "always", "never"])
      .optional()
      .describe(
        "Best-of-N synthesis policy: auto only synthesizes an extra candidate when n>=3 and candidates genuinely complement; always/never force it.",
      ),
    paidBudget: PaidBudget.optional().describe("Explicit incremental-cash budget for the run."),
    /** Requested access profile. Effective access is derived by the engine and never client-supplied. */
    access: AccessProfile.optional().describe(
      "Requested access profile; effective access is derived by the engine and never client-supplied.",
    ),
    web: ExternalContextPolicy.optional().describe(
      "Web policy for the run (alias of externalContextPolicy; must match when both set).",
    ),
    externalContextPolicy: ExternalContextPolicy.optional().describe(
      "External web/context policy for the run.",
    ),
    /** Opt this run into the agent-driven browser (Playwright MCP). */
    browser: z
      .boolean()
      .optional()
      .describe(
        "Request the agent-driven browser; preflight records per-lane effectiveness and refuses when no selected lane can receive it.",
      ),
    tests: z
      .array(TestCommandInvocation)
      .optional()
      .describe("Typed-argv commands to run as deterministic gates."),
    /** Typed per-run approval for changing auto-protected gate/test paths. This
     * does not bypass built-in critical/security path human gates. */
    protectedPathApprovals: z
      .array(ProtectedPathApproval)
      .optional()
      .describe(
        "Typed per-run approvals for changing auto-protected gate/test paths; does not bypass built-in critical/security path human gates.",
      ),
    specPath: NonBlankString.optional().describe("Path to a frozen SpecPack the run is held to."),
    specId: z.string().optional().describe("Id of the SpecPack the run is held to."),
    specHash: ContentHash.optional().describe("Content hash of the SpecPack the run is held to."),
    /** Thread/session linkage: a run is a turn inside a thread. */
    threadId: Id.optional().describe("Thread this run is a turn of."),
    /** INTERNAL single-writer handoff: control-api pre-creates the turn and
     * passes its id to the daemon runner. REJECTED (400) when supplied by a
     * client on POST /runs — a foreign turnId could rebind another thread's
     * lineage; POST /threads/:id/turns is the public turn surface. */
    turnId: Id.optional().describe(
      "Internal daemon handoff only; rejected (400) when supplied by a client on POST /runs — use POST /threads/:id/turns instead.",
    ),
    parentRunId: Id.optional().describe("Run this turn follows up on."),
    retryOf: Id.optional().describe(
      "Server-owned Exact Retry lineage; direct POST /runs rejects it.",
    ),
    /** When set, this turn implements an approved plan: the engine prefixes the
     * parent plan run's final/plan.md into the prompt (mode is forced to agent). */
    planRunId: Id.optional().describe(
      "Internal daemon handoff only; rejected (400) on POST /runs. When set, the turn implements an approved plan from that run.",
    ),
    /** Explicit reviewer panel. When present it overrides the legacy
     * per-provider-family reviewerModels/reviewerEfforts maps and preserves
     * duplicate harness entries for multi-model same-provider reviews. */
    reviewerPanel: z
      .array(ControlReviewerPanelEntry)
      .min(1)
      .optional()
      .describe(
        "Explicit reviewer panel; overrides the legacy reviewerModels/reviewerEfforts maps and preserves duplicate harness entries for multi-model same-provider reviews.",
      ),
    /** Per-run auth route override (subscription/api_key/auto). */
    authPreference: AuthPreference.optional().describe("Per-run auth route override."),
    /** Explicit per-run credential profile (INV-135); resolved against the
     * durable registry by the engine — an unknown/disabled/mismatched id is a
     * typed refusal, never a silent default. */
    credentialProfileId: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        "Explicit per-run credential profile id; null FORCES the engine-default ladder past a thread-sticky profile; unknown/disabled ids refuse, never default.",
      ),
    /** How much the orchestrate planner may act without confirmation
     * (suggest/auto_safe/auto_full). Only meaningful for mode=orchestrate;
     * consumed by the executor in runOrchestrate. */
    autonomy: OrchestrateAutonomy.optional().describe(
      "Autonomy level for the orchestrate planner; only meaningful for mode=orchestrate.",
    ),
    /** Orchestrate executor: cap on plan tool calls. Only meaningful for
     * mode=orchestrate; consumed by executeOrchestratePlan. */
    maxToolCalls: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Cap on orchestrate plan tool calls; only meaningful for mode=orchestrate."),
    /** Hard wall-clock deadline for the WHOLE run, measured from scheduler
     * start. On expiry the run is cooperatively cancelled (hard-kill fallback)
     * and ends `cancelled` with reason `wall_clock_exceeded`, preserving partial
     * artifacts. Distinct from the inactivity watchdog (per-attempt silence). */
    maxSeconds: z
      .number()
      .int()
      .positive()
      // 7 days. Bounded so `maxSeconds * 1000` never exceeds setTimeout's 32-bit
      // ms ceiling (~24.8 days), where an over-large delay silently wraps to 1ms
      // and cancels the run almost immediately.
      .max(604_800)
      .optional()
      .describe(
        "Hard wall-clock deadline for the whole run (seconds, from scheduler start, max 7 days); on expiry the run is cancelled with reason wall_clock_exceeded and partial artifacts are kept.",
      ),
    /** Per-run globs no candidate may touch at all (create/modify/delete).
     * Envelope/isolated runs only: enforced by the engine's authoritative
     * post-diff policy gate (violation → blocking finding → blocked, patch
     * undelivered); an in-place run with denyPaths is refused at preflight
     * because a live tree cannot guarantee pre-delivery containment. Native
     * per-lane enforcement is disclosed via path_deny receipts (postdiff_only
     * until an adapter supports native deny). accept_risk MAY still deliver a
     * violating patch (INV-111: the human is the final authority). */
    denyPaths: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Per-run globs no candidate may touch at all; envelope-only (in-place runs are refused), enforced by the engine post-diff gate, disclosed per lane via path_deny receipts. accept_risk may still deliver (INV-111).",
      ),
    /** JSON Schema the run's final answer must conform to. MANDATORY when
     * present: a selected lane that cannot natively constrain its output is a
     * typed preflight refusal, never best-effort. The engine validates the
     * winner's answer once, writes final/output.json, and reports a typed
     * conformance receipt (outputConformance); a non-conformant answer ends
     * success-with-warnings so the embedder can retry. Unsupported schema
     * shapes ($ref, non-object root) are refused at the boundary. */
    outputSchema: z
      .record(z.unknown())
      .optional()
      .describe(
        "JSON Schema for the run's final answer; mandatory (incapable lane => preflight refusal), engine-validated into final/output.json with a typed outputConformance receipt.",
      ),
    /** Per-run turn cap; beats per-harness settings, and a lane without native
     * max_turns support discloses the ignored knob instead of dropping it. */
    maxTurns: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Per-run turn cap (beats per-harness settings)."),
  })
  .strict()
  .describe(
    "Request body for POST /runs: prompt, mode, scope, routing, strategy flags, budget, policies, and spec/thread linkage.",
  );
export type ControlRunStartRequest = z.infer<typeof ControlRunStartRequest>;

const RunRetrySchemas = makeControlRunRetrySchemas(ControlRunStartRequest);
export const ControlRunStartInfo = RunRetrySchemas.startInfo;
export type ControlRunStartInfo = z.infer<typeof ControlRunStartInfo>;
export const ControlRunRetryResponse = RunRetrySchemas.response;
export const ControlRunAgainDraft = RunRetrySchemas.draft;

export const ControlRunState = z
  .enum([
    "queued",
    "running",
    "blocked",
    "succeeded",
    "no_op",
    "ungated",
    "review_not_run",
    "failed",
    "cancelled",
    "interrupted_unknown",
    "cost_unverifiable",
    "exhausted_overshoot",
    "exhausted",
    "not_converged",
    "stuck_no_progress",
  ])
  .describe(
    "Control-plane run state: queued/running while live, then an honest success, block, failure, interruption, cost, exhaustion, non-convergence, or cancellation terminal.",
  );
export type ControlRunState = z.infer<typeof ControlRunState>;

export const ControlQueuedRunInfo = z
  .object({
    jobId: z.string().describe("Daemon job id."),
    state: ControlRunState,
    error: z.string().optional().describe("Error message, when the job failed."),
  })
  .describe("Compact state of a queued/running daemon job.");
export type ControlQueuedRunInfo = z.infer<typeof ControlQueuedRunInfo>;

export const RunFailure = z
  .object({
    phase: z.string().default("unknown").describe("Pipeline phase where the failure happened."),
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
      .default("unknown")
      .describe(
        "Typed failure category (validation, project, auth, harness, budget, policy, cancelled, internal, unknown).",
      ),
    harnessId: z
      .string()
      .nullable()
      .default(null)
      .describe("Harness involved in the failure, when known."),
    attemptId: z
      .string()
      .nullable()
      .default(null)
      .describe("Attempt involved in the failure, when known."),
    safeMessage: z.string().describe("Redacted human-readable failure message."),
    rawDetailRef: z
      .string()
      .nullable()
      .default(null)
      .describe("Artifact path holding the raw (redacted) failure detail."),
    logRefs: z
      .array(z.string())
      .default([])
      .describe("Log artifact paths relevant to the failure."),
    eventRefs: z
      .array(z.string())
      .default([])
      .describe("Event references relevant to the failure."),
    runDir: z.string().nullable().default(null).describe("Run artifact directory."),
    nextActions: z.array(z.string()).default([]).describe("Suggested operator next actions."),
  })
  .describe(
    "Typed failure record for a run: phase, category, evidence references, and suggested next actions.",
  );
export type RunFailure = z.infer<typeof RunFailure>;

export const ControlProjectMetadata = z
  .object({
    kind: z
      .enum(["project", "none"])
      .default("none")
      .describe("Whether the run was anchored to a project."),
    root: z.string().nullable().default(null).describe("Project root, when anchored."),
    projectName: z
      .string()
      .nullable()
      .default(null)
      .describe("Project display name, when anchored."),
    context: z
      .enum(["off", "auto"])
      .default("off")
      .describe("Project context depth used for the run."),
  })
  .describe("Project metadata projected onto a run summary.");
export type ControlProjectMetadata = z.infer<typeof ControlProjectMetadata>;

export const ControlWebEvidence = z
  .object({
    required: z.boolean().default(false).describe("Whether the run required web evidence."),
    /** Requested external-context policy for the run. */
    mode: ExternalContextPolicy.default("auto").describe(
      "Requested external-context policy for the run.",
    ),
    /** Mode the selected route actually executed (disclosed upgrades, e.g. claude cached->live). */
    effectiveMode: ExternalContextPolicy.default("auto").describe(
      "Policy the selected route actually executed (disclosed upgrades, e.g. cached to live).",
    ),
    attempted: z.boolean().default(false).describe("Whether any web activity was attempted."),
    satisfied: z
      .boolean()
      .default(false)
      .describe("Whether the web-evidence requirement was satisfied."),
    status: z
      .enum(["none", "attempted", "satisfied", "failed", "unverified"])
      .default("none")
      .describe("Web-evidence verdict for the run."),
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
    errorSummary: z
      .string()
      .nullable()
      .default(null)
      .describe("Redacted error detail when web activity failed."),
    rawDetailRef: z
      .string()
      .nullable()
      .default(null)
      .describe("Artifact path holding the raw (redacted) evidence detail."),
    /** False when the run predates telemetry.yaml; surfaces must render "telemetry unavailable". */
    available: z
      .boolean()
      .default(true)
      .describe(
        'False when the run predates the telemetry artifact; surfaces must render "telemetry unavailable".',
      ),
  })
  .describe("Web evidence projected onto a run summary from the telemetry artifact.");
export type ControlWebEvidence = z.infer<typeof ControlWebEvidence>;

/**
 * Run-level route evidence projected from telemetry (observed model per
 * attempt). `verified` is true only when an observed model was actually
 * reported by the harness stream — never inferred from the request.
 */
export const ControlRouteInfo = z
  .object({
    requestedModel: z.string().nullable().default(null).describe("Model requested for the run."),
    observedModel: z
      .string()
      .nullable()
      .default(null)
      .describe("Model the harness stream actually reported."),
    harnessId: z.string().nullable().default(null).describe("Harness that ran the final attempt."),
    verified: z
      .boolean()
      .default(false)
      .describe(
        "True only when an observed model was actually reported by the harness stream — never inferred from the request.",
      ),
  })
  .describe("Run-level route evidence projected from telemetry (requested vs observed model).");
export type ControlRouteInfo = z.infer<typeof ControlRouteInfo>;

/**
 * Honest terminal outcome of a run, projected from final/work_product.yaml and
 * the presence of final/answer.md. Answers "what did this turn actually do?" so
 * a chat surface never shows a green "succeeded" next to nothing (the v0.9 plan
 * bug): `kind:"plan"` means a plan was produced and NO files changed; `diffStat`
 * is null unless a patch exists; `adopted` is true when the live in-place tree
 * was actually mutated this turn (decoupled from a clean review — see applyState).
 */
export const RunApplyState = z
  .enum([
    /** No in-place mutation happened (envelope-only, plan/answer, or nothing produced). */
    "not_applied",
    /** Winner applied to the live tree AND review converged clean. */
    "applied",
    /** Winner applied to the live tree but review is blocked/unconverged — honest
     * "Applied · review blocked"; the Revert affordance is offered. */
    "applied_review_blocked",
    /** A prior in-place application was reverted to its pre-turn snapshot. */
    "reverted",
  ])
  .describe(
    "Honest application state of a run's changes: not_applied (no in-place mutation), applied (applied and review clean), applied_review_blocked (applied but review blocked/unconverged), or reverted.",
  );
export type RunApplyState = z.infer<typeof RunApplyState>;

export const ControlRunResult = z
  .object({
    kind: z
      .enum(["patch", "answer", "plan", "report", "none"])
      .default("none")
      .describe(
        "What the turn actually produced: a patch, an answer, a plan (no files changed), a report, or nothing.",
      ),
    diffStat: z
      .object({
        files: z.number().int().nonnegative().describe("Files changed."),
        additions: z.number().int().nonnegative().describe("Lines added."),
        deletions: z.number().int().nonnegative().describe("Lines deleted."),
      })
      .nullable()
      .default(null)
      .describe("Diff statistics; null unless a patch exists."),
    blockers: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("Count of accepted blocking review findings."),
    /** True when the live in-place tree was mutated this turn (regardless of review). */
    adopted: z
      .boolean()
      .nullable()
      .default(null)
      .describe(
        "True when the live in-place tree was mutated this turn (regardless of review); null when unknown.",
      ),
    /** Honest application state (decoupled from clean-terminal). */
    applyState: RunApplyState.default("not_applied"),
    preTurnSha: z
      .string()
      .nullable()
      .default(null)
      .describe("Tree SHA before this turn mutated the in-place tree (revert restore target)."),
    postTurnSha: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "Tree SHA right after this turn's mutation; revert refuses if the working tree has diverged from this since.",
      ),
    revertAnchorId: z.string().nullable().default(null).describe("GC-independent revert anchor."),
    /** Revert metadata is available (the turn mutated the live tree in place and
     * an external patch anchor was recorded), so a Revert affordance may be offered.
     * This is NOT a live-safe guarantee: the server re-checks tree divergence at
     * revert time and refuses (fail loud) if the working tree changed since. */
    revertable: z
      .boolean()
      .default(false)
      .describe(
        "Revert metadata is available so a Revert affordance may be offered; not a live-safe guarantee — the server re-checks tree divergence at revert time.",
      ),
  })
  .describe(
    "Honest terminal outcome of a run (what the turn actually did), projected from the work product and answer artifacts.",
  );
export type ControlRunResult = z.infer<typeof ControlRunResult>;

export const ControlRunSummary = z
  .object({
    jobId: z.string().describe("Daemon job id backing the run."),
    runId: z.string().describe("Run id."),
    taskId: z.string().optional().describe("Task id, when allocated."),
    state: ControlRunState,
    runDir: z.string().optional().describe("On-disk run artifact directory."),
    error: z.string().optional().describe("Error message, when the run failed."),
    failure: RunFailure.nullable()
      .default(null)
      .describe("Typed failure record; null unless the run failed."),
    project: ControlProjectMetadata.default({}),
    mode: ModeKind.optional(),
    /** v0.9 engine strategy on the mode (flags, not modes): race width / repair caps / swarm / create. */
    strategy: z
      .enum(["race", "attempts", "until_clean", "swarm", "create"])
      .nullable()
      .optional()
      .describe(
        "Engine strategy flag on the mode (race width / attempt caps / until-clean / swarm / create); flags, not modes.",
      ),
    prompt: z.string().optional().describe("The user's prompt for the run."),
    harnesses: z.array(z.string()).optional().describe("Harness pool the run used."),
    primaryHarness: z.string().optional().describe("Primary harness the run preferred."),
    routingGoal: RoutingGoal.optional(),
    model: z.string().optional().describe("Scalar model requested for the run."),
    reviewerPanel: z
      .array(ControlReviewerPanelEntry)
      .optional()
      .describe("Explicit reviewer panel used for the run."),
    protectedPathApprovals: z
      .array(ProtectedPathApproval)
      .optional()
      .describe("Per-run protected-path approvals supplied."),
    n: z.number().int().optional().describe("Race width, when the run was a race."),
    paidBudget: PaidBudget.optional().describe("Explicit incremental-cash budget for the run."),
    spendUsd: z.number().nullable().optional().describe("Settled cash in USD; null when unknown."),
    spendEstimated: z
      .boolean()
      .optional()
      .describe("True when spend is token-derived rather than natively reported."),
    /** Token usage summed across every attempt (money stays in spendUsd). Each
     * field null until a harness reported it — never render null as 0, and never
     * sum into a grand total (codex cached ⊆ input; claude cached disjoint). */
    inputTokens: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .describe("Input tokens summed across all attempts; null when no harness reported them."),
    outputTokens: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .describe("Output tokens summed across all attempts; null when no harness reported them."),
    cachedInputTokens: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .describe(
        "Cached input tokens summed across all attempts; null when no harness reported them.",
      ),
    /** Typed conformance receipt for a run started with outputSchema: passed =
     * final/output.json conforms; failed = the answer was missing, unparsable,
     * or non-conformant (the run still ends success-with-warnings — the
     * embedder retries). Null when the run had no structured-output contract. */
    outputConformance: z
      .enum(["passed", "failed"])
      .nullable()
      .optional()
      .describe(
        "Structured-output conformance receipt (passed/failed); null when the run had no outputSchema.",
      ),
    /** Auth ROUTE RECEIPT (INV-061 disclosure) projected verbatim from the
     * engine telemetry: requested preference, effective route/source the
     * deciding attempt disclosed, and a deterministic typed reason. Null on
     * runs whose telemetry predates the receipt. */
    authRoute: z
      .object({
        requested: AuthPreference,
        effective: AuthMode.nullable().default(null),
        source: AuthSourceKind.nullable().default(null),
        reason: AuthRouteReason,
        harnessId: z.string().nullable().default(null),
        attemptId: z.string().nullable().default(null),
        /** Requested-vs-observed model mismatch on the deciding attempt; null
         * when they match or either side is unknown. */
        modelMismatch: z
          .object({ requested: z.string(), observed: z.string() })
          .nullable()
          .default(null)
          .describe("Requested-vs-observed model mismatch; null when none."),
      })
      .nullable()
      .optional()
      .describe(
        "Auth route receipt (requested/effective/source/reason + disclosing attempt), projected verbatim from telemetry; null when unavailable.",
      ),
    access: AccessProfile.optional().describe(
      "Access profile of the run: the effective profile when known, else the requested one (prefer requestedAccess/effectiveAccess).",
    ),
    requestedAccess: AccessProfile.optional().describe("Access profile the caller requested."),
    effectiveAccess: AccessProfile.optional().describe(
      "Access profile actually enforced by the engine.",
    ),
    externalContextPolicy: ExternalContextPolicy.optional().describe(
      "Requested web policy for the run.",
    ),
    webRequired: z.boolean().optional().describe("Whether the run required web evidence."),
    webMode: ExternalContextPolicy.optional().describe(
      "Web policy actually executed by the selected route.",
    ),
    webEvidence: ControlWebEvidence.default({}),
    requestRequirements: z
      .array(RequestRequirementResolution)
      .default([])
      .describe(
        "Engine-computed requested/effective capability receipts for selected harness lanes.",
      ),
    toolPermissionPolicy: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Tool allow/deny policy applied to the run."),
    outputReadyState: OutputReadyState.default("pending"),
    /** Non-blocking tool warnings projected from final/telemetry.yaml. */
    toolWarningsTotal: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("Non-blocking tool warnings projected from the telemetry artifact."),
    /** Honest terminal outcome (what the turn did): patch/answer/plan/report/none. */
    result: ControlRunResult.default({}),
    /** True while at least one interaction.requested has no answered/timeout. */
    waitingOnUser: z
      .boolean()
      .default(false)
      .describe("True while at least one interactive question is awaiting the user's answer."),
    /** Route evidence from telemetry; null when no telemetry exists (legacy). */
    route: ControlRouteInfo.nullable()
      .default(null)
      .describe("Route evidence from telemetry; null when no telemetry exists (legacy runs)."),
    tests: z.array(TestCommandInvocation).optional().describe("Typed argv gates."),
    specId: z.string().optional().describe("SpecPack id the run was held to."),
    specHash: ContentHash.optional().describe("Content hash of the SpecPack the run was held to."),
    createdAt: z.string().optional().describe("When the run was created."),
    startedAt: z.string().optional().describe("When the run started."),
    finishedAt: z.string().optional().describe("When the run finished."),
  })
  .describe(
    "Run summary row served by GET /runs and embedded in run detail: state, routing, budget, policies, and honest outcome.",
  );
export type ControlRunSummary = z.infer<typeof ControlRunSummary>;

export const ControlPrimaryOutput = z
  .object({
    kind: z
      .enum(["answer", "report", "plan", "summary", "patch", "diagnostic", "structured_output"])
      .describe(
        "What kind of output this is: answer, report, plan, summary, patch, diagnostic, or structured_output (schema-conformant final/output.json).",
      ),
    path: z.string().describe("Artifact path of the output."),
    text: z.string().nullable().default(null).describe("Inline text content, when loaded."),
    bytes: z.number().int().nonnegative().optional().describe("Size of the output in bytes."),
  })
  .describe("The run's primary user-facing output artifact.");
export type ControlPrimaryOutput = z.infer<typeof ControlPrimaryOutput>;

export const ControlTimelineEvent = z
  .object({
    type: z.string().describe("Run event type."),
    ts: z.string().optional().describe("Event timestamp."),
    harnessId: z.string().nullable().default(null).describe("Harness involved, when any."),
    attemptId: z.string().nullable().default(null).describe("Attempt involved, when any."),
    title: z.string().describe("Human-readable event title."),
    detail: z.string().nullable().default(null).describe("Human-readable event detail."),
    severity: z
      .enum(["info", "warning", "error"])
      .default("info")
      .describe("Display severity of the event."),
    toolName: z.string().nullable().default(null).describe("Tool name for tool events."),
    target: z.string().nullable().default(null).describe("Redacted tool target for tool events."),
    errorSummary: z
      .string()
      .nullable()
      .default(null)
      .describe("Redacted error detail for error events."),
    rawRef: z
      .string()
      .nullable()
      .default(null)
      .describe("Reference to the raw underlying event/artifact."),
  })
  .describe("One projected timeline row of a run for display.");
export type ControlTimelineEvent = z.infer<typeof ControlTimelineEvent>;

export const ControlBudgetSnapshot = z
  .object({
    paidBudget: PaidBudget.default({ kind: "unlimited" }),
    spendUsd: z
      .number()
      .nullable()
      .default(null)
      .describe("CASH spend so far in USD; null when unknown."),
    remainingUsd: z
      .number()
      .nullable()
      .default(null)
      .describe("Remaining budget in USD; null when no cap or unknown spend."),
    estimated: z
      .boolean()
      .default(false)
      .describe("True when spend is token-derived rather than natively reported."),
    source: z
      .enum(["decision", "events", "settings", "unknown"])
      .default("unknown")
      .describe(
        "Where the snapshot came from: the decision record, live events, settings, or unknown.",
      ),
  })
  .describe("Budget snapshot for a run: cap, spend, and provenance.");
export type ControlBudgetSnapshot = z.infer<typeof ControlBudgetSnapshot>;

export const ControlArtifactInfo = z
  .object({
    path: z.string().describe("Artifact path relative to the run directory."),
    kind: z.enum(["file", "directory"]).describe("Whether the artifact is a file or a directory."),
    bytes: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Size in bytes; absent for directories."),
    /** Clean MIME type derived from the extension (e.g. `image/png`, `text/plain`,
     *  `application/pdf`); lets a gallery render text vs image vs pdf. Absent for
     *  directories. */
    mime: z
      .string()
      .optional()
      .describe("MIME type derived from the extension; absent for directories."),
  })
  .describe("One artifact in the run's artifact tree.");
export type ControlArtifactInfo = z.infer<typeof ControlArtifactInfo>;

/** A live interaction awaiting the user's answer (snapshot projection). */
export const ControlPendingInteraction = z
  .object({
    interactionId: Id.describe("Interaction id used to answer."),
    runId: Id.describe("Run the interaction belongs to."),
    attemptId: z
      .string()
      .nullable()
      .default(null)
      .describe("Attempt the interaction was raised in, when known."),
    harnessId: z.string().nullable().default(null).describe("Harness that raised the interaction."),
    sourceTool: z
      .string()
      .nullable()
      .default(null)
      .describe("Native tool that raised the request."),
    questions: z.array(InteractionQuestion).default([]).describe("Questions awaiting answers."),
    requestedAt: z.string().describe("When the interaction was requested."),
    timeoutAt: z
      .string()
      .nullable()
      .default(null)
      .describe("When the interaction times out into a benign decline; null = no timeout."),
  })
  .describe("A live interactive question awaiting the user's answer (snapshot projection).");
export type ControlPendingInteraction = z.infer<typeof ControlPendingInteraction>;

export const ControlInteractionAnswerRequest = z
  .object({
    answers: z
      .array(
        z
          .object({
            questionId: Id.describe("Id of the question being answered."),
            selectedLabels: z
              .array(z.string())
              .default([])
              .describe("Labels of the selected options."),
            freeText: z
              .string()
              .nullable()
              .default(null)
              .describe("Free-text answer; null when only options were selected."),
          })
          .strict(),
      )
      .default([])
      .describe("Answers, one per question."),
  })
  .strict()
  .describe("Request body answering a pending interactive question.");
export type ControlInteractionAnswerRequest = z.infer<typeof ControlInteractionAnswerRequest>;

export const ControlInteractionAnswerResponse = z
  .object({
    accepted: z.boolean().describe("Whether the answer was accepted."),
    status: z
      .enum(["delivered", "not_found", "already_resolved", "rejected"])
      .describe(
        "Delivery outcome: delivered into the live session, interaction not found, already resolved, or rejected.",
      ),
    message: z.string().optional().describe("Human-readable detail."),
  })
  .describe("Response to an interaction answer.");
export type ControlInteractionAnswerResponse = z.infer<typeof ControlInteractionAnswerResponse>;

export const RunControlTarget = z
  .object({
    attemptId: z.string().optional().describe("Attempt to target; omitted = the whole run."),
    harnessId: z.string().optional().describe("Harness to target."),
    sessionId: z.string().optional().describe("Session to target."),
    requestId: z.string().optional().describe("Specific request to target."),
  })
  .describe("Optional narrowing of what a run control verb targets.");
export type RunControlTarget = z.infer<typeof RunControlTarget>;

export const RunControl = z
  .object({
    // `interrupt` was deleted as a fake knob: it mapped to the same daemon
    // cancel (staged-field doctrine — no vocabulary without distinct behavior).
    kind: z.enum(["cancel"]).describe("Control verb: cancel the run."),
    target: RunControlTarget.default({}),
    reason: z.string().optional().describe("Human-readable reason for the control."),
  })
  .describe("A control verb (cancel) aimed at a run or a narrower target inside it.");
export type RunControl = z.infer<typeof RunControl>;

export const ControlRunControlRequest = z
  .object({
    control: RunControl,
  })
  .describe("Request body for POST /runs/:id/control.");
export type ControlRunControlRequest = z.infer<typeof ControlRunControlRequest>;

export const ControlRunControlResponse = z
  .object({
    accepted: z.boolean().describe("Whether the control was accepted."),
    status: z
      .enum(["applied", "queued", "rejected", "unsupported"])
      .default("queued")
      .describe("Outcome: applied immediately, queued, rejected, or unsupported for this run."),
    runId: Id.optional().describe("Run the control was applied to."),
    message: z.string().optional().describe("Human-readable detail."),
  })
  .describe("Response to a run control request.");
export type ControlRunControlResponse = z.infer<typeof ControlRunControlResponse>;

export const ApplyTarget = z
  .discriminatedUnion("kind", [
    z
      .object({ kind: z.literal("original_project") })
      .strict()
      .describe("Apply to the project the run originally came from."),
    z
      .object({
        kind: z.literal("project"),
        root: z.string().describe("Absolute path of the target project root."),
      })
      .strict()
      .describe("Apply to an explicitly named project root."),
  ])
  .describe("Where a work product is delivered: the original project or an explicit project root.");
export type ApplyTarget = z.infer<typeof ApplyTarget>;

export const ControlApplyCheckRequest = z
  .object({
    target: ApplyTarget.default({ kind: "original_project" }),
  })
  .strict()
  .describe("Request body for a dry-run apply check.");
export type ControlApplyCheckRequest = z.infer<typeof ControlApplyCheckRequest>;

export const ControlApplyRequest = z
  .object({
    target: ApplyTarget.default({ kind: "original_project" }),
    mode: z
      .enum(["artifact_only", "apply", "branch", "commit", "pr"])
      .default("apply")
      .describe(
        "Delivery mode: artifact_only (export only), apply to the tree, or as a branch, commit, or PR.",
      ),
    branch: z.string().optional().describe("Branch name for branch/pr modes."),
    message: z.string().optional().describe("Commit message for commit/pr modes."),
  })
  .strict()
  .describe("Request body applying a run's work product to a project.");
export type ControlApplyRequest = z.infer<typeof ControlApplyRequest>;

/**
 * Operator decision on a NEEDS_HUMAN-blocked run (review_actions). Closes the
 * v0.8 "apply: human_review" dead end: a typed, auditable unblock path instead
 * of a read-only review queue.
 */
export const RunDecisionAction = z
  .enum([
    "accept_clean_patch",
    "rerun_with_feedback",
    "accept_risk",
    "override_needs_human",
    /** Restore the live in-place tree to this turn's pre-turn snapshot (server-owned;
     * refuses if the tree has diverged from the recorded post-turn state). */
    "revert_run",
  ])
  .describe(
    "Operator decision on a blocked run: accept_clean_patch (apply it), rerun_with_feedback, accept_risk, override_needs_human, or revert_run (restore the pre-turn snapshot).",
  );
export type RunDecisionAction = z.infer<typeof RunDecisionAction>;

export const ControlRunDecisionRequest = z
  .object({
    action: RunDecisionAction,
    /** Findings the decision targets (override/accept_risk). */
    findingIds: z
      .array(Id)
      .default([])
      .describe("Findings the decision targets (override/accept_risk)."),
    /** Reviewer feedback to seed a rerun turn. */
    feedback: z.string().optional().describe("Reviewer feedback to seed a rerun turn."),
    /** Risk reasons being explicitly accepted (recorded, never silent). */
    acceptedRisks: z
      .array(z.string())
      .default([])
      .describe("Risk reasons being explicitly accepted (recorded, never silent)."),
    /** Apply mode + target for accept_clean_patch. */
    applyMode: z
      .enum(["artifact_only", "apply", "branch", "commit", "pr"])
      .optional()
      .describe("Delivery mode for accept_clean_patch."),
    target: ApplyTarget.optional().describe("Delivery target for accept_clean_patch."),
  })
  .strict()
  .describe("Typed, auditable operator decision on a NEEDS_HUMAN-blocked run.");
export type ControlRunDecisionRequest = z.infer<typeof ControlRunDecisionRequest>;

export const ControlRunDecisionResponse = z
  .object({
    accepted: z.boolean().describe("Whether the decision was accepted."),
    status: z
      .enum(["applied", "requeued", "rejected", "unsupported"])
      .describe("Outcome: applied, requeued (a new turn was enqueued), rejected, or unsupported."),
    /** New run id when the decision re-enqueues a turn (rerun_with_feedback). */
    newRunId: Id.optional().describe(
      "New run id when the decision re-enqueues a turn (rerun_with_feedback).",
    ),
    message: z.string().optional().describe("Human-readable detail."),
  })
  .describe("Response to an operator run decision.");
export type ControlRunDecisionResponse = z.infer<typeof ControlRunDecisionResponse>;

/* ---- Threads / Sessions (chat/session-first; camelCase control projections) ---- */

export const ControlThread = z
  .object({
    id: Id.describe("Thread id."),
    title: z.string().nullable().default(null).describe("Thread title; null until set."),
    repoRoot: z
      .string()
      .nullable()
      .default(null)
      .describe("Project root the thread is anchored to; null for a no-project thread."),
    mode: ModeKind.optional().describe("Default mode for new turns."),
    /** How turns touch files (in-place live tree vs isolated worktree). */
    workspaceMode: WorkspaceMode.default("in_place"),
    authPreference: AuthPreference.default("auto"),
    primaryHarness: z
      .string()
      .nullable()
      .default(null)
      .describe("Sticky primary harness for the thread; null = engine routing."),
    /** Sticky eligible pool for the thread (empty => engine auto-pools). */
    eligibleHarnesses: z
      .array(z.string())
      .default([])
      .describe("Sticky eligible harness pool; empty = the engine auto-pools."),
    /** Sticky credential profile (INV-135): clients can SET it via
     * create/PATCH, so the projection must report it back (round-15 #3). */
    credentialProfileId: Id.nullable()
      .default(null)
      .describe(
        "Sticky credential profile for the thread; per-turn selection wins, null = engine-default credentials.",
      ),
    state: ThreadState.default("active"),
    trashedAt: z.string().nullable().default(null).describe("When the thread entered trash."),
    purgeAfter: z.string().nullable().default(null).describe("When trash retention expires."),
    runIds: z.array(Id).default([]).describe("Ordered run lineage of the thread."),
    headRunId: Id.nullable()
      .default(null)
      .describe("Most recent run of the thread; null before the first turn runs."),
    /** True when the head turn is blocked on a human decision (needs-me inbox). */
    needsHuman: z
      .boolean()
      .default(false)
      .describe("True when the head turn is blocked on a human decision (needs-me inbox)."),
    createdAt: z.string().describe("When the thread was created."),
    updatedAt: z.string().describe("When the thread was last updated."),
  })
  .describe("Control-plane projection of a thread (camelCase view of the Thread artifact).");
export type ControlThread = z.infer<typeof ControlThread>;

export const ControlSession = z
  .object({
    id: Id.describe("Session id."),
    threadId: Id.describe("Thread the session belongs to."),
    harnessId: Id.describe("Harness the session is bound to."),
    nativeSessionId: z
      .string()
      .nullable()
      .default(null)
      .describe("The vendor CLI session id; null when none exists."),
    observedModel: z
      .string()
      .nullable()
      .default(null)
      .describe("Model last observed on the session's stream."),
    /** Credential profile the vendor session was created under (INV-135):
     * resume never crosses profiles, so clients must be able to SEE the
     * binding they are subject to (round-15 #3). */
    profileId: Id.nullable()
      .default(null)
      .describe(
        "Credential profile the vendor session was created under; resume never crosses profiles (null = engine-default credentials).",
      ),
    state: z
      .enum(["live", "stale", "rebound"])
      .default("live")
      .describe("Session cache state: live, stale, or rebound."),
  })
  .describe("Control-plane projection of a vendor CLI session bound to a thread.");
export type ControlSession = z.infer<typeof ControlSession>;

/**
 * Compact run state embedded on a turn so a chat surface renders the whole
 * conversation from one GET /threads/:id (no N+1 run-detail fetch per turn).
 */
export const ControlTurnRunCard = z
  .object({
    state: ControlRunState,
    mode: ModeKind.optional(),
    strategy: z
      .enum(["race", "attempts", "until_clean", "swarm", "create"])
      .nullable()
      .optional()
      .describe("Engine strategy flag on the mode, when any."),
    n: z.number().int().optional().describe("Race width, when the run was a race."),
    result: ControlRunResult.default({}),
    spendUsd: z.number().nullable().optional().describe("Settled cash in USD; null when unknown."),
    outputReadyState: OutputReadyState.default("pending"),
    waitingOnUser: z
      .boolean()
      .default(false)
      .describe("True while an interactive question is awaiting the user's answer."),
    finishedAt: z
      .string()
      .nullable()
      .default(null)
      .describe("When the run finished; null while live."),
  })
  .describe(
    "Compact run state embedded on a turn so a chat surface renders the whole conversation from one thread fetch.",
  );
export type ControlTurnRunCard = z.infer<typeof ControlTurnRunCard>;

export const ControlThreadTurn = z
  .object({
    id: Id.describe("Turn id."),
    threadId: Id.describe("Thread the turn belongs to."),
    runId: Id.nullable().default(null).describe("Run backing this turn; null while unbound."),
    parentRunId: Id.nullable().default(null).describe("Run this turn follows up on, when any."),
    /** Set when this turn implements an approved plan from an earlier run. */
    planRunId: Id.nullable()
      .default(null)
      .describe("Set when this turn implements an approved plan from an earlier run."),
    kind: ThreadTurnKind.default("followup"),
    prompt: z.string().default("").describe("The user's message for this turn."),
    /** Embedded run card (outcome/state) so the chat renders without N+1 fetches. */
    run: ControlTurnRunCard.nullable()
      .default(null)
      .describe("Embedded run card (outcome/state); null while no run is bound."),
    /** Why this turn has NO run (enqueue/preflight refusal, e.g. the trust
     * gate) — surfaces render it as an inline failure card with the remedy;
     * null once a run binds (retry clears it). `code` is the typed throw's
     * machine code (remedies key on it, never on the message text);
     * `retryable=false` means no recorded job exists to replay — surfaces
     * offer "send a new message" instead of a doomed Retry. */
    enqueueError: z
      .object({
        message: z.string().describe("Human-readable refusal message."),
        code: z
          .string()
          .nullable()
          .default(null)
          .describe(
            "Machine-readable refusal code; remedies key on it, never on the message text.",
          ),
        retryable: z
          .boolean()
          .default(true)
          .describe(
            "False when no recorded job exists to replay — surfaces offer a new message instead of a doomed retry.",
          ),
        failedAt: z.string().describe("When the enqueue failed."),
      })
      .nullable()
      .default(null)
      .describe("Why this turn has no run (enqueue/preflight refusal); null once a run binds."),
    createdAt: z.string().describe("When the turn was created."),
  })
  .describe("Control-plane projection of one thread turn with its embedded run card.");
export type ControlThreadTurn = z.infer<typeof ControlThreadTurn>;

export const ControlThreadCreateRequest = z
  .object({
    title: z.string().optional().describe("Initial thread title."),
    scope: RunScope.default({ kind: "none" }),
    mode: ModeKind.optional().describe("Default mode for new turns."),
    workspace: WorkspaceMode.optional().describe(
      "Workspace mode for the thread (in_place or isolated).",
    ),
    authPreference: AuthPreference.optional().describe("Per-thread auth preference override."),
    credentialProfileId: NonBlankString.optional().describe(
      "Sticky credential profile for the thread (INV-135); per-turn selection wins.",
    ),
    primaryHarness: NonBlankString.optional().describe("Sticky primary harness for the thread."),
    /** Sticky eligible pool for the thread; turns inherit it when unset. */
    eligibleHarnesses: z
      .array(NonBlankString)
      .optional()
      .describe("Sticky eligible harness pool; turns inherit it when unset."),
  })
  .strict()
  .describe("Request body for POST /threads.");
export type ControlThreadCreateRequest = z.infer<typeof ControlThreadCreateRequest>;

/** Mutate a thread's title, open/closed state, or sticky routing (rename,
 * archive, switch primary/pool). primaryHarness nullable => clear back to auto. */
export const ControlThreadUpdateRequest = z
  .object({
    title: z.string().optional().describe("New thread title."),
    state: z.enum(["active", "closed"]).optional().describe("New open/archive state."),
    primaryHarness: NonBlankString.nullable()
      .optional()
      .describe("New sticky primary harness; null clears back to engine routing."),
    credentialProfileId: NonBlankString.nullable()
      .optional()
      .describe("New sticky credential profile; null clears back to engine-default credentials."),
    eligibleHarnesses: z
      .array(NonBlankString)
      .optional()
      .describe("New sticky eligible harness pool."),
  })
  .strict()
  .describe("Request body for PATCH /threads/:id: rename, archive, or switch sticky routing.");
export type ControlThreadUpdateRequest = z.infer<typeof ControlThreadUpdateRequest>;

export const ControlThreadListResponse = z
  .object({
    threads: z.array(ControlThread).default([]).describe("All threads."),
  })
  .describe("Response for GET /threads.");
export type ControlThreadListResponse = z.infer<typeof ControlThreadListResponse>;

export const ControlThreadDetail = z
  .object({
    thread: ControlThread,
    sessions: z.array(ControlSession).default([]).describe("Vendor sessions bound to the thread."),
    turns: z.array(ControlThreadTurn).default([]).describe("Turns of the conversation, in order."),
  })
  .describe(
    "Full thread detail served by GET /threads/:id: the thread, its vendor sessions, and its turns.",
  );
export type ControlThreadDetail = z.infer<typeof ControlThreadDetail>;

export const ControlHarnessListResponse = z
  .object({
    harnesses: z
      .array(HarnessStatusDto)
      .default([])
      .describe("Status rows for all known harnesses."),
  })
  .describe("Response for GET /harnesses.");
export type ControlHarnessListResponse = z.infer<typeof ControlHarnessListResponse>;

/**
 * Models enumerable for one harness. `source` is honest about provenance:
 * "api" when the adapter implemented a real enumeration (raw-api / OpenAI
 * `GET /v1/models`), "manifest" when the list is the manifest's known-good
 * hint set, "none" when the harness has no model truth source at all (the
 * list is then empty and explicit models are refused under strict model-truth validation).
 */
export const ControlHarnessModelsResponse = z
  .object({
    harnessId: z.string().describe("Harness the models belong to."),
    models: z
      .array(HarnessModel)
      .default([])
      .describe("Enumerable models; empty when the harness has no model truth source."),
    source: z
      .enum(["api", "manifest", "none"])
      .describe(
        "Provenance of the list: api (a live vendor enumeration), manifest (the manifest's known-good hint set), or none (no model truth source; explicit models are refused).",
      ),
    /** Freshness note for manifest-sourced lists: the vendor CLI version the
     * known-model hints were last verified against (null for api/none). */
    verifiedAgainst: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "Vendor CLI version the manifest hints were last verified against; null for api/none sources.",
      ),
  })
  .describe("Models enumerable for one harness, with honest provenance.");
export type ControlHarnessModelsResponse = z.infer<typeof ControlHarnessModelsResponse>;

export const ControlSettingsSnapshot = z
  .object({
    sources: z
      .array(z.string())
      .default([])
      .describe("Config file paths that contributed to the snapshot."),
    /** How long a run waits for an interactive answer before a benign decline. */
    interactionTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(900_000)
      .describe(
        "How long a run waits for an interactive answer before a benign decline, in milliseconds.",
      ),
    routing: z
      .object({
        defaultPolicy: z
          .enum(["auto", "primary"])
          .default("auto")
          .describe("Default routing policy."),
        primaryHarness: z
          .string()
          .nullable()
          .default(null)
          .describe("Global default primary harness; null = engine decides."),
        eligibleHarnesses: z
          .array(z.string())
          .default([])
          .describe("Harness pool eligible for routing/races; empty = all available."),
        envInheritance: z
          .enum(["mirror_native", "clean"])
          .default("mirror_native")
          .describe(
            "How the child harness env is built: mirror_native inherits the shell env; clean spawns from a minimal allowlist.",
          ),
        authPreference: AuthPreference.default("auto"),
        goal: RoutingGoal.default("auto"),
        paidFallback: PaidFallback.default("when_unavailable"),
        qualityTiers: QualityTierSet,
      })
      .default({})
      .describe("Global routing settings."),
    budget: z
      .object({
        paidBudgetPerRun: PaidBudget.default({ kind: "unlimited" }),
      })
      .default({})
      .describe("Global budget limits."),
    runtime: z
      .object({
        reviewerTimeoutMs: z
          .number()
          .int()
          .positive()
          .default(600_000)
          .describe("Wall-clock timeout for a reviewer run, in milliseconds."),
        harnessInactivityTimeoutMs: z
          .number()
          .int()
          .positive()
          .default(1_200_000)
          .describe("Inactivity watchdog for harness streams, in milliseconds."),
        transientRetry: z
          .object({
            maxRetries: z
              .number()
              .int()
              .nonnegative()
              .default(2)
              .describe("Maximum retries for a transient failure."),
            initialDelayMs: z
              .number()
              .int()
              .nonnegative()
              .default(1_000)
              .describe("Initial retry delay in milliseconds."),
            maxDelayMs: z
              .number()
              .int()
              .nonnegative()
              .default(10_000)
              .describe("Maximum retry delay in milliseconds."),
          })
          .default({})
          .describe("Bounded retry policy for transient failures."),
      })
      .default({})
      .describe("Global runtime timeouts and retry policy."),
    harnesses: z
      .record(
        z.string(),
        z
          .object({
            enabled: z
              .boolean()
              .default(true)
              .describe("Whether the harness participates in routing."),
            defaultModel: z
              .string()
              .nullable()
              .default(null)
              .describe("Per-harness default model; null = the harness's own default."),
            effort: EffortHint.nullable()
              .default(null)
              .describe("Default reasoning effort; null = harness default."),
            maxTurns: z
              .number()
              .int()
              .positive()
              .nullable()
              .default(null)
              .describe("Default max agent turns; null = no limit."),
            maxRounds: z
              .number()
              .int()
              .positive()
              .nullable()
              .default(null)
              .describe("Default max convergence rounds; null = engine default."),
            toolsAllow: z
              .array(z.string())
              .default([])
              .describe("Tool names allowed for this harness."),
            toolsDeny: z
              .array(z.string())
              .default([])
              .describe("Tool names denied for this harness."),
            fallbackModel: z
              .string()
              .nullable()
              .default(null)
              .describe("Model to fall back to on typed fallback signals; null = none."),
            web: ExternalContextPolicy.default("auto").describe(
              "Default web policy for this harness.",
            ),
            authPreference: AuthPreference.default("auto"),
            /** Profile-selection policy (INV-135): what happens when the
             * selected account hits its quota. Drives the app's auto-switch
             * toggle read-back. */
            profileLimitAction: z
              .enum(["fail", "ask", "rotate"])
              .default("fail")
              .describe(
                "Profile-selection limit action: fail (stop), ask (record), rotate (auto-switch to the next eligible account).",
              ),
          })
          .describe("Per-harness settings."),
      )
      .default({})
      .describe("Per-harness settings keyed by harness id."),
  })
  .describe("Effective settings snapshot served by GET /settings.");
export type ControlSettingsSnapshot = z.infer<typeof ControlSettingsSnapshot>;

/**
 * Partial per-harness settings patch; absent fields keep their stored value.
 * STRICT: a typoed key must 400, not silently no-op (fail-loudly contract).
 */
export const ControlHarnessSettingsPatch = z
  .object({
    enabled: z.boolean().optional().describe("Enable/disable the harness for routing."),
    defaultModel: NonBlankString.nullable()
      .optional()
      .describe("New per-harness default model; null clears it."),
    effort: EffortHint.nullable()
      .optional()
      .describe("New default reasoning effort; null clears it."),
    maxTurns: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe("New max agent turns; null clears the limit."),
    maxRounds: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe("New max convergence rounds; null clears it."),
    toolsAllow: z.array(NonBlankString).optional().describe("New tool allowlist."),
    toolsDeny: z.array(NonBlankString).optional().describe("New tool denylist."),
    fallbackModel: NonBlankString.nullable()
      .optional()
      .describe("New fallback model; null clears it."),
    web: ExternalContextPolicy.optional().describe("New default web policy."),
    authPreference: AuthPreference.optional().describe("New auth route preference."),
    /** Auto-switch accounts on quota limits (INV-135): rotate enables the
     * profile-rotation engine for this harness; fail restores the default. */
    profileLimitAction: z
      .enum(["fail", "ask", "rotate"])
      .optional()
      .describe("New profile-selection limit action (fail | ask | rotate)."),
  })
  .strict()
  .describe(
    "Partial per-harness settings patch; absent fields keep their stored value, and a typoed key 400s (strict).",
  );
export type ControlHarnessSettingsPatch = z.infer<typeof ControlHarnessSettingsPatch>;

export const ControlSettingsUpdateRequest = z
  .object({
    routingGoal: RoutingGoal.optional(),
    paidFallback: PaidFallback.optional(),
    qualityTiers: QualityTierSet.optional(),
    interactionTimeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("New interactive-answer timeout, in milliseconds."),
    routingPolicy: z.enum(["auto", "primary"]).optional().describe("New default routing policy."),
    primaryHarness: NonBlankString.nullable()
      .optional()
      .describe("New global primary harness; null clears back to engine routing."),
    eligibleHarnesses: z
      .array(NonBlankString)
      .optional()
      .describe("New global eligible harness pool."),
    envInheritance: z
      .enum(["mirror_native", "clean"])
      .optional()
      .describe("New child harness env composition mode."),
    paidBudgetPerRun: PaidBudget.optional().describe("New global incremental-cash budget per run."),
    authPreference: AuthPreference.optional().describe("New global auth route preference."),
    harnesses: z
      .record(NonBlankString, ControlHarnessSettingsPatch)
      .optional()
      .describe("Per-harness settings patches keyed by harness id."),
  })
  .strict()
  .describe("Request body for PATCH /settings; absent fields keep their stored values.");
export type ControlSettingsUpdateRequest = z.infer<typeof ControlSettingsUpdateRequest>;
