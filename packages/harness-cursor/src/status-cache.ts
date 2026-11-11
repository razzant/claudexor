import { observeHarnessProgram } from "@claudexor/core";
import { CURSOR_PROGRAM } from "./program.js";
import { uptime } from "node:os";
import { performance } from "node:perf_hooks";
import {
  credentialMutationWindowOpen,
  withoutRunScopeMarkers,
  type CredentialProfileProbeOptions,
} from "@claudexor/core";
import {
  CURSOR_STATUS_TIMEOUT_MS,
  probeCursorNativeAuth,
  type CursorStatusObservation,
} from "./auth.js";

type EnvMap = Record<string, string | null | undefined>;
/** One `cursor-agent status` child under `budgetMs`; it stops when `abortSignal` fires. */
type StatusChild = (
  env: EnvMap | undefined,
  abortSignal: AbortSignal | undefined,
  budgetMs: number,
) => Promise<CursorStatusObservation>;
/** One caller's read of a row store's sign-in status (`options.pinned`: #532). */
export type CursorStatusRead = (
  env?: EnvMap,
  abortSignal?: AbortSignal,
  options?: CredentialProfileProbeOptions,
) => Promise<CursorStatusObservation>;
type Authenticated = Extract<CursorStatusObservation, { kind: "authenticated" }>;

/**
 * How long a POSITIVE status answer for one profile store is reused instead
 * of spawning another `cursor-agent status`. Short on purpose: long enough to
 * cover one run's admission → pool readiness → spawn → rotation readiness
 * chain and a burst of concurrent runs; shorter than the doctor cache's reuse
 * of an OK report. A reuse keeps the instant the vendor answered.
 */
export const CURSOR_STATUS_REUSE_MS = 60_000;

/**
 * How long a store's last POSITIVE answer may stand in, disclosed as stale,
 * when a later probe of that store did not answer within its budget (#363,
 * owner-approved INV-135 amendment). The same five-minute horizon as quota
 * freshness: long enough to outlast a burst of host load across several runs,
 * far shorter than a login session. Only a timeout consults it; any other
 * unknown answer, a logged-out answer or a credential mutation never does.
 */
export const CURSOR_STATUS_LAST_POSITIVE_MS = 5 * 60_000;

/**
 * How long an explicit pin waits for its row store's status answer (#532). A
 * pin is never admitted on an unanswered or older answer (INV-135), so instead
 * of deciding at the ordinary `CURSOR_STATUS_TIMEOUT_MS` it keeps waiting for
 * the same status child until that child answers, the caller cancels, or this
 * bound passes; then it refuses because Cursor did not confirm sign-in in time.
 * It is also the lifetime bound of every shared status child.
 */
export const CURSOR_PINNED_STATUS_WAIT_MS = 120_000;

/** True only when the supplied env explicitly selects the vendor FILE store
 * (an account row's HOME, `AGENT_CLI_CREDENTIAL_STORE=file`). Any other env
 * would resolve the HOST Keychain login, which is never read (D-U3). */
export function cursorFileStoreEnv(env?: EnvMap): boolean {
  return env?.["AGENT_CLI_CREDENTIAL_STORE"] === "file";
}

/**
 * The auth store a profile-scoped status probe reads, or null when the env is
 * not one this coordinator may share: only the vendor FILE store with the API
 * key explicitly scrubbed (every row env from `cursorProfileRunEnv`). The
 * store is selected by HOME/USERPROFILE, XDG_CONFIG_HOME and APPDATA; the
 * lane's CURSOR_CONFIG_DIR relocates session state, not auth, so admission
 * (row HOME state) and spawn (lane HOME state) share one entry.
 */
function statusStoreKey(env?: EnvMap): string | null {
  if (!env || !cursorFileStoreEnv(env) || env["CURSOR_API_KEY"] !== null) return null;
  const home = env["HOME"];
  if (!home) return null;
  return JSON.stringify([home, env["USERPROFILE"], env["XDG_CONFIG_HOME"], env["APPDATA"]]);
}

function abortedProbe(): CursorStatusObservation {
  return { kind: "unknown", error: "cursor-agent status probe aborted" };
}

function supersededProbe(): CursorStatusObservation {
  return {
    kind: "unknown",
    error: "cursor-agent status answer predates a credential change; login state unknown",
  };
}

/** This caller's own wait ended first: the vendor has not answered it (#532). */
function unansweredProbe(waitMs: number): CursorStatusObservation {
  return {
    kind: "unknown",
    error: `cursor-agent status did not answer within ${waitMs / 1000}s; login state unknown`,
    timedOut: true,
  };
}

