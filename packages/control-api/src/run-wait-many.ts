import { RunWaitManyResult, isTerminalLifecycle, type RunWaitManyInput } from "@claudexor/schema";

/** Committed changes of observation inputs (job and run ids). A host that
 * cannot name them calls the listener without an argument: re-read everything. */
export type RunObservationListener = (changed?: ReadonlySet<string>) => void;

type Summary = RunWaitManyResult["summaries"][number];

export interface RunWaitManyHost {
  /** Without `options` every row is the compact summary; `includeBlocking`
   * asks the snapshot owner to add the fact to rows with pending questions. */
  snapshot(
    ids: readonly string[],
    signal?: AbortSignal,
    options?: { includeBlocking: true },
  ): Promise<Summary[]>;
  /** Post-commit notices for observation inputs. A host without them is polled. */
  subscribe?(listener: RunObservationListener): () => void;
  pollMs?: number;
}

/**
 * One observation, never a worker operation. Every call publishes at least one
 * completed pass with its attention indexes.
 * `waitMs` bounds the wait between passes, never a pass: the deadline wakes a
 * last full pass instead of interrupting one. Only `signal` aborts a read.
 * Between the first and the last pass, a notice re-reads only the handles it
 * names.
 */
export async function observeRunAttention(
  { targets, waitMs, includeBlocking }: RunWaitManyInput,
  host: RunWaitManyHost,
  signal?: AbortSignal,
): Promise<RunWaitManyResult> {
  // Duplicate handles share one read and keep their own positions.
  const positions = new Map<string, number[]>();
  targets.forEach(({ runId }, index) =>
    positions.set(runId, [...(positions.get(runId) ?? []), index]),
  );
  // The snapshot owner computes the opt-in; it is never stripped afterwards.
  const read = (handles: readonly string[]) =>
    includeBlocking
      ? host.snapshot(handles, signal, { includeBlocking: true })
      : host.snapshot(handles, signal);
  const summaries: Summary[] = targets.map(() => ({
    status: null,
    pending: null,
    token: null,
    problem: "not_observed",
  }));
  // The schema includes the final logical JSON byte assertion.
  const result = (wakeReason: RunWaitManyResult["wakeReason"], attention: number[] = []) =>
    RunWaitManyResult.parse({ wakeReason, attention, summaries });
  if (signal?.aborted) return result("aborted");

  let timedOut = waitMs === 0;
  let full = true;
  const dirty = new Set<string>();
  let closed = false;
  let notify: (() => void) | undefined;
  const wake = () => {
    if (!closed) notify?.();
  };
  const changed: RunObservationListener = (keys) => {
    if (!keys) full = true;
    else for (const key of keys) if (positions.has(key)) dirty.add(key);
    if (full || dirty.size > 0) wake();
  };
  const everything = () => {
    full = true;
    wake();
  };
  signal?.addEventListener("abort", wake, { once: true });
  const deadline =
    waitMs > 0
      ? setTimeout(() => {
          timedOut = true;
          everything();
        }, waitMs)
      : undefined;
  let unsubscribe: (() => void) | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  try {
    // Subscribe before the first read so a commit during it is not lost.
    if (host.subscribe) unsubscribe = host.subscribe(changed);
    else if (waitMs > 0) poll = setInterval(everything, host.pollMs ?? 250);
    while (true) {
      // This pass claims the current notices; later ones wait for the next.
      const wasFull = full;
      const handles = full ? [...positions.keys()] : [...dirty];
      full = false;
      dirty.clear();
      let rows: Summary[];
      try {
        rows = await read(handles);
      } catch (error) {
        // A read that rejects because the caller aborted is the abort itself.
        if (signal?.aborted) return result("aborted");
        throw error;
      }
      // An aborted pass is incomplete, so it publishes nothing.
      if (signal?.aborted) return result("aborted");
      if (rows.length !== handles.length)
        throw Object.assign(new Error("run observation returned an incomplete summary batch"), {
          code: "invalid_service_response",
          status: 500,
        });
      rows.forEach((row, index) => {
        for (const position of positions.get(handles[index]!)!) summaries[position] = row;
      });
      // A completed pass and its attention are published together.
      const attention: number[] = [];
      let problems = false;
      summaries.forEach((row, index) => {
        const seen = targets[index]!.seen;
        // Echoing a problem row's null token acknowledges that problem.
        if (row.problem !== null) problems ||= seen !== null;
        else if ((row.pending || isTerminalLifecycle(row.status)) && seen !== row.token)
          attention.push(index);
      });
      if (attention.length) return result("attention", attention);
      if (problems) return result("problems");
      // The answer after the deadline rests on a full pass, so a write that was
      // never noticed still shows.
      if (timedOut && wasFull) return result("timeout");
      if (!full && dirty.size === 0)
        await new Promise<void>((resolve) => {
          notify = resolve;
          // Recheck after installing the waiter: no notice may be lost between
          // the completed pass and the sleep.
          if (full || dirty.size > 0 || signal?.aborted) resolve();
        });
      notify = undefined;
      if (signal?.aborted) return result("aborted");
    }
  } finally {
    closed = true;
    clearTimeout(deadline);
    clearInterval(poll);
    signal?.removeEventListener("abort", wake);
    notify = undefined;
    unsubscribe?.();
  }
}
