/**
 * Inactivity watchdog for harness event streams: a wedged vendor CLI
 * that stops emitting events would otherwise park the run in `running`
 * forever — only reviewers had a timeout. The combinator pumps the source
 * iterator and re-arms a timer only when the caller's typed progress policy
 * accepts an event. Transport/status chatter remains observable without
 * turning into an unlimited lease on the child process.
 *
 * This is an INACTIVITY window, not a wall-clock cap: long runs are fine as
 * long as they keep talking. Distinct from cancellation by construction —
 * the caller decides what the timeout means (typed harness_timeout failure),
 * and a user cancel still routes through the run signal.
 */
import type { HarnessEvent } from "@claudexor/schema";

/** QA-027: how long to await the source's cleanup after an inactivity timeout
 * (or an early caller break) before the watchdog gives up and lets the terminal
 * proceed anyway. This MUST exceed spawnProcess's own whole-tree death-proof
 * deadline (`cancelDeadlineMs`, default `cancelKillDelayMs + 4000` = 5000ms) so
 * the underlying runCliHarness reap runs to completion and its typed
 * `termination_unconfirmed` terminal fact (14e958a3) is emitted through the
 * stream. The previous 2000ms grace was SHORTER than the reap deadline, so on an
 * inactivity timeout the caller could terminalize BEFORE death was proven and
 * the unconfirmed-death disclosure was dropped (runCliHarness wires no
 * `onTerminationUnconfirmed` callback, the only channel an early
 * iterator.return leaves). A pathological in-memory source still cannot park the
 * run past this bound. Overridable per-call for deterministic tests. */
const REAP_PROOF_DEADLINE_MS = 8000;

/** Node clamps a setTimeout delay above 2^31-1 ms to 1 ms. A longer configured
 * window is waited in chunks so its intended duration is preserved, not capped. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class HarnessInactivityTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(
      `harness produced no events for ${timeoutMs}ms (inactivity watchdog); ` +
        `the stream was aborted and the process group killed. Raise ` +
        `runtime.harness_inactivity_timeout_ms if this workload is legitimately silent.`,
    );
    this.name = "HarnessInactivityTimeoutError";
  }
}

function unknownEventKindIsNotProgress(_kind: never): false {
  // Runtime adapters are schema-validated, but fail closed if an untyped future
  // value reaches this boundary. The `never` parameter also makes a newly added
  // HarnessEvent kind a compile error until this policy is reviewed.
  return false;
}

/**
 * The one closed policy for the no-agent-progress window
 * (`runtime.harness_inactivity_timeout_ms`; its default is owned by the
 * config schema). Lifecycle, transport, retry, usage, error, and interaction
 * events stay in telemetry/UI but cannot postpone the watchdog. Interaction
 * waiting is handled separately by `isSuspended`: the interaction policy may
 * impose a finite answer deadline or disable it until
 * answer/cancel/terminal/restart.
 */
export function countsAsAgentProgress(event: HarnessEvent): boolean {
  if (event.plan_progress !== undefined) return true;
  switch (event.type) {
    case "thinking":
    case "message":
      return (event.text?.trim().length ?? 0) > 0;
    case "tool_call":
    case "tool_result":
    case "file_change":
    case "patch_produced":
      return true;
    case "context":
      return event.context?.kind === "compaction_completed";
    case "started":
    case "interaction_requested":
    case "usage":
    case "error":
    case "status":
    case "completed":
      return false;
    default:
      return unknownEventKindIsNotProgress(event.type);
  }
}

