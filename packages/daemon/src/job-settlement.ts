import {
  nowIso,
  redactSecrets,
  safeProblemContext,
  safeProblemRequiredActions,
} from "@claudexor/util";
import { TurnEnqueueProblem } from "@claudexor/schema";
import { commandStoreForId, type CommandAuthority } from "./command-authority.js";
import { resultReason, resultSummary, type JobRecord, type JobState } from "./job-record.js";

/** The settled job record for a runner's returned result. */
export function settledJobPatch(state: JobState, result: unknown): Partial<JobRecord> {
  if (state !== "failed" && state !== "interrupted") return { state, result, finishedAt: nowIso() };
  const reason = resultReason(result);
  return {
    state,
    result,
    error: resultSummary(result) ?? `run ended ${state}${reason ? ` (${reason})` : ""}`,
    finishedAt: nowIso(),
  };
}

interface JobErrorSettlement {
  thrown: unknown;
  record: JobRecord;
  aborted: boolean;
  commands: CommandAuthority;
  update: (record: JobRecord, patch: Partial<JobRecord>) => JobRecord;
}

/**
 * Settle a runner throw without allowing local terminal-finalization failures
 * to overwrite a terminal event already accepted by durable authority.
 */
export function settleJobError({
  thrown,
  record,
  aborted,
  commands,
  update,
}: JobErrorSettlement): JobRecord {
  const code = thrownField(thrown, "code");
  const status = thrownField(thrown, "status");
  const retryable = thrownField(thrown, "retryable");
  const turnRetryable = thrownField(thrown, "turnRetryable");
  const turnId = (record.params as { turnId?: unknown } | null)?.turnId;
  const refusedTurn = !aborted && !record.runId && typeof turnId === "string" && turnId.length > 0;
  const requiredActions = safeProblemRequiredActions(thrownField(thrown, "requiredActions"));
  const { turnRetryable: _reserved, ...context } = safeProblemContext(
    thrownField(thrown, "context"),
  );
  const typedStatus =
    typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
      ? status
      : undefined;
  const error = redactSecrets(thrown instanceof Error ? thrown.message : String(thrown));

  if (code === "terminal_recovery_required") {
    try {
      const recovered = commandStoreForId(commands, record.id)?.recoverDurableTerminal(record.id);
      if (!recovered) throw new Error("durable terminal event was not found");
      return recovered;
    } catch (recoveryError) {
      const recoveryDetail = redactSecrets(
        recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
      );
      return update(record, {
        state: "interrupted",
        error: `${error}; immediate terminal recovery failed: ${recoveryDetail}`,
        errorCode: code,
        ...(typedStatus !== undefined ? { errorStatus: typedStatus } : {}),
        ...(typeof retryable === "boolean" ? { errorRetryable: retryable } : {}),
        errorRequiredActions: requiredActions,
        errorContext: context,
        finishedAt: nowIso(),
      });
    }
  }

  return update(record, {
    state: aborted ? "cancelled" : "failed",
    error,
    ...(typeof code === "string" && code ? { errorCode: code } : {}),
    ...(typedStatus !== undefined ? { errorStatus: typedStatus } : {}),
    // Only an explicit boolean is a retryability claim. In particular, an
    // untyped refusal must preserve the refused-turn recorder's default.
    ...(typeof retryable === "boolean" ? { errorRetryable: retryable } : {}),
    errorRequiredActions: requiredActions,
    // Only a confirmed job that failed to start its turn can carry this claim.
    // Keeping it in bounded problem context also preserves it on receipt lookup.
    // The turn recorder (reportPreRunRefusal below, called from server.ts) reads
    // it back into the stored problem's own `retryable` and keeps it out of the
    // stored context — the same shape the route recorder persists via
    // problemFromError, so one refused turn stores one identical
    // TurnEnqueueProblem whichever path recorded it.
    errorContext:
      refusedTurn && typeof turnRetryable === "boolean" ? { turnRetryable, ...context } : context,
    finishedAt: nowIso(),
  });
}

function thrownField(thrown: unknown, field: string): unknown {
  return thrown && typeof thrown === "object" && field in thrown
    ? (thrown as Record<string, unknown>)[field]
    : undefined;
}

/**
 * A failure-shaped terminal with NO run ever bound: the refusal happened
 * before the run materialized. If the job carried a pre-created thread turn,
 * its reason is persisted on the turn (honest inline refusal, INV-093).
 * A boolean `errorContext.turnRetryable` decides the turn's retryability
 * (manual replay may succeed after workspace repair) and is not stored in
 * the turn's context.
 */
export function reportPreRunRefusal(
  rec: Pick<JobRecord, "params" | "error" | "errorCode" | "errorRetryable"> &
    Partial<Pick<JobRecord, "errorRequiredActions" | "errorContext">>,
  report: ((turnId: string, problem: TurnEnqueueProblem) => void) | undefined,
): void {
  const turnId = (rec.params as { turnId?: unknown } | null | undefined)?.turnId;
  if (!rec.error || !report || typeof turnId !== "string" || !turnId) return;
  const { turnRetryable, ...problemContext } = rec.errorContext ?? {};
  try {
    report(
      turnId,
      TurnEnqueueProblem.parse({
        message: rec.error,
        code: rec.errorCode ?? null,
        retryable:
          typeof turnRetryable === "boolean" ? turnRetryable : (rec.errorRetryable ?? true),
        required_actions: rec.errorRequiredActions ?? [],
        context: problemContext,
      }),
    );
  } catch {
    /* observer failure must not corrupt terminal bookkeeping */
  }
}