/** One owned status child per store and the callers still waiting for it. */
interface SharedProbe {
  controller: AbortController;
  fenced: boolean;
  answer: Promise<CursorStatusObservation>;
  /** Each waiter's exit; the child lives only while this set is not empty. */
  waiters: Set<(observation: CursorStatusObservation) => void>;
}

/**
 * ONE process-local coordinator for profile-scoped `cursor-agent status`
 * (#363). Run admission, pool readiness, the adapter's spawn-time route check
 * and rotation readiness ask the SAME row store within seconds, and concurrent
 * runs ask at once; on a loaded host every extra child raises the chance that
 * a signed-in account reads as not ready. So concurrent callers share one child
 * per store, and a positive answer is reused for `CURSOR_STATUS_REUSE_MS`.
 *
 * Each caller's wait is its own (#532): an ordinary caller decides after
 * `CURSOR_STATUS_TIMEOUT_MS`, an explicit pin keeps waiting for the same child
 * up to `CURSOR_PINNED_STATUS_WAIT_MS`, and a caller's abort ends only its own
 * wait. The child belongs to the coordinator, is bounded by the pinned wait,
 * and is stopped as soon as no caller still waits for it, so it never outlives
 * its waiters; if such a stopped child still answers, only a logged-out answer
 * is kept. It is spawned without the run scope marker of the caller that
 * happened to start it, so that run's terminal never ends a child another run
 * still waits for; the host's own markers stay on it. A wait that ends
 * unanswered is unknown, never a logout and never a pass; while the store's
 * last positive answer is younger than `CURSOR_STATUS_LAST_POSITIVE_MS`, that
 * unknown carries it as `lastPositive`.
 * A logged-out answer drops the store's positive entirely. `clear()`
 * (credential mutations) drops every positive, stops every in-flight child and
 * answers its waiters unknown at once: a verdict from that child may describe
 * the store before the change.
 *
 * Every age is MONOTONIC (`monotonicMs`): a wall-clock step can neither keep
 * an answer alive nor expire it early. The wall clock only stamps the instant
 * the vendor answered, for disclosure. While a login may be rewriting the
 * cursor store (`mutating`, the daemon's setup lifecycle), a probe answers its
 * callers live and nothing else: no reuse, no retained positive, no last
 * positive behind a timeout — neither for a probe started inside the window
 * nor for one that ends inside it.
 */