export async function* withInactivityWatchdog<T>(
  source: AsyncIterable<T>,
  opts: {
    /** Null disables inactivity timing while retaining stream cleanup. */
    timeoutMs: number | null;
    /** Closed typed policy deciding which values prove useful progress. */
    countsAsProgress: (value: T) => boolean;
    /** Called once when the window elapses; abort the stream here. */
    onTimeout: () => void;
    /**
     * Legitimate-silence probe. When the window elapses while this returns
     * true (e.g. a question is awaiting the USER's answer), the watchdog
     * RE-ARMS instead of firing — waiting on a human is not a wedged harness,
     * while the interaction channel applies its configured finite deadline or
     * remains suspended until answer/cancel/terminal/restart when disabled.
     */
    isSuspended?: () => boolean;
    /**
     * The caller's Stop, observed when the caller asks for the next value.
     * Once aborted, further values come from the same bounded drain as an
     * inactivity timeout and the stream then ends without an error, so a caller
     * that keeps consuming after Stop can record what the cancelled source
     * reports during teardown instead of discarding it through iterator.return.
     * The drain and the closing iterator.return share one cleanupDeadlineMs.
     * A next() already pending when Stop fires is not woken by it; that read
     * ends when the source answers or the inactivity timer fires. What the
     * caller accepts from the drained values stays its decision.
     */
    stopSignal?: AbortSignal;
    /** Monotonic suspension transition counter. This closes the polling gap
     * where a wait begins and ends entirely between inactivity timer ticks. */
    suspensionVersion?: () => number;
    /**
     * How long to drain the aborted source's cleanup after a timeout (or await
     * iterator.return on an early caller break) before giving up. MUST exceed
     * the source's process-reap deadline so its typed termination_unconfirmed
     * terminal fact surfaces; defaults to {@link REAP_PROOF_DEADLINE_MS}.
     */
    cleanupDeadlineMs?: number;
  },
): AsyncIterable<T> {
  const iterator = source[Symbol.asyncIterator]();
  const timeoutMs = opts.timeoutMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  let wake: (() => void) | null = null;
  // A suspension can begin and end between timer callbacks. Remember that the
  // event pump observed it so the first unsuspended boundary starts a fresh
  // useful-progress window instead of charging the user-wait interval to the
  // harness and firing immediately after an answer.
  let suspensionObserved = false;
  let observedSuspensionVersion = timeoutMs === null ? 0 : (opts.suspensionVersion?.() ?? 0);
  const cleanupDeadlineMs = opts.cleanupDeadlineMs ?? REAP_PROOF_DEADLINE_MS;
  const arm = (resetSuspension = true): void => {
    if (timeoutMs === null) return;
    if (resetSuspension) {
      suspensionObserved = false;
      observedSuspensionVersion = opts.suspensionVersion?.() ?? observedSuspensionVersion;
    }
    if (timer) clearTimeout(timer);
    const elapsed = (): void => {
      const currentSuspensionVersion = opts.suspensionVersion?.() ?? observedSuspensionVersion;
      if (opts.isSuspended?.()) {
        suspensionObserved = true;
        observedSuspensionVersion = currentSuspensionVersion;
        arm(false);
        return;
      }
      if (suspensionObserved || currentSuspensionVersion !== observedSuspensionVersion) {
        // Resume has no guaranteed harness event of its own. The first timer
        // boundary that proves the interaction is over starts a full new
        // window; the next boundary may time out if no agent progress follows.
        suspensionObserved = false;
        observedSuspensionVersion = currentSuspensionVersion;
        arm(false);
        return;
      }
      timedOut = true;
      opts.onTimeout();
      wake?.();
    };
    const wait = (remainingMs: number): void => {
      const chunk = Math.min(remainingMs, MAX_TIMER_DELAY_MS);
      timer = setTimeout(
        () => (remainingMs > chunk ? wait(remainingMs - chunk) : elapsed()),
        chunk,
      );
    };
    wait(Math.max(1, timeoutMs));
    // Deliberately NOT unref'd: a wedged in-process stream can leave nothing
    // else on the event loop, and an unref'd watchdog would let node exit 0
    // mid-run instead of firing the timeout.
  };
  // Hold the in-flight next() across the race so a timeout NEVER orphans it: the
  // very next value the source produces (the source reacting to the abort with
  // its terminal death-proof events) must be consumed by the drain, not silently
  // eaten by an abandoned pending promise from this loop.
  let pending: Promise<IteratorResult<T>> | null = null;
  // A recognized Stop gets ONE cleanup allowance, starting when the pump sees
  // it, shared by the drain and the final iterator.return() below; the timeout
  // path keeps its own drain plus return grace unchanged.
  let stopCleanupEndsAt: number | null = null;
  try {
    arm();
    for (;;) {
      if (opts.stopSignal?.aborted) {
        if (timer) clearTimeout(timer);
        stopCleanupEndsAt = performance.now() + cleanupDeadlineMs;
        yield* drainAbortedSource(iterator, iterator.next(), cleanupDeadlineMs);
        return;
      }
      if (!pending) pending = iterator.next();
      // Race the next event against the watchdog firing: after onTimeout()
      // aborts the child, the source SHOULD end on its own, but a stuck
      // iterator must not keep the run parked — the sentinel wakes the pump.
      const nextResult = pending.then<
        { kind: "next"; result: IteratorResult<T> } | { kind: "source_error"; error: unknown },
        { kind: "next"; result: IteratorResult<T> } | { kind: "source_error"; error: unknown }
      >(
        (result) => ({ kind: "next", result }),
        (error) => ({ kind: "source_error", error }),
      );
      const raced =
        timeoutMs === null
          ? await nextResult
          : await Promise.race([
              nextResult,
              new Promise<{ kind: "timeout" }>((resolve) => {
                wake = () => resolve({ kind: "timeout" });
                if (timedOut) resolve({ kind: "timeout" });
              }),
            ]);
      if (raced.kind === "timeout" || timedOut) {
        // Inactivity fired. onTimeout() already aborted the child. Do NOT throw
        // and terminalize yet: DRAIN the aborted source to its process-reap
        // deadline so the underlying spawnProcess whole-tree death proof runs
        // and its typed `termination_unconfirmed` terminal fact (14e958a3) is
        // emitted THROUGH the stream — instead of being cut off by an early
        // iterator.return whose only disclosure channel (spawnProcess's
        // `onTerminationUnconfirmed` callback) runCliHarness never wires up.
        // The still-pending next() is handed to the drain so the FIRST terminal
        // event is not lost; yielding the drained events lets the caller see the
        // unconfirmed-death error/terminal before it terminalizes on the throw.
        yield* drainAbortedSource(iterator, pending, cleanupDeadlineMs);
        throw new HarnessInactivityTimeoutError(timeoutMs!);
      }
      if (raced.kind === "source_error") throw raced.error;
      pending = null;
      if (raced.result.done) return;
      if (timeoutMs !== null) {
        if (opts.countsAsProgress(raced.result.value)) arm();
        else if (opts.isSuspended?.()) suspensionObserved = true;
      }
      yield raced.result.value;
    }
  } finally {
    if (timer) clearTimeout(timer);
    // AWAIT the source's cleanup (QA-027): iterator.return() drives
    // spawnProcess's finally -> requestCancel, i.e. the process teardown. It
    // used to be fire-and-forgotten, so the agent loop could break on abort and
    // the run could reach its `cancelled` terminal BEFORE the child was proven
    // dead. Awaiting makes the terminal strictly follow the death proof.
    //
    // Bound the wait by the SAME reap deadline the drain uses (not a shorter
    // grace): a cooperative spawnProcess-backed stream resolves return() as soon
    // as the reap settles, so the terminal follows the death proof in the real
    // path; a pathological in-memory source suspended in an UNRELATED await must
    // never park the terminal past the reap's own deadline. (After a timeout the
    // drain above already ran the source to completion, so this return() is then
    // a fast no-op.) After a Stop the return() still runs, but is awaited only
    // for what remains of the Stop's single allowance: a drain that already
    // spent it adds no second wait, and what the source reports past that
    // cutoff is not evidence this stream can still deliver.
    const graceMs =
      stopCleanupEndsAt === null
        ? cleanupDeadlineMs
        : Math.max(0, stopCleanupEndsAt - performance.now());
    const ret = iterator.return?.(undefined as never);
    if (ret) {
      const settled = Promise.resolve(ret).then(
        () => undefined,
        () => undefined,
      );
      if (graceMs > 0) {
        await Promise.race([
          settled,
          new Promise<void>((resolve) => {
            const grace = setTimeout(resolve, graceMs);
            (grace as unknown as { unref?: () => void }).unref?.();
          }),
        ]);
      }
    }
  }
}

