import type { CaptureResult } from "@claudexor/core";
import type { AuthSourceReadiness, HarnessEvent } from "@claudexor/schema";
import { labelStreams, runCapture } from "@claudexor/core";
import { nowIso, redactSecrets } from "@claudexor/util";

/**
 * Native-session probe with a distinct PROBE-FAILURE state (same contract as
 * the codex adapter's probeLogin). `claude auth status` prints a typed JSON
 * verdict; a probe that produces no parseable verdict is a probe error, never
 * a silent "not logged in".
 */
export interface ClaudeAuthStatusProbe {
  loggedIn: boolean;
  authed: boolean;
  authMethod: string | null;
  probeError: string | null;
  /** True only when the result came from the bounded LKG grace window. */
  stale?: boolean;
  /** Age of the LKG auth verdict in milliseconds, when `stale` is true. */
  staleAgeMs?: number;
}

/**
 * Auth-status is a read of one vendor-owned store.  A daemon can ask for the
 * same store from several concurrent runs, so coalesce those reads and keep a
 * short, process-local last-known-good value.  The cache is deliberately not
 * persisted: it is only a grace window for a transient child-process failure,
 * never an auth proof after a daemon restart.
 */
// A transient daemon/Keychain read may keep the last positive verdict alive
// briefly, but this is deliberately much shorter than a login session.  It is
// a recovery grace window, never durable auth proof.
export const CLAUDE_AUTH_STATUS_CACHE_TTL_MS = 60_000;
/** The two-attempt probe must fit the same 10s wall-clock budget as one run. */
export const CLAUDE_AUTH_STATUS_TOTAL_TIMEOUT_MS = 10_000;
const CLAUDE_AUTH_STATUS_RETRY_DELAY_MS = 50;

interface ClaudeAuthStatusCoordinatorOptions {
  env: Record<string, string | null | undefined>;
  configDir: string;
  abortSignal?: AbortSignal;
  runCapture?: typeof runCapture;
}

export function redactClaudeDoctorDetail(text: string): string {
  return redactSecrets(text).slice(0, 500);
}

export function claudeAuthSourceReadiness(input: {
  native: ClaudeAuthStatusProbe;
  oauthAvailable: boolean;
  oauthVerification: "passed" | "failed" | "not_run";
  oauthDetail: string;
  apiKeyAvailable: boolean;
  apiKeyVerification: "passed" | "failed" | "not_run";
  apiKeyDetail: string;
}): AuthSourceReadiness[] {
  const nativeReady =
    input.native.authed && input.native.probeError === null && input.native.stale !== true;
  const nativeAvailability =
    input.native.probeError || input.native.stale
      ? "unknown"
      : input.native.loggedIn
        ? "available"
        : "unavailable";
  const nativeVerification = nativeReady
    ? "passed"
    : input.native.probeError || input.native.stale || !input.native.loggedIn
      ? "not_run"
      : "failed";
  return [
    {
      source: "native_session",
      availability: nativeAvailability,
      verification: nativeVerification,
      detail: nativeReady
        ? "vendor status confirmed authMethod=claude.ai in the exact run environment"
        : input.native.stale
          ? `auth-status probe is stale; using last-known-good native session${
              input.native.staleAgeMs === undefined ? "" : ` (${input.native.staleAgeMs}ms old)`
            }`
          : input.native.probeError
            ? `auth-status probe failed: ${redactClaudeDoctorDetail(input.native.probeError)}`
            : input.native.loggedIn
              ? `Claude is logged in via ${input.native.authMethod ?? "unknown"}, not claude.ai`
              : "official native Claude session is not logged in",
    },
    {
      source: "oauth_token_env",
      availability: input.oauthAvailable ? "available" : "unavailable",
      verification: input.oauthVerification,
      detail: input.oauthDetail,
    },
    {
      source: "api_key_env",
      availability: input.apiKeyAvailable ? "available" : "unavailable",
      verification: input.apiKeyVerification,
      detail: input.apiKeyDetail,
    },
  ];
}

