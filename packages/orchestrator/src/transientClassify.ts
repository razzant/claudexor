/**
 * Typed harness-failure taxonomy (GH #31): the SINGLE place that classifies an
 * adapter/stream failure at the adapter→orchestrator boundary into a
 * `HarnessFailureCategory` + `retryable` verdict, preserving the safe provider
 * metadata. Governance is fully typed — only typed event fields
 * (`transient`/`rate_limit`/`status.error_category`) and the run loop's typed
 * exit disclosure are read, never prose. The retry policy gates on `retryable`;
 * required-actions attach auth guidance only on `auth_failed`.
 */
import type { HarnessEvent, HarnessFailureCategory } from "@claudexor/schema";

/**
 * A single classified transient failure. `kind` keeps the fine-grained adapter
 * label; `category` is the typed taxonomy the retry policy and required-actions
 * read; `retryable` is the centralized gate. Provider metadata (HTTP status,
 * retry delay, kill signal, adapter code) is preserved as disclosed evidence —
 * never fabricated.
 */
export interface TransientFailureObservation {
  kind: NonNullable<HarnessEvent["transient"]>["kind"];
  category: HarnessFailureCategory;
  retryable: boolean;
  retryDelayMs: number | null;
  httpStatus: number | null;
  signal: string | null;
  adapterCode: string | null;
}

/**
 * Whether a classified category admits a bounded stream retry. Only failures
 * the adapter DISCLOSED mid-stream as recoverable (a typed transient or a rate
 * limit) are retried — retrying replays the work with a fresh session. Auth /
 * capability / config are deterministic refusals. A process crash and an
 * inactivity-watchdog give-up are NOT auto-retried here (the watchdog exists to
 * STOP a wedged stream; a crashed child is settled, not replayed): they are
 * still classified and disclosed, but the run terminates on them.
 */
const CATEGORY_RETRYABLE: Record<HarnessFailureCategory, boolean> = {
  timeout: true,
  rate_limited: true,
  unknown_harness_error: true,
  process_crash: false,
  auth_failed: false,
  capability_refused: false,
  config_error: false,
};

function observation(
  category: HarnessFailureCategory,
  extra: Partial<Omit<TransientFailureObservation, "category" | "retryable">> = {},
): TransientFailureObservation {
  return {
    kind: extra.kind ?? "unknown",
    category,
    retryable: CATEGORY_RETRYABLE[category],
    retryDelayMs: extra.retryDelayMs ?? null,
    httpStatus: extra.httpStatus ?? null,
    signal: extra.signal ?? null,
    adapterCode: extra.adapterCode ?? null,
  };
}

/** A typed `transient` signal: a `timeout` kind is the timeout category; every
 * other adapter-declared transient is a generic retryable harness error. */
export function classifyTransientSignal(
  t: NonNullable<HarnessEvent["transient"]>,
): TransientFailureObservation {
  const category: HarnessFailureCategory =
    t.kind === "timeout" ? "timeout" : "unknown_harness_error";
  return observation(category, { kind: t.kind, retryDelayMs: t.retry_delay_ms ?? null });
}

/** A typed `rate_limit` signal is a first-class transient category (not only a
 * W5.4 rotation signal). */
export function classifyRateLimit(retryDelayMs: number | null): TransientFailureObservation {
  return observation("rate_limited", { retryDelayMs });
}

/** Map the vendor's typed `status.error_category` onto the taxonomy. Only the
 * deterministic FAILURE classes are surfaced here; rate limits arrive via the
 * dedicated `rate_limit` signal, and transient/overload retries the vendor
 * drives itself are not our failures (returns null → not recorded). */
export function classifyStatusError(
  ec: NonNullable<NonNullable<HarnessEvent["status"]>["error_category"]>,
  retryDelayMs: number | null,
): TransientFailureObservation | null {
  let category: HarnessFailureCategory | null;
  switch (ec) {
    case "authentication_failed":
      category = "auth_failed";
      break;
    case "oauth_org_not_allowed":
    case "model_not_found":
      category = "capability_refused";
      break;
    case "billing_error":
    case "invalid_request":
    case "max_output_tokens":
      category = "config_error";
      break;
    default:
      // rate_limit/overloaded/server_error/unknown: not surfaced from status.
      category = null;
  }
  if (!category) return null;
  return observation(category, { retryDelayMs, adapterCode: ec });
}

/**
 * Classify a process crash from the run loop's TYPED `completed` payload
 * (never prose): a spawn failure is a config/environment error (retrying
 * replays the same missing binary/bad config); a non-aborted signal kill or
 * non-zero exit is a settled crash. An aborted completion (our watchdog/cancel)
 * is never a crash. Returns null when the completion carries no crash evidence.
 */
export function classifyCompletedCrash(
  payload: Record<string, unknown> | undefined,
): TransientFailureObservation | null {
  if (!payload || payload["aborted"]) return null;
  const spawnFailed = payload["spawn_failed"] === true;
  const signal = typeof payload["exit_signal"] === "string" ? payload["exit_signal"] : null;
  const exitCode = typeof payload["exit_code"] === "number" ? payload["exit_code"] : null;
  if (spawnFailed) {
    return observation("config_error", { signal, adapterCode: "spawn_failed" });
  }
  if (signal !== null || (exitCode !== null && exitCode !== 0)) {
    return observation("process_crash", {
      signal,
      adapterCode: exitCode !== null ? `exit_${exitCode}` : null,
    });
  }
  return null;
}

/**
 * Classify an adapter/stream throw. The inactivity watchdog surfaces a typed
 * `HarnessInactivityTimeoutError` (timeout); every other throw is a process
 * crash. A THROWN failure is a give-up, not a mid-stream recoverable transient:
 * the watchdog already aborted a wedged stream and a crashed child is settled,
 * so it is classified and disclosed but never auto-retried here (preserving the
 * pre-#31 terminate-on-throw behavior). Never parses prose — `errorName` is the
 * constructor name.
 */
export function classifyAdapterThrow(opts: {
  errorName: string | null;
  signal?: string | null;
}): TransientFailureObservation {
  const isTimeout = opts.errorName === "HarnessInactivityTimeoutError";
  const base = observation(isTimeout ? "timeout" : "process_crash", {
    kind: isTimeout ? "timeout" : "unknown",
    signal: opts.signal ?? null,
  });
  return { ...base, retryable: false };
}
