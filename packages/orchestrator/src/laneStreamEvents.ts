/**
 * Per-stream disclosure helpers shared VERBATIM by the candidate and
 * read-only lanes. One owner for these event payload shapes: the two lanes
 * used to spell out identical bodies, and a drifted field name in one of them
 * would have split the consumers' view of the same machinery.
 */
import { reportedUsageCostUsd } from "@claudexor/budget";
import type { RunEventType } from "@claudexor/schema";
import { transientRetryDelayMs, type TransientRetryPolicy } from "./runSupport.js";
import { classifyAdapterThrow, type AttemptTelemetry } from "./attemptTelemetry.js";
import type { AttemptUsageCost } from "./attemptUsageCost.js";

type Emit = (type: RunEventType, payload: Record<string, unknown>) => void;

/** Live plan checklist: forward the adapter's typed plan progress as a run
 * event (LAST WINS; the UI renders the latest). No-op without plan_progress. */
export function emitPlanProgress(
  emit: Emit,
  harnessId: string,
  attemptId: string,
  ev: { plan_progress?: { items: unknown } | null },
): void {
  if (!ev.plan_progress) return;
  emit("plan.progress", {
    attempt_id: attemptId,
    harness_id: harnessId,
    items: ev.plan_progress.items,
  });
}

/** W-C4 flood guard (review sol #10): a per-character delta stream would
 * otherwise persist/SSE one journal event PER CHUNK without bound. Delta
 * messages past this budget are hidden from live observers, but retained in
 * the canonical event log: an interrupted stream may never send its flush. */
export function dropDeltaPastBudget(
  ev: { type: string; payload?: Record<string, unknown> | null },
  state: { count: number; disclosed: boolean },
  max: number,
  emit: Emit,
  harnessId: string,
  attemptId: string,
): boolean {
  if (ev.type !== "message" || ev.payload?.["delta"] !== true) return false;
  state.count += 1;
  if (state.count <= max) return false;
  if (!state.disclosed) {
    state.disclosed = true;
    emit("harness.event", {
      harness_id: harnessId,
      attempt_id: attemptId,
      type: "status",
      title: `direct observer delta preview capped at ${max} chunks; complete evidence remains available through run events and artifacts`,
    });
  }
  return true;
}

/** Discloses one scheduled same-profile transient retry (`detected` +
 * `retry_scheduled`), counts it as OBSERVED on the attempt, and returns the
 * backoff delay the caller must sleep. The failure that scheduled it is the
 * attempt's latest classified one (a retry is scheduled only after a retryable
 * observation in this try). A dedicated counter, not `nativeTry`: that index
 * also advances on credential rotation. */
export function emitTransientRetryPlan(
  emit: Emit,
  harnessId: string,
  attemptId: string,
  telemetry: AttemptTelemetry,
  nativeTry: number,
  policy: TransientRetryPolicy,
): number {
  const transient = telemetry.transientFailures.at(-1) ?? null;
  telemetry.transientRetries += 1;
  const delayMs = transientRetryDelayMs(transient?.retryDelayMs ?? null, policy, nativeTry);
  emit("route.transient.detected", {
    harness_id: harnessId,
    attempt_id: attemptId,
    kind: transient?.kind ?? "unknown",
    category: transient?.category ?? "unknown_harness_error",
    native_try: nativeTry + 1,
  });
  emit("route.transient.retry_scheduled", {
    harness_id: harnessId,
    attempt_id: attemptId,
    retry: nativeTry + 1,
    delay_ms: delayMs,
  });
  return delayMs;
}

/** One owner for every lane's spend row: fold one usage event's reported amount,
 * zero included, into the attempt's running cost and disclose it as a
 * `budget.observation`. An event without an amount reports nothing. The attempt's
 * telemetry has already classified the event, so `amount_kind` is the meaning the
 * ledger will settle (the live budget projection reads a zero row by it). */
export function observeUsageSpend(
  ev: { type: string; usage?: { cost_usd?: number | null; estimated?: boolean | null } | null },
  emit: (type: "budget.observation", payload: Record<string, unknown>) => void,
  harnessId: string,
  attemptId: string,
  usageCost: Pick<AttemptUsageCost, "lastAmountKind">,
): { costUsd: number; estimated: boolean } {
  const usd = ev.type === "usage" ? reportedUsageCostUsd(ev) : undefined;
  if (usd === undefined) return { costUsd: 0, estimated: false };
  const estimated = ev.usage?.estimated === true;
  emit("budget.observation", {
    harness_id: harnessId,
    attempt_id: attemptId,
    kind: "spend",
    usd,
    estimated,
    ...(usageCost.lastAmountKind ? { amount_kind: usageCost.lastAmountKind } : {}),
  });
  return { costUsd: usd, estimated };
}

/** The transient machinery's terminal disclosure for an attempt that still
 * ended errored; silent when no transient failure was ever classified.
 * `retries` is the number of same-profile retries that actually RAN (zero when
 * the failure was never retryable); `max_retries` is the configured ceiling. */
export function emitTransientExhausted(
  emit: Emit,
  harnessId: string,
  attemptId: string,
  telemetry: AttemptTelemetry,
  maxRetries: number,
): void {
  if (telemetry.transientFailures.length === 0) return;
  emit("route.transient.exhausted", {
    harness_id: harnessId,
    attempt_id: attemptId,
    category: telemetry.transientFailures.at(-1)?.category ?? "unknown_harness_error",
    retries: telemetry.transientRetries,
    max_retries: maxRetries,
  });
}

/** Effort refusal is a terminal preparation fact, not an availability failure.
 * Return whether ordinary retry/rotation handling applies to this thrown error. */
export function recordAdapterThrow(telemetry: AttemptTelemetry, error: unknown): boolean {
  if (telemetry.effortResolution?.resolution === "rejected") return false;
  telemetry.transientFailures.push(
    classifyAdapterThrow({ errorName: error instanceof Error ? error.name : null }),
  );
  return true;
}
