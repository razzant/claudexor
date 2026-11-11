import type { ControlGcReceipt, ControlGcRequest } from "@claudexor/schema";

const unobservedReceipts = new WeakSet<ControlGcReceipt>();
/** Internal evidence, not a wire field: cancellation returned no inventory. */
export function withoutRetentionInventory(receipt: ControlGcReceipt): ControlGcReceipt {
  unobservedReceipts.add(receipt);
  return receipt;
}

export type RetentionRunner = ((request: ControlGcRequest) => Promise<ControlGcReceipt>) & {
  hasMore?: (receipt?: ControlGcReceipt) => boolean;
  /** Cancel every already admitted pass and drain it before its store closes. */
  cancel?: () => Promise<void>;
};

/** Scheduled and manual passes share both serialization and shutdown. A later
 * invocation gets a new signal, so recovery can resume unfinished work. */
export function serializeRetention(
  runOnce: (request: ControlGcRequest, signal: AbortSignal) => Promise<ControlGcReceipt>,
): RetentionRunner {
  let inFlight: Promise<ControlGcReceipt> | null = null;
  const controllers = new Set<AbortController>();
  const run: RetentionRunner = (request) => {
    const controller = new AbortController();
    controllers.add(controller);
    const invoke = () => runOnce(request, controller.signal);
    const chained = (inFlight ?? Promise.resolve()).then(invoke, invoke);
    inFlight = chained;
    return chained.finally(() => {
      controllers.delete(controller);
      if (inFlight === chained) inFlight = null;
    });
  };
  run.cancel = async () => {
    for (const controller of controllers) controller.abort();
    await inFlight?.then(
      () => {},
      () => {},
    );
  };
  return run;
}

/** Keep post-processing inside the same close barrier as the core pass. Its
 * signal aborts when the pass is cancelled, so a step that works in slices ends
 * at its next boundary; a later pass gets a new signal. */
export function afterRetention(
  run: RetentionRunner,
  after: (
    request: ControlGcRequest,
    receipt: ControlGcReceipt,
    signal: AbortSignal,
  ) => void | Promise<void>,
): RetentionRunner {
  const pending = new Set<Promise<ControlGcReceipt>>();
  const controllers = new Set<AbortController>();
  const wrapped: RetentionRunner = (request) => {
    const controller = new AbortController();
    controllers.add(controller);
    const flight = run(request).then(async (receipt) => {
      try {
        await after(request, receipt, controller.signal);
      } catch (error) {
        throw new RetentionStepError(error, receipt);
      }
      return receipt;
    });
    pending.add(flight);
    return flight.finally(() => {
      pending.delete(flight);
      controllers.delete(controller);
    });
  };
  wrapped.hasMore = run.hasMore;
  wrapped.cancel = async () => {
    for (const controller of controllers) controller.abort();
    await run.cancel?.();
    await Promise.allSettled([...pending]);
  };
  return wrapped;
}

class RetentionStepError extends Error {
  constructor(
    cause: unknown,
    readonly receipt: ControlGcReceipt,
  ) {
    super(String(cause), { cause });
  }
}

/** Serialize the entire composition, including failure receipts and persistence.
 * Cancelling first reaches the inner pass, then drains every admitted finalizer. */
export function finalizeRetention(
  run: RetentionRunner,
  finish: (
    request: ControlGcRequest,
    result: {
      startedAt: string;
      inventoryObserved: boolean;
      receipt?: ControlGcReceipt;
      failed: boolean;
      cancelled: boolean;
      error?: unknown;
    },
  ) => Promise<void>,
): RetentionRunner {
  const wrapped = serializeRetention(async (request, signal) => {
    const startedAt = new Date().toISOString();
    let receipt: ControlGcReceipt | undefined;
    let failed = false;
    let started = false;
    let error: unknown;
    try {
      signal.throwIfAborted();
      started = true;
      receipt = await run(request);
    } catch (caught) {
      failed = true;
      error = caught;
      if (caught instanceof RetentionStepError) receipt = caught.receipt;
    }
    if (started)
      await finish(request, {
        startedAt,
        inventoryObserved: receipt !== undefined && !unobservedReceipts.has(receipt),
        receipt,
        failed,
        cancelled: signal.aborted && !receipt,
        error,
      });
    if (failed) throw error;
    return receipt!;
  });
  wrapped.hasMore = run.hasMore;
  const drain = wrapped.cancel!;
  wrapped.cancel = async () => {
    const draining = drain();
    await run.cancel?.();
    await draining;
  };
  return wrapped;
}
