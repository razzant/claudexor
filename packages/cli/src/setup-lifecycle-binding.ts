import { JournalRecoveryRequiredError } from "@claudexor/journal";

export interface SetupLifecycleHandle {
  start(): Promise<void>;
  beginDrain(): void;
  shutdown(): Promise<void>;
}

export interface SetupProjectionSlot<TStore> {
  current(): TStore;
  generation(): number;
}

/**
 * Stable composition-root binding between a replaceable journal projection
 * generation and its setup supervisor. Control routes dereference this owner
 * on every call; they never retain a closed store after quarantine.
 */
export class SetupLifecycleBinding<TStore, THandle extends SetupLifecycleHandle> {
  private active: THandle | null = null;
  private activeGeneration = 0;
  private lockTail: Promise<void> = Promise.resolve();
  private draining = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly slot: SetupProjectionSlot<TStore>,
    private readonly create: (store: TStore) => THandle,
  ) {}

  /** Start the initial supervisor when the projection is healthy. */
  async start(): Promise<void> {
    let store: TStore;
    try {
      store = this.slot.current();
    } catch (error) {
      // A corrupt partition is a supported degraded startup. Calling
      // current() later reproduces the typed recovery error for every setup
      // route while the recovery plane remains available.
      if (error instanceof JournalRecoveryRequiredError) return;
      throw error;
    }
    const handle = this.create(store);
    this.active = handle;
    this.activeGeneration = this.slot.generation();
    await handle.start();
  }

  current(): THandle {
    if (this.active) return this.active;
    // Preserve the projection's typed journal_recovery_required evidence.
    this.slot.current();
    throw Object.assign(new Error("setup lifecycle generation is unavailable"), {
      status: 503,
      code: "setup_supervisor_unavailable",
      retryable: false,
    });
  }

  generation(): number {
    return this.activeGeneration;
  }

  isBoundToCurrentGeneration(): boolean {
    return this.active !== null && this.activeGeneration === this.slot.generation();
  }

  beginDrain(): void {
    if (this.draining) return;
    this.draining = true;
    this.active?.beginDrain();
  }

  shutdown(): Promise<void> {
    this.beginDrain();
    this.shutdownPromise ??= this.exclusive(async () => {
      const handle = this.active;
      if (!handle) return;
      await handle.shutdown();
      if (this.active === handle) this.active = null;
    });
    return this.shutdownPromise;
  }

  /**
   * Drain the old generation, perform the journal replacement exactly once,
   * then bind and start the new supervisor before returning its receipt.
   */
  replaceAfter<R>(operation: () => R | Promise<R>): Promise<R> {
    return this.exclusive(async () => {
      this.assertReplacementAllowed();
      const previous = this.active;
      if (previous) {
        previous.beginDrain();
        await previous.shutdown();
        if (this.active === previous) this.active = null;
      }
      this.assertReplacementAllowed();
      let result: R;
      try {
        result = await operation();
      } catch (operationError) {
        if (this.draining) throw operationError;
        try {
          const restored = this.create(this.slot.current());
          this.active = restored;
          this.activeGeneration = this.slot.generation();
          await restored.start();
        } catch (restoreError) {
          throw new AggregateError(
            [operationError, restoreError],
            "setup lifecycle replacement failed and the prior generation could not be rebound",
          );
        }
        throw operationError;
      }
      const next = this.create(this.slot.current());
      this.active = next;
      this.activeGeneration = this.slot.generation();
      try {
        await next.start();
      } catch (error) {
        if (!this.draining) {
          if (this.active === next) this.active = null;
          throw error;
        }
        await next.shutdown();
        if (this.active === next) this.active = null;
        throw this.stoppingError();
      }
      if (this.draining) {
        next.beginDrain();
        await next.shutdown();
        if (this.active === next) this.active = null;
        throw this.stoppingError();
      }
      return result;
    });
  }

  private async exclusive<R>(operation: () => Promise<R>): Promise<R> {
    const previous = this.lockTail;
    let release!: () => void;
    this.lockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private assertReplacementAllowed(): void {
    if (this.draining) throw this.stoppingError();
  }

  private stoppingError(): Error & { status: number; code: string; retryable: boolean } {
    return Object.assign(new Error("daemon is stopping; recovery mutation was not started"), {
      status: 503,
      code: "daemon_stopping",
      retryable: true,
    });
  }
}