export function createCursorStatusCoordinator(options: {
  probe: StatusChild;
  programKey?: (env?: EnvMap) => Promise<string>;
  monotonicMs?: () => number;
  wallMs?: () => number;
  mutating?: () => boolean;
  reuseMs?: number;
  lastPositiveMs?: number;
}): { status: CursorStatusRead; clear(): void } {
  // Linux performance.now() excludes suspend. libuv's uptime uses /proc/uptime
  // or CLOCK_BOOTTIME, both suspend-inclusive; its fallback truncates seconds.
  // Use an upper age bound there (less than two seconds early expiry), never
  // extend freshness through sleep or let a wall-clock change decide it.
  const linuxUptime = !options.monotonicMs && process.platform === "linux";
  const monotonicMs =
    options.monotonicMs ?? (linuxUptime ? () => uptime() * 1000 : () => performance.now());
  const clockUncertaintyMs = linuxUptime ? 1000 : 0;
  const wallMs = options.wallMs ?? Date.now;
  const mutating = options.mutating ?? (() => credentialMutationWindowOpen("cursor"));
  const reuseMs = options.reuseMs ?? CURSOR_STATUS_REUSE_MS;
  const lastPositiveMs = options.lastPositiveMs ?? CURSOR_STATUS_LAST_POSITIVE_MS;
  // One entry per store: its latest positive answer, reused as fresh inside
  // `reuseMs` and offered as stale evidence to a timeout inside `lastPositiveMs`.
  const positives = new Map<
    string,
    { observation: Authenticated; atMonotonicMs: number; observedAt: string }
  >();
  const pending = new Map<string, SharedProbe>();
  let generation = 0;
  const livePositive = (key: string, withinMs: number) => {
    const entry = positives.get(key);
    if (!entry) return null;
    const ageMs = Math.ceil(Math.max(0, monotonicMs() - entry.atMonotonicMs + clockUncertaintyMs));
    if (ageMs < withinMs) return { entry, ageMs };
    if (ageMs >= lastPositiveMs) positives.delete(key);
    return null;
  };
  // Only an unanswered wait may lean on the last positive answer, and only
  // outside a mutation window; it stays unknown and never refreshes that age.
  const withLastPositive = (
    key: string,
    observation: CursorStatusObservation,
    settled: boolean,
  ): CursorStatusObservation => {
    if (observation.kind !== "unknown" || !observation.timedOut || !settled) return observation;
    const stale = livePositive(key, lastPositiveMs);
    return stale
      ? { ...observation, lastPositive: { observedAt: stale.entry.observedAt, ageMs: stale.ageMs } }
      : observation;
  };
  const share = (key: string, env: EnvMap, fenced: boolean): SharedProbe => {
    const startedGeneration = generation;
    const controller = new AbortController();
    const answer = options
      .probe(withoutRunScopeMarkers(env), controller.signal, CURSOR_PINNED_STATUS_WAIT_MS)
      .catch((err: unknown): CursorStatusObservation => ({
        kind: "unknown",
        error: err instanceof Error ? err.message : String(err),
      }))
      .then((observation): CursorStatusObservation => {
        if (pending.get(key) === shared) pending.delete(key);
        if (startedGeneration !== generation) return supersededProbe();
        // An answer read inside a mutation window is the vendor's live
        // answer for its callers only; it seeds and consumes nothing.
        const settled = !fenced && !mutating();
        if (observation.kind === "loggedOut") {
          positives.delete(key);
          return observation;
        }
        if (observation.kind === "unknown") return withLastPositive(key, observation, settled);
        const observedAt = new Date(wallMs()).toISOString();
        const stamped = { ...observation, observedAt };
        // A child stopped because no caller waited for it any more can still
        // finish after a newer read answered, so its positive is never kept; a
        // logged-out answer above revokes either way, failing closed.
        if (settled && !controller.signal.aborted) {
          positives.set(key, { observation: stamped, atMonotonicMs: monotonicMs(), observedAt });
        }
        return stamped;
      });
    const shared: SharedProbe = { controller, fenced, answer, waiters: new Set() };
    pending.set(key, shared);
    return shared;
  };
  const wait = (
    key: string,
    shared: SharedProbe,
    abortSignal: AbortSignal | undefined,
    waitMs: number,
  ): Promise<CursorStatusObservation> =>
    new Promise((resolve) => {
      const leave = (observation: CursorStatusObservation) => {
        if (!shared.waiters.delete(leave)) return;
        clearTimeout(timer);
        abortSignal?.removeEventListener("abort", onAbort);
        // The child lives only while some caller still waits for it.
        if (shared.waiters.size === 0 && pending.get(key) === shared) {
          pending.delete(key);
          shared.controller.abort();
        }
        resolve(observation);
      };
      const onAbort = () => leave(abortedProbe());
      const timer = setTimeout(
        () => leave(withLastPositive(key, unansweredProbe(waitMs), !shared.fenced && !mutating())),
        waitMs,
      );
      shared.waiters.add(leave);
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      void shared.answer.then((observation) =>
        leave(abortSignal?.aborted ? abortedProbe() : observation),
      );
    });
  return {
    async status(env, abortSignal, probeOptions) {
      const waitMs =
        probeOptions?.pinned === true ? CURSOR_PINNED_STATUS_WAIT_MS : CURSOR_STATUS_TIMEOUT_MS;
      const startedGeneration = generation;
      const initiallyFenced = mutating();
      const storeKey = statusStoreKey(env);
      const key =
        storeKey === null
          ? null
          : JSON.stringify([storeKey, options.programKey ? await options.programKey(env) : null]);
      if (startedGeneration !== generation) return supersededProbe();
      if (env === undefined || key === null) return options.probe(env, abortSignal, waitMs);
      if (abortSignal?.aborted) return abortedProbe();
      const fenced = initiallyFenced || mutating();
      const fresh = fenced ? null : livePositive(key, reuseMs);
      if (fresh) return fresh.entry.observation;
      return wait(key, pending.get(key) ?? share(key, env, fenced), abortSignal, waitMs);
    },
    clear() {
      generation += 1;
      positives.clear();
      const inFlight = [...pending.values()];
      pending.clear();
      for (const shared of inFlight) {
        shared.controller.abort();
        for (const leave of [...shared.waiters]) leave(supersededProbe());
      }
    },
  };
}

const processCoordinator = createCursorStatusCoordinator({
  programKey: async (env) => (await observeHarnessProgram(CURSOR_PROGRAM, env)).key,
  probe: (env, abortSignal, budgetMs) =>
    probeCursorNativeAuth(env, abortSignal, undefined, budgetMs),
});

/** The adapter's default native status read: coordinated per profile store. */
export const coordinatedCursorNativeAuth: CursorStatusRead = (env, abortSignal, options) =>
  processCoordinator.status(env, abortSignal, options);

/** Drop every reused answer (credential mutation / login / logout). */
export function clearCursorStatusCache(): void {
  processCoordinator.clear();
}
