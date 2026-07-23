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
/** QA-027: how long to await the source's cleanup (iterator.return) before the
 * terminal proceeds anyway. A killed child's stream closes well within this, so
 * the run terminal follows the death proof; a non-cooperative in-memory source
 * cannot park the run forever. */
const RETURN_CLEANUP_GRACE_MS = 2000;

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
  },
): AsyncIterable<T> {
  const iterator = source[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  let wake: (() => void) | null = null;
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
  try {
    arm();
    for (;;) {
      // Race the next event against the watchdog firing: after onTimeout()
      // aborts the child, the source SHOULD end on its own, but a stuck
      // iterator must not keep the run parked — the sentinel wakes the pump.
      const next = await Promise.race([
        iterator.next(),
        new Promise<"timeout">((resolve) => {
          wake = () => resolve("timeout");
          if (timedOut) resolve("timeout");
        }),
      ]);
      if (next === "timeout" || timedOut) {
        throw new HarnessInactivityTimeoutError(opts.timeoutMs);
      }
      if (next.done) return;
      arm();
      yield next.value;
    }
  } finally {
    if (timer) clearTimeout(timer);
    // AWAIT the source's cleanup (QA-027): iterator.return() drives
    // spawnProcess's finally -> requestCancel, i.e. the process teardown. It
    // used to be fire-and-forgotten, so the agent loop could break on abort and
    // the run could reach its `cancelled` terminal BEFORE the child was proven
    // dead. Awaiting makes the terminal strictly follow the death proof.
    //
    // BUT bound the wait: a cooperative source (the spawnProcess-backed stream)
    // resolves return() as soon as the killed child closes, so the terminal
    // follows the death proof in the real path. A pathological in-memory source
    // suspended in an UNRELATED await (e.g. a wedged fixture) must never park
    // the terminal forever, so the cleanup is raced against a bounded grace.
    const ret = iterator.return?.(undefined as never);
    if (ret) {
      await Promise.race([
        Promise.resolve(ret).then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => {
          const grace = setTimeout(resolve, RETURN_CLEANUP_GRACE_MS);
          (grace as unknown as { unref?: () => void }).unref?.();
        }),
      ]);
    }
  }
}
