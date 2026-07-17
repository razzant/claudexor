export type SetupSupervisorState =
  "idle" | "starting" | "healthy" | "failed" | "recovery_required" | "draining" | "stopped";

export interface SetupSupervisorHealth {
  state: SetupSupervisorState;
  failure: Error | null;
  activeTasks: number;
}

export interface SetupSupervisorOptions {
  pollMs: number;
  recoveryRequired: () => boolean;
  reconcile: () => Promise<void>;
  tick: () => Promise<void>;
  abortInFlight: (reason: Error) => void;
}

export interface SetupSupervisorTrackOptions {
  /** Safety work may be registered while an already-started drain is fencing
   * ordinary admission (for example, process-group termination). */
  safety?: boolean;
}

/**
 * Owns setup background-work liveness. Domain transitions remain in the setup
 * lifecycle service; this class only controls admission, monitor scheduling,
 * exact task tracking, abort fan-out, and idempotent drain.
 */
export class SetupSupervisor {
  private stateValue: SetupSupervisorState = "idle";
  private timer: NodeJS.Timeout | null = null;
  private readonly tasks = new Set<Promise<unknown>>();
  private failureValue: Error | null = null;
  private startPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private abortIssued = false;

  constructor(private readonly options: SetupSupervisorOptions) {
    if (!Number.isFinite(options.pollMs) || options.pollMs < 0) {
      throw new Error("setup supervisor poll interval must be a non-negative finite number");
    }
  }

  health(): SetupSupervisorHealth {
    return {
      state: this.stateValue,
      failure: this.failureValue,
      activeTasks: this.tasks.size,
    };
  }

  start(): Promise<void> {
    if (this.stateValue === "healthy") return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    if (this.stateValue === "draining" || this.stateValue === "stopped") {
      return Promise.reject(
        this.unavailableError("setup supervisor is already draining or stopped"),
      );
    }
    if (this.stateValue === "failed" || this.stateValue === "recovery_required") {
      return Promise.reject(this.unavailableError());
    }
    // Fence create/confirm/extend synchronously; startOnce runs in the tracked
    // microtask and must not leave a one-turn admission window.
    this.stateValue = "starting";
    this.startPromise = this.track("reconcile", () => this.startOnce());
    return this.startPromise;
  }

  private async startOnce(): Promise<void> {
    if (this.stateValue !== "starting") throw this.unavailableError();
    if (this.options.recoveryRequired()) {
      this.stateValue = "recovery_required";
      throw this.unavailableError("setup journal requires recovery before setup can start");
    }
    try {
      await this.options.reconcile();
    } catch (error) {
      this.reportFailure(error, "reconcile");
      throw this.unavailableError();
    }
    if (this.options.recoveryRequired()) {
      this.stateValue = "recovery_required";
      throw this.unavailableError("setup journal requires recovery after reconciliation");
    }
    if (this.stateValue !== "starting") throw this.unavailableError();
    this.stateValue = "healthy";
    this.schedule();
  }

  /** Synchronous admission/abort fence used before any shutdown await. */
  beginDrain(): void {
    if (this.stateValue === "stopped") return;
    if (this.stateValue !== "draining") {
      this.clearTimer();
      this.stateValue = "draining";
    }
    if (!this.abortIssued) {
      this.abortIssued = true;
      try {
        this.options.abortInFlight(new Error("setup supervisor is draining"));
      } catch (error) {
        this.rememberFailure(error, "abort-in-flight");
      }
    }
  }

  assertCreateAllowed(): void {
    // The production composition root awaits start() before exposing setup.
    // Allowing idle keeps isolated lifecycle stores usable in focused tests;
    // every failed/recovery/draining state remains a synchronous hard fence.
    if (this.stateValue !== "idle" && this.stateValue !== "healthy") {
      throw this.unavailableError();
    }
  }

  reportFailure(error: unknown, label = "setup-supervisor"): void {
    this.rememberFailure(error, label);
    this.clearTimer();
    if (
      this.stateValue !== "recovery_required" &&
      this.stateValue !== "draining" &&
      this.stateValue !== "stopped"
    ) {
      this.stateValue = "failed";
    }
  }

  /**
   * Tracks an operation so shutdown cannot outlive it. Rejections are observed
   * exactly once and fail-close future setup admission.
   */
  track<T>(
    label: string,
    operation: () => Promise<T>,
    options: SetupSupervisorTrackOptions = {},
  ): Promise<T> {
    if (!label.trim()) throw new Error("setup supervisor task label must not be empty");
    if ((this.stateValue === "draining" || this.stateValue === "stopped") && !options.safety) {
      return Promise.reject(
        this.unavailableError("setup supervisor will not start ordinary work while draining"),
      );
    }
    if (this.stateValue === "stopped") {
      return Promise.reject(this.unavailableError("setup supervisor is stopped"));
    }

    const raw = Promise.resolve().then(operation);
    let tracked!: Promise<T>;
    tracked = raw
      .then(
        (value) => value,
        (error) => {
          this.reportFailure(error, label);
          throw error;
        },
      )
      .finally(() => {
        this.tasks.delete(tracked);
      });
    this.tasks.add(tracked);
    return tracked;
  }

  shutdown(): Promise<void> {
    this.beginDrain();
    this.shutdownPromise ??= this.shutdownOnce();
    return this.shutdownPromise;
  }

  private async shutdownOnce(): Promise<void> {
    // Drain to a fixed point: an operation that was already running may
    // register bounded safety termination while handling its abort.
    for (;;) {
      const pending = [...this.tasks];
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
    this.stateValue = "stopped";
  }

  private schedule(): void {
    if (this.stateValue !== "healthy") return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const task = this.track("monitor", this.options.tick);
      void task.then(
        () => this.schedule(),
        () => undefined,
      );
    }, this.options.pollMs);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private rememberFailure(error: unknown, label: string): void {
    if (this.failureValue) return;
    const cause = error instanceof Error ? error : new Error(String(error));
    this.failureValue = new Error(`${label}: ${cause.message}`, { cause });
  }

  private unavailableError(message?: string): Error & { status: number; code: string } {
    const detail =
      message ??
      (this.failureValue
        ? `setup supervisor is unavailable: ${this.failureValue.message}`
        : `setup supervisor is unavailable (${this.stateValue})`);
    return Object.assign(new Error(detail), {
      status: 503,
      code: "setup_supervisor_unavailable",
    });
  }
}
