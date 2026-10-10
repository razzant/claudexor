import { z } from "zod/v3";
import { ApplyEligibility } from "./apply-eligibility.js";
import { ControlBudgetSnapshot } from "./control.js";
import { ControlThreadTurnResponse } from "./control-operation-responses.js";
import { RunFailure } from "./control-run-failure.js";
import { RunOutcomeFacts } from "./decision.js";
import { RunDelegationInfo } from "./delegation.js";
import { CouncilProjection, PlanReadiness } from "./plan.js";
import { RunFacts } from "./run-facts.js";
import { AttemptExecutionEvidence } from "./attempt-execution.js";

export const RunDetailProblem = z
  .object({
    code: z.string().nullable().describe("Stable machine code of the detail problem, if any."),
    message: z.string().describe("Human-readable description of the detail problem."),
    retryable: z.boolean().nullable().describe("Whether retrying the detail read may help."),
  })
  .strict()
  .describe("Typed failure of a post-run detail read whose durable run result still survives.");
export type RunDetailProblem = z.infer<typeof RunDetailProblem>;

/**
 * INV-062 disclosure for a run whose output held secret-like strings: the
 * changes were kept and only Claudexor's saved/served copies hide them. Paths,
 * rule ids and counts — never a matched value.
 */
export const SecretLikeDisclosure = z
  .object({
    totalMatches: z
      .number()
      .int()
      .nonnegative()
      .describe("Strings hidden across patch and answer."),
    answerMatches: z.number().int().nonnegative().describe("Strings hidden in the answer."),
    files: z
      .array(
        z
          .object({
            path: z.string().describe("Changed file whose saved diff hides strings."),
            matches: z.number().int().nonnegative().describe("Strings hidden in that file's diff."),
            kinds: z.array(z.string()).describe("Content-rule ids that matched."),
          })
          .strict(),
      )
      .describe("Changed files with hidden strings in the saved patch copy."),
    binaryPaths: z.array(z.string()).describe("Binary files whose payload the saved patch omits."),
    mediaWithheld: z.array(z.string()).describe("Images that were not saved as produced outputs."),
    persistedPatch: z
      .enum(["exact", "redacted"])
      .describe(
        "Whether the saved final/patch.diff is byte-exact or a display-only redacted copy.",
      ),
    exactPatchRecorded: z
      .boolean()
      .nullable()
      .describe(
        "For a redacted copy: whether the private exact patch object was recorded (false = deferred Apply answers patch_exact_bytes_unavailable); null for an exact copy.",
      ),
  })
  .strict()
  .describe(
    "What a run's saved copies hide: secret-like strings kept in the work, hidden on disk.",
  );
export type SecretLikeDisclosure = z.infer<typeof SecretLikeDisclosure>;

/**
 * The structured result shape MCP run tools return (structuredContent).
 * Text content mirrors it for hosts without structured-output support.
 */
export const McpRunToolResult = z
  .object({
    attemptExecution: z.array(AttemptExecutionEvidence).optional(),
    summary: z
      .string()
      .describe("Human-readable outcome summary (same text as the tool's text content)."),
    runId: z
      .string()
      .nullable()
      .describe(
        "Daemon run id (recovery handle for inspect/follow/apply/decision); null for in-process read-only runs.",
      ),
    runDir: z
      .string()
      .nullable()
      .describe("Artifact directory of the run; null when not persisted."),
    status: z
      .string()
      .nullable()
      .describe("Terminal run LIFECYCLE (succeeded | failed | cancelled | interrupted)."),
    runFacts: RunFacts.nullable()
      .default(null)
      .describe(
        "Validated canonical terminal RunFacts receipt; null while active, unavailable, or for legacy runs.",
      ),
    outcomeFacts: RunOutcomeFacts.nullable()
      .default(null)
      .describe(
        "The D8 terminal outcome axes (checks/review/reason/noChanges); null for non-terminal or read-only routes.",
      ),
    failure: RunFailure.nullable()
      .default(null)
      .describe("Typed terminal failure detail and recovery actions; null for non-failed runs."),
    applyEligibility: ApplyEligibility.nullable().describe(
      "Apply-gate verdict for mutating runs; null for read-only routes or when no patch exists.",
    ),
    outcomeBanner: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "Server-owned outcome headline (D18); the single honest one-line verdict, null while non-terminal or unavailable.",
      ),
    planReadiness: PlanReadiness.nullable()
      .default(null)
      .describe("Derived plan readiness for plan tools (D17); null for non-plan tools."),
    /** Typed disclosure that the post-terminal detail read DEGRADED: the run
     * finished and its result survived, but the detail projections above are
     * absent for this machine-readable reason (e.g. run_facts_invalid). */
    detailProblem: RunDetailProblem.nullable()
      .default(null)
      .describe(
        "Typed post-terminal detail-read problem (the run result survives; its detail projections are absent for this reason); null when the detail read succeeded.",
      ),
    /** Council membership + merge disclosure (QA-023b) so an MCP host can
     * machine-verify a `--council` plan was really N/N and who merged, without
     * reading local artifacts; null for solo/non-plan tools and deferred handles. */
    council: CouncilProjection.nullable()
      .default(null)
      .describe(
        "Council membership + merge disclosure (QA-023b); null for solo/non-plan tools or deferred handles.",
      ),
    parentRunId: z.string().nullable().default(null),
    delegatedFromRunId: z.string().nullable().default(null),
    delegation: RunDelegationInfo.nullable().default(null),
  })
  .describe("Structured MCP tool result for Claudexor run tools.");