/**
 * After an inactivity timeout or the caller's Stop aborted the child, pump the
 * source to completion so its own teardown/death-proof events (the typed
 * `termination_unconfirmed` terminal fact and terminal `completed`) surface
 * through the stream, bounded by the process-reap deadline so a source that
 * cannot prove death still cannot park the run. The inactivity timer is NOT
 * re-armed here — the source is being torn down, and a second timeout would
 * race the reap it is waiting on.
 */
async function* drainAbortedSource<T>(
  iterator: AsyncIterator<T>,
  pending: Promise<IteratorResult<T>>,
  deadlineMs: number,
): AsyncGenerator<T> {
  const deadline = new Promise<"deadline">((resolve) => {
    const t = setTimeout(() => resolve("deadline"), Math.max(1, deadlineMs));
    (t as unknown as { unref?: () => void }).unref?.();
  });
  // Start from the loop's still-in-flight next() (the abort-reaction event),
  // then keep pumping until the source ends or the reap deadline elapses.
  let cur = pending;
  for (;;) {
    const drained = await Promise.race([
      cur.then<
        { kind: "next"; result: IteratorResult<T> } | { kind: "source_error" },
        { kind: "next"; result: IteratorResult<T> } | { kind: "source_error" }
      >(
        (result) => ({ kind: "next", result }),
        () => ({ kind: "source_error" }),
      ),
      deadline,
    ]);
    // Source could not prove death within the reap deadline — give up draining;
    // the outer `finally` runs iterator.return() (also bounded) as a last resort.
    if (drained === "deadline") return;
    // Abort commonly rejects the in-flight native iterator. The timeout or Stop
    // has already established the terminal cause, so stop draining and let the
    // caller receive the typed inactivity timeout (or the Stop's end of stream)
    // instead of misclassifying this cleanup rejection as a process crash.
    if (drained.kind === "source_error") return;
    if (drained.result.done) return;
    yield drained.result.value;
    cur = iterator.next();
  }
}
