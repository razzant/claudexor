export interface RuntimeStopParticipant {
  stop(): Promise<void>;
}

export interface RuntimeSetupParticipant {
  beginDrain(): void;
  shutdown(): Promise<void>;
}

export interface RuntimeJournalParticipant {
  close(): void;
}

export interface DaemonRuntimeShutdownOptions {
  daemon: RuntimeStopParticipant;
  setup: RuntimeSetupParticipant;
  control: () => RuntimeStopParticipant | null;
  journal: RuntimeJournalParticipant;
  /** Shutdown diagnostics sink (must never throw); silent by default. */
  log?: (message: string) => void;
  /** Injectable force-exit (tests); defaults to process.exit. */
  forceExit?: (code: number) => void;
  /** Observes a failed participant stop; defaults to process.exitCode = 1. */
  onStopFailure?: (error: unknown) => void;
  /** Graceful-stop deadline before the escalation exit (default 15s). */
  stopDeadlineMs?: number;
  /** Post-stop grace for the event loop to drain before the sweep exit (default 2s). */
  drainGraceMs?: number;
}

/**
 * THE daemon shutdown state machine (W3.5): every trigger — OS signal,
 * socket-RPC stop, startup failure, test dispose — enters through
 * beginShutdown(reason) and gets the SAME escalation ladder (Ф2.5 W-C8:
 * hung-stop deadline, then post-stop leaked-handle sweep). It stops ingress
 * and setup work before closing the journal they write to; a hung
 * participant or a leaked handle can no longer immortalize the daemon,
 * whichever trigger asked it to die. Every rung is DISCLOSED in the log and
 * every timer is unref'd so the ladder itself never keeps a clean process
 * alive. Timer handles are retained so a clean shutdown reaching the
 * composition root's tail can cancel them via finalize().
 */
export class DaemonRuntimeShutdown {
  private requestedValue = false;
  private finalized = false;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly completion: Promise<void>;
  private resolveCompletion!: () => void;
  private rejectCompletion!: (error: unknown) => void;

  constructor(private readonly options: DaemonRuntimeShutdownOptions) {
    this.completion = new Promise<void>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    void this.completion.catch(() => undefined);
  }

  beginShutdown(reason: string): Promise<void> {
    if (this.requestedValue) {
      this.log(`shutdown already in progress (${reason} coalesced)`);
      return this.completion;
    }
    this.requestedValue = true;
    this.log(`shutdown requested (${reason})`);
    const stopDeadlineMs = this.options.stopDeadlineMs ?? 15_000;
    this.deadlineTimer = this.armExitTimer(
      stopDeadlineMs,
      `graceful stop exceeded ${stopDeadlineMs}ms; forcing exit`,
      1,
    );

    const failures: unknown[] = [];
    const operations: Promise<void>[] = [];
    const start = (operation: () => Promise<void>): void => {
      try {
        operations.push(Promise.resolve(operation()));
      } catch (error) {
        failures.push(error);
      }
    };

    try {
      this.options.setup.beginDrain();
    } catch (error) {
      failures.push(error);
    }
    try {
      const control = this.options.control();
      if (control) start(() => control.stop());
    } catch (error) {
      failures.push(error);
    }
    start(() => this.options.daemon.stop());
    start(() => this.options.setup.shutdown());

    void Promise.allSettled(operations).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      if (failures.length > 0) {
        this.settleFailure(new AggregateError(failures, "daemon runtime shutdown failed"));
        return;
      }
      try {
        this.options.journal.close();
      } catch (error) {
        this.settleFailure(error);
        return;
      }
      // Clean stop: the hung-stop deadline is no longer needed. Unless the
      // composition root already finalized (a clean shutdown reached main()'s
      // tail before this continuation — it must not be force-exited, and a
      // post-finalize callback must never re-arm), sweep a leaked handle with
      // the exit code read at FIRE time so a late failure still exits nonzero.
      if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
      if (!this.finalized) {
        const drainGraceMs = this.options.drainGraceMs ?? 2_000;
        this.drainTimer = this.armExitTimer(
          drainGraceMs,
          `event loop still alive ${drainGraceMs}ms after a clean stop (leaked handle); forcing exit`,
        );
      }
      this.resolveCompletion();
    });
    return this.completion;
  }

  /** Cancel armed escalation timers: a clean shutdown reaching the
   * composition root's tail must not be force-exited by a pending timer. */
  finalize(): void {
    this.finalized = true;
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.deadlineTimer = null;
    this.drainTimer = null;
  }

  wait(): Promise<void> {
    return this.completion;
  }

  requested(): boolean {
    return this.requestedValue;
  }

  private settleFailure(error: unknown): void {
    if (this.options.onStopFailure) {
      try {
        this.options.onStopFailure(error);
      } catch {
        /* the observer must not mask the shutdown failure */
      }
    } else {
      process.exitCode = 1;
    }
    this.log(`shutdown FAILED: ${error instanceof Error ? error.message : String(error)}`);
    // Failure: the deadline timer stays armed to guarantee termination.
    this.rejectCompletion(error);
  }

  private armExitTimer(ms: number, reason: string, code?: number): ReturnType<typeof setTimeout> {
    const forceExit = this.options.forceExit ?? ((exitCode: number) => process.exit(exitCode));
    const t = setTimeout(() => {
      this.log(reason);
      forceExit(code ?? Number(process.exitCode ?? 0));
    }, ms);
    t.unref?.();
    return t;
  }

  private log(message: string): void {
    try {
      this.options.log?.(message);
    } catch {
      /* shutdown safety must not depend on diagnostic I/O */
    }
  }
}