export function staleClaudeAuthStatusEvent(sessionId: string, ageMs?: number): HarnessEvent {
  return {
    type: "message",
    session_id: sessionId,
    ts: nowIso(),
    text: `[auth] native auth-status probe stale; using last-known-good session${
      ageMs === undefined ? "" : ` (${ageMs}ms old)`
    }`,
    payload: {
      auth_status_stale: true,
      ...(ageMs === undefined ? {} : { auth_status_stale_age_ms: ageMs }),
    },
  };
}

interface CachedAuthStatus {
  result: ClaudeAuthStatusProbe;
  checkedAt: number;
}

interface ProbeAttempt {
  result?: ClaudeAuthStatusProbe;
  transportFailure: boolean;
  detail: string;
}

const cache = new Map<string, CachedAuthStatus>();
interface PendingProbe {
  promise: Promise<ClaudeAuthStatusProbe>;
  controller: AbortController;
}
const pending = new Map<string, PendingProbe>();

/** Test seam for isolating the process-local cache between focused cases. */
export function clearClaudeAuthStatusCache(): void {
  cache.clear();
  // An explicit credential mutation must also stop an in-flight probe from
  // repopulating the just-invalidated LKG with a pre-mutation verdict.
  for (const { controller } of pending.values()) controller.abort("credential state changed");
  pending.clear();
}

function cacheKey(bin: string, configDir: string): string {
  return JSON.stringify([bin, configDir]);
}

function probeErrorDetail(capture: CaptureResult): string {
  return (
    labelStreams(capture.stderr, capture.stdout, { transform: redactSecrets }) ??
    `claude auth status exited with ${capture.code ?? capture.signal ?? "unknown result"}`
  );
}

function thrownErrorDetail(err: unknown): string {
  return [...redactSecrets(err instanceof Error ? err.message : String(err))]
    .slice(0, 300)
    .join("");
}

function typedVerdict(capture: CaptureResult): ClaudeAuthStatusProbe | null {
  // A killed/timed-out child may have flushed a complete-looking JSON object
  // before the signal arrived.  The bytes are not a fresh vendor verdict in
  // that case.  Keep exit-code semantics separate: `claude auth status` uses
  // code 1 for a clean logged-out JSON response, so code alone cannot reject
  // an otherwise complete status result.
  if (capture.signal !== null) return null;
  try {
    const verdict = JSON.parse(capture.stdout.trim()) as {
      loggedIn?: unknown;
      authMethod?: unknown;
    };
    if (typeof verdict.loggedIn === "boolean" && typeof verdict.authMethod === "string") {
      return {
        loggedIn: verdict.loggedIn,
        authed: verdict.loggedIn && verdict.authMethod === "claude.ai",
        authMethod: verdict.authMethod,
        probeError: null,
      };
    }
  } catch {
    // The caller turns an absent typed verdict into a probe error below.
  }
  return null;
}

async function waitBeforeRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0 || signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function attempt(
  bin: string,
  options: ClaudeAuthStatusCoordinatorOptions,
  timeoutMs: number,
): Promise<ProbeAttempt> {
  const capture = options.runCapture ?? runCapture;
  try {
    const result = await capture(bin, ["auth", "status"], {
      env: options.env,
      timeoutMs,
      abortSignal: options.abortSignal,
      cancelSignal: "SIGTERM",
      cancelKillDelayMs: 0,
    });
    const verdict = typedVerdict(result);
    if (verdict !== null) {
      return { result: verdict, transportFailure: false, detail: "" };
    }
    return {
      transportFailure: result.code === null || result.signal !== null,
      detail: probeErrorDetail(result),
    };
  } catch (err) {
    return { transportFailure: true, detail: thrownErrorDetail(err) };
  }
}

