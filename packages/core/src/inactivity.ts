/**
 * Inactivity watchdog for harness event streams: a wedged vendor CLI
 * that stops emitting events would otherwise park the run in `running`
 * forever — only reviewers had a timeout. The combinator pumps the source
 * iterator and re-arms a timer on EVERY event; when the window elapses with
 * no event, `onTimeout` fires exactly once (the caller aborts its per-attempt
 * controller, which kills the process group through the existing abort
 * plumbing) and the pump stops waiting for the source.
 *
 * This is an INACTIVITY window, not a wall-clock cap: long runs are fine as
 * long as they keep talking. Distinct from cancellation by construction —
 * the caller decides what the timeout means (typed harness_timeout failure),
 * and a user cancel still routes through the run signal.
 */
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

export async function* withInactivityWatchdog<T>(
  source: AsyncIterable<T>,
  opts: {
    timeoutMs: number;
    /** Called once when the window elapses; abort the stream here. */
    onTimeout: () => void;
    /**
     * Legitimate-silence probe. When the window elapses while this returns
     * true (e.g. a question is awaiting the USER's answer), the watchdog
     * RE-ARMS instead of firing — waiting on a human is not a wedged harness,
     * and the interaction channel enforces its own answer-wait budget.
     */
    isSuspended?: () => boolean;
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
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  let wake: (() => void) | null = null;
  const cleanupDeadlineMs = opts.cleanupDeadlineMs ?? REAP_PROOF_DEADLINE_MS;
  const arm = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => {
        if (opts.isSuspended?.()) {
          arm();
          return;
        }
        timedOut = true;
        opts.onTimeout();
        wake?.();
      },
      Math.max(1, opts.timeoutMs),
    );
    // Deliberately NOT unref'd: a wedged in-process stream can leave nothing
    // else on the event loop, and an unref'd watchdog would let node exit 0
    // mid-run instead of firing the timeout.
  };
  // Hold the in-flight next() across the race so a timeout NEVER orphans it: the
  // very next value the source produces (the source reacting to the abort with
  // its terminal death-proof events) must be consumed by the drain, not silently
  // eaten by an abandoned pending promise from this loop.
  let pending: Promise<IteratorResult<T>> | null = null;
  try {
    arm();
    for (;;) {
      if (!pending) pending = iterator.next();
      // Race the next event against the watchdog firing: after onTimeout()
      // aborts the child, the source SHOULD end on its own, but a stuck
      // iterator must not keep the run parked — the sentinel wakes the pump.
      const raced = await Promise.race([
        pending.then((result): { kind: "next"; result: IteratorResult<T> } => ({
          kind: "next",
          result,
        })),
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
        yield* drainAfterTimeout(iterator, pending, cleanupDeadlineMs);
        throw new HarnessInactivityTimeoutError(opts.timeoutMs);
      }
      pending = null;
      if (raced.result.done) return;
      arm();
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
    // a fast no-op.)
    const ret = iterator.return?.(undefined as never);
    if (ret) {
      await Promise.race([
        Promise.resolve(ret).then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => {
          const grace = setTimeout(resolve, cleanupDeadlineMs);
          (grace as unknown as { unref?: () => void }).unref?.();
        }),
      ]);
    }
  }
}

/**
 * After an inactivity timeout aborted the child, pump the source to completion
 * so its own teardown/death-proof events (the typed `termination_unconfirmed`
 * terminal fact and terminal `completed`) surface through the stream, bounded by
 * the process-reap deadline so a source that cannot prove death still cannot
 * park the run. The inactivity timer is NOT re-armed here — the source is being
 * torn down, and a second timeout would race the reap it is waiting on.
 */
async function* drainAfterTimeout<T>(
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
      cur.then((result): { kind: "next"; result: IteratorResult<T> } => ({ kind: "next", result })),
      deadline,
    ]);
    // Source could not prove death within the reap deadline — give up draining;
    // the outer `finally` runs iterator.return() (also bounded) as a last resort.
    if (drained === "deadline") return;
    if (drained.result.done) return;
    yield drained.result.value;
    cur = iterator.next();
  }
}
