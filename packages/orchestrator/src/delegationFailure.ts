import { join } from "node:path";
import { ArtifactStore, type RunPaths } from "@claudexor/artifact-store";
import { EventLog } from "@claudexor/event-log";
import {
  makeOutcomeFacts,
  type ModeKind,
  type RunOutcomeFacts,
  type WorkspaceKind,
} from "@claudexor/schema";
import { newId } from "@claudexor/util";
import { snapshotTree } from "@claudexor/workspace";
import { publishUnverifiedGitCandidate } from "./candidateWorkProduct.js";
import type { AttemptTelemetry } from "./attemptTelemetry.js";
import {
  candidateCaptureRefusals,
  hasCandidateChanges,
  type CandidateRun,
} from "./candidateEvidence.js";
import { publishDirectoryCandidate } from "./directoryCandidate.js";
import { delegationBeltToolFailure, delegationBeltUnavailable } from "./delegationToolEvidence.js";
import {
  captureInspectionActions,
  captureRefusalNextActions,
  resultSummaryLines,
} from "./secretDiff.js";
import { CAPTURE_REFUSED_REASON, captureRefusedFacts } from "./captureRefusal.js";

export type DelegationFailureKind = "startup" | "runtime";

/** One owner for the post-injection failure boundary shared by race,
 * convergence, and attempt finalization. Runtime takes precedence if corrupt
 * evidence ever reports both facts. */
export function delegationFailureKind(t: AttemptTelemetry): DelegationFailureKind | null {
  if (delegationBeltToolFailure(t)) return "runtime";
  if (delegationBeltUnavailable(t)) return "startup";
  return null;
}

export function delegationFailureError(t: AttemptTelemetry): string | null {
  const kind = delegationFailureKind(t);
  return kind === "runtime"
    ? "delegation belt tool failed after injection"
    : kind === "startup"
      ? "delegation belt failed to start after injection"
      : null;
}

export function candidateFailureKind(run: CandidateRun): DelegationFailureKind | "capture" | null {
  return delegationFailureKind(run.telemetry) ?? (run.captureRefusal ? "capture" : null);
}

/** Race-level precedence: an unrecovered injected-belt failure dominates all
 * siblings; an uncaptured isolated candidate is merely ineligible (its bytes
 * remain in retained custody), while an uncaptured in-place candidate remains
 * terminal because its live effects need direct inspection. An isolated copy of
 * a directory run whose retention setup failed is ineligible too (owner
 * decision): a healthy sibling may still win, and its receipt keeps the
 * stage that failed. A Git source whose retention failed stays terminal. */
export function dominantRaceCandidateFailure(
  runs: CandidateRun[],
  race: { workspaceKind?: WorkspaceKind },
): CandidateRun | undefined {
  return (
    runs.find((run) => delegationFailureKind(run.telemetry)) ??
    runs.find(
      (run) =>
        run.captureRefusal?.disposition === "manual_cleanup" &&
        !(race.workspaceKind === "directory" && run.captureRefusal.retentionFailure),
    )
  );
}

/** The run summary's disclosure for a race that has a winner: the winner's own
 * result lines, then every sibling excluded by a refused capture, or holding a
 * continuation's refused one, with its exact receipt (cause, kept copy and any
 * retention stage that failed). */
export function raceSummaryDisclosure(
  winner: CandidateRun | undefined,
  runs: CandidateRun[],
): string | null {
  const lines = [
    resultSummaryLines(winner),
    ...runs
      .filter((run) => run !== winner && run.captureRefusal)
      .map(
        (run) =>
          `- Excluded ${run.label} (${run.attemptId}, ${run.harnessId}): ${run.captureRefusal!.detail}`,
      ),
    ...runs.flatMap((run) =>
      run.continuationRefusal
        ? [
            `- Excluded ${run.label}'s continuation (${run.continuationRefusal.attemptId}, ${run.harnessId}): ${run.continuationRefusal.refusal.detail}`,
          ]
        : [],
    ),
  ].filter((line): line is string => !!line);
  return lines.length > 0 ? lines.join("\n") : null;
}

/** Build the terminal cause/provenance without duplicating the race and
 * convergence messages or raw-attempt links. */
export function delegationFailureTerminal(run: CandidateRun, lane: "race" | "convergence") {
  const kind = delegationFailureKind(run.telemetry);
  if (!kind) throw new Error("delegation failure terminal requested for a healthy attempt");
  const runtime = kind === "runtime";
  const message = runtime
    ? lane === "race"
      ? `Delegate belt tool failed in ${run.harnessId}; no deliverable or native fallback may replace the failed injected operation`
      : `Delegate belt tool failed in ${run.harnessId}; convergence cannot review, repair, or continue after an unrecovered injected operation fails`
    : lane === "race"
      ? `Delegate startup failed in ${run.harnessId}; no degraded sibling may replace an injected failed belt`
      : `Delegate startup failed in ${run.harnessId}; convergence cannot repair or continue after an injected belt fails`;
  return {
    phase: runtime ? "delegation_runtime" : "delegation_startup",
    error: new Error(message),
    metadata: {
      category: "harness_error" as const,
      harnessId: run.harnessId,
      attemptId: run.attemptId,
      rawDetailRef: `attempts/${run.attemptId}/attempt.yaml`,
      nextActions: [
        `Inspect attempts/${run.attemptId}/attempt.yaml`,
        runtime
          ? "Repair the failed Delegate belt operation, then retry the run"
          : "Repair the required Delegate belt startup, then retry the run",
      ],
    },
  };
}