async function probeUnshared(
  bin: string,
  options: ClaudeAuthStatusCoordinatorOptions,
  key: string,
): Promise<ClaudeAuthStatusProbe> {
  const deadline = Date.now() + CLAUDE_AUTH_STATUS_TOTAL_TIMEOUT_MS;
  let latest = await attempt(bin, options, Math.max(1, deadline - Date.now()));
  if (options.abortSignal?.aborted) return abortedProbe();
  if (latest.result !== undefined) {
    // A clean logged-out or wrong-method verdict is authoritative and must
    // invalidate an older positive cache entry, so it cannot resurrect a
    // session that the vendor explicitly says is gone.
    if (!latest.result.authed) cache.delete(key);
    else cache.set(key, { result: latest.result, checkedAt: Date.now() });
    return latest.result;
  }

  if (latest.transportFailure && !options.abortSignal?.aborted) {
    const remainingBeforeWait = deadline - Date.now();
    if (remainingBeforeWait > 0) {
      await waitBeforeRetry(
        Math.min(CLAUDE_AUTH_STATUS_RETRY_DELAY_MS, remainingBeforeWait),
        options.abortSignal,
      );
      const remaining = deadline - Date.now();
      if (remaining > 0 && !options.abortSignal?.aborted)
        latest = await attempt(bin, options, remaining);
    }
    if (options.abortSignal?.aborted) return abortedProbe();
  }

  if (latest.result !== undefined) {
    if (!latest.result.authed) cache.delete(key);
    else cache.set(key, { result: latest.result, checkedAt: Date.now() });
    return latest.result;
  }

  // Only a transport failure can use LKG.  A parseable vendor error is a real
  // negative signal and remains a probe error, preserving the tri-state caller
  // contract instead of hiding configuration corruption behind stale data.
  if (latest.transportFailure && !options.abortSignal?.aborted) {
    const prior = cache.get(key);
    if (prior !== undefined) {
      const staleAgeMs = Math.max(0, Date.now() - prior.checkedAt);
      if (staleAgeMs <= CLAUDE_AUTH_STATUS_CACHE_TTL_MS) {
        return {
          ...prior.result,
          probeError: null,
          stale: true,
          staleAgeMs,
        };
      }
      cache.delete(key);
    }
  }
  return {
    loggedIn: false,
    authed: false,
    authMethod: null,
    probeError: latest.detail,
  };
}

/**
 * Probe one exact `(binary, config-dir)` store.  Concurrent callers share one
 * child process.  The lock is intentionally process-local and auth-status-only;
 * full Claude runs are not serialized, and no cross-process lock or new wire
 * schema is required for this recovery path.
 */
export async function probeClaudeAuthStatus(
  bin: string,
  options: ClaudeAuthStatusCoordinatorOptions,
): Promise<ClaudeAuthStatusProbe> {
  if (options.abortSignal?.aborted) {
    return {
      loggedIn: false,
      authed: false,
      authMethod: null,
      probeError: "claude auth status probe aborted",
    };
  }
  const key = cacheKey(bin, options.configDir);
  const inFlight = pending.get(key);
  if (inFlight !== undefined) return awaitProbe(inFlight.promise, options.abortSignal);
  // The underlying operation uses its own signal.  A caller cancelling its
  // wait must not cancel the child process shared with a second caller.
  const operationAbort = new AbortController();
  const operation = probeUnshared(bin, { ...options, abortSignal: operationAbort.signal }, key);
  const promise = operation.finally(() => {
    if (pending.get(key)?.promise === promise) pending.delete(key);
  });
  pending.set(key, { promise, controller: operationAbort });
  return awaitProbe(promise, options.abortSignal);
}

function abortedProbe(): ClaudeAuthStatusProbe {
  return {
    loggedIn: false,
    authed: false,
    authMethod: null,
    probeError: "claude auth status probe aborted",
  };
}

async function awaitProbe(
  promise: Promise<ClaudeAuthStatusProbe>,
  signal?: AbortSignal,
): Promise<ClaudeAuthStatusProbe> {
  if (!signal) return promise;
  if (signal.aborted) return abortedProbe();
  return new Promise<ClaudeAuthStatusProbe>((resolve) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const finish = (result: ClaudeAuthStatusProbe) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(signal.aborted ? abortedProbe() : result);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(abortedProbe());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(finish, (err) =>
      finish({
        loggedIn: false,
        authed: false,
        authMethod: null,
        probeError: thrownErrorDetail(err),
      }),
    );
  });
}