export type McpRunToolResult = z.infer<typeof McpRunToolResult>;

/**
 * The structured result shape the MCP READ tools (claudexor_inspect /
 * claudexor_run_status / claudexor_run_result) return: a durable run handle
 * projected from GET /runs/:id through the SAME axes every surface reads.
 * Strict — the read tools emit exactly these keys so hosts can branch on a
 * declared shape instead of a free-text blob (v3: no legacy extra fields).
 */
export const McpRunHandleResult = z
  .object({
    attemptExecution: z.array(AttemptExecutionEvidence).optional(),
    summary: z
      .string()
      .describe("Human-readable outcome/status text (same as the tool's text content)."),
    runId: z.string().nullable().default(null).describe("The daemon run id, when known."),
    runDir: z.string().nullable().default(null).describe("Artifact directory; null when absent."),
    status: z
      .string()
      .nullable()
      .default(null)
      .describe("The run's terminal or in-flight lifecycle state, when known."),
    runFacts: RunFacts.nullable()
      .default(null)
      .describe(
        "Validated canonical terminal RunFacts receipt; null while active, unavailable, or for legacy runs.",
      ),
    decisionStatus: z
      .string()
      .nullable()
      .default(null)
      .describe("The arbitration decision status, when the run reached arbitration."),
    pendingInteractions: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .default(null)
      .describe("Count of questions still awaiting answers, when known."),
    outcomeFacts: RunOutcomeFacts.nullable()
      .default(null)
      .describe("The D8 terminal outcome axes (checks/review/reason/noChanges), when terminal."),
    failure: RunFailure.nullable()
      .default(null)
      .describe("Typed terminal failure detail and recovery actions; null for non-failed runs."),
    outcomeBanner: z
      .string()
      .nullable()
      .default(null)
      .describe("Server-owned outcome headline (D18); null while non-terminal."),
    applyEligibility: ApplyEligibility.nullable()
      .default(null)
      .describe("Derived apply-gate verdict; null for read-only runs or when no patch exists."),
    planReadiness: PlanReadiness.nullable()
      .default(null)
      .describe("Derived plan readiness (plan runs only, D17); null otherwise."),
    /** Council membership + merge disclosure (QA-023b), projected from the same
     * GET /runs/:id detail every read surface shares; null for solo/non-plan runs. */
    council: CouncilProjection.nullable()
      .default(null)
      .describe("Council membership + merge disclosure (QA-023b); null for solo/non-plan runs."),
    /** Run budget snapshot (QA-023c) carrying BOTH exact billed cash and the
     * separate subscription valuation, so an MCP host learns a native-subscription
     * run's real resource cost (cash $0 + non-null valuation) without reading
     * local artifacts; null when no budget snapshot is available. */
    budget: ControlBudgetSnapshot.nullable()
      .default(null)
      .describe(
        "Run budget snapshot (cash + subscription valuation, QA-023c); null when unavailable.",
      ),
    parentRunId: z
      .string()
      .nullable()
      .default(null)
      .describe("Server-owned ordinary parent/follow-up run id, when present."),
    delegatedFromRunId: z
      .string()
      .nullable()
      .default(null)
      .describe("Claudexor Delegate parent id; null for ordinary runs and native subagents."),
    delegation: RunDelegationInfo.nullable()
      .default(null)
      .describe("Typed Delegate receipt; null when unavailable or legacy."),
    detailProblem: RunDetailProblem.nullable()
      .default(null)
      .describe(
        "Typed post-terminal detail-read problem (the durable run handle survives); null when the detail read succeeded.",
      ),
    /** The answer-first `summary` of run_result would otherwise drop this fact. */
    secretLike: SecretLikeDisclosure.nullable()
      .default(null)
      .describe(
        "INV-062 disclosure: secret-like strings kept in the work but hidden in saved copies (paths and counts only); null when nothing was hidden.",
      ),
  })
  .strict()
  .describe("Structured MCP result for Claudexor durable-run read tools (inspect/status/result).");
export type McpRunHandleResult = z.infer<typeof McpRunHandleResult>;

const threadTurnSummary = {
  summary: z
    .string()
    .describe("Human-readable turn handle summary (same as the tool's text content)."),
};

/**
 * The structured result claudexor_thread_turn returns: the daemon's durable
 * thread-turn handle (a bound runId, or a queued jobId) plus the text summary.
 * Each member stays as strict as the daemon handle it mirrors.
 */
export const McpThreadTurnResult = z
  .union([
    ControlThreadTurnResponse.options[0].extend(threadTurnSummary),
    ControlThreadTurnResponse.options[1].extend(threadTurnSummary),
  ])
  .describe("Structured MCP result for claudexor_thread_turn: the durable thread-turn handle.");
export type McpThreadTurnResult = z.infer<typeof McpThreadTurnResult>;