/** A Delegate failure leads when both occur. An incomplete capture is
 * orthogonal to the leading cause: its typed facts (capture failure, unknown
 * changes) and inspection actions ride with either cause, so a later terminal
 * owner (a late cancellation) recognizes the record by those facts. Any other
 * capture refusal among `attempts` (a sibling's, a continuation's) follows. */
export function candidateFailureTerminal(
  run: CandidateRun,
  lane: "race" | "convergence",
  attempts: readonly CandidateRun[] = [run],
) {
  const refusal = run.captureRefusal;
  const others = candidateCaptureRefusals(attempts).filter((other) => other !== refusal);
  const followUps = { followUps: others.flatMap(captureInspectionActions) };
  const terminal = delegationFailureKind(run.telemetry)
    ? delegationFailureTerminal(run, lane)
    : refusal && {
        phase: refusal.phase ?? "workspace",
        error: new Error(run.errors[0] ?? refusal.detail),
        metadata: {
          category: "project" as const,
          harnessId: run.harnessId,
          attemptId: run.attemptId,
          rawDetailRef: `attempts/${run.attemptId}/attempt.yaml`,
          nextActions: [] as string[],
        },
      };
  if (!terminal) throw new Error("candidate failure terminal requested without cause");
  if (!refusal)
    return {
      ...terminal,
      metadata: { ...terminal.metadata, captureFailure: others[0]?.failure, ...followUps },
    };
  return {
    ...terminal,
    metadata: {
      ...terminal.metadata,
      ...followUps,
      captureFailure: refusal.failure,
      // The leading cause owns the reason: a Delegate failure's phase, else the refusal.
      priorFacts: makeOutcomeFacts("failed", { noChanges: null }),
      ...(delegationFailureKind(run.telemetry) ? {} : { reason: CAPTURE_REFUSED_REASON }),
      nextActions: [...captureRefusalNextActions(refusal), ...terminal.metadata.nextActions],
    },
  };
}

type FailedCandidateOutput = {
  live: boolean;
  run: CandidateRun;
  store: ArtifactStore;
  log: EventLog;
  paths: RunPaths;
  execRoot: string;
  projectRoot: string;
  preTurnSha: string | null;
  postTurnSha?: string | null;
  taskId: string;
  mode: ModeKind;
  kind: "patch" | "new_repo";
  attempts?: number;
  /** The run's own terminal facts when a budget or cancel outranks the failure. */
  facts?: RunOutcomeFacts;
};

/** One owner for what a failed candidate leaves behind: complete directory
 * files keep their manifest; live Git effects keep their blocked record. */
export async function persistFailedCandidateOutput(input: FailedCandidateOutput): Promise<void> {
  const { run } = input;
  if (!run.files) return persistFailedInPlaceWorkProduct(input);
  await publishDirectoryCandidate({
    ...{ store: input.store, paths: input.paths, taskId: input.taskId, log: input.log },
    ...{ files: run.files, attemptId: run.attemptId, harnessId: run.harnessId },
    facts: input.facts ?? makeOutcomeFacts("failed", { noChanges: run.files.noChanges }),
  });
}

/** An explicitly in-place harness may have changed the live tree before a
 * required Delegate failure becomes terminal. Persist those unavoidable bytes
 * as blocked and revertable; envelope runs stay diagnostic-only. */
export async function persistFailedInPlaceWorkProduct(input: FailedCandidateOutput): Promise<void> {
  if (!input.live || (!hasCandidateChanges(input.run) && !input.run.captureRefusal)) return;
  const refusal = input.run.captureRefusal;
  if (refusal) {
    // Uncaptured live effects: nothing was rolled back and no patch or revert
    // anchor can be produced, so the record says exactly that.
    const manualCleanup = refusal.disposition === "manual_cleanup";
    const facts = input.facts ?? captureRefusedFacts();
    input.store.writeYaml(join(input.paths.finalDir, "work_product.yaml"), {
      id: newId("wp"),
      kind: input.kind,
      source_task_id: input.taskId,
      producer_attempt_id: input.run.attemptId,
      meta: {
        harness_id: input.run.harnessId,
        result_kind: "none",
        mode: input.mode,
        ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
        lifecycle: facts.lifecycle,
        outcome_facts: facts,
        review_verified: false,
        capture_refused: true,
        capture_recovery: refusal.disposition,
        recovery_detail: refusal.detail,
        capture_failure: refusal.failure,
        execution_root: refusal.sourceRoot,
        adopted: manualCleanup,
        apply_state: manualCleanup ? "applied_review_blocked" : "not_applied",
        pre_turn_sha: input.preTurnSha,
        post_turn_sha: null,
        revert_anchor_id: null,
      },
    });
    input.log.emit("work_product.emitted", {
      winner: input.run.attemptId,
      apply_state: manualCleanup ? "applied_review_blocked" : "not_applied",
      capture_refused: true,
      manual_cleanup_required: manualCleanup,
    });
    return;
  }
  let postTurnSha = input.postTurnSha;
  if (postTurnSha === undefined) {
    try {
      postTurnSha = await snapshotTree(input.execRoot);
    } catch {
      postTurnSha = null;
    }
  }
  await publishUnverifiedGitCandidate({
    ...input,
    postTurnSha,
    facts:
      input.facts ?? makeOutcomeFacts("failed", { reason: "harness_failed", noChanges: false }),
  });
}
